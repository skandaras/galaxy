import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { dataDir, db, runMigrations } from '$lib/server/db';
import { skillCandidates, skills } from '$lib/server/db/schema';
import { saveSkill } from '$lib/server/skills';
import { knowledgeTools } from './knowledge';

/**
 * The skill tools as an agent meets them: a repository's own skills ahead of
 * stored ones, files read beside a skill, and proposals that wait for a person.
 */

const ALICE = 'u-know-alice';
const BOB = 'u-know-bob';
const WS = 'workspaces/knowledge-test';

const tool = (name: string, tools = knowledgeTools(ALICE)) => {
	const found = tools.find((t) => t.def.name === name);
	if (!found) throw new Error(`no such tool: ${name}`);
	return found;
};

const stored = (name: string, extra: Partial<Parameters<typeof saveSkill>[0]> = {}) =>
	saveSkill({
		name,
		category: 'general',
		description: `${name} does a thing`,
		triggers: '',
		author: 'user',
		body: `stored ${name}`,
		...extra
	});

beforeAll(() => {
	runMigrations();
	const root = join(dataDir, WS);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(join(root, '.agents', 'skills', 'release', 'templates'), { recursive: true });
	writeFileSync(
		join(root, '.agents', 'skills', 'release', 'SKILL.md'),
		'---\nname: release\ndescription: How this repo releases\n---\nrepo release steps'
	);
	writeFileSync(join(root, '.agents', 'skills', 'release', 'templates', 'notes.md'), 'notes template');
});

beforeEach(() => {
	db.delete(skills).run();
	db.delete(skillCandidates).run();
});

describe('skill_load', () => {
	it("loads the repository's own skill ahead of a stored one of the same name", async () => {
		stored('release');
		const tools = knowledgeTools(ALICE, { repo: WS });
		const out = await tool('skill_load', tools).execute({ name: 'release' });
		expect(out).toContain('repo release steps');
		expect(out).not.toContain('---');
		expect(out).toContain('[Files in this skill, for skill_read: templates/notes.md]');
	});

	it('falls back to a stored skill outside a repository', async () => {
		stored('release');
		expect(await tool('skill_load').execute({ name: 'release' })).toBe('stored release');
	});

	it("will not load someone else's personal skill, or a switched-off one", async () => {
		stored('bobs', { ownerId: BOB });
		stored('off', { enabled: false });
		await expect(tool('skill_load').execute({ name: 'bobs' })).rejects.toThrow(/No such skill/);
		await expect(tool('skill_load').execute({ name: 'off' })).rejects.toThrow(/No such skill/);
	});
});

describe('skill_read', () => {
	it('reads a file a skill carries', async () => {
		const tools = knowledgeTools(ALICE, { repo: WS });
		expect(await tool('skill_read', tools).execute({ name: 'release', path: 'templates/notes.md' })).toBe(
			'notes template'
		);
	});

	it('refuses a path out of the skill', async () => {
		const tools = knowledgeTools(ALICE, { repo: WS });
		await expect(
			tool('skill_read', tools).execute({ name: 'release', path: '../../../AGENTS.md' })
		).rejects.toThrow(/Not a file in this skill/);
	});
});

describe('propose_skill', () => {
	const proposal = {
		name: 'Weekly Review',
		description: 'How this person runs a weekly review',
		body: '## Steps\n1. Open the board',
		rationale: 'They walked through it twice',
		tasks: 'Chat'
	};

	it('files a pending candidate for this person, and nothing more', async () => {
		const out = await tool('propose_skill').execute(proposal);
		expect(out).toContain('waits for the person');
		const rows = db.select().from(skillCandidates).all();
		expect(rows).toEqual([
			expect.objectContaining({
				name: 'weekly-review',
				userId: ALICE,
				status: 'pending',
				tasks: 'chat'
			})
		]);
		expect(db.select().from(skills).all()).toEqual([]);
	});

	it('takes one proposal a turn', async () => {
		const tools = knowledgeTools(ALICE);
		await tool('propose_skill', tools).execute(proposal);
		await expect(
			tool('propose_skill', tools).execute({ ...proposal, name: 'another' })
		).rejects.toThrow(/One skill proposal a turn/);
	});

	it('will not propose a name already taken or already proposed', async () => {
		stored('weekly-review');
		await expect(tool('propose_skill').execute(proposal)).rejects.toThrow(/already/);
		db.delete(skills).run();
		db.insert(skillCandidates)
			.values({
				id: 'c1',
				userId: BOB,
				name: 'weekly-review',
				status: 'rejected',
				createdAt: new Date()
			})
			.run();
		await expect(tool('propose_skill').execute(proposal)).rejects.toThrow(/already/);
		expect(db.select().from(skillCandidates).where(eq(skillCandidates.userId, ALICE)).all()).toEqual(
			[]
		);
	});

	it('is not offered in a hidden chat, which is never written down', () => {
		const names = knowledgeTools(ALICE, { hidden: true }).map((t) => t.def.name);
		expect(names).not.toContain('propose_skill');
		expect(names).toContain('skill_load');
	});
});
