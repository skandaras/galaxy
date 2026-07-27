import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareAttachment, UnsupportedAttachmentError } from './attachments';
import { classifyAttachment, MAX_DOC_BYTES } from '$lib/attachment-types';

const fixture = (name: string) => readFileSync(join('src/lib/server/fixtures', name));

describe('classifyAttachment', () => {
	it('classifies by extension when the browser sends no mime type', () => {
		// Browsers routinely report '' for .md, which is why the old
		// image/-prefix check rejected every document.
		expect(classifyAttachment('notes.md', '')).toMatchObject({
			kind: 'document',
			strategy: 'text'
		});
	});

	it('treats images as vision input, not text', () => {
		expect(classifyAttachment('shot.png', 'image/png')).toMatchObject({
			kind: 'image',
			strategy: 'none'
		});
	});

	it('routes pdf and docx to their parsers', () => {
		expect(classifyAttachment('a.pdf', '').strategy).toBe('pdf');
		expect(classifyAttachment('a.docx', '').strategy).toBe('docx');
	});

	it('explains why known-but-unreadable formats are rejected', () => {
		expect(() => classifyAttachment('old.doc', '')).toThrow(/\.docx or PDF/);
		expect(() => classifyAttachment('sheet.xlsx', '')).toThrow(/csv/);
	});

	it('rejects unknown binary types', () => {
		expect(() => classifyAttachment('thing.bin', 'application/octet-stream')).toThrow(
			UnsupportedAttachmentError
		);
	});
});

describe('prepareAttachment', () => {
	it('reads a markdown file', async () => {
		const out = await prepareAttachment('notes.md', '', Buffer.from('# Title\n\nBody text.'));
		expect(out.kind).toBe('document');
		expect(out.text).toBe('# Title\n\nBody text.');
	});

	it('normalises CRLF so read_attachment offsets match what the model saw', async () => {
		const out = await prepareAttachment('win.txt', 'text/plain', Buffer.from('a\r\nb\r\nc'));
		expect(out.text).toBe('a\nb\nc');
	});

	it('extracts text from a PDF', async () => {
		const out = await prepareAttachment('sample.pdf', 'application/pdf', fixture('sample.pdf'));
		expect(out.kind).toBe('document');
		expect(out.text).toContain('Galaxy attachment test document.');
		expect(out.text).toContain('[page 1]');
	});

	it('extracts text from a .docx', async () => {
		const out = await prepareAttachment('sample.docx', '', fixture('sample.docx'));
		expect(out.text).toContain('Quarterly plan heading');
		expect(out.text).toContain('Second paragraph of the Word fixture.');
	});

	it('leaves images alone', async () => {
		const out = await prepareAttachment('x.png', 'image/png', Buffer.from([0x89, 0x50]));
		expect(out).toEqual({ kind: 'image', text: '' });
	});

	it('rejects a binary file wearing a text extension', async () => {
		const binary = Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x04, 0x00]);
		await expect(prepareAttachment('fake.txt', 'text/plain', binary)).rejects.toThrow(
			/binary file/
		);
	});

	it('enforces the size cap', async () => {
		const big = Buffer.alloc(MAX_DOC_BYTES + 1);
		await expect(prepareAttachment('big.txt', 'text/plain', big)).rejects.toThrow(/too large/);
	});
});
