import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	alignmentAssessments,
	alignmentEntries,
	alignmentPrincipleRevisions,
	alignmentPrincipleTensions,
	alignmentPrinciples
} from '$lib/server/db/schema';
import { saveEntry, savePrinciple } from '$lib/server/alignment';
import { RUBRIC_DIMENSIONS, type ActiveDimension } from '$lib/server/alignment-rubric';
import { CARE_FALLBACK, checkDistress } from '$lib/server/alignment-distress';
import { assessEntry, parseAssessment } from './alignment';

const ALICE = 'user-alice';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(alignmentAssessments).run();
	db.delete(alignmentEntries).run();
	db.delete(alignmentPrincipleRevisions).run();
	db.delete(alignmentPrincipleTensions).run();
	db.delete(alignmentPrinciples).run();
});

const ENTRY =
	'I told Sam the deadline was fine when I knew it was not. I did it because the meeting was nearly over and I wanted to leave.';

const dimensions: ActiveDimension[] = RUBRIC_DIMENSIONS.slice(0, 3).map((d) => ({
	...d,
	weight: d.defaultWeight
}));

const opts = (over: Partial<Parameters<typeof parseAssessment>[1]> = {}) => ({
	entryBody: ENTRY,
	dimensions,
	principleIds: new Set(['p-honesty', 'p-courage']),
	declaredPairs: new Set<string>(),
	...over
});

const reply = (body: Record<string, unknown>) => JSON.stringify(body);

describe('parseAssessment — evidence', () => {
	it('keeps a score whose quote is really in the entry', () => {
		const out = parseAssessment(
			reply({
				band: 'diverging',
				confidence: 'high',
				dimensions: [
					{
						id: dimensions[0].id,
						score: 2,
						evidence: 'I told Sam the deadline was fine when I knew it was not',
						principles: ['p-honesty'],
						note: 'said the comfortable thing'
					}
				]
			}),
			opts()
		);
		expect(out.scores).toHaveLength(1);
		expect(out.scores[0].score).toBe(2);
		expect(out.scores[0].principles).toEqual(['p-honesty']);
		expect(out.band).toBe('diverging');
	});

	it('drops a score whose quote is not in the entry', () => {
		const out = parseAssessment(
			reply({
				band: 'diverging',
				dimensions: [
					{ id: dimensions[0].id, score: 1, evidence: 'I lied to everyone all week', principles: [] }
				]
			}),
			opts()
		);
		// The whole point: a model cannot assert something about someone's
		// character and dress it as a finding.
		expect(out.scores).toEqual([]);
		expect(out.band).toBe('insufficient');
	});

	it('accepts a quote the model re-wrapped', () => {
		const out = parseAssessment(
			reply({
				dimensions: [
					{
						id: dimensions[0].id,
						score: 2,
						evidence: 'I told Sam   the deadline\n was fine',
						principles: []
					}
				]
			}),
			opts()
		);
		expect(out.scores).toHaveLength(1);
	});

	it('drops a score with no quote at all', () => {
		const out = parseAssessment(
			reply({ dimensions: [{ id: dimensions[0].id, score: 5, principles: ['p-honesty'] }] }),
			opts()
		);
		expect(out.scores).toEqual([]);
	});

	it('drops a gap with no quote behind it', () => {
		const out = parseAssessment(
			reply({
				gaps: [
					{ principle: 'p-honesty', observation: 'you were dishonest', evidence: 'never said this' },
					{
						principle: 'p-honesty',
						observation: 'said the easy thing',
						evidence: 'I wanted to leave'
					}
				]
			}),
			opts()
		);
		expect(out.gaps).toHaveLength(1);
		expect(out.gaps[0].observation).toBe('said the easy thing');
	});
});

describe('parseAssessment — ids and ranges', () => {
	it('discards principle ids that are not theirs', () => {
		const out = parseAssessment(
			reply({
				dimensions: [
					{
						id: dimensions[0].id,
						score: 3,
						evidence: 'I wanted to leave',
						principles: ['p-honesty', 'p-invented']
					}
				]
			}),
			opts()
		);
		expect(out.scores[0].principles).toEqual(['p-honesty']);
	});

	it('ignores a dimension that is not on this person\'s rubric', () => {
		const out = parseAssessment(
			reply({
				dimensions: [
					{ id: 'made-up-dimension', score: 4, evidence: 'I wanted to leave', principles: [] }
				]
			}),
			opts()
		);
		expect(out.scores).toEqual([]);
	});

	it('ignores a dimension the person switched off', () => {
		const out = parseAssessment(
			reply({
				dimensions: [
					{ id: RUBRIC_DIMENSIONS[7].id, score: 4, evidence: 'I wanted to leave', principles: [] }
				]
			}),
			// Only the first three are active in these tests.
			opts()
		);
		expect(out.scores).toEqual([]);
	});

	it('clamps a score into 1-5 and rounds it', () => {
		const out = parseAssessment(
			reply({
				dimensions: [
					{ id: dimensions[0].id, score: 99, evidence: 'I wanted to leave', principles: [] },
					{ id: dimensions[1].id, score: 0, evidence: 'I wanted to leave', principles: [] },
					{ id: dimensions[2].id, score: 3.6, evidence: 'I wanted to leave', principles: [] }
				]
			}),
			opts()
		);
		expect(out.scores.map((s) => s.score)).toEqual([5, 1, 4]);
	});

	it('keeps only the first reading of a repeated dimension', () => {
		const out = parseAssessment(
			reply({
				dimensions: [
					{ id: dimensions[0].id, score: 2, evidence: 'I wanted to leave', principles: [] },
					{ id: dimensions[0].id, score: 5, evidence: 'I wanted to leave', principles: [] }
				]
			}),
			opts()
		);
		expect(out.scores).toHaveLength(1);
		expect(out.scores[0].score).toBe(2);
	});

	it('falls back to insufficient on an unknown band', () => {
		const out = parseAssessment(
			reply({
				band: 'excellent',
				dimensions: [
					{ id: dimensions[0].id, score: 4, evidence: 'I wanted to leave', principles: [] }
				]
			}),
			opts()
		);
		expect(out.band).toBe('insufficient');
	});

	it('survives a reply that is not JSON at all', () => {
		const out = parseAssessment('I am sorry, I cannot help with that.', opts());
		expect(out.band).toBe('insufficient');
		expect(out.confidence).toBe('low');
		expect(out.scores).toEqual([]);
	});

	it('reads JSON out of a fenced block with prose around it', () => {
		const out = parseAssessment(
			'Here you go:\n```json\n' +
				reply({
					band: 'mixed',
					standing: 'honest about it afterwards',
					dimensions: [
						{ id: dimensions[0].id, score: 3, evidence: 'I wanted to leave', principles: [] }
					]
				}) +
				'\n```',
			opts()
		);
		expect(out.band).toBe('mixed');
		expect(out.standing).toBe('honest about it afterwards');
	});
});

describe('parseAssessment — tensions', () => {
	it('marks a pair the person had already declared', () => {
		const out = parseAssessment(
			reply({
				tensions: [{ between: ['p-honesty', 'p-courage'], chose: 'p-courage', note: 'chose ease' }]
			}),
			opts({ declaredPairs: new Set(['p-courage:p-honesty']) })
		);
		expect(out.tensions).toHaveLength(1);
		// A known trade-off is judged on how it was resolved, not reported as a
		// discovery every single time it recurs.
		expect(out.tensions[0].declared).toBe(true);
	});

	it('marks an undeclared pair as such', () => {
		const out = parseAssessment(
			reply({ tensions: [{ between: ['p-honesty', 'p-courage'], chose: 'p-honesty' }] }),
			opts()
		);
		expect(out.tensions[0].declared).toBe(false);
	});

	it('drops a tension whose chosen side is not one of the two', () => {
		const out = parseAssessment(
			reply({ tensions: [{ between: ['p-honesty', 'p-courage'], chose: 'p-invented' }] }),
			opts()
		);
		expect(out.tensions).toEqual([]);
	});

	it('drops a tension that does not name exactly two of their principles', () => {
		const out = parseAssessment(
			reply({ tensions: [{ between: ['p-honesty', 'p-nope'], chose: 'p-honesty' }] }),
			opts()
		);
		expect(out.tensions).toEqual([]);
	});
});

describe('parseAssessment — insufficient', () => {
	it('refuses a confident verdict when nothing survived', () => {
		const out = parseAssessment(
			reply({ band: 'aligned', confidence: 'high', standing: 'doing wonderfully' }),
			opts()
		);
		// An empty scorecard must never read as a clean bill of health.
		expect(out.band).toBe('insufficient');
		expect(out.confidence).toBe('low');
	});

	it('keeps a real verdict when a gap alone survived', () => {
		const out = parseAssessment(
			reply({
				band: 'diverging',
				confidence: 'high',
				gaps: [{ principle: 'p-honesty', observation: 'x', evidence: 'I wanted to leave' }]
			}),
			opts()
		);
		expect(out.band).toBe('diverging');
		expect(out.confidence).toBe('high');
	});
});

describe('parseAssessment — care', () => {
	it('replaces the whole assessment when the model raises care', () => {
		const out = parseAssessment(
			reply({
				care: true,
				care_message: 'That sounds heavy.',
				band: 'diverging',
				dimensions: [
					{ id: dimensions[0].id, score: 1, evidence: 'I wanted to leave', principles: [] }
				],
				gaps: [{ principle: 'p-honesty', observation: 'x', evidence: 'I wanted to leave' }]
			}),
			opts()
		);
		expect(out.care).toBe(true);
		expect(out.careMessage).toBe('That sounds heavy.');
		// No scorecard survives the care path. That is the entire point of it.
		expect(out.scores).toEqual([]);
		expect(out.gaps).toEqual([]);
		expect(out.standing).toBe('');
	});

	it('forces care when the pre-screen fired, whatever the model returned', () => {
		const out = parseAssessment(
			reply({
				care: false,
				band: 'aligned',
				dimensions: [
					{ id: dimensions[0].id, score: 5, evidence: 'I wanted to leave', principles: [] }
				]
			}),
			opts({ forceCare: true })
		);
		expect(out.care).toBe(true);
		expect(out.careMessage).toBe(CARE_FALLBACK);
		expect(out.scores).toEqual([]);
	});
});

describe('checkDistress', () => {
	it('fires on an unambiguous statement', () => {
		expect(checkDistress('some days I want to die').flagged).toBe(true);
		expect(checkDistress('I have been hurting myself again').flagged).toBe(true);
	});

	it('stays quiet on ordinary difficulty', () => {
		expect(checkDistress('a hard week, I was short with everyone').flagged).toBe(false);
		expect(checkDistress('this deadline is killing me').flagged).toBe(false);
		expect(checkDistress('I died of embarrassment in the meeting').flagged).toBe(false);
	});

	it('backs off when the phrase is clearly about something else', () => {
		expect(checkDistress('I am not suicidal, just tired').flagged).toBe(false);
		expect(checkDistress('the documentary was about suicide prevention').flagged).toBe(false);
	});
});

describe('assessEntry — refusals before any model call', () => {
	it('refuses an entry flagged not to be assessed', async () => {
		savePrinciple(ALICE, { title: 'Honesty' });
		const entry = saveEntry(ALICE, { body: ENTRY, skipAssessment: true });

		const result = await assessEntry(ALICE, entry.id);
		expect(result.ran).toBe(false);
		expect(result.reason).toMatch(/not to be assessed/);
	});

	it('refuses when there is no constitution to read against', async () => {
		const entry = saveEntry(ALICE, { body: ENTRY });
		const result = await assessEntry(ALICE, entry.id);
		expect(result.ran).toBe(false);
		expect(result.reason).toMatch(/constitution/);
	});

	it('refuses an entry that is not yours', async () => {
		savePrinciple(ALICE, { title: 'Honesty' });
		const entry = saveEntry(ALICE, { body: ENTRY });
		const result = await assessEntry('user-bob', entry.id);
		expect(result.ran).toBe(false);
		expect(result.reason).toBe('entry not found');
	});

	it('refuses when no model is configured, without writing an assessment', async () => {
		savePrinciple(ALICE, { title: 'Honesty' });
		const entry = saveEntry(ALICE, { body: ENTRY });
		const result = await assessEntry(ALICE, entry.id);
		expect(result.ran).toBe(false);
		expect(result.reason).toBe('no model configured');
		expect(db.select().from(alignmentAssessments).all()).toEqual([]);
	});
});
