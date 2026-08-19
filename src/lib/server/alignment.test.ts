import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	alignmentAssessments,
	alignmentConstitutionVersions,
	alignmentEntries,
	alignmentPrincipleRevisions,
	alignmentPrincipleTensions,
	alignmentPrinciples,
	alignmentSyntheses,
	type AssessmentScore,
	type AssessmentTension,
	type AssessmentGap
} from '$lib/server/db/schema';
import {
	AlignmentError,
	constitutionFingerprint,
	currentConstitutionVersion,
	deleteAllAlignmentData,
	deleteEntry,
	deletePrinciple,
	direction,
	entryHash,
	getPrinciple,
	listConstitutionVersions,
	listEntries,
	listPrinciples,
	listRevisions,
	listTensions,
	livePrinciples,
	neglectedPrinciples,
	principleStats,
	retirePrinciple,
	saveEntry,
	savePrinciple,
	saveTension,
	latestAssessments
} from './alignment';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(alignmentAssessments).run();
	db.delete(alignmentEntries).run();
	db.delete(alignmentPrincipleRevisions).run();
	db.delete(alignmentPrincipleTensions).run();
	db.delete(alignmentPrinciples).run();
	db.delete(alignmentConstitutionVersions).run();
	db.delete(alignmentSyntheses).run();
});

const principle = (title: string, extra: Record<string, unknown> = {}, userId = ALICE) =>
	savePrinciple(userId, { title, statement: `${title} matters`, ...extra }).principle;

/** An assessment row, written directly: the agent is not under test here. */
function assess(
	userId: string,
	opts: {
		entryId?: string;
		at?: number;
		scores?: AssessmentScore[];
		tensions?: AssessmentTension[];
		gaps?: AssessmentGap[];
	} = {}
) {
	const id = randomUUID();
	db.insert(alignmentAssessments)
		.values({
			id,
			userId,
			entryId: opts.entryId ?? randomUUID(),
			constitutionVersionId: 'v1',
			rubricVersion: 1,
			entryHash: 'hash',
			band: 'mixed',
			standing: 'standing',
			summary: '',
			confidence: 'medium',
			scores: opts.scores ?? [],
			tensions: opts.tensions ?? [],
			gaps: opts.gaps ?? [],
			disengagement: [],
			rumination: false,
			care: false,
			nextStep: '',
			question: '',
			modelKey: 'test',
			createdAt: new Date(opts.at ?? Date.now())
		})
		.run();
	return id;
}

/** Backdate a principle, so "has this been neglected" has a past to look at. */
const age = (id: string, byMs: number) =>
	db
		.update(alignmentPrinciples)
		.set({ createdAt: new Date(Date.now() - byMs) })
		.where(eq(alignmentPrinciples.id, id))
		.run();

const score = (dimensionId: string, value: number, principles: string[]): AssessmentScore => ({
	dimensionId,
	score: value,
	evidence: 'quoted',
	principles,
	note: ''
});

describe('principles', () => {
	it('creates with sane defaults and records the creation as a revision', () => {
		const p = principle('Honesty');
		expect(p.kind).toBe('value');
		expect(p.status).toBe('active');
		expect(p.weight).toBe(3);
		expect(p.conviction).toBe(3);

		const revisions = listRevisions(p.id, ALICE);
		expect(revisions).toHaveLength(1);
		expect(revisions[0].changedFields).toEqual(['created']);
	});

	it('refuses a principle with no title', () => {
		expect(() => savePrinciple(ALICE, { statement: 'no title' })).toThrow(AlignmentError);
	});

	it('clamps weight and conviction into 1-5', () => {
		const p = principle('Courage', { weight: 99, conviction: -4 });
		expect(p.weight).toBe(5);
		expect(p.conviction).toBe(1);
	});

	it('ignores an unknown kind rather than storing it', () => {
		expect(principle('Odd', { kind: 'vibes' }).kind).toBe('value');
	});

	it('writes a revision naming exactly the fields that changed', () => {
		const p = principle('Presence');
		savePrinciple(ALICE, { id: p.id, statement: 'reworded', weight: 5 }, 'it was too vague');

		const revisions = listRevisions(p.id, ALICE);
		expect(revisions).toHaveLength(2);
		// Newest first.
		expect(revisions[0].changedFields).toEqual(['statement', 'weight']);
		expect(revisions[0].note).toBe('it was too vague');
		expect((revisions[0].snapshot as { statement: string }).statement).toBe('reworded');
	});

	it('writes no revision when a save changes nothing', () => {
		const p = principle('Patience');
		const { revision } = savePrinciple(ALICE, { id: p.id, title: 'Patience' });
		expect(revision).toBeNull();
		expect(listRevisions(p.id, ALICE)).toHaveLength(1);
	});

	it('retires without erasing, and keeps it out of the live constitution', () => {
		const p = principle('Ambition');
		retirePrinciple(p.id, ALICE);

		expect(getPrinciple(p.id, ALICE)?.status).toBe('retired');
		expect(listPrinciples(ALICE).map((x) => x.id)).toContain(p.id);
		expect(livePrinciples(ALICE).map((x) => x.id)).not.toContain(p.id);
	});

	it('keeps provisional principles live — they are being tried on, not shelved', () => {
		const p = principle('Stillness', { status: 'provisional' });
		expect(livePrinciples(ALICE).map((x) => x.id)).toContain(p.id);
	});

	it('hard delete takes the revisions and tensions with it', () => {
		const a = principle('Craft');
		const b = principle('Speed');
		saveTension(ALICE, a.id, b.id, 'usually craft');
		savePrinciple(ALICE, { id: a.id, statement: 'changed' });

		expect(deletePrinciple(a.id, ALICE)).toBe(true);
		expect(getPrinciple(a.id, ALICE)).toBeUndefined();
		expect(listRevisions(a.id, ALICE)).toEqual([]);
		expect(listTensions(ALICE)).toEqual([]);
	});

	it('keeps one person out of another\'s constitution', () => {
		const mine = principle('Mine');
		principle('Theirs', {}, BOB);

		expect(listPrinciples(ALICE).map((p) => p.title)).toEqual(['Mine']);
		expect(getPrinciple(mine.id, BOB)).toBeUndefined();
		expect(() => savePrinciple(BOB, { id: mine.id, title: 'stolen' })).toThrow(AlignmentError);
	});
});

describe('declared tensions', () => {
	it('stores a pair once, whichever order it arrives in', () => {
		const a = principle('Ambition');
		const b = principle('Presence');
		saveTension(ALICE, a.id, b.id, 'first');
		saveTension(ALICE, b.id, a.id, 'second');

		const tensions = listTensions(ALICE);
		expect(tensions).toHaveLength(1);
		expect(tensions[0].note).toBe('second');
		expect(tensions[0].aId < tensions[0].bId).toBe(true);
	});

	it('refuses a principle in tension with itself', () => {
		const a = principle('Honesty');
		expect(() => saveTension(ALICE, a.id, a.id)).toThrow(AlignmentError);
	});

	it('refuses a pair that is not entirely yours', () => {
		const mine = principle('Mine');
		const theirs = principle('Theirs', {}, BOB);
		expect(() => saveTension(ALICE, mine.id, theirs.id)).toThrow(AlignmentError);
	});
});

describe('constitution versions', () => {
	it('reuses the current version until something the agent sees changes', () => {
		const p = principle('Honesty');
		const first = currentConstitutionVersion(ALICE);
		expect(currentConstitutionVersion(ALICE).id).toBe(first.id);

		savePrinciple(ALICE, { id: p.id, statement: 'reworded' });
		const second = currentConstitutionVersion(ALICE);
		expect(second.id).not.toBe(first.id);
		expect(listConstitutionVersions(ALICE)).toHaveLength(2);
	});

	it('does not cut a new version for a change the agent never sees', () => {
		const p = principle('Honesty');
		const first = currentConstitutionVersion(ALICE);
		// `origin` and `position` are not part of the prompt, so the ruler has not
		// moved and the trend chart should not gain a boundary.
		savePrinciple(ALICE, { id: p.id, origin: 'a book I read', position: 4 });
		expect(currentConstitutionVersion(ALICE).id).toBe(first.id);
	});

	it('changes fingerprint when a principle is retired', () => {
		const p = principle('Honesty');
		const before = constitutionFingerprint(livePrinciples(ALICE));
		retirePrinciple(p.id, ALICE);
		expect(constitutionFingerprint(livePrinciples(ALICE))).not.toBe(before);
	});

	it('is order-independent', () => {
		const a = principle('A');
		const b = principle('B');
		const before = constitutionFingerprint([a, b]);
		expect(constitutionFingerprint([b, a])).toBe(before);
	});
});

describe('entries', () => {
	it('refuses an empty entry but allows an untitled one', () => {
		expect(() => saveEntry(ALICE, { body: '   ' })).toThrow(AlignmentError);
		expect(saveEntry(ALICE, { body: 'something' }).title).toBe('');
	});

	it('clamps mood and keeps null meaning "did not say"', () => {
		expect(saveEntry(ALICE, { body: 'a', mood: 44 }).mood).toBe(5);
		expect(saveEntry(ALICE, { body: 'b', mood: null }).mood).toBeNull();
	});

	it('changes hash when the body is edited, which is what makes a reading stale', () => {
		const e = saveEntry(ALICE, { body: 'first version' });
		const before = entryHash(e.body);
		const after = saveEntry(ALICE, { id: e.id, body: 'second version' });
		expect(entryHash(after.body)).not.toBe(before);
	});

	it('deleting an entry takes its assessments with it', () => {
		const e = saveEntry(ALICE, { body: 'a day' });
		assess(ALICE, { entryId: e.id });
		expect(deleteEntry(e.id, ALICE)).toBe(true);
		expect(latestAssessments(ALICE)).toEqual([]);
	});

	it('keeps entries private to their author', () => {
		saveEntry(ALICE, { body: 'mine' });
		expect(listEntries(BOB)).toEqual([]);
	});
});

describe('latestAssessments', () => {
	it('counts each entry once, taking the newest reading of it', () => {
		const e = saveEntry(ALICE, { body: 'reassessed twice' });
		assess(ALICE, { entryId: e.id, at: 1_000 });
		const newest = assess(ALICE, { entryId: e.id, at: 2_000 });

		const latest = latestAssessments(ALICE);
		expect(latest).toHaveLength(1);
		expect(latest[0].id).toBe(newest);
	});
});

describe('direction', () => {
	it('needs enough points before it will claim anything', () => {
		expect(direction([])).toBe('unknown');
		expect(direction([4, 4, 4])).toBe('unknown');
	});

	it('reads the last three against the three before', () => {
		expect(direction([2, 2, 2, 4, 4, 4])).toBe('rising');
		expect(direction([5, 5, 5, 2, 2, 2])).toBe('falling');
		expect(direction([3, 3, 3, 3, 3, 3])).toBe('steady');
	});

	it('calls a small wobble steady rather than a trend', () => {
		expect(direction([3, 3, 3, 3, 3, 3.2])).toBe('steady');
	});
});

describe('principleStats', () => {
	it('counts an assessment once however many times it cites the principle', () => {
		const p = principle('Honesty');
		assess(ALICE, {
			at: 1_000,
			scores: [score('authenticity', 4, [p.id]), score('rationalisation', 2, [p.id])]
		});

		const stats = principleStats(ALICE, p.id);
		expect(stats.cited).toBe(1);
		expect(stats.ofAssessments).toBe(1);
		expect(stats.meanScore).toBe(3);
	});

	it('counts a gap or a tension as a citation even with no score', () => {
		const a = principle('Ambition');
		const b = principle('Presence');
		assess(ALICE, { at: 1_000, gaps: [{ principle: a.id, observation: 'x', evidence: 'y' }] });
		assess(ALICE, {
			at: 2_000,
			tensions: [{ between: [a.id, b.id], chose: a.id, note: '', declared: true }]
		});

		expect(principleStats(ALICE, a.id).cited).toBe(2);
		expect(principleStats(ALICE, b.id).cited).toBe(1);
	});

	it('records which principle won and which lost a trade-off', () => {
		const a = principle('Ambition');
		const b = principle('Presence');
		for (const at of [1_000, 2_000]) {
			assess(ALICE, {
				at,
				tensions: [{ between: [a.id, b.id], chose: a.id, note: '', declared: true }]
			});
		}

		expect(principleStats(ALICE, b.id).lostTo).toEqual([{ principleId: a.id, times: 2 }]);
		expect(principleStats(ALICE, a.id).wonOver).toEqual([{ principleId: b.id, times: 2 }]);
	});

	it('reports the direction of travel in chronological order', () => {
		const p = principle('Presence');
		// Written newest-first to prove the function sorts rather than trusting order.
		[5, 5, 5, 2, 2, 2].forEach((value, i) =>
			assess(ALICE, { at: 6_000 - i * 1_000, scores: [score('authenticity', value, [p.id])] })
		);
		expect(principleStats(ALICE, p.id).direction).toBe('rising');
	});

	it('says nothing rather than zero when a principle has never come up', () => {
		const p = principle('Courage');
		assess(ALICE, { at: 1_000 });
		const stats = principleStats(ALICE, p.id);
		expect(stats.cited).toBe(0);
		expect(stats.meanScore).toBeNull();
		expect(stats.direction).toBe('unknown');
	});
});

describe('neglectedPrinciples', () => {
	const DAY = 86_400_000;

	it('lists an old principle nothing recent has cited', () => {
		const cited = principle('Honesty');
		const forgotten = principle('Courage');
		// Both predate the window; only one shows up in recent assessments.
		for (const p of [cited, forgotten]) age(p.id, 200 * DAY);
		assess(ALICE, { at: Date.now(), scores: [score('authenticity', 4, [cited.id])] });

		expect(neglectedPrinciples(ALICE).map((p) => p.id)).toEqual([forgotten.id]);
	});

	it('does not accuse a principle written last week of being neglected', () => {
		principle('Brand new');
		assess(ALICE, { at: Date.now() });
		expect(neglectedPrinciples(ALICE)).toEqual([]);
	});

	it('stays quiet when there is no recent activity to judge against', () => {
		principle('Honesty');
		expect(neglectedPrinciples(ALICE)).toEqual([]);
	});
});

describe('deleteAllAlignmentData', () => {
	it('erases everything of the caller and nothing of anyone else', () => {
		const a = principle('Honesty');
		const b = principle('Presence');
		saveTension(ALICE, a.id, b.id);
		const entry = saveEntry(ALICE, { body: 'a day' });
		assess(ALICE, { entryId: entry.id });
		currentConstitutionVersion(ALICE);

		principle('Theirs', {}, BOB);
		saveEntry(BOB, { body: 'their day' });

		const removed = deleteAllAlignmentData(ALICE);
		expect(removed.principles).toBe(2);
		expect(removed.entries).toBe(1);
		expect(removed.assessments).toBe(1);
		expect(removed.tensions).toBe(1);

		expect(listPrinciples(ALICE)).toEqual([]);
		expect(listEntries(ALICE)).toEqual([]);
		expect(listConstitutionVersions(ALICE)).toEqual([]);
		expect(listPrinciples(BOB)).toHaveLength(1);
		expect(listEntries(BOB)).toHaveLength(1);
	});
});
