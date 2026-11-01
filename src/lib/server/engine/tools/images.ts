import type { LoopTool } from '../loop';
import type { GeneratedImage, ProviderMessage, Usage } from '$lib/server/providers/types';
import { addAttachment, attachmentDataUrl, listAttachments } from '$lib/server/chats';
import { getTaskConfig, systemPromptFor } from '../engine';
import { resolveModel, type ModelChoice } from '$lib/server/providers/registry';
import { logUsage } from '../usage';
import { taskPath } from '$lib/admin-sections';

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
					'mock-up. Not for diagrams, charts or anything made of shapes and labels, which ' +
					'belong in a mermaid or svg fenced block instead. Returns a markdown image link: ' +
					'include it in your reply exactly as given, or the user never sees what you drew. ' +
					'Pass reference_attachment_ids to work from images already in the conversation. ' +
					'Use exact attachment ids supplied with the message; if you do not have them, call list_attachments first. Never guess an id. ' +
					'Set the other options only when the user asked for them; leave them out otherwise.',
				parameters: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description:
								'What to draw, in as much detail as you can give: subject, composition, ' +
								'style, palette, mood. Vague prompts produce vague pictures.'
						},
						name: {
							type: 'string',
							description: 'Short file name for the image, without an extension'
						},
						reference_attachment_ids: {
							type: 'array',
							items: { type: 'string' },
							description: `Ids of images already attached to this conversation to work from, for an edit, a variation or a combination (up to ${MAX_REFERENCES}). From list_attachments.`
						},
						reference_attachment_id: {
							type: 'string',
							description: 'One image to work from. Prefer reference_attachment_ids.'
						},
						aspect_ratio: {
							type: 'string',
							description: 'Shape, such as 1:1, 16:9, 9:16, 4:3, 3:2 or 2:3, or auto.'
						},
						resolution: { type: 'string', enum: [...RESOLUTIONS] },
						quality: { type: 'string', enum: [...QUALITIES] },
						background: {
							type: 'string',
							enum: [...BACKGROUNDS],
							description: 'transparent needs png or webp output.'
						},
						output_format: { type: 'string', enum: [...FORMATS] },
						n: { type: 'number', description: `How many images, 1 to ${MAX_IMAGES}.` },
						seed: {
							type: 'number',
							description: 'Repeat a result exactly, where the model supports it.'
						}
					},
					required: ['prompt']
				}
			},
			describe: (a) => String(a.prompt ?? '').slice(0, 80),
			execute: async (a, report) => {
				const prompt = String(a.prompt ?? '').trim();
				if (!prompt) throw new Error('prompt is required');
				const read = readImageOptions(a);
				if ('problem' in read) throw new Error(read.problem);
				const options = read.options;

				const choice = imageModel();
				const references = referenceUrls(chatId, a);

				let res: { images: GeneratedImage[]; usage: Usage | null; text?: string };
				try {
					if (choice.model.imageApi && choice.adapter.generateImages) {
						// The Image API has no system message. The shipped visual prompt
						// is written for chat completions, so only a prompt the owner
						// wrote rides along, as direction ahead of the ask.
						const own = ownDirection();
						res = await choice.adapter.generateImages(
							{
								modelKey: choice.model.modelKey,
								prompt: own ? `${own}\n\n${prompt}` : prompt,
								...(references.length ? { references } : {}),
								...options
							},
							AbortSignal.timeout(IMAGE_TIMEOUT_MS)
						);
					} else {
						res = await viaChat(choice, prompt, references, options);
					}
				} catch (err) {
					// Logged before rethrowing, the same way vision.ts does it and for
					// the same reason: a call that reached the provider and then timed
					// out at IMAGE_TIMEOUT_MS has still been generated and still been
					// billed. This was the one model call in the platform that wrote no
					// row on the failure path, so that spend was invisible to
					// getBudgetStatus and to the usage dashboard alike — which is
					// exactly what usage.ts exists to prevent.
					logUsage({ task: 'visual', choice, usage: null, status: 'error', userId });
					throw err;
				}
				logUsage({ task: 'visual', choice, usage: res.usage, status: 'ok', userId });

				const images = res.images;
				if (!images.length) {
					throw new Error(
						`${choice.model.displayName} returned no image${res.text ? `, and replied: ${res.text.slice(0, 300)}` : ''}. ` +
							`It may not actually generate images; check ${taskPath('visual')}.`
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
				report?.({
					model: choice.model.modelKey,
					images: images.length,
					references: references.length,
					options: Object.keys(options)
				});

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
					'user can download and keep it. Write the SVG yourself; this does not call an ' +
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
					throw new Error(`SVG is ${markup.length} characters; the limit is ${MAX_SVG_CHARS}`);
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
			`No image model is configured. Set ${taskPath('visual')} to a model that generates images.`
		);
	}
	if (!choice.model.supportsImageOutput) {
		throw new Error(
			`${choice.model.displayName} does not generate images. Point ${taskPath('visual')} at a model badged “I” in Admin → Models.`
		);
	}
	return choice;
}

/**
 * The images to work from, as data URLs, in the order given. The array wins
 * over the single id the tool used to take; each must be an image attached to
 * this chat, and a bad id is the model's to fix, so it says which.
 */
function referenceUrls(chatId: string, args: Record<string, unknown>): string[] {
	const listed = Array.isArray(args.reference_attachment_ids)
		? args.reference_attachment_ids
		: typeof args.reference_attachment_id === 'string'
			? [args.reference_attachment_id]
			: [];
	const ids = [...new Set(listed.map((x) => String(x ?? '').trim()).filter(Boolean))];
	if (ids.length > MAX_REFERENCES) {
		throw new Error(`At most ${MAX_REFERENCES} reference images; ${ids.length} were given.`);
	}
	const attached = listAttachments(chatId);
	return ids.map((id) => {
		const match = attached.find((x) => x.id === id);
		if (!match) throw new Error(`No attachment with id ${id}. Call list_attachments first.`);
		if (match.kind !== 'image') throw new Error(`${match.name} is not an image.`);
		const url = attachmentDataUrl(chatId, id);
		if (!url) throw new Error(`Could not read ${match.name}.`);
		return url;
	});
}

/** The owner's own `visual` prompt, where they wrote one. */
function ownDirection(): string {
	return getTaskConfig('visual')?.promptOverride?.trim() ?? '';
}

/**
 * Drawing over chat completions, for an endpoint with no Image API. Only what
 * that path can carry is accepted: the shape and size go in `image_config`,
 * and everything else is refused here by name, because an endpoint that has
 * never heard of a field is free to ignore it and hand back something other
 * than what was asked for.
 */
async function viaChat(
	choice: ModelChoice,
	prompt: string,
	references: string[],
	options: ImageOptions
): Promise<{ images: GeneratedImage[]; usage: Usage | null; text: string }> {
	const { aspectRatio, resolution, ...rest } = options;
	const unsupported = Object.keys(rest).map((k) => OPTION_NAMES[k] ?? k);
	if (resolution && !CHAT_SIZES.has(resolution)) unsupported.push(`resolution ${resolution}`);
	if (unsupported.length) {
		throw new Error(
			`${choice.model.displayName} is reached through chat completions, which cannot set ${unsupported.join(', ')}. Leave ${unsupported.length > 1 ? 'them' : 'it'} out and draw again.`
		);
	}
	const messages: ProviderMessage[] = [
		{ role: 'system', content: systemPromptFor('visual') },
		{
			role: 'user',
			content: references.length
				? [
						{ type: 'text', text: prompt },
						...references.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
					]
				: prompt
		}
	];
	const imageConfig = {
		...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
		...(resolution ? { image_size: resolution } : {})
	};
	const res = await choice.adapter.complete(
		{
			modelKey: choice.model.modelKey,
			messages,
			// The whole point of the call: without this an image model replies
			// with a paragraph about the picture it would have drawn. A model that
			// only draws is asked for the image alone, which is what it accepts.
			modalities: choice.model.imageOnly ? ['image'] : ['image', 'text'],
			...(Object.keys(imageConfig).length ? { imageConfig } : {}),
			maxTokens: IMAGE_MAX_TOKENS
		},
		AbortSignal.timeout(IMAGE_TIMEOUT_MS)
	);
	return { images: res.images ?? [], usage: res.usage, text: res.text };
}

const RESOLUTIONS = ['512', '768', '1K', '1.5K', '2K', '4K'] as const;
const QUALITIES = ['auto', 'low', 'medium', 'high'] as const;
const BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const;
const FORMATS = ['png', 'jpeg', 'webp', 'svg'] as const;
/** The sizes chat completions' `image_config.image_size` takes. */
const CHAT_SIZES = new Set(['1K', '2K', '4K']);
const MAX_REFERENCES = 8;
const MAX_IMAGES = 4;
/** The tool's own names for options, for a refusal the model can act on. */
const OPTION_NAMES: Record<string, string> = {
	outputFormat: 'output_format',
	quality: 'quality',
	background: 'background',
	n: 'n',
	seed: 'seed'
};

export interface ImageOptions {
	aspectRatio?: string;
	resolution?: string;
	quality?: (typeof QUALITIES)[number];
	background?: (typeof BACKGROUNDS)[number];
	outputFormat?: (typeof FORMATS)[number];
	n?: number;
	seed?: number;
}

/**
 * The drawing options a call asked for, checked, or what is wrong with them.
 * Only fields that were given are returned, so a call that sets nothing sends
 * nothing and the model's own defaults apply. Exported for tests.
 */
export function readImageOptions(
	args: Record<string, unknown>
): { options: ImageOptions } | { problem: string } {
	const given = (key: string) => args[key] !== undefined && args[key] !== null && args[key] !== '';
	const options: ImageOptions = {};
	if (given('aspect_ratio')) {
		const ratio = String(args.aspect_ratio).trim();
		// Decimals included: providers list shapes like 19.5:9 for a phone.
		if (!/^(auto|\d{1,2}(\.\d{1,2})?:\d{1,2}(\.\d{1,2})?)$/.test(ratio)) {
			return { problem: `aspect_ratio "${ratio}" is not a ratio like 16:9, or auto.` };
		}
		options.aspectRatio = ratio;
	}
	const choices = [
		['resolution', RESOLUTIONS, 'resolution'],
		['quality', QUALITIES, 'quality'],
		['background', BACKGROUNDS, 'background'],
		['output_format', FORMATS, 'outputFormat']
	] as const;
	for (const [key, allowed, field] of choices) {
		if (!given(key)) continue;
		const value = String(args[key]).trim();
		if (!(allowed as readonly string[]).includes(value)) {
			return { problem: `${key} must be one of ${allowed.join(', ')}.` };
		}
		(options as Record<string, unknown>)[field] = value;
	}
	if (given('n')) {
		const n = Number(args.n);
		if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) {
			return { problem: `n must be a whole number from 1 to ${MAX_IMAGES}.` };
		}
		if (n > 1) options.n = n;
	}
	if (given('seed')) {
		const seed = Number(args.seed);
		if (!Number.isInteger(seed) || seed < 0) return { problem: 'seed must be a whole number, 0 or more.' };
		options.seed = seed;
	}
	// A transparent background is a property of the file format: jpeg has no
	// alpha channel, so the request would come back with a filled background.
	if (options.background === 'transparent') {
		if (options.outputFormat && options.outputFormat !== 'png' && options.outputFormat !== 'webp') {
			return { problem: 'A transparent background needs png or webp output.' };
		}
		options.outputFormat ??= 'png';
	}
	return { options };
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
