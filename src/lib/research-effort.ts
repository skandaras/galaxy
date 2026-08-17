/**
 * How much of the admin's research ceiling one request is allowed to spend.
 *
 * Deliberately outside `$lib/server`: the composer's effort popover imports
 * these names too, and SvelteKit refuses to bundle `$lib/server/*` into client
 * code. Same reason `run-timeline.ts` sits here rather than under the engine.
 */

export const RESEARCH_EFFORTS = ['quick', 'balanced', 'exhaustive'] as const;
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

/** Fraction of the admin ceiling each level may spend. */
export const EFFORT_FRACTION: Record<ResearchEffort, number> = {
	quick: 1 / 3,
	balanced: 2 / 3,
	exhaustive: 1
};

/** What each level is called in the composer. */
export const EFFORT_LABEL: Record<ResearchEffort, string> = {
	quick: 'Quick',
	balanced: 'Balanced',
	exhaustive: 'Exhaustive'
};

/**
 * Never throws: absent or unknown reads as 'balanced'.
 *
 * A bad effort string is not worth a 400 — the run behind it is still a
 * perfectly valid research request, and refusing it would turn a typo in a
 * client into a failed question.
 */
export function resolveEffort(raw: unknown): ResearchEffort {
	const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	return (RESEARCH_EFFORTS as readonly string[]).includes(value)
		? (value as ResearchEffort)
		: 'balanced';
}
