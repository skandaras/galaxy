import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { attachments, chats, messages, usageLog } from '$lib/server/db/schema';
import { addAttachment, createChat } from '$lib/server/chats';
import type { LoopTool } from '../loop';

/**
 * Reading an image on behalf of an agent that cannot see one.
 *
 * `view_image` resolves its model inside the call, so the seam is a module
 * mock — the same shape images.test.ts beside it uses. Both halves of the
 * resolver are scripted: the task pointed at a model, and the task pointed at
 * nothing, which is the case the fallback exists for.
 */

const PIXEL = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

interface FakeModel {
	id: string;
	modelKey: string;
	displayName: string;
	supportsVision: boolean;
}

let configuredModelId: string | null = null;
let known: FakeModel[] = [];
let scripted: { text: string } | { throws: string } = { text: '' };
let requests: Record<string, unknown>[] = [];

vi.mock('../engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../engine')>();
	return {
		...actual,
		getTaskConfig: (task: string) =>
			task === 'vision'
				? {
						task,
						systemPrompt: 'you look',
						promptOverride: 'you look',
						primaryModelId: configuredModelId
					}
				: actual.getTaskConfig(task)
	};
});

vi.mock('$lib/server/providers/registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/providers/registry')>();
	return {
		...actual,
		listEnabledModels: () => known,
		resolveModel: (id: string) => {
			const model = known.find((m) => m.id === id);
			if (!model) return null;
			return {
				model,
				provider: {},
				adapter: {
					complete: async (req: Record<string, unknown>) => {
						requests.push(req);
						if ('throws' in scripted) throw new Error(scripted.throws);
						return { text: scripted.text, usage: { promptTokens: 900, completionTokens: 60 } };
					}
				}
			};
		}
	};
});

const { visionTools } = await import('./vision');

const USER = 'user-ada';
const SEEING: FakeModel = {
	id: 'model-eyes',
	modelKey: 'mock/eyes',
	displayName: 'Eyes',
	supportsVision: true
};
const BLIND: FakeModel = {
	id: 'model-prose',
	modelKey: 'mock/prose',
	displayName: 'Prose',
	supportsVision: false
};

const view = (tools: LoopTool[]) => tools.find((t) => t.def.name === 'view_image')!;

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const t of [attachments, messages, chats, usageLog]) db.delete(t).run();
	requests = [];
	scripted = { text: 'The banner reads "connection refused" over a red field.' };
	known = [SEEING, BLIND];
	configuredModelId = SEEING.id;
});

/** A chat with `count` images on it, and the tool bound to it. */
function withImages(count: number, opts: { hidden?: boolean } = {}) {
	const chat = createChat({ userId: USER, mode: 'chat', hidden: opts.hidden ?? false });
	const ids = Array.from({ length: count }, (_, i) =>
		addAttachment(chat.id, {
			name: `shot-${i + 1}.png`,
			mime: 'image/png',
			data: PIXEL,
			kind: 'image'
		})
	);
	return { chatId: chat.id, ids, tool: view(visionTools(chat.id, USER)) };
}

describe('view_image', () => {
	it('hands back what the vision model said, and who said it', async () => {
		const { tool } = withImages(1);
		const out = await tool.execute({ question: 'what does the error say?' });
		expect(out).toContain('connection refused');
		expect(out).toContain('Eyes');
		expect(out).toContain('shot-1.png');
	});

	it('sends the image as a data URL beside the question', async () => {
		const { tool } = withImages(1);
		await tool.execute({ question: 'what does the error say?' });
		const parts = (requests[0].messages as { role: string; content: unknown }[])[1]
			.content as { type: string; text?: string; image_url?: { url: string } }[];
		expect(parts[0].text).toContain('what does the error say?');
		expect(parts[1].type).toBe('image_url');
		expect(parts[1].image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
	});

	it('carries the vision task’s own system prompt', async () => {
		const { tool } = withImages(1);
		await tool.execute({ question: 'anything' });
		const messages = requests[0].messages as { role: string; content: string }[];
		expect(messages[0]).toEqual({ role: 'system', content: 'you look' });
	});

	it('records the spend against the vision task', async () => {
		const { tool } = withImages(1);
		await tool.execute({ question: 'anything' });
		const [row] = db.select().from(usageLog).all();
		expect(row.task).toBe('vision');
		expect(row.modelKey).toBe('mock/eyes');
		expect(row.status).toBe('ok');
	});

	it('records the spend when the call fails, and says why it failed', async () => {
		scripted = { throws: 'upstream timed out' };
		const { tool } = withImages(1);
		await expect(tool.execute({ question: 'anything' })).rejects.toThrow('upstream timed out');
		// A call that reached the provider and then died has still been paid for.
		const [row] = db.select().from(usageLog).all();
		expect(row.task).toBe('vision');
		expect(row.status).toBe('error');
	});

	it('never writes the chat id, so a hidden conversation stays unnamed', async () => {
		const { tool } = withImages(1, { hidden: true });
		await tool.execute({ question: 'anything' });
		const [row] = db.select().from(usageLog).all();
		expect(row.chatId).toBeNull();
		expect(row.costUsd === null || typeof row.costUsd === 'number').toBe(true);
	});
});

describe('choosing which image', () => {
	it('needs no id when the conversation holds one', async () => {
		const { tool } = withImages(1);
		await expect(tool.execute({ question: 'anything' })).resolves.toContain('shot-1.png');
	});

	it('names them rather than guessing when there are several', async () => {
		const { tool, ids } = withImages(2);
		await expect(tool.execute({ question: 'anything' })).rejects.toThrow(/shot-1\.png/);
		await expect(tool.execute({ question: 'anything', id: ids[1].id })).resolves.toContain(
			'shot-2.png'
		);
	});

	it('sends a document id back to read_attachment', async () => {
		const chat = createChat({ userId: USER, mode: 'chat', hidden: false });
		addAttachment(chat.id, { name: 'a.png', mime: 'image/png', data: PIXEL, kind: 'image' });
		const doc = addAttachment(chat.id, {
			name: 'notes.txt',
			mime: 'text/plain',
			data: Buffer.from('hello'),
			kind: 'document',
			text: 'hello'
		});
		const tool = view(visionTools(chat.id, USER));
		await expect(tool.execute({ question: 'anything', id: doc.id })).rejects.toThrow(
			'read_attachment'
		);
	});

	it('says so when nothing is attached at all', async () => {
		const chat = createChat({ userId: USER, mode: 'chat', hidden: false });
		const tool = view(visionTools(chat.id, USER));
		await expect(tool.execute({ question: 'anything' })).rejects.toThrow('No images are attached');
	});
});

describe('choosing which model', () => {
	it('falls back to an enabled model that can see, when the task is unset', async () => {
		configuredModelId = null;
		const { tool } = withImages(1);
		await tool.execute({ question: 'anything' });
		expect(requests[0].modelKey).toBe('mock/eyes');
	});

	it('refuses a configured model that cannot see, and says where to fix it', async () => {
		// Not silently falling back: an admin who pointed the task somewhere
		// deliberately is owed the reason it did not work.
		configuredModelId = BLIND.id;
		const { tool } = withImages(1);
		await expect(tool.execute({ question: 'anything' })).rejects.toThrow(
			/Prose cannot read images.*Admin/s
		);
	});

	it('refuses when no enabled model can see anything', async () => {
		configuredModelId = null;
		known = [BLIND];
		const { tool } = withImages(1);
		await expect(tool.execute({ question: 'anything' })).rejects.toThrow(/Admin → Models/);
		expect(db.select().from(usageLog).all()).toHaveLength(0);
	});
});

describe('what comes back', () => {
	it('trims an answer that will not stop', async () => {
		scripted = { text: 'x'.repeat(20_000) };
		const { tool } = withImages(1);
		const out = await tool.execute({ question: 'anything' });
		expect(out.length).toBeLessThan(9_000);
		expect(out).toContain('one part of the image at a time');
	});

	it('treats an empty reply as a failure rather than an answer', async () => {
		scripted = { text: '   ' };
		const { tool } = withImages(1);
		await expect(tool.execute({ question: 'anything' })).rejects.toThrow('returned nothing');
	});

	it('requires a question', async () => {
		const { tool } = withImages(1);
		await expect(tool.execute({ question: '  ' })).rejects.toThrow('question is required');
	});
});
