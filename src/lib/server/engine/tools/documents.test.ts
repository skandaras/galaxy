import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { attachments, chats, messages } from '$lib/server/db/schema';
import { attachmentBytes, attachmentText, createChat, listAttachments } from '$lib/server/chats';
import { resetTypstProbe, typstAvailable } from '$lib/server/pdf';
import { documentTools } from './documents';

/** Skipped where the compiler is absent — see the note in pdf.test.ts. */
resetTypstProbe();
const installed = await typstAvailable();

const USER = 'user-ida';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const t of [attachments, messages, chats]) db.delete(t).run();
});

function tool() {
	const chat = createChat({ userId: USER, mode: 'chat', hidden: false });
	return { chatId: chat.id, createPdf: documentTools(chat.id)[0] };
}

describe.skipIf(!installed)('create_pdf', () => {
	it('attaches a real PDF and links it', async () => {
		const { chatId, createPdf } = tool();
		const out = await createPdf.execute({
			title: 'Quarterly report',
			source: '= Quarterly report\n\nSpending is down.'
		});
		const [saved] = listAttachments(chatId);
		expect(saved.name).toBe('quarterly-report.pdf');
		expect(saved.kind).toBe('document');
		expect(attachmentBytes(chatId, saved.id)?.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(out).toContain(`/api/chats/${chatId}/attachments/${saved.id}`);
	});

	it('keeps the source as the attachment text, so the next turn can edit it', async () => {
		const { chatId, createPdf } = tool();
		const source = '= Letter\n\nDear Ada,';
		await createPdf.execute({ title: 'Letter', source });
		const [saved] = listAttachments(chatId);
		expect(attachmentText(chatId, saved.id)).toBe(source);
	});

	it("hands back the compiler's complaint rather than a generic failure", async () => {
		const { createPdf } = tool();
		await expect(
			createPdf.execute({ title: 'Broken', source: '#table(columns: 2\n' })
		).rejects.toThrow(/unclosed delimiter/i);
	});
});

describe('create_pdf, whatever the compiler situation', () => {
	it('refuses an empty document without compiling', async () => {
		const { createPdf } = tool();
		await expect(createPdf.execute({ title: 'Nothing', source: '  ' })).rejects.toThrow(
			/source is required/
		);
	});

	it('refuses a document too long to be one', async () => {
		const { createPdf } = tool();
		await expect(
			createPdf.execute({ title: 'Huge', source: 'x'.repeat(200_001) })
		).rejects.toThrow(/the limit is/);
	});
});
