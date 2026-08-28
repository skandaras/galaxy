import type { LoopTool } from '../loop';
import { addAttachment } from '$lib/server/chats';
import { compileTypst } from '$lib/server/pdf';

/** Past this the model is pasting data, not writing a document. */
const MAX_SOURCE_CHARS = 200_000;

export const createPdfToolDef = {
	name: 'create_pdf',
	description:
		'Typeset a PDF from Typst markup and attach it to this conversation. Use it whenever the ' +
		'user wants a document to keep, print or send — a report, a letter, a summary, an invoice, ' +
		'a one-pager. Load the "typst" skill first for the syntax; it is close to Markdown but not ' +
		'the same. Returns a link: include it in your reply or the user has no way to open the ' +
		"file. If the compile fails you get the compiler's own errors back — fix the markup and " +
		'call it again.',
	parameters: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: 'What the document is, for the file name and for the user'
			},
			source: { type: 'string', description: 'The complete Typst document' },
			name: { type: 'string', description: 'File name, without the .pdf' }
		},
		required: ['title', 'source']
	}
};

/**
 * Authoring a PDF, as opposed to reading one — `prepareAttachment` covers the
 * other direction.
 *
 * The Typst source is stored as the attachment's extracted text, so
 * `read_attachment` hands the agent its own document back. That turns "change
 * the heading" into an edit rather than a rewrite from memory, which is the
 * difference between a document you can iterate on and one you get once.
 */
export function documentTools(chatId: string): LoopTool[] {
	return [
		{
			def: createPdfToolDef,
			describe: (a) => String(a.title ?? a.name ?? 'document'),
			execute: async (a, report) => {
				const source = String(a.source ?? '');
				const title = String(a.title ?? '').trim();
				if (!source.trim()) throw new Error('source is required');
				if (source.length > MAX_SOURCE_CHARS) {
					throw new Error(
						`The document is ${source.length} characters — the limit is ${MAX_SOURCE_CHARS}.`
					);
				}

				const pdf = await compileTypst(source);
				const ref = addAttachment(chatId, {
					name: `${fileBase(a.name, title)}.pdf`,
					mime: 'application/pdf',
					data: pdf,
					kind: 'document',
					text: source
				});
				report?.({ bytes: pdf.length, sourceChars: source.length });

				return [
					`Typeset ${ref.name} (${Math.max(1, Math.round(pdf.length / 1024))} KB).`,
					'Link it in your reply so the user can open it:',
					`[${title || ref.name}](/api/chats/${chatId}/attachments/${ref.id})`
				].join('\n');
			}
		}
	];
}

function fileBase(rawName: unknown, fallback: string): string {
	const source = typeof rawName === 'string' && rawName.trim() ? rawName : fallback;
	const slug = source
		.toLowerCase()
		.replace(/\.pdf$/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return slug || 'document';
}
