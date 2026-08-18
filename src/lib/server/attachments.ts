import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
	classifyAttachment,
	MAX_EXTRACTED_CHARS,
	UnsupportedAttachmentError,
	type AttachmentClass
} from '$lib/attachment-types';

export { UnsupportedAttachmentError };

export interface PreparedAttachment {
	kind: 'image' | 'document';
	/** Extracted plain text; empty for images. */
	text: string;
}

/**
 * Validate an upload and, for documents, pull out plain text. Images pass
 * through untouched — they reach the model as data URLs via the vision path.
 *
 * Throws UnsupportedAttachmentError with a message meant for the user.
 */
export async function prepareAttachment(
	name: string,
	mime: string,
	data: Buffer
): Promise<PreparedAttachment> {
	const spec: AttachmentClass = classifyAttachment(name, mime);
	if (data.length > spec.maxBytes) {
		const limitMb = Math.round(spec.maxBytes / (1024 * 1024));
		throw new UnsupportedAttachmentError(`File too large (${limitMb} MB limit for this type)`);
	}
	if (spec.strategy === 'none') return { kind: spec.kind, text: '' };

	let text: string;
	switch (spec.strategy) {
		case 'text':
			text = decodeText(name, data);
			break;
		case 'pdf':
			text = await extractPdf(data);
			break;
		case 'docx':
			text = await extractDocx(data);
			break;
	}
	return { kind: spec.kind, text: truncate(normalise(text)) };
}

function normalise(s: string): string {
	// Strip a BOM and normalise line endings so offsets in read_attachment
	// line up with what the model was shown.
	return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function truncate(s: string): string {
	return s.length > MAX_EXTRACTED_CHARS
		? `${s.slice(0, MAX_EXTRACTED_CHARS)}\n…(file truncated at ${MAX_EXTRACTED_CHARS} characters)`
		: s;
}

function decodeText(name: string, data: Buffer): string {
	const text = data.toString('utf8');
	// A NUL byte in the first few KB means this is binary wearing a text
	// extension; decoding it would feed the model mojibake.
	if (text.slice(0, 4096).includes('\u0000')) {
		throw new UnsupportedAttachmentError(`${name} looks like a binary file, not text.`);
	}
	return text;
}

/**
 * Directory of pdfjs's bundled standard fonts. Under Node pdfjs reads this
 * with fs, so it wants a plain path with a trailing slash — not a file:// URL.
 */
function standardFontDir(): string {
	const require = createRequire(import.meta.url);
	return `${dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;
}

/**
 * Text layer of a PDF.
 *
 * Exported because deep research reads PDFs off the open web too — a great
 * many primary sources (government reports, standards, papers) are PDFs, and
 * before this they reached the model as binary noise.
 */
export async function extractPdf(data: Buffer): Promise<string> {
	// The legacy build is the one that runs outside a browser; pdfjs v6 ships
	// no exports map, so the deep path is the supported way in.
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	// No DOM and no font loading — this runs server-side on untrusted uploads
	// and only ever needs the text layer. The standard-font data still has to
	// be locatable or pdfjs warns and degrades on Helvetica/Times documents.
	const task = pdfjs.getDocument({
		data: new Uint8Array(data),
		useSystemFonts: false,
		disableFontFace: true,
		standardFontDataUrl: standardFontDir()
	});
	const doc = await task.promise;

	try {
		const pages: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			const line = content.items
				.map((item) => ('str' in item ? item.str : ''))
				.join(' ')
				.replace(/[ \t]+/g, ' ')
				.trim();
			pages.push(`[page ${i}]\n${line}`);
			page.cleanup();
			if (pages.join('\n\n').length > MAX_EXTRACTED_CHARS) break;
		}
		const out = pages.join('\n\n').trim();
		if (!out) {
			throw new UnsupportedAttachmentError(
				'No text found in this PDF — it is probably a scan. OCR is not supported yet.'
			);
		}
		return out;
	} finally {
		// Tears down the worker as well as the document.
		await task.destroy();
	}
}

async function extractDocx(data: Buffer): Promise<string> {
	const mammoth = await import('mammoth');
	const result = await mammoth.extractRawText({ buffer: data });
	const out = result.value.trim();
	if (!out) throw new UnsupportedAttachmentError('No text found in this Word document.');
	return out;
}
