import {
	direction,
	latestAssessments,
	listConstitutionVersions,
	listEntries,
	listSyntheses,
	neglectedPrinciples,
	type Assessment
} from '$lib/server/alignment';
import { activeDimensions } from '$lib/server/alignment-rubric';
import type { AssessmentBand } from '$lib/alignment-types';
import type { AssessmentScore } from '$lib/server/db/schema';

export interface DimensionStanding {
	id: string;
	name: string;
	tradition: string;
	weight: number;
	/** Mean across the window, or null when nothing has scored it. */
	mean: number | null;
	/** Mean of the most recent readings only — what the star's brightness shows. */
	recent: number | null;
	direction: 'rising' | 'steady' | 'falling' | 'unknown';
	count: number;
}

export interface AlignmentStanding {
	/** One plain sentence, from the newest reading. Never a number. */
	standing: string;
	band: AssessmentBand;
	confidence: 'low' | 'medium' | 'high';
	assessedAt: number | null;
	dimensions: DimensionStanding[];
	/** Distinct days written on in the last fortnight — cadence, not score. */
	streak: number;
	entries: number;
	assessments: number;
	neglected: { id: string; title: string }[];
	/**
	 * Where the constitution changed, as timestamps the chart can mark. A step
	 * at a boundary is the ruler moving, not the person, and without the marker
	 * that distinction is invisible.
	 */
	versionBoundaries: { id: string; at: number }[];
	latestSynthesis: { id: string; body: string; highlights: string[]; createdAt: number } | null;
	/** Bandura mechanisms seen across the window, commonest first. */
	disengagement: { mechanism: string; times: number }[];
	/** Set when recent entries read as brooding rather than reflecting. */
	rumination: boolean;
}

const STREAK_DAYS = 14;
const RECENT_WINDOW = 3;

/**
 * Everything the Standing view shows, derived rather than stored.
 *
 * Deliberately produces no overall number. There is a band, which is coarse and
 * worded, and per-dimension movement — but nothing that could be watched go up.
 * A single score would become the thing to optimise, and the first casualty
 * would be honest journal entries.
 */
export function alignmentStanding(userId: string, window = 12): AlignmentStanding {
	const assessments = latestAssessments(userId, window).filter((a) => !a.care);
	const newest: Assessment | undefined = assessments[0];
	const dimensions = activeDimensions(userId);

	const byDimension = new Map<string, { at: number; score: number }[]>();
	const mechanisms = new Map<string, number>();
	// Oldest first, so a trend reads in the direction time runs.
	for (const a of [...assessments].reverse()) {
		for (const s of (a.scores ?? []) as AssessmentScore[]) {
			const list = byDimension.get(s.dimensionId) ?? [];
			list.push({ at: a.createdAt.getTime(), score: s.score });
			byDimension.set(s.dimensionId, list);
		}
		for (const m of a.disengagement ?? []) {
			mechanisms.set(m, (mechanisms.get(m) ?? 0) + 1);
		}
	}

	const mean = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);

	const standings: DimensionStanding[] = dimensions.map((d) => {
		const scores = (byDimension.get(d.id) ?? []).map((s) => s.score);
		return {
			id: d.id,
			name: d.name,
			tradition: d.tradition,
			weight: d.weight,
			mean: mean(scores),
			recent: mean(scores.slice(-RECENT_WINDOW)),
			direction: direction(scores),
			count: scores.length
		};
	});

	const since = Date.now() - STREAK_DAYS * 86_400_000;
	const entries = listEntries(userId, 500);
	const days = new Set(
		entries
			.filter((e) => e.createdAt.getTime() >= since)
			.map((e) => new Date(e.createdAt).toISOString().slice(0, 10))
	);

	const synthesis = listSyntheses(userId, 1)[0];

	return {
		// The synthesis is the longer view, so it wins when it is the fresher of
		// the two; otherwise the newest reading speaks for itself.
		standing: newest?.standing ?? '',
		band: newest?.band ?? 'insufficient',
		confidence: newest?.confidence ?? 'low',
		assessedAt: newest ? newest.createdAt.getTime() : null,
		dimensions: standings,
		streak: days.size,
		entries: entries.length,
		assessments: assessments.length,
		neglected: neglectedPrinciples(userId).map((p) => ({ id: p.id, title: p.title })),
		versionBoundaries: listConstitutionVersions(userId).map((v) => ({
			id: v.id,
			at: v.createdAt.getTime()
		})),
		latestSynthesis: synthesis
			? {
					id: synthesis.id,
					body: synthesis.body,
					highlights: synthesis.highlights ?? [],
					createdAt: synthesis.createdAt.getTime()
				}
			: null,
		disengagement: [...mechanisms.entries()]
			.map(([mechanism, times]) => ({ mechanism, times }))
			.sort((a, b) => b.times - a.times),
		// Only when it is the pattern rather than one hard day.
		rumination: assessments.slice(0, RECENT_WINDOW).filter((a) => a.rumination).length >= 2
	};
}
