import type { LoopTool } from '../loop';
import type { ProviderMessage } from '$lib/server/providers/types';
import { addAttachment, attachmentDataUrl, listAttachments } from '$lib/server/chats';
import { getTaskConfig } from '../engine';
import { resolveModel } from '$lib/server/providers/registry';
import { logUsage } from '../usage';

/**
 * A drawing takes far longer than a sentence, and there is nothing to stream —
 * the image arrives whole or not at all.
 */
const IMAGE_TIMEOUT_MS = 180_000;

/** Room for the model to think out loud alongside the picture it returns. */
const IMAGE_MAX_TOKENS = 4_096;

/** Enough SVG for a real diagram; past this the model is pasting a bitmap trace. */
const MAX_SVG_CHARS = 400_000;

/**
 * Turning what a model draws into something the reader can see.
 *
 * The two halves are deliberately different. A PNG comes from an image model —
 * a second model call, made against whatever the `visual` task is pointed at —
 * whereas an SVG is *code*, which the agent already in the conversation writes
 * far better than any image model draws. So `generate_image` calls out and
 * `save_svg` does not.
 *
 * Both end at the same place: a chat attachment plus a markdown link to it, so
 * the picture lands in the saved reply and is still there after a reload. The
 * bytes themselves never go back to the model — see the note in `linkFor`.
 */
export function imageTools(chatId: string, userId: string): LoopTool[] {
	return [
		{
			def: {
				name: 'generate_image',
				description:
					'Draw an image from a description and attach it to this conversation. Use it when ' +
					'the user asks for a picture, an illustration, a logo, a photo-like asset or a ' +
					'mock-up — not for diagrams, charts or anything made of shapes and labels, which ' +
					'belong in a mermaid or svg fenced block instead. Returns a markdown image link: ' +
					'include it in your reply exactly as given, or the user never sees what you drew. ' +
					'Pass reference_attachment_id to work from an image already in the conversation.',
				parameters: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description:
								'What to draw, in as much detail as you can give — subject, composition, ' +
								'style, palette, mood. Vague prompts produce vague pictures.'
						},
						name: {
							type: 'string',
							description: 'Short file name for the image, without an extension'
						},
						reference_attachment_id: {
							type: 'string',
							description:
								'Id of an image already attached to this conversation to work from, for ' +
								'an edit or a variation. From list_attachments.'
						}
					},
					required: ['prompt']
				}
			},
			describe: (a) => String(a.prompt ?? '').slice(0, 80),
			execute: async (a, report) => {
				const prompt = String(a.prompt ?? '').trim();
				if (!prompt) throw new Error('prompt is required');

				const choice = imageModel();
				const content = referenceContent(chatId, a.reference_attachment_id);
				const messages: ProviderMessage[] = [
					{ role: 'system', content: getTaskConfig('visual')?.systemPrompt ?? '' },
					{
						role: 'user',
						content: content ? [{ type: 'text', text: prompt }, content] : prompt
					}
				];

				const res = await choice.adapter.complete(
					{
						modelKey: choice.model.modelKey,
						messages,
						// The whole point of the call: without this an image model
						// replies with a paragraph about the picture it would have drawn.
						modalities: ['image', 'text'],
						maxTokens: IMAGE_MAX_TOKENS
					},
					AbortSignal.timeout(IMAGE_TIMEOUT_MS)
				);
				logUsage('visual', choice.model.modelKey, res.usage, 'ok', userId);

				const images = res.images ?? [];
				if (!images.length) {
					throw new Error(
						`${choice.model.displayName} returned no image${res.text ? ` — it replied: ${res.text.slice(0, 300)}` : ''}. ` +
							'It may not actually generate images; check Admin → Tasks → visual.'
					);
				}

				const base = fileBase(a.name, prompt);
				const links = images.map((img, i) => {
					const data = Buffer.from(img.base64, 'base64');
					const ref = addAttachment(chatId, {
						name: `${base}${images.length > 1 ? `-${i + 1}` : ''}.${extensionFor(img.mime)}`,
						mime: img.mime,
						data,
						kind: 'image'
					});
					return linkFor(chatId, ref.id, ref.name);
				});
				report?.({ model: choice.model.modelKey, images: images.length });

				return [
					`Drew ${images.length} image${images.length > 1 ? 's' : ''} with ${choice.model.displayName}.`,
					'Put this in your reply, exactly as written, so the user can see it:',
					...links
				].join('\n');
			}
		},
		{
			def: {
				name: 'save_svg',
				description:
					'Save SVG markup you have written as a file attached to this conversation, so the ' +
					'user can download and keep it. Write the SVG yourself — this does not call an ' +
					'image model. To simply show a diagram in the thread you do not need this tool at ' +
					'all: an ```svg fenced code block renders inline. Use this when the user wants the ' +
					'file itself.',
				parameters: {
					type: 'object',
					properties: {
						markup: { type: 'string', description: 'The complete <svg>…</svg> document' },
						name: { type: 'string', description: 'Short file name, without an extension' }
					},
					required: ['markup']
				}
			},
			describe: (a) => String(a.name ?? 'svg'),
			execute: async (a) => {
				const markup = String(a.markup ?? '').trim();
				if (!markup) throw new Error('markup is required');
				if (!/^<(\?xml|svg)\b/i.test(markup)) {
					throw new Error('markup must be a complete SVG document starting with <svg');
				}
				if (markup.length > MAX_SVG_CHARS) {
					throw new Error(`SVG is ${markup.length} characters — the limit is ${MAX_SVG_CHARS}`);
				}
				const ref = addAttachment(chatId, {
					name: `${fileBase(a.name, 'drawing')}.svg`,
					mime: 'image/svg+xml',
					data: Buffer.from(markup, 'utf8'),
					kind: 'image'
				});
				return [
					`Saved ${ref.name}.`,
					'Link it in your reply so the user can open it:',
					linkFor(chatId, ref.id, ref.name)
				].join('\n');
			}
		}
	];
}

/**
 * The model the `visual` task is pointed at, which must actually draw.
 *
 * Deliberately not falling back to "the first enabled model" the way pickModel
 * does: a text model asked for an image returns prose, and a tool that
 * confidently produces nothing is worse than one that says what to go and fix.
 */
function imageModel() {
	const cfg = getTaskConfig('visual');
	const choice = cfg?.primaryModelId ? resolveModel(cfg.primaryModelId) : null;
	if (!choice) {
		throw new Error(
			'No image model is configured. Set Admin → Tasks → visual to a model that generates images.'
		);
	}
	if (!choice.model.supportsImageOutput) {
		throw new Error(
			`${choice.model.displayName} does not generate images. Point Admin → Tasks → visual at a model badged “I” in Admin → Models.`
		);
	}
	return choice;
}

/** An attachment to work from, as a vision part the image model can see. */
function referenceContent(chatId: string, rawId: unknown) {
	const id = typeof rawId === 'string' ? rawId.trim() : '';
	if (!id) return null;
	const match = listAttachments(chatId).find((x) => x.id === id);
	if (!match) throw new Error(`No attachment with id ${id} — call list_attachments first.`);
	if (match.kind !== 'image') throw new Error(`${match.name} is not an image.`);
	const url = attachmentDataUrl(chatId, id);
	if (!url) throw new Error(`Could not read ${match.name}.`);
	return { type: 'image_url' as const, image_url: { url } };
}

/**
 * What the model gets back: a link, never the picture.
 *
 * A single PNG as base64 is comfortably past the 30 000-character cap on one
 * tool result and would eat the whole turn's 240 000-character budget on the
 * way. The model has no use for the pixels in any case — it needs to know the
 * image exists and how to show it.
 */
function linkFor(chatId: string, attachmentId: string, name: string): string {
	return `![${name}](/api/chats/${chatId}/attachments/${attachmentId})`;
}

/** A safe, readable file stem from the model's name, or from the prompt. */
function fileBase(rawName: unknown, fallback: string): string {
	const source = typeof rawName === 'string' && rawName.trim() ? rawName : fallback;
	const slug = source
		.toLowerCase()
		.replace(/\.[a-z0-9]{1,5}$/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return slug || 'image';
}

function extensionFor(mime: string): string {
	const known: Record<string, string> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/webp': 'webp',
		'image/gif': 'gif',
		'image/svg+xml': 'svg'
	};
	return known[mime] ?? 'png';
}
