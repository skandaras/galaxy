import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { attachments, chats, messages, usageLog } from '$lib/server/db/schema';
import { attachmentBytes, createChat, listAttachments } from '$lib/server/chats';
import type { LoopTool } from '../loop';

/**
 * The drawing half of the visual tools.
 *
 * `generate_image` resolves its model inside the call, so the seam is a module
 * mock — the same shape cortex-groom-model.test.ts uses. The adapter is
 * scripted per test so a model that draws, a model that only talks, and a model
 * that is not an image model at all are all reachable.
 */

const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let scripted: { text?: string; images?: { mime: string; base64: string }[] } = {};
let requests: Record<string, unknown>[] = [];
let modelRow: Record<string, unknown> | null = null;

vi.mock('../engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../engine')>();
	return {
		...actual,
		getTaskConfig: (task: string) =>
			task === 'visual'
				? { task, systemPrompt: 'you draw', primaryModelId: 'model-visual' }
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
							}
						}
					}
				: null
	};
});

const { imageTools } = await import('./images');

const USER = 'user-ada';
const byName = (tools: LoopTool[], name: string) => tools.find((t) => t.def.name === name)!;

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const t of [attachments, messages, chats, usageLog]) db.delete(t).run();
	requests = [];
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
			/Admin → Tasks → visual/
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
