import { describe, it, expect } from 'vitest';
import { periodStart } from './budget';

describe('periodStart', () => {
	// Wed 2026-07-22 15:30 local
	const now = new Date(2026, 6, 22, 15, 30);

	it('day → local midnight today', () => {
		expect(periodStart('day', now)).toEqual(new Date(2026, 6, 22));
	});

	it('week → Monday of the current ISO week', () => {
		expect(periodStart('week', now)).toEqual(new Date(2026, 6, 20));
		// A Sunday still belongs to the week started the previous Monday
		expect(periodStart('week', new Date(2026, 6, 26, 9, 0))).toEqual(new Date(2026, 6, 20));
		// A Monday starts its own week
		expect(periodStart('week', new Date(2026, 6, 20, 0, 5))).toEqual(new Date(2026, 6, 20));
	});

	it('month → the 1st', () => {
		expect(periodStart('month', now)).toEqual(new Date(2026, 6, 1));
	});
});
