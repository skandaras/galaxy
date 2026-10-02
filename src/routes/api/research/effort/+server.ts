import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { RESEARCH_EFFORTS, type ResearchEffort } from '$lib/research-effort';
import { roundBudget, type RoundBudget } from '$lib/server/engine/research';
import { researchSettings } from '$lib/server/settings';
import { getTaskConfig } from '$lib/server/engine/engine';
import { listEnabledModels, resolveModel } from '$lib/server/providers/registry';

/**
 * What each effort level would actually buy, given the current admin ceiling.
 *
 * The composer's effort popover shows these numbers, and it must not compute
 * them: the mapping belongs to the server that will run the round loop, so a
 * stale client cannot promise rounds an admin has since taken away. Read-only
 * and non-secret — every user sees the same ceiling the runs observe.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const cfg = researchSettings();
	const levels = {} as Record<ResearchEffort, RoundBudget>;
	for (const effort of RESEARCH_EFFORTS) levels[effort] = roundBudget(cfg, effort);
	return json({
		roundCeiling: levels.exhaustive.roundCeiling,
		levels,
		modelName: researchModelName()
	});
};

/**
 * The model a research run will use, named so the chat header can say so in
 * Research mode instead of greying out a picker that is ignored.
 *
 * Resolved the way startResearchTurn resolves it, but without pickModel: that
 * records a failover event whenever it substitutes, and a page load is not a
 * substitution anyone needs logged.
 */
function researchModelName(): string | null {
	const configured = getTaskConfig('deep-research')?.primaryModelId;
	const direct = configured ? resolveModel(configured) : null;
	if (direct) return direct.model.displayName;
	return listEnabledModels()[0]?.displayName ?? null;
}
