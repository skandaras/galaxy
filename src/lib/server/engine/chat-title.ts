import { reasoningFor } from '$lib/server/providers/registry';
import { getChat, getMessages, updateChat } from '$lib/server/chats';
import type { ToolDef } from '$lib/server/providers/types';
import type { LoopTool } from './loop';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import { logUsage } from './usage';

/** Enough of the exchange to name it by; the rest is noise for this job. */
const MAX_SOURCE_CHARS = 2_000;
const MAX_TITLE_CHARS = 60;

/**
 * Generous for a six-word answer, because a reasoning model spends this budget
 * thinking before it writes anything. At 32 those models returned empty and the
 * chat silently kept its fallback name — the same starvation that once made
 * deep research return nothing.
 */
const TITLE_MAX_TOKENS = 256;

export const setChatTitleToolDef: ToolDef = {
	name: 'set_chat_title',
	description:
		'Name this conversation. Call this once, as part of your first reply, with a short ' +
		'subject-style name — two to five words, naming what the conversation is about rather ' +
		'than restating the request. "Postgres connection pooling", not "Question about databases" ' +
		'or "How to fix my pool". Only offered while the conversation is still unnamed; calling it ' +
		'costs the user nothing and saves a second model call.',
	parameters: {
		type: 'object',
		properties: {
			title: { type: 'string', description: 'The name, two to five words' }
		},
		required: ['title']
	}
};

/**
 * Let the agent name the chat inside the turn it is already running.
 *
 * A separate titling call is a second thing that can fail on its own — a
 * starved token budget, an unconfigured model, a provider hiccup — and when it
 * does, the chat keeps a truncated first message and nothing says why. Naming it
 * from the turn that produced the reply costs no extra call and cannot fail
 * separately from the reply itself.
 *
 * `onSet` tells the caller the agent did the job, so the fallback stays quiet.
 */
export function setChatTitleTool(chatId: string, userId: string, onSet: () => void): LoopTool {
	return {
		def: setChatTitleToolDef,
		describe: (args) => String(args.title ?? ''),
		execute: async (args) => {
			const title = cleanTitle(String(args.title ?? ''));
			if (!title) throw new Error('title is required');

			// A name the user chose always wins, even mid-turn.
			const chat = getChat(chatId, userId);
			if (!chat) throw new Error('chat not found');
			if (chat.titleCustom) {
				onSet();
				return `This conversation is already named "${chat.title}" by the user — left unchanged.`;
			}

			updateChat(chatId, { title });
			onSet();
			return `Named this conversation "${title}".`;
		}
	};
}

/** Prompt note for a turn that is being asked to name its own chat. */
export function nameThisChatNote(): string {
	return [
		'',
		'[This conversation has no name yet]',
		'Call set_chat_title once during this reply with a short, subject-style name for it. Do this alongside answering — it is not a reason to delay or shorten your reply.'
	].join('\n');
}

/**
 * Name a chat from its opening exchange.
 *
 * The fallback title is the first 48 characters of whatever was typed, which
 * reads as a truncated question rather than a subject — fine for one chat,
 * useless for a list of thirty. This replaces it once, after the first reply,
 * with something a person can scan.
 *
 * Deliberately best-effort: any failure leaves the fallback in place. A chat
 * that cannot be named is not a chat that has gone wrong.
 */
export async function maybeTitleChat(chatId: string, userId: string): Promise<string | null> {
	const chat = getChat(chatId, userId);

	/**
	 * Record why a chat kept its fallback name. Every one of these used to be a
	 * bare `return null`, which is precisely why intermittent failures here were
	 * impossible to diagnose — the chat just quietly stayed named after its first
	 * message, with nothing anywhere saying so.
	 */
	const skip = (reason: string): null => {
		emitEvent(
			{
				userId,
				chatId: chat?.hidden ? undefined : chatId,
				task: 'chat-title',
				type: 'job',
				name: 'chat-title.skipped',
				status: 'ok',
				detail: { reason }
			},
			{ persist: !chat?.hidden }
		);
		return null;
	};

	if (!chat) return null;
	if (chat.titleCustom) return skip('the user named this chat');

	const messages = getMessages(chatId);
	const firstUser = messages.find((m) => m.role === 'user');
	const firstReply = messages.find((m) => m.role === 'assistant');
	// Only the opening exchange earns a title. Re-titling later would rename a
	// conversation under someone mid-read.
	if (!firstUser) return skip('no user message');
	if (!firstReply) return skip('the turn produced no reply');
	if (messages.filter((m) => m.role === 'assistant').length > 1) {
		return skip('not the first exchange');
	}

	if (getBudgetStatus().blocked) return skip('budget cap reached');
	const cfg = getTaskConfig('chat-title');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) return skip('no model configured');

	const started = Date.now();
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: cfg?.systemPrompt ?? '' },
					{
						role: 'user',
						content: [
							'CHAT-TITLE: Name this conversation. Reply with the title alone — no quotes, no punctuation at the end, no preamble.',
							`--- OPENING MESSAGE ---\n${firstUser.content.slice(0, MAX_SOURCE_CHARS)}`,
							`--- REPLY ---\n${firstReply.content.slice(0, MAX_SOURCE_CHARS)}`
						].join('\n\n')
					}
				],
				maxTokens: TITLE_MAX_TOKENS,
				// Reads what it was given and emits a short structured answer, which is
				// the class of task where deliberation buys nothing and costs the wall
				// clock. Sent only to models that accept it — see reasoningFor.
				reasoning: reasoningFor(choice, 'low')
			},
			AbortSignal.timeout(30_000)
		);

		const title = cleanTitle(text);
		if (!title) {
			logUsage('chat-title', choice.model.modelKey, usage, 'ok', userId);
			return skip(`model returned nothing usable: ${JSON.stringify(text.slice(0, 120))}`);
		}

		// Re-read: the user may have renamed it while this was in flight, and
		// their name wins.
		const fresh = getChat(chatId, userId);
		if (!fresh || fresh.titleCustom) return skip('renamed while the title was in flight');

		updateChat(chatId, { title });
		logUsage('chat-title', choice.model.modelKey, usage, 'ok', userId);
		emitEvent(
			{
				userId,
				chatId: chat.hidden ? undefined : chatId,
				task: 'chat-title',
				type: 'job',
				name: 'chat-title.run',
				status: 'ok',
				durationMs: Date.now() - started,
				detail: chat.hidden ? { hidden: true } : { title }
			},
			{ persist: !chat.hidden }
		);
		return title;
	} catch (err) {
		logUsage('chat-title', choice.model.modelKey, null, 'error', userId);
		emitEvent(
			{
				userId,
				task: 'chat-title',
				type: 'job',
				name: 'chat-title.run',
				status: 'error',
				durationMs: Date.now() - started,
				detail: { error: String(err) }
			},
			{ persist: !chat.hidden }
		);
		return null;
	}
}

/**
 * Models asked for "the title alone" still return `"Quoted"`, `Title:` prefixes
 * and the occasional trailing full stop. Strip the usual decorations and take
 * the first line.
 */
export function cleanTitle(raw: string): string {
	let out = (raw.trim().split('\n')[0] ?? '').trim();

	// The decorations nest — `"Title: Nebulae"` is the common shape — so quotes
	// have to come off before the prefix is even at the start of the string.
	// Stripping in one fixed order left the prefix in place, which is how
	// "Title: …" ended up in the sidebar.
	for (let pass = 0; pass < 3; pass++) {
		const before = out;
		out = out.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
		out = out.replace(/^(chat\s+)?title\s*[:\-—]\s*/i, '').trim();
		if (out === before) break;
	}

	return out.replace(/[.,;:]+$/, '').trim().slice(0, MAX_TITLE_CHARS);
}
