import { randomUUID } from 'node:crypto';
import { desc, eq, gt, and } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	chats,
	codeSessions,
	libraryDocs,
	memoryItems,
	messages,
	skillCandidates,
	usageLog
} from '$lib/server/db/schema';
import { listSkills, saveSkill } from '$lib/server/skills';
import { getSetting, setSetting } from '$lib/server/settings';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';

const WATERMARK_KEY = 'memory.watermark';
const LAST_RUN_KEY = 'memory.lastRun';
const MAX_ACTIVITY_CHARS = 40_000;

export type MemoryItem = typeof memoryItems.$inferSelect;
export type SkillCandidate = typeof skillCandidates.$inferSelect;

export function getMemoryStatus() {
	return {
		watermark: getSetting<number>(WATERMARK_KEY, 0),
		lastRun: getSetting<number>(LAST_RUN_KEY, 0)
	};
}

export function listMemoryItems(): MemoryItem[] {
	return db.select().from(memoryItems).orderBy(desc(memoryItems.createdAt)).all();
}

export function listCandidates(): SkillCandidate[] {
	return db.select().from(skillCandidates).orderBy(desc(skillCandidates.createdAt)).all();
}

export function archiveMemoryItem(id: string): void {
	db.update(memoryItems).set({ status: 'archived' }).where(eq(memoryItems.id, id)).run();
}

export function deleteMemoryItem(id: string): void {
	db.delete(memoryItems).where(eq(memoryItems.id, id)).run();
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

/** Active memory, formatted for the context bootstrap. */
export function memoryDigest(maxItems = 20): string {
	const items = listMemoryItems().filter((m) => m.status === 'active');
	if (!items.length) return '';
	const lines = items.slice(0, maxItems).map((m) => `- (${m.kind}) ${m.content}`);
	return ['', '[Memory — durable observations from past activity]', ...lines].join('\n');
}

interface ActivityDigest {
	text: string;
	empty: boolean;
}

function gatherActivity(sinceMs: number): ActivityDigest {
	const since = new Date(sinceMs);
	const parts: string[] = [];

	const newChats = db.select().from(chats).where(gt(chats.updatedAt, since)).all();
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

	const docs = db.select().from(libraryDocs).where(gt(libraryDocs.updatedAt, since)).all();
	if (docs.length) {
		parts.push(
			'## Library changes\n' + docs.map((d) => `- ${d.title}: ${d.snippet.slice(0, 200)}`).join('\n')
		);
	}

	const sessions = db.select().from(codeSessions).where(gt(codeSessions.createdAt, since)).all();
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
export async function runMemory(trigger: 'schedule' | 'manual'): Promise<{
	ran: boolean;
	reason?: string;
	memories?: number;
	candidates?: number;
}> {
	const startedAt = Date.now();
	setSetting(LAST_RUN_KEY, startedAt);
	const { watermark } = getMemoryStatus();

	const activity = gatherActivity(watermark);
	if (activity.empty) {
		emitEvent({
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
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'error',
			detail: { trigger, reason: 'no model configured' }
		});
		return { ran: false, reason: 'no model configured' };
	}

	const existingMemories = listMemoryItems()
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

		setSetting(WATERMARK_KEY, startedAt);
		logMemoryUsage(choice.model.modelKey, usage, 'ok');
		emitEvent({
			task: 'memory',
			type: 'job',
			name: 'memory.run',
			status: 'ok',
			durationMs: Date.now() - startedAt,
			detail: { trigger, memories: memories.length, candidates: added }
		});
		return { ran: true, memories: memories.length, candidates: added };
	} catch (err) {
		logMemoryUsage(choice.model.modelKey, null, 'error');
		emitEvent({
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

/** Ask the skill-optimiser to review existing skills; proposals join the queue. */
export async function runSkillOptimiser(): Promise<{ ran: boolean; reason?: string; candidates?: number }> {
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
		logOptimiserUsage(choice.model.modelKey, usage, 'ok');
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
	status: 'ok' | 'error'
) {
	insertUsage('memory', modelKey, usage, status);
}
function logOptimiserUsage(
	modelKey: string,
	usage: { promptTokens: number; completionTokens: number } | null,
	status: 'ok' | 'error'
) {
	insertUsage('skill-optimiser', modelKey, usage, status);
}
function insertUsage(
	task: string,
	modelKey: string,
	usage: { promptTokens: number; completionTokens: number } | null,
	status: 'ok' | 'error'
) {
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: null,
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
