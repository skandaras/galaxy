import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { addAttachment, createChat } from '$lib/server/chats';
import { GET } from './+server';

/**
 * Serving an attachment's bytes — the route that makes a generated image
 * visible in a reply.
 *
 * Hidden chats are used throughout because they keep their attachments in
 * memory, which exercises the same handler without touching the uploads
 * directory. What matters here is who may read a file and how it is served,
 * neither of which cares where the bytes came from.
 */
const USER = { id: 'u1', username: 'u1', email: null, displayName: null, isAdmin: false };
const OTHER = { ...USER, id: 'u2', username: 'u2' };

beforeAll(() => {
	runMigrations();
});

let chatId: string;
beforeEach(() => {
	chatId = createChat({ userId: USER.id, hidden: true }).id;
});

function attach(name: string, mime: string, body: string, kind: 'image' | 'document' = 'image') {
	return addAttachment(chatId, { name, mime, data: Buffer.from(body), kind });
}

function callGet(attachmentId: string, user: typeof USER = USER, id = chatId) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return GET({ locals: { user }, params: { id, attachmentId } } as any) as Response;
}

/** The handler is synchronous, so SvelteKit's error() throws on the call itself. */
const status = (call: () => Response) => {
	try {
		return call().status;
	} catch (err) {
		return (err as { status?: number }).status;
	}
};

describe('GET an attachment', () => {
	it('serves the bytes with the stored type', async () => {
		const ref = attach('galaxy.png', 'image/png', 'not really a png');
		const res = callGet(ref.id);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(await res.text()).toBe('not really a png');
	});

	it('renders an image inline, which is what an <img> needs', async () => {
		const ref = attach('galaxy.png', 'image/png', 'x');
		const res = callGet(ref.id);
		expect(res.headers.get('content-disposition')).toContain('inline');
	});

	it('hands a document over as a download instead', async () => {
		const ref = attach('report.pdf', 'application/pdf', '%PDF-1.7', 'document');
		const res = callGet(ref.id);
		expect(res.headers.get('content-disposition')).toContain('attachment');
	});

	it('never lets the type be sniffed into something else', async () => {
		const ref = attach('galaxy.png', 'image/png', 'x');
		expect(callGet(ref.id).headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('makes SVG inert as a document, since a model wrote it', async () => {
		const ref = attach('chart.svg', 'image/svg+xml', '<svg></svg>');
		const csp = callGet(ref.id).headers.get('content-security-policy') ?? '';
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain('sandbox');
	});

	it('leaves a raster image without a policy it does not need', async () => {
		const ref = attach('galaxy.png', 'image/png', 'x');
		expect(callGet(ref.id).headers.get('content-security-policy')).toBeNull();
	});

	it("refuses another user's attachment", async () => {
		const ref = attach('galaxy.png', 'image/png', 'x');
		expect(status(() => callGet(ref.id, OTHER))).toBe(404);
	});

	it('refuses an attachment id from a different conversation', async () => {
		const ref = attach('galaxy.png', 'image/png', 'x');
		const elsewhere = createChat({ userId: USER.id, hidden: true }).id;
		expect(status(() => callGet(ref.id, USER, elsewhere))).toBe(404);
	});

	it('404s on an id that does not exist', async () => {
		expect(status(() => callGet('nope'))).toBe(404);
	});
});
