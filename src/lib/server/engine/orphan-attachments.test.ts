import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { attachments, chats, messages } from '$lib/server/db/schema';
import { addAttachment, createChat } from '$lib/server/chats';
import { withUnlinkedAttachments } from './engine';

/**
 * The file that was drawn, paid for, and unreachable.
 *
 * Attachments are stored against the chat with no message id, and nothing in
 * the interface lists them — so the only route a person has to a generated
 * image or PDF is the link the tool hands the model with "put this in your
 * reply". A turn that ends exhausted, out of budget or cancelled saves its last
 * step label instead of that reply, and the file is then reachable from
 * nowhere, permanently.
 */

beforeAll(() => runMigrations());

let chatId = '';
beforeEach(() => {
	db.delete(attachments).run();
	db.delete(messages).run();
	db.delete(chats).run();
	chatId = createChat({ userId: 'ana' }).id;
});

const draw = (name: string) =>
	addAttachment(chatId, { name, mime: 'image/png', data: Buffer.from('x'), kind: 'image' });

describe('withUnlinkedAttachments', () => {
	it('leaves a reply that linked what it made alone', () => {
		const before = new Set<string>();
		const ref = draw('sunset.png');
		const text = `Here it is: ![sunset](/api/chats/${chatId}/attachments/${ref.id})`;
		expect(withUnlinkedAttachments(chatId, text, before)).toBe(text);
	});

	it('appends the link a truncated turn never got to write', () => {
		const before = new Set<string>();
		const ref = draw('sunset.png');
		// What a run that ended `exhausted` actually saves.
		const out = withUnlinkedAttachments(chatId, 'Ran out of steps before finishing.', before);
		expect(out).toContain(ref.id);
		expect(out).toContain('sunset.png');
		expect(out).toContain('Ran out of steps');
	});

	it('ignores what was already on the chat before the turn', () => {
		// An upload the person made is not something this turn produced, and
		// listing it back at them every reply would be noise.
		const existing = draw('their-upload.png');
		const out = withUnlinkedAttachments(chatId, 'Answer.', new Set([existing.id]));
		expect(out).toBe('Answer.');
	});

	it('links a document as a document rather than an image', () => {
		const ref = addAttachment(chatId, {
			name: 'report.pdf',
			mime: 'application/pdf',
			data: Buffer.from('x'),
			kind: 'document'
		});
		const out = withUnlinkedAttachments(chatId, 'Done.', new Set());
		expect(out).toContain(`[report.pdf](/api/chats/${chatId}/attachments/${ref.id})`);
		expect(out).not.toContain(`![report.pdf]`);
	});

	it('still hands over the file when the reply came back empty', () => {
		const ref = draw('sunset.png');
		expect(withUnlinkedAttachments(chatId, '', new Set())).toContain(ref.id);
	});

	it('does nothing when the turn made nothing', () => {
		expect(withUnlinkedAttachments(chatId, 'Just prose.', new Set())).toBe('Just prose.');
	});
});
