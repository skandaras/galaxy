import type { PresenceView } from './presence';

export const MIN_PRESENCE_MS = 1200;
export const PRESENCE_TTL_MS = 2000;
export interface OrbView extends PresenceView { detail?: string }

/** Keep brief calls visible without replaying work that has already gone stale. */
export class PresenceQueue {
	current: OrbView;
	private since: number;
	private pending: { view: OrbView; at: number }[] = [];
	constructor(initial: OrbView, now: number) {
		this.current = initial;
		this.since = now;
	}
	push(view: OrbView, now: number) {
		const last = this.pending.at(-1)?.view ?? this.current;
		const key = (v: OrbView) => `${v.state}:${v.calls.map((c) => c.kind).join(',')}`;
		if (key(last) === key(view)) {
			if (this.pending.length) this.pending[this.pending.length - 1].view = view;
			else this.current = view;
		} else if (view.state === 'waiting' || view.state === 'error') {
			// A question or failure needs attention now, even during a held tool pose.
			this.pending = [];
			this.current = view;
			this.since = now;
		} else {
			this.pending.push({ view, at: now });
			this.advance(now);
		}
	}
	advance(now: number) {
		if (now - this.since < MIN_PRESENCE_MS) return;
		// Keep the newest state even when there were no more events: it is
		// still the live state, whereas earlier entries describe past work.
		while (this.pending.length > 1 && now - this.pending[0].at >= PRESENCE_TTL_MS) {
			this.pending.shift();
		}
		const next = this.pending.shift();
		if (next) {
			this.current = next.view;
			this.since = now;
		}
	}
}
