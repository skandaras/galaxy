import { describe, expect, it } from 'vitest';
import { draftProblems } from './profile-draft';
import { DOMAINS, KINDS, SEED_SUBDOMAINS } from './profile-taxonomy';
import { emptyAnswers, joinList, nowUntil, SURVEY, surveyDraft, type SurveyAnswers } from './survey';

const questions = SURVEY.flatMap((s) => s.questions);
const seedPaths = new Set(
	Object.entries(SEED_SUBDOMAINS).flatMap(([d, subs]) => subs.map((s) => `${d}/${s}`))
);

/** Answers a person might really give, every question filled. */
function full(): SurveyAnswers {
	return {
		text: {
			name: 'Tama',
			place: 'Auckland, New Zealand',
			timezone: 'Pacific/Auckland',
			languages: 'English, te reo Māori',
			background: 'Grew up in Rotorua.',
			role: 'Staff engineer leading a platform team',
			organisation: 'Acme',
			expertise: 'TypeScript, SQLite, distributed systems',
			tools: 'Neovim, pnpm, Docker on Linux',
			'work-more': 'On call one week in four.',
			home: 'A villa in Grey Lynn with Aroha and Nikau.',
			transport: 'bike and train; no car.',
			constraints: 'vegetarian, no stairs',
			health: 'Coeliac.',
			money: 'Saving for a deposit.',
			pursuits: 'trail running, sailing',
			learning: 'te reo Māori',
			taste: 'Scandinavian crime fiction.'
		},
		optedIn: ['health'],
		people: [
			{ name: 'Aroha', kind: 'person', relation: 'partner', line: 'GP on weekend shifts' },
			{ name: 'Pip', kind: 'pet', relation: 'dog', line: '' }
		],
		projects: [{ name: 'Galaxy', line: 'a self-hosted AI workspace' }],
		now: [{ what: 'Moving house to Raglan', until: '2026-11-01' }]
	};
}

describe('the survey', () => {
	it('files every answer somewhere the store has', () => {
		const ids = questions.map((q) => q.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const q of questions) {
			if (q.type === 'text' || q.type === 'list' || q.type === 'entity') {
				expect(seedPaths.has(q.path), `${q.id}: ${q.path}`).toBe(true);
				expect((KINDS as readonly string[]).includes(q.kind), q.id).toBe(true);
				expect(q.claim, q.id).toContain(q.type === 'list' ? '{list}' : '{value}');
			}
			if (q.type === 'free') {
				expect(seedPaths.has(q.about) || (DOMAINS as readonly string[]).includes(q.about), q.id).toBe(true);
			}
		}
	});

	it('turns ordinary answers into lines the store will take', () => {
		const { draft } = surveyDraft(full());
		const problems = draftProblems(draft, '2026-10-10');
		expect(problems.entries.filter(Boolean)).toEqual([]);
		expect(problems.people.filter(Boolean)).toEqual([]);
		const claims = draft.entries.map((e) => e.claim);
		expect(claims).toContain('Goes by Tama.');
		expect(claims).toContain('Speaks English and te reo Māori.');
		expect(claims).toContain('Uses Neovim, pnpm and Docker on Linux.');
		expect(claims).toContain('Gets around by bike and train; no car.');
	});

	it('makes nothing from a blank answer, and asks nothing behind a box left unticked', () => {
		const { draft, parts } = surveyDraft(emptyAnswers());
		expect(draft.entries).toEqual([]);
		expect(parts).toEqual([]);

		const answers = full();
		const { parts: sent } = surveyDraft(answers);
		expect(sent.map((p) => p.about)).toContain('life/health');
		// Money has text in it, but its box was never ticked.
		expect(sent.map((p) => p.about)).not.toContain('life/money');
		expect(sent.find((p) => p.about === 'life/health')?.text).toBe('Coeliac.');
	});

	it('keeps people, projects and an employer as people in the profile, with what was said about them', () => {
		const { draft } = surveyDraft(full());
		expect(draft.people).toEqual([
			{ name: 'Acme', kind: 'organisation', relation: 'employer', aka: [] },
			{ name: 'Aroha', kind: 'person', relation: 'partner', aka: [] },
			{ name: 'Pip', kind: 'pet', relation: 'dog', aka: [] },
			{ name: 'Galaxy', kind: 'project', relation: '', aka: [] }
		]);
		expect(draft.entries).toContainEqual(
			expect.objectContaining({ path: 'people/Aroha', claim: 'GP on weekend shifts.' })
		);
		expect(draft.entries.some((e) => e.path === 'people/Pip')).toBe(false);
		expect(draft.entries).toContainEqual(
			expect.objectContaining({ path: 'work/projects', claim: 'Galaxy: a self-hosted AI workspace.', about: 'Galaxy' })
		);
		expect(draft.entries).toContainEqual(
			expect.objectContaining({ path: 'work/organisation', claim: 'Works at Acme.', about: 'Acme' })
		);
	});

	it('pins what is on their plate and lets it lapse on its date', () => {
		const { draft } = surveyDraft(full());
		expect(draft.entries).toContainEqual(
			expect.objectContaining({ claim: 'Moving house to Raglan.', pinned: true, until: '2026-11-01' })
		);
		expect(nowUntil(new Date('2026-10-10T09:00:00Z'))).toBe('2026-11-09');
	});

	it('takes no more rows than a step offers', () => {
		const answers = emptyAnswers();
		answers.now = Array.from({ length: 9 }, (_, i) => ({ what: `Thing number ${i} to do`, until: '' }));
		expect(surveyDraft(answers).draft.entries).toHaveLength(5);
	});
});

describe('joinList', () => {
	it('reads a list the way a sentence would say it', () => {
		expect(joinList('a')).toBe('a');
		expect(joinList('a, b')).toBe('a and b');
		expect(joinList(' a ,b,\nc, ')).toBe('a, b and c');
		expect(joinList('')).toBe('');
	});
});
