import { describe, expect, it } from 'vitest';
import { PresenceQueue, MIN_PRESENCE_MS } from './presence-queue';
import type { PresenceView, Presence } from './presence';
const view = (state: Presence): PresenceView => ({ state, calls: [] });

describe('presence queue', () => {
	it('holds a quick tool state long enough to be seen, then returns to idle', () => {
		const q = new PresenceQueue(view('tool'), 0);
		q.push(view('idle'), 50);
		q.advance(MIN_PRESENCE_MS - 1);
		expect(q.current.state).toBe('tool');
		q.advance(MIN_PRESENCE_MS);
		expect(q.current.state).toBe('idle');
	});
	it('discards expired history but keeps the current live state', () => {
		const q = new PresenceQueue(view('thinking'), 0);
		q.push(view('searching'), 20);
		q.push(view('tool'), 40);
		q.push(view('idle'), 60);
		q.advance(2200);
		expect(q.current.state).toBe('idle');
	});
	it('does not hold up a question or an error behind old work', () => {
		const q = new PresenceQueue(view('tool'), 0);
		q.push(view('searching'), 20);
		q.push(view('waiting'), 40);
		expect(q.current.state).toBe('waiting');
		q.advance(2000);
		expect(q.current.state).toBe('waiting');
		q.push(view('error'), 2010);
		expect(q.current.state).toBe('error');
	});
	it('updates call details without extending a state hold', () => {
		const q = new PresenceQueue(view('tool'), 0);
		q.push({ ...view('tool'), label: 'Second call' }, 1000);
		q.push(view('streaming'), 1100);
		q.advance(1200);
		expect(q.current.state).toBe('streaming');
	});
});
