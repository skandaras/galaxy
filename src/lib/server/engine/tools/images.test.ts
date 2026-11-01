import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { attachments, chats, messages, usageLog } from '$lib/server/db/schema';
import { attachmentBytes, createChat, listAttachments } from '$lib/server/chats';
import type { LoopTool } from '../loop';

/**
 * The drawing half of the visual tools.
 *
 * `generate_image` resolves its model inside the call, so the seam is a module
 * mock. The adapter is
 * scripted per test so a model that draws, a model that only talks, and a model
 * that is not an image model at all are all reachable.
 */

const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let scripted: { text?: string; images?: { mime: string; base64: string }[] } = {};
let requests: Record<string, unknown>[] = [];
let imageApiRequests: Record<string, unknown>[] = [];
let modelRow: Record<string, unknown> | null = null;
/** Whether the scripted adapter offers OpenRouter's Image API. */
let imageApi = false;

vi.mock('../engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../engine')>();
	return {
		...actual,
		getTaskConfig: (task: string) =>
			task === 'visual'
				? {
						task,
						systemPrompt: 'you draw',
						promptOverride: 'you draw',
						primaryModelId: 'model-visual'
					}
				: actual.getTaskConfig(task)
	};
});

vi.mock('$lib/server/providers/registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/providers/registry')>();
	return {
		...actual,
		resolveModel: () =>
			modelRow
				? {
						model: modelRow,
						provider: {},
						adapter: {
							complete: async (req: Record<string, unknown>) => {
								requests.push(req);
								return {
									text: scripted.text ?? '',
									usage: { promptTokens: 40, completionTokens: 5 },
									finishReason: 'stop',
									...(scripted.images ? { images: scripted.images } : {})
								};
							},
							...(imageApi
								? {
										generateImages: async (req: Record<string, unknown>) => {
											imageApiRequests.push(req);
											return {
												images: scripted.images ?? [],
												usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.04 }
											};
										}
									}
								: {})
						}
					}
				: null
	};
});

const { imageTools, readImageOptions } = await import('./images');

const USER = 'user-ada';
const byName = (tools: LoopTool[], name: string) => tools.find((t) => t.def.name === name)!;

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const t of [attachments, messages, chats, usageLog]) db.delete(t).run();
	requests = [];
	imageApiRequests = [];
	imageApi = false;
	scripted = { images: [{ mime: 'image/png', base64: PIXEL }] };
	modelRow = {
		id: 'model-visual',
		modelKey: 'mock/painter',
		displayName: 'Painter',
		supportsImageOutput: true
	};
});

function tools() {
	const chat = createChat({ userId: USER, mode: 'chat', hidden: false });
	return { chatId: chat.id, tools: imageTools(chat.id, USER) };
}

describe('generate_image', () => {
	it('asks the provider for the image modality', async () => {
		const { tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'a red barn at dusk' });
		expect(requests[0].modalities).toEqual(['image', 'text']);
		expect(requests[0].modelKey).toBe('mock/painter');
	});

	it('attaches what the model drew', async () => {
		const { chatId, tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'a red barn', name: 'Red Barn!' });
		const [saved] = listAttachments(chatId);
		expect(saved.name).toBe('red-barn.png');
		expect(saved.kind).toBe('image');
		expect(attachmentBytes(chatId, saved.id)?.data.length).toBeGreaterThan(50);
	});

	it('returns a link and never the bytes', async () => {
		const { chatId, tools: t } = tools();
		const out = await byName(t, 'generate_image').execute({ prompt: 'a red barn' });
		const [saved] = listAttachments(chatId);
		expect(out).toContain(`![${saved.name}](/api/chats/${chatId}/attachments/${saved.id})`);
		// A single PNG as base64 would blow the per-call result cap on its own.
		expect(out).not.toContain(PIXEL.slice(0, 24));
		expect(out.length).toBeLessThan(500);
	});

	it('records the spend against the visual task', async () => {
		const { tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'a red barn' });
		const [row] = db.select().from(usageLog).all();
		expect(row.task).toBe('visual');
		expect(row.modelKey).toBe('mock/painter');
	});

	it('names more than one image apart', async () => {
		scripted = {
			images: [
				{ mime: 'image/png', base64: PIXEL },
				{ mime: 'image/webp', base64: PIXEL }
			]
		};
		const { chatId, tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'two barns', name: 'barn' });
		expect(listAttachments(chatId).map((a) => a.name).sort()).toEqual([
			'barn-1.png',
			'barn-2.webp'
		]);
	});

	it('says what to fix when the visual task points at a text model', async () => {
		modelRow = { ...modelRow, supportsImageOutput: false };
		const { tools: t } = tools();
		await expect(byName(t, 'generate_image').execute({ prompt: 'a barn' })).rejects.toThrow(
			/Admin → General tasks → visual/
		);
	});

	it('says what to fix when no image model is configured at all', async () => {
		modelRow = null;
		const { tools: t } = tools();
		await expect(byName(t, 'generate_image').execute({ prompt: 'a barn' })).rejects.toThrow(
			/No image model is configured/
		);
	});

	it('reports a model that replied with words instead of a picture', async () => {
		scripted = { text: 'I would draw a lovely barn.' };
		const { tools: t } = tools();
		await expect(byName(t, 'generate_image').execute({ prompt: 'a barn' })).rejects.toThrow(
			/returned no image/
		);
	});

	it('refuses an empty prompt without calling the model', async () => {
		const { tools: t } = tools();
		await expect(byName(t, 'generate_image').execute({ prompt: '  ' })).rejects.toThrow(
			/prompt is required/
		);
		expect(requests).toHaveLength(0);
	});

	it('passes a reference image through as a vision part', async () => {
		const { chatId, tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'a barn' });
		const [first] = listAttachments(chatId);
		await byName(t, 'generate_image').execute({
			prompt: 'the same barn in snow',
			reference_attachment_id: first.id
		});
		const content = (requests[1].messages as { role: string; content: unknown }[]).find(
			(m) => m.role === 'user'
		)?.content as { type: string }[];
		expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
	});

	it('rejects a reference that is not on this conversation', async () => {
		const { tools: t } = tools();
		await expect(
			byName(t, 'generate_image').execute({ prompt: 'a barn', reference_attachment_id: 'nope' })
		).rejects.toThrow(/No attachment with id nope/);
	});

	it('works from several references, in the order given', async () => {
		const { chatId, tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'a barn' });
		await byName(t, 'generate_image').execute({ prompt: 'a field' });
		const [barn, field] = listAttachments(chatId);
		await byName(t, 'generate_image').execute({
			prompt: 'the barn standing in the field',
			reference_attachment_ids: [barn.id, field.id]
		});
		const content = (requests[2].messages as { role: string; content: unknown }[]).find(
			(m) => m.role === 'user'
		)?.content as { type: string }[];
		expect(content.map((c) => c.type)).toEqual(['text', 'image_url', 'image_url']);
	});

	it('asks a model that only draws for the image alone, and passes the shape it was given', async () => {
		modelRow = { ...modelRow, imageOnly: true };
		const { tools: t } = tools();
		await byName(t, 'generate_image').execute({ prompt: 'a banner', aspect_ratio: '16:9', resolution: '2K' });
		expect(requests[0].modalities).toEqual(['image']);
		expect(requests[0].imageConfig).toEqual({ aspect_ratio: '16:9', image_size: '2K' });
	});

	it('refuses, by name, an option chat completions cannot carry, before any call', async () => {
		const { tools: t } = tools();
		await expect(
			byName(t, 'generate_image').execute({ prompt: 'a logo', quality: 'high', n: 2 })
		).rejects.toThrow(/cannot set quality, n/);
		expect(requests).toHaveLength(0);
	});

	describe('through the Image API', () => {
		it('is used only for a model the Image API serves, whatever the provider offers', async () => {
			// openrouter/auto and its kind draw, but answer only on chat completions.
			imageApi = true;
			const { tools: t } = tools();
			await byName(t, 'generate_image').execute({ prompt: 'a barn' });
			expect(imageApiRequests).toHaveLength(0);
			expect(requests).toHaveLength(1);
		});

		it('sends the references and every option asked for, with the owner\'s direction ahead of the prompt', async () => {
			imageApi = true;
			modelRow = { ...modelRow, imageApi: true };
			const { chatId, tools: t } = tools();
			await byName(t, 'generate_image').execute({ prompt: 'a barn' });
			const [barn] = listAttachments(chatId);
			await byName(t, 'generate_image').execute({
				prompt: 'the barn as a sticker',
				reference_attachment_ids: [barn.id],
				background: 'transparent',
				quality: 'high',
				n: 2,
				seed: 7
			});
			const sent = imageApiRequests[1];
			expect(sent.prompt).toBe('you draw\n\nthe barn as a sticker');
			expect(sent).toMatchObject({ background: 'transparent', outputFormat: 'png', quality: 'high', n: 2, seed: 7 });
			expect((sent.references as string[])[0]).toMatch(/^data:image\/png;base64,/);
			expect(requests).toHaveLength(0);
		});

		it('logs the price the provider named', async () => {
			imageApi = true;
			modelRow = { ...modelRow, imageApi: true };
			const { tools: t } = tools();
			await byName(t, 'generate_image').execute({ prompt: 'a barn' });
			const row = db.select().from(usageLog).all().at(-1)!;
			expect(row.costUsd).toBeCloseTo(0.04);
		});
	});
});

describe('readImageOptions', () => {
	it('returns only what was asked for', () => {
		expect(readImageOptions({ prompt: 'x' })).toEqual({ options: {} });
		expect(readImageOptions({ aspect_ratio: 'auto', n: 1 })).toEqual({ options: { aspectRatio: 'auto' } });
		expect(readImageOptions({ aspect_ratio: '19.5:9' })).toEqual({ options: { aspectRatio: '19.5:9' } });
	});

	it('gives a transparent background a format that can hold one', () => {
		expect(readImageOptions({ background: 'transparent' })).toEqual({
			options: { background: 'transparent', outputFormat: 'png' }
		});
		expect(readImageOptions({ background: 'transparent', output_format: 'jpeg' })).toEqual({
			problem: 'A transparent background needs png or webp output.'
		});
	});

	it('says what is wrong with a value it cannot use', () => {
		expect(readImageOptions({ aspect_ratio: 'wide' })).toHaveProperty('problem');
		expect(readImageOptions({ quality: 'ultra' })).toHaveProperty('problem');
		expect(readImageOptions({ n: 9 })).toHaveProperty('problem');
		expect(readImageOptions({ seed: -1 })).toHaveProperty('problem');
	});
});

describe('save_svg', () => {
	it('stores the markup and links it', async () => {
		const { chatId, tools: t } = tools();
		const out = await byName(t, 'save_svg').execute({
			markup: '<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>',
			name: 'dot'
		});
		const [saved] = listAttachments(chatId);
		expect(saved.name).toBe('dot.svg');
		expect(saved.mime).toBe('image/svg+xml');
		expect(out).toContain(`/api/chats/${chatId}/attachments/${saved.id}`);
		expect(attachmentBytes(chatId, saved.id)?.data.toString('utf8')).toContain('<circle');
	});

	it('refuses anything that is not an SVG document', async () => {
		const { tools: t } = tools();
		await expect(byName(t, 'save_svg').execute({ markup: '<div>hello</div>' })).rejects.toThrow(
			/complete SVG document/
		);
	});

	it('never calls a model', async () => {
		const { tools: t } = tools();
		await byName(t, 'save_svg').execute({ markup: '<svg viewBox="0 0 1 1"></svg>' });
		expect(requests).toHaveLength(0);
	});
});
