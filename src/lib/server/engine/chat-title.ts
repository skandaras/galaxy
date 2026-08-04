import { getChat, getMessages, updateChat } from '$lib/server/chats';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import { logUsage } from './usage';

/** Enough of the exchange to name it by; the rest is noise for this job. */
const MAX_SOURCE_CHARS = 2_000;
const MAX_TITLE_CHARS = 60;

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
	if (!chat || chat.titleCustom) return null;

	const messages = getMessages(chatId);
	const firstUser = messages.find((m) => m.role === 'user');
	const firstReply = messages.find((m) => m.role === 'assistant');
	// Only the opening exchange earns a title. Re-titling later would rename a
	// conversation under someone mid-read.
	if (!firstUser || !firstReply) return null;
	if (messages.filter((m) => m.role === 'assistant').length > 1) return null;

	if (getBudgetStatus().blocked) return null;
	const cfg = getTaskConfig('chat-title');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) return null;

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
				maxTokens: 32
			},
			AbortSignal.timeout(30_000)
		);

		const title = cleanTitle(text);
		if (!title) return null;

		// Re-read: the user may have renamed it while this was in flight, and
		// their name wins.
		const fresh = getChat(chatId, userId);
		if (!fresh || fresh.titleCustom) return null;

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
