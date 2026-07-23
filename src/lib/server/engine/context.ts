import type { ChatMeta, StoredMessage } from '$lib/server/chats';
import { attachmentDataUrl } from '$lib/server/chats';
import type { MessageContent, ProviderMessage } from '$lib/server/providers/types';

/**
 * Build the provider message array for a turn: system prompt (plus the
 * rolling compaction summary when present), then the un-compacted history.
 * Image attachments become data-URL parts when the model supports vision.
 */
export function buildContext(opts: {
	systemPrompt: string;
	chat: ChatMeta;
	history: StoredMessage[];
	supportsVision: boolean;
}): ProviderMessage[] {
	const { chat } = opts;
	const system = [
		opts.systemPrompt,
		chat.compactSummary
			? `\n\n[Summary of earlier conversation]\n${chat.compactSummary}`
			: ''
	].join('');

	const out: ProviderMessage[] = [{ role: 'system', content: system }];
	for (const m of opts.history.slice(chat.compactedUpTo)) {
		if (m.role === 'tool') continue; // tool exchanges are not replayed across turns
		out.push({ role: m.role, content: messageContent(m, opts.supportsVision) });
	}
	return out;
}

function messageContent(m: StoredMessage, supportsVision: boolean): MessageContent {
	if (!m.attachments?.length || !supportsVision) return m.content;
	const parts: MessageContent = [{ type: 'text', text: m.content }];
	for (const att of m.attachments) {
		if (!att.mime.startsWith('image/')) continue;
		const url = attachmentDataUrl(m.chatId, att.id);
		if (url) parts.push({ type: 'image_url', image_url: { url } });
	}
	return parts;
}
