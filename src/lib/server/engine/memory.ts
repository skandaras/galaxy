import { randomUUID } from 'node:crypto';
import { desc, eq, gt, and } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	chats,
	codeSessions,
	memoryItems,
	messages,
	skillCandidates,
	usageLog,
	users
} from '$lib/server/db/schema';
import { listSkills, saveSkill } from '$lib/server/skills';
import { getSetting, setSetting } from '$lib/server/settings';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';

const WATERMARK_KEY = 'memory.watermark';
const LAST_RUN_KEY = 'memory.lastRun';
const USER_ENABLED_KEY = 'memory.userEnabled';
const MAX_ACTIVITY_CHARS = 40_000;

export type MemoryItem = typeof memoryItems.$inferSelect;
export type SkillCandidate = typeof skillCandidates.$inferSelect;

/** Watermark and last-run are per user, stored at that user's settings scope. */
export function getMemoryStatus(userId: string) {
	return {
		watermark: getSetting<number>(WATERMARK_KEY, 0, userId),
		lastRun: getSetting<number>(LAST_RUN_KEY, 0, userId),
		enabled: getSetting<boolean>(USER_ENABLED_KEY, true, userId)
	};
}

export function setUserMemoryEnabled(userId: string, enabled: boolean): void {
	setSetting(USER_ENABLED_KEY, enabled, userId);
}

/** A user's own memories. Never call this without an owner for user-facing output. */
export function listMemoryItems(userId: string): MemoryItem[] {
	return db
		.select()
		.from(memoryItems)
		.where(eq(memoryItems.userId, userId))
		.orderBy(desc(memoryItems.createdAt))
		.all();
}

export function listCandidates(): SkillCandidate[] {
	return db.select().from(skillCandidates).orderBy(desc(skillCandidates.createdAt)).all();
}

/** Both mutations are owner-scoped: a non-owner's id simply matches no row. */
export function archiveMemoryItem(id: string, userId: string): boolean {
	const res = db
		.update(memoryItems)
		.set({ status: 'archived' })
		.where(and(eq(memoryItems.id, id), eq(memoryItems.userId, userId)))
		.run();
	return res.changes > 0;
}

export function deleteMemoryItem(id: string, userId: string): boolean {
	const res = db
		.delete(memoryItems)
		.where(and(eq(memoryItems.id, id), eq(memoryItems.userId, userId)))
		.run();
	return res.changes > 0;
}

/** Approving writes the real (agent-authored) skill; both paths close the candidate. */
export function decideCandidate(id: string, approve: boolean): SkillCandidate | null {
	const cand = db.select().from(skillCandidates).where(eq(skillCandidates.id, id)).get();
	if (!cand || cand.status !== 'pending') return null;
	if (approve) {
		saveSkill({
			name: cand.name,
			category: cand.category,
			description: cand.description,
			triggers: cand.triggers,
			author: 'agent',
			body: cand.body
		});
	}
	db.update(skillCandidates)
		.set({ status: approve ? 'approved' : 'rejected', decidedAt: new Date() })
		.where(eq(skillCandidates.id, id))
		.run();
	return db.select().from(skillCandidates).where(eq(skillCandidates.id, id)).get() ?? null;
}

/**
 * Active memory for one user, formatted for the context bootstrap. Only ever
 * that user's own items — this is what keeps one person's observations out of
 * another person's system prompt.
 */
export function memoryDigest(userId: string, maxItems = 20): string {
	const items = listMemoryItems(userId).filter((m) => m.status === 'active');
	if (!items.length) return '';
	const lines = items.slice(0, maxItems).map((m) => `- (${m.kind}) ${m.content}`);
	return ['', '[Memory — durable observations from past activity]', ...lines].join('\n');
}

/** Content-free per-user status for the admin panel. Never returns memory text. */
export function memoryStatusByUser(): {
	userId: string;
	username: string;
	lastRun: number;
	enabled: boolean;
	activeItems: number;
}[] {
	return db
		.select()
		.from(users)
		.all()
		.map((u) => {
			const status = getMemoryStatus(u.id);
			return {
				userId: u.id,
				username: u.username,
				lastRun: status.lastRun,
				enabled: status.enabled,
				activeItems: listMemoryItems(u.id).filter((m) => m.status === 'active').length
			};
		});
}

interface ActivityDigest {
	text: string;
	empty: boolean;
}

/**
 * One user's activity since their watermark. Hidden chats never reach here —
 * they are held in memory and never written to the chats table.
 *
 * The Library is deliberately not audited: it is shared and its rows carry no
 * owner, so attributing changes to a user is impossible, and `libraryDigest()`
 * already lists every document in the bootstrap — auditing it again only
 * produced the same observation duplicated into every user's memory.
 */
function gatherActivity(userId: string, sinceMs: number): ActivityDigest {
	const since = new Date(sinceMs);
	const parts: string[] = [];

	const newChats = db
		.select()
		.from(chats)
		.where(and(eq(chats.userId, userId), gt(chats.updatedAt, since)))
		.all();
	for (const chat of newChats.slice(0, 20)) {
		const msgs = db
			.select()
			.from(messages)
			.where(and(eq(messages.chatId, chat.id), gt(messages.createdAt, since)))
			.all();
		if (!msgs.length) continue;
		parts.push(
			`## ${chat.mode === 'code' ? 'Coding session' : 'Chat'}: ${chat.title}\n` +
				msgs
					.slice(0, 30)
					.map((m) => `${m.role}: ${m.content.slice(0, 600)}`)
					.join('\n')
		);
	}

	const sessions = db
		.select()
		.from(codeSessions)
		.where(and(eq(codeSessions.userId, userId), gt(codeSessions.createdAt, since)))
		.all();
	if (sessions.length) {
		parts.push(
			'## New coding sessions\n' +
				sessions.map((s) => `- ${s.repoName} on ${s.workBranch} (${s.mode})`).join('\n')
		);
	}

	return { text: parts.join('\n\n').slice(0, MAX_ACTIVITY_CHARS), empty: parts.length === 0 };
}

/**
 * One memory audit: look at everything new since the watermark, extract
 * durable memories and skill candidates, advance the watermark. Skips
 * cleanly when there is no new activity or the budget cap is hit.
 */
export async function runMemory(
	trigger: 'schedule' | 'manual',
	userId: string
): Promise<{
	ran: boolean;
	reason?: string;
	memories?: number;
	candidates?: number;
}> {
	const startedAt = Date.now();
	setSetting(LAST_RUN_KEY, startedAt, userId);
	const { watermark } = getMemoryStatus(userId);

	const activity = gatherActivity(userId, watermark);
	if (activity.empty) {
		emitEvent({
			userId,
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'ok',
			detail: { trigger, skipped: true, reason: 'no new activity' }
		});
		return { ran: false, reason: 'no new activity' };
	}
	if (getBudgetStatus().blocked) {
		emitEvent({
			userId,
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'error',
			detail: { trigger, skipped: true, reason: 'budget cap reached' }
		});
		return { ran: false, reason: 'budget cap reached' };
	}

	const cfg = getTaskConfig('memory');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) {
		emitEvent({
			userId,
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'error',
			detail: { trigger, reason: 'no model configured' }
		});
		return { ran: false, reason: 'no model configured' };
	}

	const existingMemories = listMemoryItems(userId)
		.filter((m) => m.status === 'active')
		.map((m) => m.content)
		.join('\n');
	const existingSkills = listSkills()
		.map((s) => s.name)
		.join(', ');

	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: cfg?.systemPrompt ?? '' },
					{
						role: 'user',
						content: [
							'MEMORY-AUDIT: Review the activity below. Extract durable, clearly-supported observations and (rarely) reusable skill candidates.',
							'Reply with ONLY a JSON object: {"memories":[{"kind":"preference|pattern|fact","content":"…"}],"skill_candidates":[{"name":"kebab-case","category":"…","description":"…","triggers":"a, b","body":"markdown instructions","rationale":"why this is worth a skill"}]}',
							'Do not repeat existing memories. Do not propose skills that already exist.',
							`Existing memories:\n${existingMemories || '(none)'}`,
							`Existing skills: ${existingSkills || '(none)'}`,
							`--- ACTIVITY ---\n${activity.text}`
						].join('\n\n')
					}
				],
				maxTokens: 2048
			},
			AbortSignal.timeout(120_000)
		);

		const parsed = extractJson(text);
		const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
		const candidates = Array.isArray(parsed?.skill_candidates) ? parsed.skill_candidates : [];
		const source = `memory-run ${new Date(startedAt).toISOString()}`;

		for (const m of memories.slice(0, 20)) {
			if (typeof m?.content !== 'string' || !m.content.trim()) continue;
			db.insert(memoryItems)
				.values({
					id: randomUUID(),
					userId,
					kind: ['preference', 'pattern', 'fact'].includes(m.kind) ? m.kind : 'fact',
					content: m.content.trim().slice(0, 1000),
					source,
					status: 'active',
					createdAt: new Date()
				})
				.run();
		}

		const knownSkills = new Set(listSkills().map((s) => s.name));
		const pendingNames = new Set(
			listCandidates()
				.filter((c) => c.status === 'pending')
				.map((c) => c.name)
		);
		let added = 0;
		for (const c of candidates.slice(0, 5)) {
			const name = String(c?.name ?? '').trim();
			if (!name || knownSkills.has(name) || pendingNames.has(name)) continue;
			db.insert(skillCandidates)
				.values({
					id: randomUUID(),
					userId,
					name,
					category: String(c.category ?? 'general'),
					description: String(c.description ?? ''),
					triggers: String(c.triggers ?? ''),
					body: String(c.body ?? ''),
					rationale: String(c.rationale ?? ''),
					status: 'pending',
					createdAt: new Date()
				})
				.run();
			added++;
		}

		// Only advance the watermark on a successful run, so a failure re-reads
		// the same window next time instead of silently losing activity.
		setSetting(WATERMARK_KEY, startedAt, userId);
		logMemoryUsage(choice.model.modelKey, usage, 'ok', userId);
		emitEvent({
			userId,
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'ok',
			durationMs: Date.now() - startedAt,
			detail: { trigger, memories: memories.length, candidates: added }
		});
		return { ran: true, memories: memories.length, candidates: added };
	} catch (err) {
		logMemoryUsage(choice.model.modelKey, null, 'error', userId);
		emitEvent({
			userId,
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { trigger, error: String(err) }
		});
		return { ran: false, reason: String(err) };
	}
}

/**
 * Ask the skill-optimiser to review existing skills; proposals join the queue.
 * Global, not per user: skills are platform-wide. `adminUserId` is recorded as
 * the candidate's origin so the queue shows where it came from.
 */
export async function runSkillOptimiser(
	adminUserId?: string
): Promise<{ ran: boolean; reason?: string; candidates?: number }> {
	const enabled = listSkills().filter((s) => s.enabled);
	if (!enabled.length) return { ran: false, reason: 'no skills to optimise' };
	if (getBudgetStatus().blocked) return { ran: false, reason: 'budget cap reached' };
	const cfg = getTaskConfig('skill-optimiser');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) return { ran: false, reason: 'no model configured' };

	const skillDump = enabled
		.map((s) => `### ${s.name} (${s.category}) v${s.version}\n${s.description}\ntriggers: ${s.triggers}`)
		.join('\n\n')
		.slice(0, MAX_ACTIVITY_CHARS);
	const startedAt = Date.now();
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: cfg?.systemPrompt ?? '' },
					{
						role: 'user',
						content: [
							'SKILL-OPTIMISE: Review the skill index below for unclear descriptions, overlap, or missing triggers. Propose improved versions only where clearly better.',
							'Reply with ONLY JSON: {"skill_candidates":[{"name":"existing-or-new-name","category":"…","description":"…","triggers":"…","body":"full improved markdown body","rationale":"…"}]}',
							`--- SKILLS ---\n${skillDump}`
						].join('\n\n')
					}
				],
				maxTokens: 2048
			},
			AbortSignal.timeout(120_000)
		);
		const parsed = extractJson(text);
		const candidates = Array.isArray(parsed?.skill_candidates) ? parsed.skill_candidates : [];
		const pendingNames = new Set(
			listCandidates()
				.filter((c) => c.status === 'pending')
				.map((c) => c.name)
		);
		let added = 0;
		for (const c of candidates.slice(0, 5)) {
			const name = String(c?.name ?? '').trim();
			if (!name || pendingNames.has(name)) continue;
			db.insert(skillCandidates)
				.values({
					id: randomUUID(),
					userId: adminUserId ?? null,
					name,
					category: String(c.category ?? 'general'),
					description: String(c.description ?? ''),
					triggers: String(c.triggers ?? ''),
					body: String(c.body ?? ''),
					rationale: String(c.rationale ?? '(skill optimiser)'),
					status: 'pending',
					createdAt: new Date()
				})
				.run();
			added++;
		}
		logOptimiserUsage(choice.model.modelKey, usage, 'ok', adminUserId);
		emitEvent({
			task: 'skill-optimiser',
			type: 'job',
			name: 'optimise.run',
			status: 'ok',
			durationMs: Date.now() - startedAt,
			detail: { candidates: added }
		});
		return { ran: true, candidates: added };
	} catch (err) {
		emitEvent({
			task: 'skill-optimiser',
			type: 'job',
			name: 'optimise.run',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { error: String(err) }
		});
		return { ran: false, reason: String(err) };
	}
}

function extractJson(text: string): Record<string, unknown> | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

function logMemoryUsage(
	modelKey: string,
	usage: { promptTokens: number; completionTokens: number } | null,
	status: 'ok' | 'error',
	userId?: string
) {
	insertUsage('memory', modelKey, usage, status, userId);
}
function logOptimiserUsage(
	modelKey: string,
	usage: { promptTokens: number; completionTokens: number } | null,
	status: 'ok' | 'error',
	userId?: string
) {
	insertUsage('skill-optimiser', modelKey, usage, status, userId);
}
function insertUsage(
	task: string,
	modelKey: string,
	usage: { promptTokens: number; completionTokens: number } | null,
	status: 'ok' | 'error',
	userId?: string
) {
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: userId ?? null,
			chatId: null,
			task,
			modelKey,
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			costUsd: null,
			status
		})
		.run();
}
