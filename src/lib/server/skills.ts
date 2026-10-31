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
import { and, asc, desc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { skillCandidates, skills } from '$lib/server/db/schema';
import { applySkillPatch, lineDiff, type DiffLine, type SkillPatch } from '$lib/skill-patch';

export type Skill = typeof skills.$inferSelect;
export type SkillCandidate = typeof skillCandidates.$inferSelect;

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
	// A change to a skill that is gone can never apply.
	db.update(skillCandidates)
		.set({ status: 'rejected', decidedAt: new Date() })
		.where(and(eq(skillCandidates.targetSkillId, existing.id), eq(skillCandidates.status, 'pending')))
		.run();
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

/**
 * Whether this person already has a skill of this name, or has proposed one.
 *
 * Per person, where it used to be global: a check across every skill and every
 * candidate told one person's agent the names of other people's personal
 * skills ("already exists"), and let one person's rejection block another's
 * proposal. A clash this person cannot see is settled when the candidate is
 * approved, by saving under a free name (see freeSkillName).
 */
export function skillNameSeen(userId: string, name: string): boolean {
	const own = db
		.select({ id: skills.id })
		.from(skills)
		.where(and(eq(skills.name, name), skillVisibleTo(userId)))
		.get();
	if (own) return true;
	return Boolean(
		db
			.select({ id: skillCandidates.id })
			.from(skillCandidates)
			.where(
				and(
					eq(skillCandidates.name, name),
					eq(skillCandidates.userId, userId),
					eq(skillCandidates.kind, 'new')
				)
			)
			.get()
	);
}

/**
 * `name`, or `name-2`, `name-3`… whichever no skill holds yet, in the form
 * saveSkill will store it. Normalised before the check, not after: a prefix
 * cut to end in a hyphen made `…--2`, which saveSkill collapses into a `…-2`
 * that may already exist, and would then have overwritten.
 */
export function freeSkillName(name: string): string {
	const taken = (n: string) => db.select({ id: skills.id }).from(skills).where(eq(skills.name, n)).get();
	const wanted = normalizeSkillName(name);
	if (!taken(wanted)) return wanted;
	// The base is cut to leave room for the whole suffix, whatever its length:
	// a fixed cut let `-1000` be truncated back to `-100`, and the search could
	// then circle names that were all taken.
	for (let i = 2; i < 100_000; i++) {
		const suffix = `-${i}`;
		const next = `${wanted.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
		if (!taken(next)) return next;
	}
	throw new Error(`No free name near ${wanted}.`);
}

export function getSkillById(id: string, userId?: string): { meta: Skill; body: string } | null {
	const meta = db
		.select()
		.from(skills)
		.where(userId ? and(eq(skills.id, id), skillVisibleTo(userId)) : eq(skills.id, id))
		.get();
	return meta ? getSkill(meta.name) : null;
}

/** A change that cannot be applied to the skill as it now stands. */
export class SkillPatchConflict extends Error {}

/**
 * File a change to an existing skill for approval.
 *
 * Checked against the body as it stands, so a change that could never apply is
 * refused while its author can still fix it. One waiting change per proposer
 * and skill: a second would be decided against a body the first may change.
 * `userId` null is the skill optimiser, whose changes an admin decides.
 */
export function proposeSkillPatch(opts: {
	userId: string | null;
	skill: { meta: Skill; body: string };
	patch: SkillPatch;
	rationale: string;
}): SkillCandidate {
	const { meta, body } = opts.skill;
	const applied = applySkillPatch(body, opts.patch.edits);
	if (!applied.ok) throw new Error(applied.problem);
	const waiting = db
		.select({ id: skillCandidates.id })
		.from(skillCandidates)
		.where(
			and(
				eq(skillCandidates.kind, 'patch'),
				eq(skillCandidates.targetSkillId, meta.id),
				eq(skillCandidates.status, 'pending'),
				opts.userId === null ? isNull(skillCandidates.userId) : eq(skillCandidates.userId, opts.userId)
			)
		)
		.get();
	if (waiting) {
		throw new Error(`A change to ${meta.name} is already waiting for a decision. Mention this one in your reply instead.`);
	}
	const row: SkillCandidate = {
		id: randomUUID(),
		userId: opts.userId,
		name: meta.name,
		category: meta.category,
		description: opts.patch.description?.trim() || meta.description,
		triggers: opts.patch.triggers?.trim() || meta.triggers,
		tasks: meta.tasks,
		body: applied.body,
		rationale: opts.rationale.trim().slice(0, 1000),
		status: 'pending',
		kind: 'patch',
		targetSkillId: meta.id,
		baseVersion: meta.version,
		patch: opts.patch,
		createdAt: new Date(),
		decidedAt: null
	};
	db.insert(skillCandidates).values(row).run();
	return row;
}

/**
 * Who may decide a candidate, as a predicate.
 *
 * The person whose activity proposed it; and for a change to an existing
 * skill, only when the skill is also theirs. A change to a shared skill, or to
 * someone else's, is an admin's to decide, and answers "not found" here.
 */
function decidableBy(userId: string): SQL {
	return and(
		eq(skillCandidates.userId, userId),
		or(eq(skillCandidates.kind, 'new'), eq(skills.ownerId, userId))
	)!;
}

/** A one-line field a change replaces, as it is and as it would be. */
export interface FieldChange {
	from: string;
	to: string;
}

export type CandidatePreview =
	| {
			kind: 'patch';
			applies: true;
			diff: DiffLine[];
			drifted: boolean;
			/**
			 * The description and triggers, where the change replaces them. They
			 * reach every future agent's skill index, so approving them unseen
			 * would be approving more than the diff shows.
			 */
			fields: { description?: FieldChange; triggers?: FieldChange };
	  }
	| { kind: 'patch'; applies: false; problem: string }
	/** A new skill whose name another skill has taken since; it saves as `savesAs`. */
	| { kind: 'new'; savesAs: string };

/**
 * What approving would do, for the person deciding: the diff a change makes to
 * the skill as it is now, or why it no longer applies. Null for a new skill
 * with nothing to say.
 *
 * With `viewer`, a name clash is reported only when the skill holding the name
 * is one they can see. Otherwise the preview would answer "does a private skill
 * of this name exist?" for anyone able to get an agent to propose that name.
 * Approval still saves under a free name either way, which is the residue a
 * single namespace for every person's skills leaves.
 */
export function candidatePreview(c: SkillCandidate, viewer?: string): CandidatePreview | null {
	if (c.kind === 'new') {
		const savesAs = freeSkillName(c.name);
		if (savesAs === c.name) return null;
		if (viewer && !skillNameSeenAsSkill(viewer, c.name)) return null;
		return { kind: 'new', savesAs };
	}
	const target = c.targetSkillId ? getSkillById(c.targetSkillId) : null;
	if (!target) return { kind: 'patch', applies: false, problem: 'The skill this change was for has been deleted.' };
	const applied = applySkillPatch(target.body, c.patch?.edits ?? []);
	if (!applied.ok) return { kind: 'patch', applies: false, problem: applied.problem };
	const field = (to: string | undefined, from: string): FieldChange | undefined =>
		to?.trim() && to.trim() !== from ? { from, to: to.trim() } : undefined;
	const description = field(c.patch?.description, target.meta.description);
	const triggers = field(c.patch?.triggers, target.meta.triggers);
	return {
		kind: 'patch',
		applies: true,
		diff: lineDiff(target.body, applied.body),
		drifted: c.baseVersion !== target.meta.version,
		fields: { ...(description ? { description } : {}), ...(triggers ? { triggers } : {}) }
	};
}

/** Whether a skill this person can see holds the name. */
function skillNameSeenAsSkill(userId: string, name: string): boolean {
	return Boolean(
		db
			.select({ id: skills.id })
			.from(skills)
			.where(and(eq(skills.name, normalizeSkillName(name)), skillVisibleTo(userId)))
			.get()
	);
}

export function listCandidates(): SkillCandidate[] {
	return db
		.select()
		.from(skillCandidates)
		.orderBy(desc(skillCandidates.createdAt), skillCandidates.id)
		.all();
}

/**
 * The candidates one person's activity proposed and they may decide, whatever
 * became of them. A change they proposed to a shared skill waits in Admin.
 */
export function listCandidatesOf(userId: string): SkillCandidate[] {
	return db
		.select({ cand: skillCandidates })
		.from(skillCandidates)
		.leftJoin(skills, eq(skills.id, skillCandidates.targetSkillId))
		.where(decidableBy(userId))
		.orderBy(desc(skillCandidates.createdAt))
		.all()
		.map((r) => r.cand);
}

/**
 * Approving writes the skill or applies the change; both paths close the
 * candidate.
 *
 * An admin may decide any candidate. With `by`, only what `decidableBy`
 * allows, and anything else is "not found". A new skill belongs to the person
 * whose activity proposed it, because it was learnt from their conversations;
 * an admin shares it from Admin.
 *
 * A new skill whose name is taken by then is saved under a free name. It used
 * to go through saveSkill's update path instead, which replaced the body of
 * whatever skill held the name, a shared one or another person's included.
 *
 * A change is applied to the skill as it is now, not the body stored with the
 * candidate. If the skill is gone, or has moved so the change no longer lands
 * in one place, this throws SkillPatchConflict and the candidate stays pending.
 * Owner, tasks, enabled state and the files beside SKILL.md are kept.
 */
export function decideCandidate(
	id: string,
	approve: boolean,
	by?: { userId: string }
): SkillCandidate | null {
	const found = db
		.select({ cand: skillCandidates })
		.from(skillCandidates)
		.leftJoin(skills, eq(skills.id, skillCandidates.targetSkillId))
		.where(by ? and(eq(skillCandidates.id, id), decidableBy(by.userId)) : eq(skillCandidates.id, id))
		.get();
	const cand = found?.cand;
	if (!cand || cand.status !== 'pending') return null;
	if (approve && cand.kind === 'patch') {
		const target = cand.targetSkillId ? getSkillById(cand.targetSkillId) : null;
		if (!target) throw new SkillPatchConflict('The skill this change was for has been deleted.');
		const applied = applySkillPatch(target.body, cand.patch?.edits ?? []);
		if (!applied.ok) {
			throw new SkillPatchConflict(`The skill has changed since this was proposed: ${applied.problem}`);
		}
		saveSkill({
			name: target.meta.name,
			category: target.meta.category,
			description: cand.patch?.description?.trim() || target.meta.description,
			triggers: cand.patch?.triggers?.trim() || target.meta.triggers,
			author: target.meta.author,
			body: applied.body
		});
	} else if (approve) {
		const name = freeSkillName(cand.name);
		saveSkill({
			name,
			category: cand.category,
			description: cand.description,
			triggers: cand.triggers,
			tasks: cand.tasks,
			author: 'agent',
			body: cand.body,
			ownerId: cand.userId
		});
		if (name !== cand.name) {
			db.update(skillCandidates).set({ name }).where(eq(skillCandidates.id, id)).run();
		}
	}
	db.update(skillCandidates)
		.set({ status: approve ? 'approved' : 'rejected', decidedAt: new Date() })
		.where(eq(skillCandidates.id, id))
		.run();
	return db.select().from(skillCandidates).where(eq(skillCandidates.id, id)).get() ?? null;
}
