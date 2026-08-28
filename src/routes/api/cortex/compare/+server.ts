import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { comparisonContext, type ComparisonSide } from '$lib/server/cortex';
import { getTaskConfig, pickModel } from '$lib/server/engine/engine';
import { getBudgetStatus } from '$lib/server/engine/budget';
import { logUsage } from '$lib/server/engine/usage';

/**
 * The same question, answered twice: once knowing this person, once not.
 *
 * The design's oldest weakness is that everything it claims about itself is
 * unfalsifiable — "richer context", "understands how things connect". The eval
 * fixture answers half of that by measuring whether retrieval returns the right
 * concepts. This answers the half that matters: does having them change the
 * reply, and for the better.
 *
 * **What varies is the context, not the agent.** The lattice side gets the
 * activated subgraph injected rather than being left to call `cortex_query`
 * itself. That isolates one variable — mixing them would leave a poor answer
 * ambiguous between "the lattice had nothing useful" and "the agent never
 * looked", and the second question is what the context digest is for.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
	if (!prompt) error(400, 'prompt is required');
	if (getBudgetStatus().blocked) error(429, 'Budget cap reached');

	const cfg = getTaskConfig('chat');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) error(503, 'No model configured for the chat task');

	// Scoped like every other Cortex read: their own concepts plus what is shared.
	const { text: context, concepts } = comparisonContext(user.id, prompt);

	const run = async (extra: string): Promise<ComparisonSide> => {
		const system = [cfg?.systemPrompt ?? '', extra].filter(Boolean).join('\n\n');
		const startedAt = Date.now();
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: prompt }
				],
				maxTokens: 1024
			},
			AbortSignal.timeout(120_000)
		);
		logUsage('chat', choice.model.modelKey, usage, 'ok', user.id);
		return {
			answer: text,
			promptChars: system.length + prompt.length,
			promptTokens: usage?.promptTokens ?? null,
			completionTokens: usage?.completionTokens ?? null,
			ms: Date.now() - startedAt
		};
	};

	// Sequential rather than parallel: two calls at once race the budget cap,
	// and this is a thing someone runs a handful of times, not a hot path.
	const withLattice = await run(context);
	const without = await run('');

	return json({ prompt, withLattice, without, concepts });
};
