import type { ChatMeta, StoredMessage } from '$lib/server/chats';
import { attachmentDataUrl, attachmentText } from '$lib/server/chats';
import type { MessageContent, ProviderMessage } from '$lib/server/providers/types';

/** How much of a document is inlined before the model must call read_attachment. */
export const INLINE_DOC_CHARS = 8_000;

/**
 * Build the provider message array for a turn: system prompt (plus the
 * rolling compaction summary when present), then the un-compacted history,
 * then any volatile context as a trailing note. Image attachments become
 * data-URL parts when the model supports vision; documents are inlined as text
 * extracted at upload time.
 *
 * `tail` exists for prompt caching. Every provider that caches does it on a
 * prefix, so anything that changes between turns must sit at the *end* or
 * nothing before it can be reused. The coding agent's session state block —
 * files read, git status, diffstat — was concatenated into the system message,
 * which is to say the very front, and it changes on every leg: three legs of
 * one turn therefore missed the cache three times over, on automatic-caching
 * providers as much as explicit ones. Moved here, the system prompt and the
 * whole settled history stay byte-identical and cacheable.
 */
export function buildContext(opts: {
	systemPrompt: string;
	chat: ChatMeta;
	history: StoredMessage[];
	supportsVision: boolean;
	/** Volatile context, appended last so it cannot invalidate the prefix. */
	tail?: string;
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
	const tail = opts.tail?.trim();
	if (tail) {
		const note: ProviderMessage = {
			role: 'user',
			content: `[Notes for this turn — context, not a new request. Answer the message that follows.]\n${tail}`
		};
		// Slipped in *before* the person's own message rather than after it. The
		// last message is the one a model weighs most heavily, and that place
		// belongs to what was actually asked — a session-state dump sitting there
		// reads as the request. Everything before the note is still a stable
		// prefix, which is all caching needs.
		const insertAt = out.at(-1)?.role === 'user' ? out.length - 1 : out.length;
		out.splice(insertAt, 0, note);
	}
	return out;
}

/**
 * Render one stored message for the provider. Exported so the coding agent,
 * which builds its own message array, gets identical attachment handling.
 */
export function messageContent(m: StoredMessage, supportsVision: boolean): MessageContent {
	if (!m.attachments?.length) return m.content;

	// Documents are text either way, so they append to the text part whether
	// or not the model has vision.
	const text = withDocumentText(m.chatId, m.content, m.attachments);

	const images = m.attachments.filter(isImage);
	if (!images.length) return text;

	if (!supportsVision) {
		// These used to vanish without trace. Say so, so the model can tell the
		// user rather than answering as if nothing had been attached.
		const names = images.map((a) => a.name).join(', ');
		return `${text}\n\n[Attached image${images.length > 1 ? 's' : ''}: ${names} — the selected model cannot view images, so the contents are unavailable.]`;
	}

	const parts: MessageContent = [{ type: 'text', text }];
	for (const att of images) {
		const url = attachmentDataUrl(m.chatId, att.id);
		if (url) parts.push({ type: 'image_url', image_url: { url } });
	}
	return parts;
}

/**
 * Append the extracted text of every document attachment to a prompt. Used by
 * the chat context builder and by deep research, which assembles its own
 * prompts from the question text alone.
 */
export function withDocumentText(
	chatId: string,
	text: string,
	refs: { id: string; name: string; mime: string; kind?: string }[] | null | undefined
): string {
	let out = text;
	for (const att of refs ?? []) {
		if (isImage(att)) continue;
		out += `\n\n${documentBlock(chatId, att.id, att.name, att.mime)}`;
	}
	return out;
}

/** Refs stored before document support have no `kind`; those were all images. */
function isImage(att: { mime: string; kind?: string }): boolean {
	return att.kind ? att.kind === 'image' : att.mime.startsWith('image/');
}

function documentBlock(chatId: string, attId: string, name: string, mime: string): string {
	const text = attachmentText(chatId, attId);
	if (!text) return `[Attached file: ${name} (${mime}) — contents unavailable]`;
	const header = `[Attached file: ${name} (${mime}, ${text.length.toLocaleString('en-US')} chars)]`;
	if (text.length <= INLINE_DOC_CHARS) return `${header}\n${text}`;
	return [
		header,
		text.slice(0, INLINE_DOC_CHARS),
		`…(truncated — call read_attachment with id="${attId}" and offset=${INLINE_DOC_CHARS} for the rest)`
	].join('\n');
}
