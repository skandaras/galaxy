import { describe, expect, it } from 'vitest';
import { addAttachment, appendMessage, createChat, getMessages } from '$lib/server/chats';
import { buildContext, INLINE_DOC_CHARS, messageContent } from './context';

/**
 * Hidden chats live entirely in memory, so these exercise the real storage
 * and context code without needing a migrated database.
 */
function chatWith(attachment: {
	name: string;
	mime: string;
	kind: 'image' | 'document';
	text?: string;
}) {
	const chat = createChat({ userId: 'u1', hidden: true });
	const ref = addAttachment(chat.id, {
		name: attachment.name,
		mime: attachment.mime,
		data: Buffer.from('raw bytes'),
		kind: attachment.kind,
		text: attachment.text ?? ''
	});
	appendMessage(chat.id, { role: 'user', content: 'Summarise this', attachments: [ref] });
	return { chat, ref, message: getMessages(chat.id)[0] };
}

describe('messageContent', () => {
	it('passes plain messages straight through', () => {
		const chat = createChat({ userId: 'u1', hidden: true });
		appendMessage(chat.id, { role: 'user', content: 'hello' });
		expect(messageContent(getMessages(chat.id)[0], true)).toBe('hello');
	});

	it('inlines a short document as text', () => {
		const { message } = chatWith({
			name: 'spec.md',
			mime: 'text/markdown',
			kind: 'document',
			text: '# Spec\nBuild the thing.'
		});
		const out = messageContent(message, false);
		expect(out).toContain('Summarise this');
		expect(out).toContain('[Attached file: spec.md');
		expect(out).toContain('Build the thing.');
	});

	it('truncates a long document and points at read_attachment', () => {
		const long = 'x'.repeat(INLINE_DOC_CHARS + 500);
		const { ref, message } = chatWith({
			name: 'big.pdf',
			mime: 'application/pdf',
			kind: 'document',
			text: long
		});
		const out = messageContent(message, false) as string;
		expect(out).toContain(`read_attachment with id="${ref.id}"`);
		expect(out).toContain(`offset=${INLINE_DOC_CHARS}`);
		expect(out.length).toBeLessThan(long.length);
	});

	it('sends images as vision parts when the model supports it', () => {
		const { message, ref } = chatWith({ name: 'shot.png', mime: 'image/png', kind: 'image' });
		const out = messageContent(message, true);
		expect((out as { type: string; text?: string }[])[0].text).toContain(`id="${ref.id}"`);
		expect(Array.isArray(out)).toBe(true);
		const parts = out as { type: string }[];
		expect(parts[0].type).toBe('text');
		expect(parts[1].type).toBe('image_url');
	});

	it('says so instead of silently dropping images on a non-vision model', () => {
		const { message } = chatWith({ name: 'shot.png', mime: 'image/png', kind: 'image' });
		const out = messageContent(message, false);
		expect(typeof out).toBe('string');
		expect(out).toContain('shot.png');
		expect(out).toContain('cannot view images');
	});

	it('points a non-vision model at view_image, with the id it needs to call it', () => {
		// The note is the only place the model is told the id, so a pointer
		// without one is a pointer it cannot follow.
		const { ref, message } = chatWith({ name: 'shot.png', mime: 'image/png', kind: 'image' });
		const out = messageContent(message, false) as string;
		expect(out).toContain('view_image');
		expect(out).toContain(`id="${ref.id}"`);
	});

	it('still reads documents when the model has no vision', () => {
		const chat = createChat({ userId: 'u1', hidden: true });
		const doc = addAttachment(chat.id, {
			name: 'notes.txt',
			mime: 'text/plain',
			data: Buffer.from('x'),
			kind: 'document',
			text: 'important detail'
		});
		const img = addAttachment(chat.id, {
			name: 'shot.png',
			mime: 'image/png',
			data: Buffer.from('x'),
			kind: 'image'
		});
		appendMessage(chat.id, { role: 'user', content: 'look', attachments: [doc, img] });
		const out = messageContent(getMessages(chat.id)[0], false) as string;
		expect(out).toContain('important detail');
		expect(out).toContain('cannot view images');
	});

	it('treats legacy refs without a kind as images', () => {
		const chat = createChat({ userId: 'u1', hidden: true });
		appendMessage(chat.id, {
			role: 'user',
			content: 'old message',
			// Shape written before document support landed.
			attachments: [{ id: 'legacy', name: 'old.png', mime: 'image/png' }]
		});
		const out = messageContent(getMessages(chat.id)[0], false) as string;
		expect(out).toContain('cannot view images');
		expect(out).not.toContain('[Attached file');
	});
});

describe('buildContext', () => {
	function conversation() {
		const chat = createChat({ userId: 'u1', hidden: true });
		appendMessage(chat.id, { role: 'user', content: 'Add a feature' });
		appendMessage(chat.id, { role: 'assistant', content: 'Done.' });
		return chat;
	}

	const build = (tail?: string) => {
		const chat = conversation();
		return buildContext({
			systemPrompt: 'BASE PROMPT',
			chat,
			history: getMessages(chat.id),
			supportsVision: false,
			tail
		});
	};

	for (const hidden of [true, false]) {
		it(`keeps generated versions usable after a later turn and compaction (hidden=${hidden})`, async () => {
			if (!hidden) {
				const { runMigrations } = await import('$lib/server/db');
				runMigrations();
			}
			const chat = createChat({ userId: 'u1', hidden });
			const refs = [];
			for (let i = 0; i < 4; i++) {
				const ref = addAttachment(chat.id, { name: 'portrait.png', mime: 'image/png',
					data: Buffer.from(`version-${i}`), kind: 'image' });
				refs.push(ref);
				appendMessage(chat.id, { role: 'assistant',
					content: `![portrait](/api/chats/${chat.id}/attachments/${ref.id})` });
			}
			const other = createChat({ userId: 'u1', hidden });
			const privateRef = addAttachment(other.id, { name: 'other.png', mime: 'image/png',
				data: Buffer.from('other-chat'), kind: 'image' });
			appendMessage(chat.id, { role: 'user', content: 'Revert to the earlier version and change only the smile.' });
			const opts = { systemPrompt: 'BASE', chat: { ...chat, compactedUpTo: 4, compactSummary: 'Drew four portraits.' },
				history: getMessages(chat.id), supportsVision: true };
			const out = buildContext(opts);
			expect(out.at(-1)?.content).toBe('Revert to the earlier version and change only the smile.');
			const context = out.find((m) => JSON.stringify(m.content).includes('Earlier generated images'))!;
			expect(context.role).toBe('user');
			for (const ref of refs) expect(JSON.stringify(context.content)).toContain(ref.id);
			expect(JSON.stringify(context.content)).not.toContain(privateRef.id);
			const parts = context.content as { type: string; image_url?: { url: string } }[];
			expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url)).toEqual(
				[1, 2, 3].map((i) => `data:image/png;base64,${Buffer.from(`version-${i}`).toString('base64')}`)
			);
			const blind = buildContext({ ...opts, supportsVision: false });
			const blindContext = blind.find((m) => String(m.content).includes('Earlier generated images'))!;
			expect(blindContext.content).toContain('view_image');
			expect(blindContext.content).not.toContain('base64');
		});
	}

	it('leads with the system prompt and follows with the history', () => {
		const out = build();
		expect(out[0]).toEqual({ role: 'system', content: 'BASE PROMPT' });
		expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
	});

	it('adds nothing at all when there is no tail', () => {
		// The common case, and it must not gain an empty note.
		expect(build('   ')).toHaveLength(3);
	});

	it('keeps volatile context out of the system message, which stays cacheable', () => {
		// The whole point: anything that changes between turns has to sit behind
		// everything a provider might have cached.
		const out = build('Already read: a.ts');
		expect(out[0].content).toBe('BASE PROMPT');
		expect(out.filter((m) => String(m.content).includes('Already read: a.ts'))).toHaveLength(1);
	});

	it('leaves the last word to the person, not to the notes', () => {
		// A model weighs the final message most heavily, and that place belongs
		// to what was actually asked — a session-state dump sitting there reads
		// as the request.
		const chat = createChat({ userId: 'u1', hidden: true });
		appendMessage(chat.id, { role: 'assistant', content: 'Done.' });
		appendMessage(chat.id, { role: 'user', content: 'Now add tests' });
		const out = buildContext({
			systemPrompt: 'BASE PROMPT',
			chat,
			history: getMessages(chat.id),
			supportsVision: false,
			tail: 'Already read: a.ts'
		});
		expect(out.at(-1)?.content).toBe('Now add tests');
		expect(String(out.at(-2)?.content)).toContain('Already read: a.ts');
	});

	it('frames the note as context rather than a request', () => {
		// build()'s conversation ends on the assistant, so the note lands last.
		expect(String(build('git status: clean').at(-1)?.content)).toMatch(/context, not a new request/);
	});

	it('appends the note when the conversation does not end on the user', () => {
		const chat = createChat({ userId: 'u1', hidden: true });
		appendMessage(chat.id, { role: 'assistant', content: 'Done.' });
		const out = buildContext({
			systemPrompt: 'BASE PROMPT',
			chat,
			history: getMessages(chat.id),
			supportsVision: false,
			tail: 'git status: clean'
		});
		expect(String(out.at(-1)?.content)).toContain('git status: clean');
	});
});
