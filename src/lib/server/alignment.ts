import { randomUUID, createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	alignmentAssessments,
	alignmentConstitutionVersions,
	alignmentEntries,
	alignmentPrincipleRevisions,
	alignmentPrincipleTensions,
	alignmentPrinciples,
	alignmentSyntheses,
	PRINCIPLE_KINDS,
	PRINCIPLE_STATUSES,
	type AssessmentScore,
	type AssessmentTension
} from '$lib/server/db/schema';
import type { PrincipleStats } from '$lib/alignment-types';

export type Principle = typeof alignmentPrinciples.$inferSelect;
export type PrincipleRevision = typeof alignmentPrincipleRevisions.$inferSelect;
export type PrincipleTension = typeof alignmentPrincipleTensions.$inferSelect;
export type AlignmentEntry = typeof alignmentEntries.$inferSelect;
export type Assessment = typeof alignmentAssessments.$inferSelect;
export type ConstitutionVersion = typeof alignmentConstitutionVersions.$inferSelect;

/**
 * Fields a person can actually set. Anything outside this list — ids, timestamps
 * — is ours, which is what stops a PATCH body reassigning a principle to someone
 * else by including a userId.
 */
export const EDITABLE_FIELDS = [
	'kind',
	'title',
	'statement',
	'body',
	'exemplar',
	'counterExemplar',
	'weight',
	'conviction',
	'origin',
	'status',
	'reviewAfter',
	'position'
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export class AlignmentError extends Error {}

const MAX_PRINCIPLES = 120;
const MAX_TITLE = 120;
const MAX_LINE = 2_000;
const MAX_BODY = 20_000;

const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// --- principles -------------------------------------------------------------

export function listPrinciples(userId: string, includeRetired = true): Principle[] {
	const rows = db
		.select()
		.from(alignmentPrinciples)
		.where(eq(alignmentPrinciples.userId, userId))
		.all();
	return rows
		.filter((p) => includeRetired || p.status !== 'retired')
		.sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
}

/** The part of the constitution an assessment is actually judged against. */
export function livePrinciples(userId: string): Principle[] {
	return listPrinciples(userId, false);
}

export function getPrinciple(id: string, userId: string): Principle | undefined {
	return db
		.select()
		.from(alignmentPrinciples)
		.where(and(eq(alignmentPrinciples.id, id), eq(alignmentPrinciples.userId, userId)))
		.get();
}

function normalisePrincipleInput(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (input.kind !== undefined) {
		const kind = String(input.kind);
		out.kind = (PRINCIPLE_KINDS as readonly string[]).includes(kind) ? kind : 'value';
	}
	if (input.status !== undefined) {
		const status = String(input.status);
		out.status = (PRINCIPLE_STATUSES as readonly string[]).includes(status) ? status : 'active';
	}
	if (input.title !== undefined) out.title = str(input.title, MAX_TITLE);
	if (input.statement !== undefined) out.statement = str(input.statement, MAX_LINE);
	if (input.body !== undefined) out.body = str(input.body, MAX_BODY);
	if (input.exemplar !== undefined) out.exemplar = str(input.exemplar, MAX_BODY);
	if (input.counterExemplar !== undefined)
		out.counterExemplar = str(input.counterExemplar, MAX_BODY);
	if (input.origin !== undefined) out.origin = str(input.origin, MAX_LINE);
	if (input.weight !== undefined) out.weight = clampInt(input.weight, 3, 1, 5);
	if (input.conviction !== undefined) out.conviction = clampInt(input.conviction, 3, 1, 5);
	if (input.position !== undefined) out.position = clampInt(input.position, 0, 0, 10_000);
	if (input.reviewAfter !== undefined) {
		const n = Number(input.reviewAfter);
		out.reviewAfter = Number.isFinite(n) && n > 0 ? new Date(n) : null;
	}
	return out;
}

const snapshotOf = (p: Principle) => ({
	kind: p.kind,
	title: p.title,
	statement: p.statement,
	body: p.body,
	exemplar: p.exemplar,
	counterExemplar: p.counterExemplar,
	weight: p.weight,
	conviction: p.conviction,
	origin: p.origin,
	status: p.status,
	reviewAfter: p.reviewAfter ? p.reviewAfter.getTime() : null,
	position: p.position
});

/**
 * Create or update a principle, always leaving a revision behind.
 *
 * History is written here rather than by the caller on purpose: a route that
 * forgets is a principle whose past is silently gone, and the past is most of
 * the point. A save that changes nothing writes no revision — otherwise opening
 * and closing the editor would litter the history with empty entries.
 */
export function savePrinciple(
	userId: string,
	input: Record<string, unknown>,
	note = ''
): { principle: Principle; revision: PrincipleRevision | null } {
	const now = new Date();
	const clean = normalisePrincipleInput(input);
	const existing = typeof input.id === 'string' ? getPrinciple(input.id, userId) : undefined;

	if (typeof input.id === 'string' && !existing) {
		throw new AlignmentError('Principle not found');
	}

	let principle: Principle;
	let changed: string[];

	if (existing) {
		changed = EDITABLE_FIELDS.filter((f) => {
			if (!(f in clean)) return false;
			const next = clean[f];
			const prev = existing[f];
			if (next instanceof Date || prev instanceof Date) {
				const nextMs = next instanceof Date ? next.getTime() : null;
				const prevMs = prev instanceof Date ? prev.getTime() : null;
				return nextMs !== prevMs;
			}
			return next !== prev;
		});
		if (!changed.length) return { principle: existing, revision: null };
		db.update(alignmentPrinciples)
			.set({ ...clean, updatedAt: now })
			.where(and(eq(alignmentPrinciples.id, existing.id), eq(alignmentPrinciples.userId, userId)))
			.run();
		principle = getPrinciple(existing.id, userId)!;
	} else {
		if (listPrinciples(userId).length >= MAX_PRINCIPLES) {
			throw new AlignmentError(
				`A constitution of more than ${MAX_PRINCIPLES} entries is a filing system, not a character`
			);
		}
		const title = str(clean.title, MAX_TITLE);
		if (!title) throw new AlignmentError('A principle needs a title');
		const id = randomUUID();
		db.insert(alignmentPrinciples)
			.values({
				id,
				userId,
				kind: (clean.kind as Principle['kind']) ?? 'value',
				title,
				statement: (clean.statement as string) ?? '',
				body: (clean.body as string) ?? '',
				exemplar: (clean.exemplar as string) ?? '',
				counterExemplar: (clean.counterExemplar as string) ?? '',
				weight: (clean.weight as number) ?? 3,
				conviction: (clean.conviction as number) ?? 3,
				origin: (clean.origin as string) ?? '',
				status: (clean.status as Principle['status']) ?? 'active',
				reviewAfter: (clean.reviewAfter as Date | null) ?? null,
				position: (clean.position as number) ?? listPrinciples(userId).length,
				createdAt: now,
				updatedAt: now
			})
			.run();
		principle = getPrinciple(id, userId)!;
		changed = ['created'];
	}

	const revision: PrincipleRevision = {
		id: randomUUID(),
		principleId: principle.id,
		userId,
		snapshot: snapshotOf(principle),
		changedFields: changed,
		note: str(note, MAX_LINE),
		createdAt: now
	};
	db.insert(alignmentPrincipleRevisions).values(revision).run();
	return { principle, revision };
}

/**
 * Retiring is the normal way to stop holding something, and it keeps the
 * principle readable — "what I used to believe" is arguably the most valuable
 * thing this feature accumulates. Deleting is still offered, because a typo
 * should not become part of a permanent record, but it takes the revisions and
 * the tensions with it.
 */
export function retirePrinciple(id: string, userId: string): Principle | null {
	const existing = getPrinciple(id, userId);
	if (!existing) return null;
	return savePrinciple(userId, { id, status: 'retired' }, 'Retired').principle;
}

export function deletePrinciple(id: string, userId: string): boolean {
	const existing = getPrinciple(id, userId);
	if (!existing) return false;
	db.delete(alignmentPrincipleRevisions)
		.where(
			and(
				eq(alignmentPrincipleRevisions.principleId, id),
				eq(alignmentPrincipleRevisions.userId, userId)
			)
		)
		.run();
	for (const t of listTensions(userId)) {
		if (t.aId === id || t.bId === id) deleteTension(t.id, userId);
	}
	db.delete(alignmentPrinciples)
		.where(and(eq(alignmentPrinciples.id, id), eq(alignmentPrinciples.userId, userId)))
		.run();
	return true;
}

export function listRevisions(principleId: string, userId: string): PrincipleRevision[] {
	return db
		.select()
		.from(alignmentPrincipleRevisions)
		.where(
			and(
				eq(alignmentPrincipleRevisions.principleId, principleId),
				eq(alignmentPrincipleRevisions.userId, userId)
			)
		)
		.orderBy(desc(alignmentPrincipleRevisions.createdAt))
		.all();
}

// --- declared tensions ------------------------------------------------------

export function listTensions(userId: string): PrincipleTension[] {
	return db
		.select()
		.from(alignmentPrincipleTensions)
		.where(eq(alignmentPrincipleTensions.userId, userId))
		.all();
}

/**
 * Declare that two principles pull against each other.
 *
 * Stored with aId < bId so the same pair entered in the other order is the same
 * row rather than a second one — otherwise the tension map slowly fills with
 * duplicates that look like distinct conflicts.
 */
export function saveTension(userId: string, aId: string, bId: string, note = ''): PrincipleTension {
	if (aId === bId) throw new AlignmentError('A principle cannot be in tension with itself');
	if (!getPrinciple(aId, userId) || !getPrinciple(bId, userId)) {
		throw new AlignmentError('Both principles must be yours');
	}
	const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
	const cleanNote = str(note, MAX_LINE);
	const existing = listTensions(userId).find((t) => t.aId === lo && t.bId === hi);
	if (existing) {
		db.update(alignmentPrincipleTensions)
			.set({ note: cleanNote })
			.where(eq(alignmentPrincipleTensions.id, existing.id))
			.run();
		return { ...existing, note: cleanNote };
	}
	const row: PrincipleTension = {
		id: randomUUID(),
		userId,
		aId: lo,
		bId: hi,
		note: cleanNote,
		createdAt: new Date()
	};
	db.insert(alignmentPrincipleTensions).values(row).run();
	return row;
}

export function deleteTension(id: string, userId: string): boolean {
	return (
		db
			.delete(alignmentPrincipleTensions)
			.where(
				and(eq(alignmentPrincipleTensions.id, id), eq(alignmentPrincipleTensions.userId, userId))
			)
			.run().changes > 0
	);
}

// --- constitution versions --------------------------------------------------

/**
 * A hash of everything the agent is actually shown.
 *
 * Only the fields that reach the prompt count, so reordering the list or fixing
 * a typo in `origin` does not create a version boundary that the trend chart
 * then has to explain.
 */
export function constitutionFingerprint(principles: Principle[]): string {
	const material = principles
		.map((p) =>
			[
				p.id,
				p.kind,
				p.title,
				p.statement,
				p.exemplar,
				p.counterExemplar,
				p.weight,
				p.conviction
			].join(' ')
		)
		.sort()
		.join('');
	return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function latestConstitutionVersion(userId: string): ConstitutionVersion | undefined {
	return db
		.select()
		.from(alignmentConstitutionVersions)
		.where(eq(alignmentConstitutionVersions.userId, userId))
		.orderBy(desc(alignmentConstitutionVersions.createdAt))
		.limit(1)
		.get();
}

export function listConstitutionVersions(userId: string): ConstitutionVersion[] {
	return db
		.select()
		.from(alignmentConstitutionVersions)
		.where(eq(alignmentConstitutionVersions.userId, userId))
		.orderBy(desc(alignmentConstitutionVersions.createdAt))
		.all();
}

/**
 * The version an assessment should be anchored to, writing a new one only when
 * the constitution has actually changed since the last.
 *
 * Called at assessment time rather than on edit, so editing costs nothing until
 * it next matters, and a run of edits collapses into a single boundary.
 */
export function currentConstitutionVersion(userId: string): ConstitutionVersion {
	const principles = livePrinciples(userId);
	const fingerprint = constitutionFingerprint(principles);
	const latest = latestConstitutionVersion(userId);
	if (latest?.fingerprint === fingerprint) return latest;
	const row: ConstitutionVersion = {
		id: randomUUID(),
		userId,
		fingerprint,
		snapshot: principles.map(snapshotOf),
		createdAt: new Date()
	};
	db.insert(alignmentConstitutionVersions).values(row).run();
	return row;
}

// --- entries ----------------------------------------------------------------

export const entryHash = (body: string) =>
	createHash('sha256').update(body).digest('hex').slice(0, 32);

export function listEntries(userId: string, limit = 200): AlignmentEntry[] {
	return db
		.select()
		.from(alignmentEntries)
		.where(eq(alignmentEntries.userId, userId))
		.orderBy(desc(alignmentEntries.createdAt))
		.limit(limit)
		.all();
}

export function getEntry(id: string, userId: string): AlignmentEntry | undefined {
	return db
		.select()
		.from(alignmentEntries)
		.where(and(eq(alignmentEntries.id, id), eq(alignmentEntries.userId, userId)))
		.get();
}

export function saveEntry(userId: string, input: Record<string, unknown>): AlignmentEntry {
	const now = new Date();
	const existing = typeof input.id === 'string' ? getEntry(input.id, userId) : undefined;
	if (typeof input.id === 'string' && !existing) throw new AlignmentError('Entry not found');

	const patch: Record<string, unknown> = { updatedAt: now };
	if (input.title !== undefined) patch.title = str(input.title, MAX_TITLE);
	if (input.body !== undefined) patch.body = str(input.body, 200_000);
	if (input.tags !== undefined) patch.tags = str(input.tags, MAX_LINE);
	if (input.skipAssessment !== undefined) patch.skipAssessment = input.skipAssessment === true;
	if (input.mood !== undefined) {
		patch.mood = input.mood === null ? null : clampInt(input.mood, 3, 1, 5);
	}

	if (existing) {
		db.update(alignmentEntries)
			.set(patch)
			.where(and(eq(alignmentEntries.id, existing.id), eq(alignmentEntries.userId, userId)))
			.run();
		return getEntry(existing.id, userId)!;
	}

	const body = (patch.body as string) ?? '';
	if (!body) throw new AlignmentError('An entry needs something in it');
	const id = randomUUID();
	db.insert(alignmentEntries)
		.values({
			id,
			userId,
			title: (patch.title as string) ?? '',
			body,
			mood: (patch.mood as number | null) ?? null,
			tags: (patch.tags as string) ?? '',
			skipAssessment: (patch.skipAssessment as boolean) ?? false,
			createdAt: now,
			updatedAt: now
		})
		.run();
	return getEntry(id, userId)!;
}

export function deleteEntry(id: string, userId: string): boolean {
	const existing = getEntry(id, userId);
	if (!existing) return false;
	db.delete(alignmentAssessments)
		.where(and(eq(alignmentAssessments.entryId, id), eq(alignmentAssessments.userId, userId)))
		.run();
	db.delete(alignmentEntries)
		.where(and(eq(alignmentEntries.id, id), eq(alignmentEntries.userId, userId)))
		.run();
	return true;
}

// --- assessments ------------------------------------------------------------

export function listAssessments(userId: string, limit = 50): Assessment[] {
	return db
		.select()
		.from(alignmentAssessments)
		.where(eq(alignmentAssessments.userId, userId))
		.orderBy(desc(alignmentAssessments.createdAt))
		.limit(limit)
		.all();
}

export function assessmentsForEntry(entryId: string, userId: string): Assessment[] {
	return db
		.select()
		.from(alignmentAssessments)
		.where(and(eq(alignmentAssessments.entryId, entryId), eq(alignmentAssessments.userId, userId)))
		.orderBy(desc(alignmentAssessments.createdAt))
		.all();
}

/**
 * Newest assessment per entry, which is what both the journal and the trend
 * want: re-assessing after a constitution edit adds a row rather than replacing
 * one, and counting both would let a single entry vote twice.
 */
export function latestAssessments(userId: string, limit = 12): Assessment[] {
	const seen = new Set<string>();
	const out: Assessment[] = [];
	for (const a of listAssessments(userId, 200)) {
		if (seen.has(a.entryId)) continue;
		seen.add(a.entryId);
		out.push(a);
		if (out.length >= limit) break;
	}
	return out;
}

// --- a principle's track record ---------------------------------------------

const citesPrinciple = (a: Assessment, principleId: string) =>
	((a.scores ?? []) as AssessmentScore[]).some((s) => s.principles?.includes(principleId)) ||
	(a.gaps ?? []).some((g) => g.principle === principleId) ||
	((a.tensions ?? []) as AssessmentTension[]).some((t) => t.between?.includes(principleId));

/**
 * How much a principle has actually been in play.
 *
 * Shown in the editor *before* anything is changed, and that placement is the
 * point of the whole function: rewording a value you have been failing for three
 * months is a different act from rewording one that has never come up, and
 * without this you cannot tell which one you are doing.
 */
export function principleStats(userId: string, principleId: string, window = 20): PrincipleStats {
	const recent = latestAssessments(userId, window);
	const scores: { at: number; score: number }[] = [];
	let lastCitedAt: number | null = null;
	const lostTo = new Map<string, number>();
	const wonOver = new Map<string, number>();
	let cited = 0;

	for (const a of recent) {
		for (const s of (a.scores ?? []) as AssessmentScore[]) {
			if (s.principles?.includes(principleId)) scores.push({ at: a.createdAt.getTime(), score: s.score });
		}
		for (const t of (a.tensions ?? []) as AssessmentTension[]) {
			if (!t.between?.includes(principleId)) continue;
			const other = t.between.find((p) => p !== principleId);
			if (!other) continue;
			const bucket = t.chose === principleId ? wonOver : lostTo;
			bucket.set(other, (bucket.get(other) ?? 0) + 1);
		}
		if (citesPrinciple(a, principleId)) {
			cited++;
			lastCitedAt = Math.max(lastCitedAt ?? 0, a.createdAt.getTime());
		}
	}

	const ordered = scores.sort((a, b) => a.at - b.at).map((s) => s.score);
	const meanScore = ordered.length
		? ordered.reduce((n, x) => n + x, 0) / ordered.length
		: null;

	const asList = (m: Map<string, number>) =>
		[...m.entries()]
			.map(([id, times]) => ({ principleId: id, times }))
			.sort((a, b) => b.times - a.times);

	return {
		cited,
		ofAssessments: recent.length,
		lastCitedAt,
		meanScore,
		direction: direction(ordered),
		lostTo: asList(lostTo),
		wonOver: asList(wonOver)
	};
}

/**
 * Latest three against the three before them.
 *
 * Six data points is not statistics and this does not pretend to be — it is the
 * smallest window that distinguishes a bad week from a direction of travel, and
 * anything longer stops responding to change at all.
 */
export function direction(scores: number[]): PrincipleStats['direction'] {
	if (scores.length < 4) return 'unknown';
	const recent = scores.slice(-3);
	const prior = scores.slice(-6, -3);
	if (!prior.length) return 'unknown';
	const avg = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
	const delta = avg(recent) - avg(prior);
	if (delta > 0.4) return 'rising';
	if (delta < -0.4) return 'falling';
	return 'steady';
}

/**
 * Principles nothing has cited lately — the "is this still yours?" list.
 *
 * Restricted to principles older than the window: something written last week
 * has not been neglected, it has simply not come up yet, and listing it would
 * teach people to ignore the list.
 */
export function neglectedPrinciples(userId: string, days = 90): Principle[] {
	const cutoff = Date.now() - days * 86_400_000;
	const live = livePrinciples(userId);
	const recent = listAssessments(userId, 200).filter((a) => a.createdAt.getTime() >= cutoff);
	if (!recent.length) return [];
	return live.filter(
		(p) => p.createdAt.getTime() < cutoff && !recent.some((a) => citesPrinciple(a, p.id))
	);
}

// --- syntheses --------------------------------------------------------------

export function listSyntheses(userId: string, limit = 10) {
	return db
		.select()
		.from(alignmentSyntheses)
		.where(eq(alignmentSyntheses.userId, userId))
		.orderBy(desc(alignmentSyntheses.createdAt))
		.limit(limit)
		.all();
}

// --- wholesale removal ------------------------------------------------------

/**
 * Erase everything. Offered because a journal nobody can delete is a journal
 * with a different risk profile from the one people think they are keeping.
 */
export function deleteAllAlignmentData(userId: string): Record<string, number> {
	return {
		assessments: db
			.delete(alignmentAssessments)
			.where(eq(alignmentAssessments.userId, userId))
			.run().changes,
		entries: db.delete(alignmentEntries).where(eq(alignmentEntries.userId, userId)).run().changes,
		revisions: db
			.delete(alignmentPrincipleRevisions)
			.where(eq(alignmentPrincipleRevisions.userId, userId))
			.run().changes,
		tensions: db
			.delete(alignmentPrincipleTensions)
			.where(eq(alignmentPrincipleTensions.userId, userId))
			.run().changes,
		principles: db
			.delete(alignmentPrinciples)
			.where(eq(alignmentPrinciples.userId, userId))
			.run().changes,
		versions: db
			.delete(alignmentConstitutionVersions)
			.where(eq(alignmentConstitutionVersions.userId, userId))
			.run().changes,
		syntheses: db
			.delete(alignmentSyntheses)
			.where(eq(alignmentSyntheses.userId, userId))
			.run().changes
	};
}
