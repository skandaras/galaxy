import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { skillCandidates, skills } from '$lib/server/db/schema';
import { decideCandidate, getSkill, listCandidates, saveSkill } from '$lib/server/skills';

/**
 * The optimiser reviews shared skills by reading them, and proposes exact
 * edits an admin decides, rather than whole bodies written from a one-line
 * description.
 */

const prompts: string[] = [];
let reply = '{}';

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		pickModel: () => ({
			model: { id: 'm', modelKey: 'mock/opt', displayName: 'Opt', supportsReasoning: false, reasoningMode: 'auto' },
			provider: {},
			adapter: {
				complete: async (req: { messages: { content: string }[] }) => {
					prompts.push(req.messages.map((m) => m.content).join('\n'));
					return { text: reply, usage: null };
				}
			}
		})
	};
});

const { runSkillOptimiser } = await import('./skill-optimiser');

const skill = (name: string, ownerId: string | null, body: string) =>
	saveSkill({ name, category: 'ops', description: `${name} desc`, triggers: '', author: 'user', tasks: 'chat', body, ownerId });

beforeAll(() => runMigrations());
beforeEach(() => {
	db.delete(skillCandidates).run();
	db.delete(skills).run();
	prompts.length = 0;
});

describe('the skill optimiser', () => {
	it('reads the bodies of shared skills, and never sees a personal one', async () => {
		skill('opt-skill', null, 'Step one: OPT-ORIGINAL.');
		skill('private-skill', 'someone', 'PRIVATE-BODY');
		await runSkillOptimiser('admin-1');
		expect(prompts[0]).toContain('OPT-ORIGINAL');
		expect(prompts[0]).not.toContain('PRIVATE-BODY');
	});

	it('files a change with no proposer, against the version it read, that keeps the tasks on approval', async () => {
		skill('opt-skill', null, 'Step one: OPT-ORIGINAL.');
		reply = JSON.stringify({
			changes: [{ skill: 'Opt Skill', edits: [{ old: 'OPT-ORIGINAL', new: 'OPT-PATCHED' }], rationale: 'clearer' }]
		});
		const res = await runSkillOptimiser('admin-1');
		expect(res).toMatchObject({ ran: true, candidates: 1 });
		const [cand] = listCandidates();
		expect(cand).toMatchObject({ kind: 'patch', userId: null, name: 'opt-skill', baseVersion: 1 });
		decideCandidate(cand.id, true);
		expect(getSkill('opt-skill')?.body).toContain('OPT-PATCHED');
		expect(getSkill('opt-skill')?.meta).toMatchObject({ tasks: 'chat', ownerId: null, version: 2 });
	});

	it('drops an edit that does not land, and a new skill under a name already used', async () => {
		skill('opt-skill', null, 'Step one: OPT-ORIGINAL.');
		reply = JSON.stringify({
			changes: [{ skill: 'opt-skill', edits: [{ old: 'NOT THERE', new: 'x' }] }],
			new_skills: [
				{ name: 'opt-skill', body: 'dup' },
				{ name: 'brand-new', category: 'ops', description: 'd', tasks: 'Chat', body: 'New steps' }
			]
		});
		const res = await runSkillOptimiser();
		expect(res).toMatchObject({ ran: true, candidates: 1 });
		const [cand] = listCandidates();
		expect(cand).toMatchObject({ kind: 'new', name: 'brand-new', userId: null, tasks: 'chat' });
	});
});
