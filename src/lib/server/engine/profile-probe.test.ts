import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { events, usageLog } from '$lib/server/db/schema';
import { addEntry, createEntity, wipeProfile } from '$lib/server/profile';

/**
 * The over-personalisation check: what it counts as intruding, and that it
 * runs on the admin's own profile, a question at a time, recording counts.
 */

let answer: (question: string, system: string) => string = () => 'A plain answer.';
let blocked = false;
let calls = 0;

vi.mock('./budget', () => ({ getBudgetStatus: () => ({ blocked }) }));

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		pickModel: () => ({
			model: { id: 'm', modelKey: 'mock/chat', displayName: 'Chatty', supportsReasoning: false, reasoningMode: 'auto' },
			provider: {},
			adapter: {
				complete: async (req: { messages: { role: string; content: string }[] }) => {
					calls++;
					const [system, user] = req.messages;
					return { text: answer(user.content, system.content), usage: { promptTokens: 10, completionTokens: 5 } };
				}
			}
		})
	};
});

const { PROBE_QUESTIONS, profileIntrusion, runProbe } = await import('./profile-probe');

const ADMIN = 'u-probe-admin';

beforeAll(() => runMigrations());

beforeEach(() => {
	wipeProfile(ADMIN);
	db.delete(events).run();
	db.delete(usageLog).run();
	answer = () => 'A plain answer.';
	blocked = false;
	calls = 0;
});

const profile = {
	names: ['Aroha', 'Ro', 'Pip'],
	pinned: ['Vegetarian; trains for the Tarawera ultramarathon on weekends.']
};

describe('profileIntrusion', () => {
	it('flags a name of someone in the profile, as a whole word and whatever its case', () => {
		expect(profileIntrusion('Aroha might enjoy this one.', 'What is a good book?', profile)).toEqual(['Aroha']);
		expect(profileIntrusion('Its rotation is slow.', 'Why?', profile)).toEqual([]);
	});

	it('flags a distinctive word from the pinned brief, and not a common one', () => {
		expect(profileIntrusion('Here is a vegetarian version for your ultramarathon training.', 'Give me a recipe.', profile)).toEqual([
			'vegetarian',
			'ultramarathon'
		]);
		expect(profileIntrusion('This works on weekends and weekdays.', 'Why?', profile)).toEqual([]);
	});

	it('leaves alone what the question itself asked about', () => {
		expect(profileIntrusion('Pip is a common name for a dog.', 'Is Pip a good name for a dog?', profile)).toEqual([]);
		expect(profileIntrusion('A vegetarian lasagne works well.', 'Suggest a vegetarian lasagne.', profile)).toEqual([]);
	});
});

describe('runProbe', () => {
	beforeEach(() => {
		createEntity(ADMIN, { kind: 'person', name: 'Aroha', relation: 'partner' });
		addEntry(
			ADMIN,
			{ domain: 'life', subdomain: 'constraints', kind: 'constraint', claim: 'Vegetarian, and coeliac too.', pinned: true },
			{ source: 'stated' }
		);
	});

	it('asks every question with the person’s own block, and counts the replies that intrude', async () => {
		let sawBlock = false;
		answer = (q, system) => {
			sawBlock ||= system.includes('[Profile:');
			return q.includes('capital') ? 'Canberra, though Aroha might say otherwise.' : 'A plain answer.';
		};
		const out = await runProbe(ADMIN);
		expect(sawBlock).toBe(true);
		expect(out).toMatchObject({ ran: true, asked: PROBE_QUESTIONS.length, flagged: 1 });
		expect(out.ran && out.results.find((r) => r.flagged.length)).toMatchObject({
			question: 'What is the capital of Australia?',
			flagged: ['Aroha']
		});
		expect(db.select().from(usageLog).all()).toHaveLength(PROBE_QUESTIONS.length);
		const recorded = JSON.stringify(db.select().from(events).all());
		expect(recorded).toContain('"flagged":1');
		expect(recorded).not.toContain('Canberra');
	});

	it('does not run on an empty profile, and stops at the spending cap', async () => {
		wipeProfile(ADMIN);
		expect(await runProbe(ADMIN)).toMatchObject({ ran: false });
		expect(calls).toBe(0);
		createEntity(ADMIN, { kind: 'person', name: 'Aroha', relation: 'partner' });
		blocked = true;
		expect(await runProbe(ADMIN)).toMatchObject({ ran: false, reason: expect.stringMatching(/spending cap/) });
		expect(calls).toBe(0);
	});
});
