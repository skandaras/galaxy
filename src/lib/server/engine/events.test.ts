import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { emitEvent, eventVisibleTo, subscribeEvents, type GalaxyEvent } from './events';

beforeAll(() => {
	runMigrations();
});

const owner = { id: 'owner', isAdmin: false };
const admin = { id: 'admin', isAdmin: true };
const stranger = { id: 'stranger', isAdmin: false };

function emitted(persist: boolean): GalaxyEvent {
	const seen: GalaxyEvent[] = [];
	const stop = subscribeEvents((e) => seen.push(e));
	emitEvent(
		{ userId: owner.id, chatId: 'c1', type: 'tool.call', name: 'web_search', status: 'ok', detail: { query: 'private' } },
		{ persist }
	);
	stop();
	return seen[0];
}

describe('who the live feed shows an event to', () => {
	it('shows a recorded event to its owner and to an admin', () => {
		const e = emitted(true);
		expect(eventVisibleTo(e, owner)).toBe(true);
		expect(eventVisibleTo(e, admin)).toBe(true);
		expect(eventVisibleTo(e, stranger)).toBe(false);
	});

	it("keeps a hidden chat's events to the person whose chat it is", () => {
		// An admin's feed carries everyone's events, and it used to carry these
		// as well: the one kind of chat that promises to leave nothing behind
		// was readable live, queries and tool arguments included.
		const e = emitted(false);
		expect(eventVisibleTo(e, owner)).toBe(true);
		expect(eventVisibleTo(e, admin)).toBe(false);
		expect(eventVisibleTo(e, stranger)).toBe(false);
	});
});
