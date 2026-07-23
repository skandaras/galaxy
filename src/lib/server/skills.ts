import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
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
}

const skillsDir = () => join(dataDir, 'skills');

export const SKILL_TEMPLATE = `---
name: my-skill-name
description: One line saying when and why an agent should use this skill.
category: general
version: 1
author: user
triggers: keyword-one, keyword-two
---

## When to use

Describe the situations this skill applies to.

## Instructions

Step-by-step guidance the agent should follow. Keep it focused: one skill,
one capability. Link Library docs by title where helpful.
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
			author: meta.author === 'agent' ? 'agent' : meta.author === 'user' ? 'user' : undefined
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

export function listSkills(): Skill[] {
	return db.select().from(skills).orderBy(asc(skills.category), asc(skills.name)).all();
}

export function getSkill(name: string): { meta: Skill; body: string } | null {
	const meta = db.select().from(skills).where(eq(skills.name, name)).get();
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
}): Skill {
	ensureSkillsRepo();
	const name = normalizeSkillName(opts.name);
	if (!name) throw new Error('Skill name is required');
	const now = new Date();
	const existing = db.select().from(skills).where(eq(skills.name, name)).get();
	const version = (existing?.version ?? 0) + 1;
	const category = normalizeSkillName(opts.category) || 'general';

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
				author: existing?.author ?? opts.author
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

/** Categorised one-liner index injected into agent context at session start. */
export function skillIndexText(maxSkills = 60): string {
	const enabled = listSkills().filter((s) => s.enabled);
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
