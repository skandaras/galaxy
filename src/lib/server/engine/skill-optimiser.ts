import { randomUUID } from 'node:crypto';
import { reasoningFor, type ModelChoice } from '$lib/server/providers/registry';
import type { Usage } from '$lib/server/providers/types';
import { db } from '$lib/server/db';
import { skillCandidates } from '$lib/server/db/schema';
import { listCandidates, listSkills } from '$lib/server/skills';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel, systemPromptFor } from './engine';
import { emitEvent } from './events';
import { extractJson } from './json';
import { learningTimeoutMs } from './profile-learn';
import { logUsage } from './usage';

/** The skill index handed to the optimiser, at most. */
const MAX_SKILLS_CHARS = 40_000;

/**
 * Ask the skill-optimiser to review existing skills; proposals join the queue.
 * Global, not per user: skills are platform-wide. `adminUserId` is recorded as
 * the candidate's origin so the queue shows where it came from.
 */
export async function runSkillOptimiser(
	adminUserId?: string
): Promise<{ ran: boolean; reason?: string; candidates?: number }> {
	/**
	 * Say why a run did not happen.
	 *
	 * All three of these returned in silence, which was survivable while the only
	 * caller was a button somebody was watching — the reason went back in the
	 * response. Now that a schedule can call it, a silent return is an agent that
	 * looks like it ran and did nothing worth reporting. The UX audit already
	 * announces its skips this way.
	 */
	const skip = (reason: string) => {
		emitEvent({
			userId: adminUserId,
			task: 'skill-optimiser',
			type: 'job',
			name: 'optimise.run',
			status: 'error',
			detail: { skipped: true, reason }
		});
		return { ran: false, reason };
	};

	// Shared skills only. A personal one was learnt from one person's
	// conversations, and this pass runs platform-wide on an admin's behalf.
	const enabled = listSkills().filter((s) => s.enabled && s.ownerId === null);
	if (!enabled.length) return skip('no skills to optimise');
	if (getBudgetStatus().blocked) return skip('budget cap reached');
	const cfg = getTaskConfig('skill-optimiser');
	const choice = pickModel(cfg?.primaryModelId ?? null, 'skill-optimiser');
	if (!choice) return skip('no model configured');

	const skillDump = enabled
		.map((s) => `### ${s.name} (${s.category}) v${s.version}\n${s.description}\ntriggers: ${s.triggers}`)
		.join('\n\n')
		.slice(0, MAX_SKILLS_CHARS);
	const startedAt = Date.now();
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: systemPromptFor('skill-optimiser') },
					{
						role: 'user',
						content: [
							'SKILL-OPTIMISE: Review the skill index below for unclear descriptions, overlap, or missing triggers. Propose improved versions only where clearly better.',
							'Reply with ONLY JSON: {"skill_candidates":[{"name":"existing-or-new-name","category":"…","description":"…","triggers":"…","body":"full improved markdown body","rationale":"…"}]}',
							`--- SKILLS ---\n${skillDump}`
						].join('\n\n')
					}
				],
				maxTokens: 2048,
				// Reads a list it was handed and emits a short structured answer.
				// Without this a reasoning model can spend the entire window
				// deliberating before it writes any of it — see reasoningFor.
				reasoning: reasoningFor(choice, 'low')
			},
			// The learning job's limit, set on the same Admin card as this one.
			AbortSignal.timeout(learningTimeoutMs())
		);
		const parsed = extractJson(text);
		const candidates = Array.isArray(parsed?.skill_candidates) ? parsed.skill_candidates : [];
		// Every candidate, whatever became of it: a rejection is a decision, and
		// filtering to `pending` let a rejected skill be proposed again forever.
		const proposedNames = new Set(listCandidates().map((c) => c.name));
		let added = 0;
		for (const c of candidates.slice(0, 5)) {
			const name = String(c?.name ?? '').trim();
			if (!name || proposedNames.has(name)) continue;
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
		logOptimiserUsage(choice, usage, 'ok', adminUserId);
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
		// A failed call may still have been billed, and the cap counts what it sees.
		logOptimiserUsage(choice, null, 'error', adminUserId);
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

const logOptimiserUsage = (
	choice: ModelChoice,
	usage: Usage | null,
	status: 'ok' | 'error',
	userId?: string
) => logUsage({ task: 'skill-optimiser', choice, usage, status, userId });
