import { beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '$lib/server/chats';
import { POST } from './+server';

/**
 * Hidden chats live in memory, so these exercise the real handler without a
 * migrated database.
 */
const USER = { id: 'u1', username: 'u1', email: null, displayName: null, isAdmin: false };

let chatId: string;
beforeEach(() => {
	chatId = createChat({ userId: USER.id, hidden: true }).id;
});

/** Minimal RequestEvent — the handler only touches locals, params and request. */
function callPost(request: unknown, id = chatId) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return POST({ locals: { user: USER }, params: { id }, request } as any);
}

function multipart(file: File): Request {
	const form = new FormData();
	form.append('file', file);
	return new Request('http://localhost/upload', { method: 'POST', body: form });
}

/** A body that blows the adapter's BODY_SIZE_LIMIT rejects when it is read. */
function oversizedRequest(bytes: number): unknown {
	const err = Object.assign(
		new Error(`Content-length of ${bytes} exceeds limit of 524288 bytes.`),
		{ status: 413 }
	);
	return {
		headers: new Headers({ 'content-length': String(bytes) }),
		formData: () => Promise.reject(err)
	};
}

/** `error()` throws an HttpError; unwrap it to a plain status + message. */
async function statusOf(result: unknown) {
	try {
		await result;
		return { status: 200, message: '' };
	} catch (thrown) {
		const e = thrown as { status?: number; body?: { message?: string } };
		return { status: e.status ?? 500, message: e.body?.message ?? '' };
	}
}

describe('attachment upload route', () => {
	it('reports an over-limit body as 413 naming the size and the setting', async () => {
		// Regression: adapter-node enforces BODY_SIZE_LIMIT inside the body
		// stream, so this surfaces when formData() is read. Swallowing it made
		// every oversized upload look like a malformed form.
		const { status, message } = await statusOf(callPost(oversizedRequest(2_000_000)));
		expect(status).toBe(413);
		expect(message).toContain('BODY_SIZE_LIMIT');
		expect(message).toContain('1.9 MB');
		expect(message).not.toContain('file" field');
	});

	it('still detects a genuinely missing file field', async () => {
		const request = new Request('http://localhost/upload', {
			method: 'POST',
			body: new FormData()
		});
		const { status, message } = await statusOf(callPost(request));
		expect(status).toBe(400);
		expect(message).toContain('file');
	});

	it('accepts a document and reports the extracted length', async () => {
		const file = new File(['# Spec\n\nBuild it.'], 'spec.md', { type: 'text/markdown' });
		const res = (await callPost(multipart(file))) as Response;
		expect(res.status).toBe(201);
		await expect(res.json()).resolves.toMatchObject({
			name: 'spec.md',
			kind: 'document',
			textChars: 17
		});
	});

	it('rejects an unsupported type with a reason, not a 500', async () => {
		const file = new File(['x'], 'thing.bin', { type: 'application/octet-stream' });
		const { status, message } = await statusOf(callPost(multipart(file)));
		expect(status).toBe(415);
		expect(message).toMatch(/Unsupported file type/);
	});

	it("404s on someone else's chat", async () => {
		const { status } = await statusOf(callPost(multipart(new File(['x'], 'a.md')), 'nope'));
		expect(status).toBe(404);
	});
});
