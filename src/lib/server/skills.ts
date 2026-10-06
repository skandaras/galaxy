import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { skills } from '$lib/server/db/schema';

export type Skill = typeof skills.$inferSelect;

export interface SkillMeta {
	name: string;
	category: string;
	description: string;
	triggers: string;
	version: number;
	author: 'user' | 'agent';
	/** Comma-separated tasks whose index lists it; empty for every task. */
	tasks: string;
}

const skillsDir = () => join(dataDir, 'skills');

export const SKILL_TEMPLATE = `---
name: my-skill-name
description: One line saying when and why an agent should use this skill.
category: general
version: 1
author: user
triggers: keyword-one, keyword-two
tasks:
---

## When to use

Describe the situations this skill applies to.

## Instructions

Step-by-step guidance the agent should follow. Keep it focused: one skill,
one capability. Link Library docs by title where helpful. Longer reference
material can sit beside this file in the skill's folder, where an agent reads
it with skill_read only when it needs it.

\`tasks\` limits which agents list this skill (chat, coding, deep-research…);
leave it empty for all of them.
`;

/** Ensure the skills directory exists and is a git repo (versioning every edit). */
export function ensureSkillsRepo(): void {
	mkdirSync(skillsDir(), { recursive: true });
	if (!existsSync(join(skillsDir(), '.git'))) {
		try {
			git('init', '-q');
			git('config', 'user.email', 'galaxy@localhost');
			git('config', 'user.name', 'Galaxy');
			writeFileSync(join(skillsDir(), 'TEMPLATE.md'), SKILL_TEMPLATE);
			git('add', '-A');
			git('commit', '-qm', 'Initialise skills repository');
		} catch {
			// git unavailable — skills still work, just unversioned
		}
	}
}

function git(...args: string[]): void {
	execFileSync('git', args, { cwd: skillsDir(), stdio: 'ignore' });
}

function commitSkills(message: string): void {
	try {
		git('add', '-A');
		git('commit', '-qm', message);
	} catch {
		/* nothing staged or git unavailable */
	}
}

export function parseFrontmatter(raw: string): { meta: Partial<SkillMeta>; body: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { meta: {}, body: raw };
	const meta: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (kv) meta[kv[1]] = kv[2].trim();
	}
	return {
		meta: {
			name: meta.name,
			category: meta.category,
			description: meta.description,
			triggers: meta.triggers,
			version: meta.version ? Number(meta.version) : undefined,
			author: meta.author === 'agent' ? 'agent' : meta.author === 'user' ? 'user' : undefined,
			tasks: meta.tasks
		},
		body: m[2].replace(/^\r?\n/, '')
	};
}

export function serializeSkill(meta: SkillMeta, body: string): string {
	return [
		'---',
		`name: ${meta.name}`,
		`description: ${meta.description}`,
		`category: ${meta.category}`,
		`version: ${meta.version}`,
		`author: ${meta.author}`,
		`triggers: ${meta.triggers}`,
		`tasks: ${meta.tasks}`,
		'---',
		'',
		body.trimStart()
	].join('\n');
}

export function normalizeSkillName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

function skillPath(category: string, name: string): string {
	return join(skillsDir(), normalizeSkillName(category) || 'general', name, 'SKILL.md');
}

/** A person's own skills and every shared one. */
export function skillVisibleTo(userId: string): SQL {
	return or(isNull(skills.ownerId), eq(skills.ownerId, userId))!;
}

/**
 * Skills in category order. With a user, only those that person may see; with
 * none, every skill, which is for Admin and the platform's own lookups.
 */
export function listSkills(userId?: string): Skill[] {
	return db
		.select()
		.from(skills)
		.where(userId ? skillVisibleTo(userId) : undefined)
		.orderBy(asc(skills.category), asc(skills.name))
		.all();
}

/** Normalise a comma-separated task list. */
export function normalizeTasks(raw: unknown): string {
	return [
		...new Set(
			String(raw ?? '')
				.split(',')
				.map((t) => t.trim().toLowerCase())
				.filter(Boolean)
		)
	].join(', ');
}

/** Whether a skill belongs in a task's index. Empty means every task. */
export function skillAppliesTo(skill: Pick<Skill, 'tasks'>, task: string | undefined): boolean {
	if (!task || !skill.tasks.trim()) return true;
	return normalizeTasks(skill.tasks).split(', ').includes(task);
}

export function getSkill(name: string, userId?: string): { meta: Skill; body: string } | null {
	const meta = db
		.select()
		.from(skills)
		.where(userId ? and(eq(skills.name, name), skillVisibleTo(userId)) : eq(skills.name, name))
		.get();
	if (!meta) return null;
	const path = skillPath(meta.category, meta.name);
	const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
	return { meta, body: parseFrontmatter(raw).body };
}

export function saveSkill(opts: {
	name: string;
	category: string;
	description: string;
	triggers: string;
	author: 'user' | 'agent';
	body: string;
	enabled?: boolean;
	tasks?: string;
	/** Only for a new skill; an existing one keeps its owner. See setSkillOwner. */
	ownerId?: string | null;
}): Skill {
	ensureSkillsRepo();
	const name = normalizeSkillName(opts.name);
	if (!name) throw new Error('Skill name is required');
	const now = new Date();
	const existing = db.select().from(skills).where(eq(skills.name, name)).get();
	const version = (existing?.version ?? 0) + 1;
	const category = normalizeSkillName(opts.category) || 'general';
	const tasks = opts.tasks === undefined ? (existing?.tasks ?? '') : normalizeTasks(opts.tasks);

	// Category may change — remove the old file location first.
	if (existing && existing.category !== category) {
		rmSync(join(skillsDir(), existing.category, name), { recursive: true, force: true });
	}
	const path = skillPath(category, name);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(
		path,
		serializeSkill(
			{
				name,
				category,
				description: opts.description,
				triggers: opts.triggers,
				version,
				author: existing?.author ?? opts.author,
				tasks
			},
			opts.body
		)
	);

	const row: Skill = {
		id: existing?.id ?? randomUUID(),
		name,
		category,
		description: opts.description,
		triggers: opts.triggers,
		version,
		author: existing?.author ?? opts.author,
		enabled: opts.enabled ?? existing?.enabled ?? true,
		ownerId: existing ? existing.ownerId : (opts.ownerId ?? null),
		tasks,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	if (existing) {
		db.update(skills)
			.set({ ...row, id: existing.id })
			.where(eq(skills.id, existing.id))
			.run();
	} else {
		db.insert(skills).values(row).run();
	}
	commitSkills(`${existing ? 'Update' : 'Add'} skill ${name} (v${version})`);
	return row;
}

/** Share a skill with everyone (null), or hand it to one person. */
export function setSkillOwner(name: string, ownerId: string | null): void {
	db.update(skills).set({ ownerId, updatedAt: new Date() }).where(eq(skills.name, name)).run();
}

export function setSkillEnabled(name: string, enabled: boolean): void {
	db.update(skills).set({ enabled, updatedAt: new Date() }).where(eq(skills.name, name)).run();
}

export function deleteSkill(name: string): boolean {
	const existing = db.select().from(skills).where(eq(skills.name, name)).get();
	if (!existing) return false;
	db.delete(skills).where(eq(skills.id, existing.id)).run();
	rmSync(join(skillsDir(), existing.category, existing.name), { recursive: true, force: true });
	commitSkills(`Remove skill ${existing.name}`);
	return true;
}

/**
 * Categorised one-liner index injected into agent context at session start:
 * the skills this person may see, and only those meant for this task.
 */
export function skillIndexText(userId?: string, task?: string, maxSkills = 60): string {
	const enabled = listSkills(userId).filter((s) => s.enabled && skillAppliesTo(s, task));
	if (!enabled.length) return '(no skills defined yet)';
	const lines: string[] = [];
	let currentCategory = '';
	for (const s of enabled.slice(0, maxSkills)) {
		if (s.category !== currentCategory) {
			currentCategory = s.category;
			lines.push(`${currentCategory}:`);
		}
		lines.push(
			`  - ${s.name}: ${s.description}${s.triggers ? ` (triggers: ${s.triggers})` : ''}`
		);
	}
	if (enabled.length > maxSkills) lines.push(`…and ${enabled.length - maxSkills} more.`);
	return lines.join('\n');
}

/** Files a skill may carry beside SKILL.md, listed for the agent. */
const MAX_SKILL_FILES = 50;

/**
 * The files in a skill's folder other than SKILL.md: reference material,
 * templates, scripts. Listed by `skill_load` and read one at a time with
 * `skill_read`, so a long reference costs nothing until it is needed.
 */
export function skillFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (at: string) => {
		let entries;
		try {
			entries = readdirSync(at, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= MAX_SKILL_FILES) return;
			if (e.name.startsWith('.')) continue;
			const abs = join(at, e.name);
			if (e.isDirectory()) walk(abs);
			else if (e.isFile() && !(at === dir && e.name === 'SKILL.md')) out.push(relative(dir, abs));
		}
	};
	walk(dir);
	return out.sort();
}

/**
 * Read one file from a skill's folder, refusing anything that resolves outside
 * it, through `..` or through a link planted inside it.
 */
export function readSkillFile(dir: string, path: string, maxChars: number): string {
	const base = realpathSync(resolve(dir));
	const target = resolve(base, path);
	if (target === base || !target.startsWith(base + sep)) {
		throw new Error(`Not a file in this skill: ${path}`);
	}
	if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`No such file: ${path}`);
	const real = realpathSync(target);
	if (!real.startsWith(base + sep)) throw new Error(`Not a file in this skill: ${path}`);
	const text = readFileSync(real, 'utf8');
	return text.length > maxChars
		? `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`
		: text;
}

/** The folder a stored skill's SKILL.md lives in. */
export function skillDir(meta: Pick<Skill, 'category' | 'name'>): string {
	return join(skillPath(meta.category, meta.name), '..');
}
