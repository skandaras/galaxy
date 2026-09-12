import { beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events } from '$lib/server/db/schema';
import { CLIENT_ERROR_LIMIT, recordClientError } from './client-errors';

const latest = (userId: string) =>
	db.select().from(events).where(eq(events.userId, userId)).orderBy(desc(events.ts)).all();

beforeAll(runMigrations);

describe('recordClientError', () => {
	it('records a crash as an event the Observatory can draw', () => {
		expect(
			recordClientError('u-record', { name: 'TypeError: x', stack: 'at y', pathname: '/chat' })
		).toBe(true);
		const [row] = latest('u-record');
		expect(row.type).toBe('client');
		expect(row.status).toBe('error');
		expect(row.name).toBe('TypeError: x');
	});

	it('never carries a chat id, whatever the browser sent', () => {
		// A hidden chat is memory-only by design and its id must not survive in
		// `events`. A crash report carrying no chat identity at all is the whole
		// of that guarantee, so a client that sends one is ignored rather than
		// trusted.
		recordClientError('u-privacy', {
			name: 'boom',
			stack: 'at y',
			pathname: '/chat',
			chatId: 'hidden-1',
			userId: 'someone-else'
		});
		const [row] = latest('u-privacy');
		expect(row.chatId).toBe(null);
		expect(row.userId).toBe('u-privacy');
		expect(JSON.stringify(row.detail)).not.toContain('hidden-1');
	});

	it('refuses a report with nothing to say', () => {
		expect(recordClientError('u-empty', {})).toBe(false);
		expect(recordClientError('u-empty', null)).toBe(false);
		expect(recordClientError('u-empty', { name: 42 })).toBe(false);
		expect(latest('u-empty')).toHaveLength(0);
	});

	it('stops a looping page from writing a row per frame', () => {
		// The failure this exists for throws on every flush, which on a phone is
		// several times a second for as long as the app is open.
		for (let i = 0; i < CLIENT_ERROR_LIMIT.MAX_PER_WINDOW + 20; i++) {
			recordClientError('u-flood', { name: `boom ${i}` }, 1000);
		}
		expect(latest('u-flood')).toHaveLength(CLIENT_ERROR_LIMIT.MAX_PER_WINDOW);
	});

	it('opens again once the window has passed', () => {
		for (let i = 0; i < CLIENT_ERROR_LIMIT.MAX_PER_WINDOW; i++) {
			recordClientError('u-window', { name: 'boom' }, 1000);
		}
		expect(recordClientError('u-window', { name: 'boom' }, 1000)).toBe(false);
		expect(
			recordClientError('u-window', { name: 'boom' }, 1000 + CLIENT_ERROR_LIMIT.WINDOW_MS + 1)
		).toBe(true);
	});

	it('truncates rather than letting a browser choose the row size', () => {
		recordClientError('u-long', { name: 'x'.repeat(9000), stack: 'y'.repeat(99_000) });
		const [row] = latest('u-long');
		expect(row.name.length).toBe(300);
		expect((row.detail as { stack: string }).stack.length).toBe(4000);
	});
});
