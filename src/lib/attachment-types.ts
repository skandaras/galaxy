// Attachment type policy, shared by the upload route (validation) and the
// composers (the file picker's accept list). Kept free of server imports so
// the browser bundle can use it.

export type AttachmentKind = 'image' | 'document';

/** How the extracted text is produced. `none` = images, handled by vision. */
export type ExtractStrategy = 'none' | 'text' | 'pdf' | 'docx';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOC_BYTES = 25 * 1024 * 1024;

/** Upper bound on stored extracted text, so one huge PDF can't bloat the DB. */
export const MAX_EXTRACTED_CHARS = 400_000;

/**
 * Extensions decoded as UTF-8 as-is. Deliberately broad — prose, data and
 * source files are all just text to a model.
 */
const TEXT_EXTENSIONS = [
	'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'org',
	'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
	'xml', 'html', 'htm', 'log', 'diff', 'patch',
	'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'svelte', 'vue',
	'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
	'php', 'pl', 'lua', 'r', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1',
	'sql', 'graphql', 'gql', 'proto', 'css', 'scss', 'sass', 'less',
	'dockerfile', 'gitignore', 'gradle', 'tf'
];

const PDF_EXTENSIONS = ['pdf'];
const DOCX_EXTENSIONS = ['docx'];

/**
 * Formats we recognise but cannot read, so the user gets a useful message
 * instead of a generic "unsupported type".
 */
const REJECTED: Record<string, string> = {
	doc: 'Legacy .doc is not supported — save as .docx or PDF.',
	rtf: 'RTF is not supported — save as .docx, .md or PDF.',
	pages: 'Apple Pages files are not supported — export to .docx or PDF.',
	key: 'Keynote files are not supported — export to PDF.',
	numbers: 'Apple Numbers files are not supported — export to .csv or PDF.',
	xls: 'Legacy .xls is not supported — save as .csv.',
	xlsx: 'Spreadsheets are not supported yet — export the sheet as .csv.',
	pptx: 'Slide decks are not supported yet — export to PDF.',
	zip: 'Archives are not supported — upload the individual files.'
};

const TEXTUAL_MIME_PREFIXES = ['text/'];
const TEXTUAL_MIMES = new Set([
	'application/json',
	'application/xml',
	'application/x-yaml',
	'application/yaml',
	'application/toml',
	'application/x-sh',
	'application/javascript',
	'application/typescript',
	'application/sql',
	'application/graphql'
]);

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The composer's file input `accept` attribute. */
export const ATTACHMENT_ACCEPT = [
	'image/*',
	PDF_MIME,
	DOCX_MIME,
	'text/*',
	...[...TEXT_EXTENSIONS, ...PDF_EXTENSIONS, ...DOCX_EXTENSIONS].map((e) => `.${e}`)
].join(',');

export function extensionOf(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? '';
	const dot = base.lastIndexOf('.');
	// Extension-less dotfiles like "Dockerfile" still match by whole name.
	return (dot > 0 ? base.slice(dot + 1) : base).toLowerCase();
}

export class UnsupportedAttachmentError extends Error {}

export interface AttachmentClass {
	kind: AttachmentKind;
	strategy: ExtractStrategy;
	maxBytes: number;
}

/**
 * Decide how a file should be handled. Extension wins over the browser's
 * reported MIME type, which is frequently empty or wrong for .md and friends.
 */
export function classifyAttachment(name: string, mime: string): AttachmentClass {
	const ext = extensionOf(name);
	const type = (mime || '').toLowerCase().split(';')[0].trim();

	if (REJECTED[ext]) throw new UnsupportedAttachmentError(REJECTED[ext]);

	if (PDF_EXTENSIONS.includes(ext) || type === PDF_MIME) {
		return { kind: 'document', strategy: 'pdf', maxBytes: MAX_DOC_BYTES };
	}
	if (DOCX_EXTENSIONS.includes(ext) || type === DOCX_MIME) {
		return { kind: 'document', strategy: 'docx', maxBytes: MAX_DOC_BYTES };
	}
	if (TEXT_EXTENSIONS.includes(ext)) {
		return { kind: 'document', strategy: 'text', maxBytes: MAX_DOC_BYTES };
	}
	// Check images before generic text so an SVG is treated as an image.
	if (type.startsWith('image/')) {
		return { kind: 'image', strategy: 'none', maxBytes: MAX_IMAGE_BYTES };
	}
	if (TEXTUAL_MIMES.has(type) || TEXTUAL_MIME_PREFIXES.some((p) => type.startsWith(p))) {
		return { kind: 'document', strategy: 'text', maxBytes: MAX_DOC_BYTES };
	}

	throw new UnsupportedAttachmentError(
		`Unsupported file type${ext ? ` (.${ext})` : ''} — supported: images, PDF, Word (.docx), and text/markdown/code files.`
	);
}

/** Icon for an attachment chip. */
export function attachmentIcon(kind: AttachmentKind | undefined): string {
	return kind === 'document' ? '📄' : '🖼';
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
