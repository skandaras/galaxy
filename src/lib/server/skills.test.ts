import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, db, runMigrations } from '$lib/server/db';
import { skills } from '$lib/server/db/schema';
import {
	getSkill,
	listSkills,
	normalizeSkillName,
	normalizeTasks,
	parseFrontmatter,
	readSkillFile,
	saveSkill,
	serializeSkill,
	setSkillOwner,
	skillAppliesTo,
	skillFiles,
	skillIndexText
} from './skills';

describe('skill frontmatter', () => {
	it('round-trips meta and body', () => {
		const raw = serializeSkill(
			{
				name: 'test-skill',
				description: 'Does testing things',
				category: 'coding',
				version: 3,
				author: 'agent',
				triggers: 'test, spec',
				tasks: 'coding'
			},
			'## When to use\n\nAlways.\n'
		);
		const { meta, body } = parseFrontmatter(raw);
		expect(meta).toEqual({
			name: 'test-skill',
			description: 'Does testing things',
			category: 'coding',
			version: 3,
			author: 'agent',
			triggers: 'test, spec',
			tasks: 'coding'
		});
		expect(body).toBe('## When to use\n\nAlways.\n');
	});

	it('treats files without frontmatter as pure body', () => {
		const { meta, body } = parseFrontmatter('just some text');
		expect(meta).toEqual({
			name: undefined,
			category: undefined,
			description: undefined,
			triggers: undefined,
			version: undefined,
			author: undefined,
			tasks: undefined
		});
		expect(body).toBe('just some text');
	});
});

describe('normalizeSkillName', () => {
	it('kebab-cases arbitrary input', () => {
		expect(normalizeSkillName('My Fancy Skill!')).toBe('my-fancy-skill');
		expect(normalizeSkillName('--already-fine--')).toBe('already-fine');
	});
});

describe('task scope', () => {
	it('normalises a list', () => {
		expect(normalizeTasks(' Chat,coding , chat,, ')).toBe('chat, coding');
		expect(normalizeTasks(undefined)).toBe('');
	});

	it('applies everywhere when empty, and only where named otherwise', () => {
		expect(skillAppliesTo({ tasks: '' }, 'coding')).toBe(true);
		expect(skillAppliesTo({ tasks: 'chat' }, 'coding')).toBe(false);
		expect(skillAppliesTo({ tasks: 'chat, coding' }, 'coding')).toBe(true);
		// No task is the catalogue view, which lists everything.
		expect(skillAppliesTo({ tasks: 'chat' }, undefined)).toBe(true);
	});
});

describe('the skill index', () => {
	const ALICE = 'u-skill-alice';
	const BOB = 'u-skill-bob';
	const write = (name: string, extra: Partial<Parameters<typeof saveSkill>[0]> = {}) =>
		saveSkill({
			name,
			category: 'general',
			description: `${name} does a thing`,
			triggers: '',
			author: 'user',
			body: `# ${name}`,
			...extra
		});

	beforeAll(() => runMigrations());
	beforeEach(() => {
		db.delete(skills).run();
	});

	it('lists only the skills meant for the task', () => {
		write('figma-ish', { tasks: 'chat' });
		write('everywhere');
		const coding = skillIndexText(ALICE, 'coding');
		expect(coding).toContain('everywhere');
		expect(coding).not.toContain('figma-ish');
		expect(skillIndexText(ALICE, 'chat')).toContain('figma-ish');
	});

	it("never lists or loads someone else's personal skill", () => {
		write('alice-only', { ownerId: ALICE });
		write('shared-one');
		expect(skillIndexText(BOB, 'chat')).not.toContain('alice-only');
		expect(skillIndexText(ALICE, 'chat')).toContain('alice-only');
		expect(getSkill('alice-only', BOB)).toBeNull();
		expect(getSkill('alice-only', ALICE)?.body).toContain('alice-only');
		expect(listSkills(BOB).map((s) => s.name)).toEqual(['shared-one']);
		// Admin and the platform's own lookups see everything.
		expect(listSkills().map((s) => s.name).sort()).toEqual(['alice-only', 'shared-one']);
	});

	it('keeps its owner through an edit, and shares on request', () => {
		write('alice-only', { ownerId: ALICE });
		write('alice-only', { body: 'reworded', ownerId: BOB });
		expect(getSkill('alice-only', BOB)).toBeNull();
		setSkillOwner('alice-only', null);
		expect(getSkill('alice-only', BOB)?.body).toBe('reworded');
	});
});

describe('files beside a skill', () => {
	const dir = join(dataDir, 'skill-files-test', 'demo');
	const outside = join(dataDir, 'skill-files-test', 'secret.txt');

	beforeAll(() => {
		rmSync(join(dataDir, 'skill-files-test'), { recursive: true, force: true });
		mkdirSync(join(dir, 'references'), { recursive: true });
		writeFileSync(join(dir, 'SKILL.md'), '# demo');
		writeFileSync(join(dir, 'references', 'api.md'), 'the reference');
		writeFileSync(join(dir, '.hidden'), 'x');
		writeFileSync(outside, 'not yours');
		symlinkSync(outside, join(dir, 'link.txt'));
	});

	it('lists what sits beside SKILL.md, not SKILL.md itself, and no links', () => {
		expect(skillFiles(dir)).toEqual(['references/api.md']);
	});

	it('reads a listed file', () => {
		expect(readSkillFile(dir, 'references/api.md', 1000)).toBe('the reference');
	});

	it('refuses anything that resolves outside the skill', () => {
		expect(() => readSkillFile(dir, '../secret.txt', 1000)).toThrow(/Not a file in this skill/);
		expect(() => readSkillFile(dir, 'link.txt', 1000)).toThrow(/Not a file in this skill/);
		expect(() => readSkillFile(dir, '/etc/passwd', 1000)).toThrow(/Not a file in this skill/);
	});

	it('caps a long file', () => {
		writeFileSync(join(dir, 'long.md'), 'x'.repeat(50));
		expect(readSkillFile(dir, 'long.md', 10)).toMatch(/^x{10}\n\n\[truncated at 10 characters\]$/);
	});
});
