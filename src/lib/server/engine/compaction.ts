import { reasoningFor } from '$lib/server/providers/registry';
import type { ChatMeta, StoredMessage } from '$lib/server/chats';
import { getMessages, updateChat } from '$lib/server/chats';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { CompactionSettings } from '$lib/server/settings';

import { emitEvent } from './events';

// Cheap deterministic token estimate (~4 chars/token). Good enough to decide
// when to compact; a real tokenizer is not worth the dependency yet.
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateContextTokens(system: string, msgs: { content: string }[]): number {
	return estimateTokens(system) + msgs.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

const FALLBACK_CONTEXT_WINDOW = 32_768;

/**
 * If the chat's estimated context exceeds the cutoff, fold everything except
 * the most recent messages into a rolling summary. The full transcript is
 * untouched — compaction only changes what gets sent to the model.
 */
export async function maybeCompact(opts: {
	chat: ChatMeta;
	systemPrompt: string;
	choice: ModelChoice;
	settings: CompactionSettings;
}): Promise<boolean> {
	const { chat, choice, settings } = opts;
	const all = getMessages(chat.id);
	const active = all.slice(chat.compactedUpTo);
	const windowTokens = choice.model.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
	const used = estimateContextTokens(
		opts.systemPrompt + (chat.compactSummary ?? ''),
		active
	);
	if (used < windowTokens * settings.ratio) return false;

	const cutoff = Math.max(all.length - settings.keepRecent, chat.compactedUpTo);
	const toFold = all.slice(chat.compactedUpTo, cutoff);
	if (!toFold.length) return false;

	const started = Date.now();
	try {
		const summary = await summarise(toFold, chat.compactSummary, choice);
		updateChat(chat.id, { compactSummary: summary, compactedUpTo: cutoff });
		emitEvent(
			{
				userId: chat.userId,
				chatId: chat.id,
				task: 'chat',
				type: 'compaction',
				name: 'auto-compact',
				status: 'ok',
				durationMs: Date.now() - started,
				detail: { foldedMessages: toFold.length, summaryChars: summary.length }
			},
			{ persist: !chat.hidden }
		);
		return true;
	} catch (err) {
		emitEvent(
			{
				userId: chat.userId,
				chatId: chat.id,
				task: 'chat',
				type: 'compaction',
				name: 'auto-compact',
				status: 'error',
				durationMs: Date.now() - started,
				detail: { error: String(err) }
			},
			{ persist: !chat.hidden }
		);
		return false;
	}
}

async function summarise(
	msgs: StoredMessage[],
	previousSummary: string | null,
	choice: ModelChoice
): Promise<string> {
	const transcript = msgs
		.map((m) => `${m.role.toUpperCase()}: ${m.content}`)
		.join('\n')
		.slice(0, 60_000);
	const { text } = await choice.adapter.complete(
		{
			modelKey: choice.model.modelKey,
			messages: [
				{
					role: 'system',
					content:
						'Summarise the conversation so far for use as compressed context. Preserve decisions, facts, preferences, open questions and code identifiers. Be dense and factual. Reply with the summary only.'
				},
				{
					role: 'user',
					content: previousSummary
						? `Earlier summary:\n${previousSummary}\n\nNew conversation to fold in:\n${transcript}`
						: transcript
				}
			],
			maxTokens: 1024,
			// Reads what it was given and emits a short structured answer, which is
			// the class of task where deliberation buys nothing and costs the wall
			// clock. Sent only to models that accept it — see reasoningFor.
			reasoning: reasoningFor(choice, 'low')
		},
		AbortSignal.timeout(60_000)
	);
	return text.trim();
}
