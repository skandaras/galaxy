import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { forgeEpics, forgeSprints, forgeTasks } from '$lib/server/db/schema';
import { addSprint, createEpic, openTask } from '$lib/server/forge';
import {
	charterTools,
	forgeReadTools,
	forgeTreeText,
	readChecks,
	readTasks,
	type CharterProposal
} from './forge';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
});

describe('readChecks', () => {
	it('takes a name and a command and nothing else', () => {
		expect(readChecks([{ name: 'tests', command: 'npm test' }], 500)).toEqual([
			{ name: 'tests', command: 'npm test', timeoutMs: 500 }
		]);
	});

	it('never lets the model set its own deadline', () => {
		// A check that picks its own timeout can pick nothing, and the gate counts
		// a timeout as a failure — so the run decides, not the reply.
		expect(readChecks([{ name: 'x', command: 'npm test', timeoutMs: 1 }], 600_000)[0].timeoutMs).toBe(
			600_000
		);
	});

	it('drops an entry with no command, and names one with no name', () => {
		const out = readChecks([{ name: 'nameless' }, { command: 'npm run lint' }]);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('npm run lint');
	});

	it('survives anything that is not a list of objects', () => {
		expect(readChecks(undefined)).toEqual([]);
		expect(readChecks('npm test')).toEqual([]);
		expect(readChecks([null, 7, 'x'])).toEqual([]);
	});
});

describe('readTasks', () => {
	it('reads a proposal and keeps its stated reason for having no check', () => {
		const [task] = readTasks([
			{ title: 'Rename the thing', intent: 'do it', acceptance: 'it is renamed', noCheckReason: 'a rename' }
		]);
		expect(task).toMatchObject({ title: 'Rename the thing', checks: [], noCheckReason: 'a rename' });
	});

	it('drops an entry with no title, since nothing could be opened from it', () => {
		expect(readTasks([{ intent: 'something' }, { title: 'Real' }])).toHaveLength(1);
	});

	it('caps how much a reply can ask for', () => {
		expect(readTasks(Array.from({ length: 80 }, (_, i) => ({ title: `t${i}` })))).toHaveLength(20);
	});
});

describe('forge_charter_write', () => {
	const capture = () => {
		let got: CharterProposal | null = null;
		const [tool] = charterTools((p) => (got = p));
		return { tool, read: () => got as CharterProposal | null };
	};

	it('hands the proposal to the run rather than writing it anywhere', async () => {
		const { tool, read } = capture();
		await tool.execute({
			sprints: [{ title: 'Foundations', goal: 'the schema exists' }],
			standingChecks: [{ name: 'tests', command: 'npm test' }],
			acceptance: ['it builds']
		});
		expect(read()).toMatchObject({
			sprints: [{ title: 'Foundations', goal: 'the schema exists' }],
			acceptance: ['it builds']
		});
		// Nothing was written: approveEpic is the only door standingChecks has.
		expect(db.select().from(forgeEpics).all()).toHaveLength(0);
	});

	it('refuses a structure with no sprints', async () => {
		const { tool } = capture();
		await expect(
			tool.execute({ sprints: [], standingChecks: [{ name: 'x', command: 'npm test' }] })
		).rejects.toThrow(/sprint/i);
	});

	it('refuses a build with nothing to judge it by', async () => {
		const { tool } = capture();
		await expect(
			tool.execute({ sprints: [{ title: 'One', goal: 'g' }], standingChecks: [] })
		).rejects.toThrow(/standing check/i);
	});
});

describe('forge_read', () => {
	const build = (owner = ALICE) => {
		const epic = createEpic({
			ownerId: owner,
			title: 'Galaxy mobile',
			brief: 'make it work on a phone',
			repoUrl: 'https://example.invalid/r.git'
		});
		const sprint = addSprint({ epicId: epic.id, title: 'Foundations', goal: 'the shell renders' });
		openTask({
			epicId: epic.id,
			sprintId: sprint.id,
			title: 'Add the viewport meta',
			checks: [{ name: 'ui', command: 'npm run test:ui', timeoutMs: 0 }]
		});
		return epic;
	};

	it('reads the whole tree, with each task’s state and check', () => {
		const text = forgeTreeText(build());
		expect(text).toContain('Galaxy mobile');
		expect(text).toContain('1. Foundations [outlined]');
		expect(text).toContain('[planned] Add the viewport meta');
		expect(text).toContain('ui');
	});

	it('says plainly when a task has no check', () => {
		const epic = createEpic({
			ownerId: ALICE,
			title: 'Small',
			repoUrl: 'https://example.invalid/r.git'
		});
		const sprint = addSprint({ epicId: epic.id, title: 'One' });
		openTask({
			epicId: epic.id,
			sprintId: sprint.id,
			title: 'Tidy a comment',
			noCheckReason: 'a comment'
		});
		expect(forgeTreeText(epic)).toContain('no check, a comment');
	});

	it('is scoped to the acting user', async () => {
		// "Not yours" has to be indistinguishable from "does not exist": an epic
		// names somebody's repository.
		const epic = build();
		const [mine] = forgeReadTools(epic.id, ALICE);
		const [theirs] = forgeReadTools(epic.id, BOB);
		expect(await mine.execute({})).toContain('Galaxy mobile');
		await expect(theirs.execute({})).rejects.toThrow(/No such epic/);
	});
});
