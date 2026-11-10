import { randomUUID } from 'node:crypto';
import { systemPromptFor } from '../engine';
import { emitEvent } from '../events';
import type { LiveJob } from '../jobs';
import { exploreMaxSteps } from '../limits';
import type { LoopTool } from '../loop';
import type { ToolDef } from '$lib/server/providers/types';
import { createAnnouncer, resolveAgentModel, runNestedAgent } from './nested';
import { readOnlyCodingTools, type CodingToolContext } from './tools';

/**
 * A sub-agent that reads the repository and answers one question.
 *
 * The economics, since a sub-agent is easy to get wrong: this is a
 * context-isolation device, not extra capacity. Reading fifteen files to answer
 * "where is X wired up?" costs the parent thirty or forty thousand tokens that
 * are then replayed on every later iteration of the leg — and which
 * elideOldToolOutput will eventually drop anyway, losing the information along
 * with the cost. The same work here costs the parent the answer: a few hundred
 * tokens, once.
 *
 * That only holds if the sub-agent itself runs lean, which is the whole design:
 *
 * - **No bootstrapContext.** Every other agent gets the profile block, skill
 *   index, library digest and boards digest prepended. A sub-agent inheriting
 *   all of that would pay for it on every one of its own iterations and would
 *   lose money on exactly the small jobs it exists for.
 * - **Read-only tools, and only the coding ones.** No web, no library, no
 *   boards, no MCP, no ask_user — and no dispatch_explore, so recursion is
 *   impossible by construction rather than by a depth counter.
 * - **Its own model**, chosen in Admin like run-summary and chat-title, so it
 *   can be a cheap one.
 * - **Hard caps** on steps and on the size of what it hands back.
 * - **Its own usage rows**, under task 'subagent', so what it costs is visible
 *   in Admin → Spend from the first run rather than hidden inside coding.
 */

/** Longest answer handed back to the parent. Past this it is not a summary. */
const MAX_ANSWER_CHARS = 2_000;

export interface ExploreContext extends CodingToolContext {
	/** The run that asked, so the sub-agent's work shows in its timeline. */
	parentJob: LiveJob;
	userId: string;
	chatId: string;
}

/** Declared apart from the factory so the tool catalogue can list it. */
export const exploreToolDef: ToolDef = {
	name: 'dispatch_explore',
	description:
		'Hand a read-only question about this repository to a sub-agent, which explores on its own ' +
		'and replies with a short answer. Use it when finding something out would take several file ' +
		'reads whose contents you do not otherwise need — "where is X wired up", "which modules call ' +
		'Y", "how does Z currently work". The searching happens outside your context, so you pay for ' +
		'the answer rather than for everything it had to read. Do not use it for anything you can ' +
		'settle in one or two reads, and never for making changes: it cannot write, run commands, or ' +
		'ask the user anything.',
	parameters: {
		type: 'object',
		properties: {
			question: {
				type: 'string',
				description: 'One specific question about the repository, in plain language.'
			},
			hint: {
				type: 'string',
				description: 'Optional: where you think it should start looking.'
			}
		},
		required: ['question']
	}
};

export function exploreTool(ctx: ExploreContext): LoopTool {
	return {
		def: exploreToolDef,
		// Read-only, owning no shared state, and each dispatch gets its own job —
		// so several can explore at once under the loop's concurrency cap. That is
		// the cheapest speed-up a long leg has: four questions answered in the
		// time one used to take, none of their reading entering this context.
		parallelSafe: true,
		describe: (a) => String(a.question ?? ''),
		execute: async (a) => {
			const question = String(a.question ?? '').trim();
			if (!question) throw new Error('question is required');
			const hint = String(a.hint ?? '').trim();
			return explore(ctx, question, hint);
		}
	};
}

async function explore(ctx: ExploreContext, question: string, hint: string): Promise<string> {
	const { choice } = resolveAgentModel('subagent');
	const agentId = randomUUID();
	const startedAt = Date.now();
	const announce = createAnnouncer(ctx.parentJob, { id: agentId, label: question, startedAt });
	announce('running', 'explore');

	let result;
	try {
		result = await runNestedAgent({
			parent: { job: ctx.parentJob, userId: ctx.userId },
			task: 'subagent',
			rowPrefix: 'explore',
			choice,
			backup: null,
			tools: readOnlyCodingTools(ctx),
			maxIterations: exploreMaxSteps(),
			system: systemPrompt(systemPromptFor('subagent'), ctx),
			user: hint ? `${question}\n\nStart by looking at: ${hint}` : question,
			// And the same call as this sub-agent's current activity, so the pane
			// has one line to show without parsing the flattened rows back out.
			onActivity: (detail) => announce('running', 'explore', detail)
		});
	} catch (err) {
		// Closed on a throw too, or the pane shows an explorer that never finishes.
		announce('error', 'explore', 'nothing to report');
		throw err;
	}
	const { answer, steps, failure } = result;
	announce(answer ? 'ok' : 'error', 'explore', answer ? undefined : 'nothing to report');

	emitEvent({
		userId: ctx.userId,
		chatId: ctx.chatId,
		task: 'subagent',
		type: 'job',
		name: 'subagent.explore',
		status: answer ? 'ok' : 'error',
		durationMs: Date.now() - startedAt,
		detail: { question, steps, answerChars: answer.length, model: result.model }
	});

	if (!answer) {
		if (failure) throw new Error(`The sub-agent could not run: ${failure}`);
		return 'The sub-agent found nothing to report. Look yourself if it matters.';
	}
	// Truncated rather than refused: a long answer is still worth having, and
	// the point of the cap is that it cannot grow the parent's context without
	// bound however chatty the model is.
	return answer.length > MAX_ANSWER_CHARS
		? `${answer.slice(0, MAX_ANSWER_CHARS)}\n…(the sub-agent said more; ask a narrower question if you need it)`
		: answer;
}

function systemPrompt(base: string, ctx: ExploreContext): string {
	return [
		base,
		'',
		`You are exploring the repository at branch ${ctx.workBranch}, based on ${ctx.baseBranch}.`,
		'You have read-only tools and a small step budget. Find the answer, then say it plainly in a few sentences — cite the files and line numbers you found it in, and say what you could not establish rather than guessing.',
		'You are answering another agent, not a person: no preamble, no offers to help further.'
	].join('\n');
}
