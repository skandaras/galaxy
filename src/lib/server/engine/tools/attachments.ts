import type { LoopTool } from '../loop';
import { attachmentText, listAttachments } from '$lib/server/chats';

/** Default slice size, matching the coding tools' file-read budget. */
const DEFAULT_LIMIT = 20_000;
const MAX_LIMIT = 60_000;

/**
 * Access to files the user attached to this conversation. Documents are
 * text-extracted at upload; the context builder inlines the first few
 * thousand characters and points here for the rest.
 */
export function attachmentTools(chatId: string): LoopTool[] {
	return [
		{
			def: {
				name: 'list_attachments',
				description:
					'List the files attached to this conversation, with their ids, types and text lengths.',
				parameters: { type: 'object', properties: {} }
			},
			execute: async () => {
				const items = listAttachments(chatId);
				if (!items.length) return 'No files are attached to this conversation.';
				return items
					.map(
						(a) =>
							`- ${a.name} (id: ${a.id}, ${a.mime}, ${a.kind}${a.kind === 'document' ? `, ${a.textChars} chars` : ''})`
					)
					.join('\n');
			}
		},
		{
			def: {
				name: 'read_attachment',
				description:
					'Read the text of a document attached to this conversation. Use offset/limit to page through long files. Images cannot be read this way.',
				parameters: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Attachment id from list_attachments' },
						name: { type: 'string', description: 'File name, if the id is unknown' },
						offset: { type: 'number', description: 'Character offset to start at (default 0)' },
						limit: {
							type: 'number',
							description: `Characters to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
						}
					}
				}
			},
			describe: (a) => String(a.name ?? a.id ?? ''),
			execute: async (a) => {
				const items = listAttachments(chatId);
				if (!items.length) throw new Error('No files are attached to this conversation.');

				const id = typeof a.id === 'string' ? a.id : '';
				const name = typeof a.name === 'string' ? a.name.trim().toLowerCase() : '';
				const match =
					items.find((x) => x.id === id) ??
					items.find((x) => x.name.toLowerCase() === name) ??
					// Models often paraphrase the filename; fall back to a contains match.
					(name ? items.find((x) => x.name.toLowerCase().includes(name)) : undefined);

				if (!match) {
					throw new Error(
						`No attachment matching ${id || a.name || '(nothing given)'}. Available: ${items.map((x) => x.name).join(', ')}`
					);
				}
				if (match.kind === 'image') {
					throw new Error(
						`${match.name} is an image — it is shown directly to vision-capable models and has no text to read.`
					);
				}

				const text = attachmentText(chatId, match.id);
				if (!text) throw new Error(`No extracted text stored for ${match.name}.`);

				const offset = clampInt(a.offset, 0, 0, Math.max(0, text.length - 1));
				const limit = clampInt(a.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
				const slice = text.slice(offset, offset + limit);
				const end = offset + slice.length;
				const remaining = text.length - end;
				return remaining > 0
					? `${slice}\n…(${remaining} characters remain — call again with offset=${end})`
					: slice;
			}
		}
	];
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}
