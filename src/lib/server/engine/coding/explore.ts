import { getBudgetStatus } from '../budget';
import { getTaskConfig, pickModel } from '../engine';
import { emitEvent } from '../events';
import { createJob, subscribeJob, type LiveJob } from '../jobs';
import { exploreMaxSteps } from '../limits';
import { runAgentLoop, type LoopTool } from '../loop';
import type { ToolDef } from '$lib/server/providers/types';
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
 * - **No bootstrapContext.** Every other agent gets the skill index, library
 *   digest, boards digest and memory digest prepended. A sub-agent inheriting
 *   all of that would pay for it on every one of its own iterations and would
 *   lose money on exactly the small jobs it exists for.
 * - **Read-only tools, and only the coding ones.** No web, no library, no
 *   boards, no MCP, no ask_user — and no dispatch_explore, so recursion is
 *   impossible by construction rather than by a depth counter.
 * - **Its own model**, chosen in Admin like run-summary and chat-title, so it
 *   can be a cheap one.
 * - **Hard caps** on steps and on the size of what it hands back.
 * - **Its own usage rows**, under task 'subagent', so what it costs is visible
 *   in Admin → Usage from the first run rather than hidden inside coding.
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
	if (getBudgetStatus().blocked) {
		throw new Error('The spend cap has been reached — answer with what you already know.');
	}
	const cfg = getTaskConfig('subagent');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) throw new Error('No model configured for sub-agents');
	if (!choice.model.supportsTools) {
		throw new Error(`${choice.model.displayName} cannot call tools — pick another in Admin → Tasks`);
	}

	// A chat id of its own so the sub-agent never appears to be the run holding
	// the parent's chat: findRunningJobForChat scans live jobs by chat id, and a
	// child sharing one would be reported as the blocker.
	const job = createJob({
		chatId: `${ctx.chatId}#explore`,
		userId: ctx.userId,
		task: 'subagent',
		persist: false
	});
	// Subscribed before the loop starts, and for two reasons: failJob only rings
	// the notification bell when nothing is watching, and a child's failure is
	// the parent's tool error, not something to wake a phone for.
	const off = subscribeJob(job, (chunk) => {
		// Only the tool calls are forwarded, and as the parent's own chunks, so
		// the timeline shows what the sub-agent actually did rather than a pause.
		if (chunk.type === 'tool') {
			ctx.parentJob.subscribers.forEach((sub) =>
				sub({ ...chunk, name: `explore · ${chunk.name}` })
			);
		}
	});
	// The parent stopping must stop this too, or a cancelled run keeps spending.
	const onAbort = () => job.controller.abort();
	ctx.parentJob.controller.signal.addEventListener('abort', onAbort, { once: true });

	const started = Date.now();
	let answer = '';
	let steps = 0;
	try {
		await runAgentLoop({
			job,
			task: 'subagent',
			userId: ctx.userId,
			// Never the parent's chat: nothing here should be attributed to that
			// conversation, and persist is off so none of it is written anyway.
			chatId: job.chatId,
			persist: false,
			primary: choice,
			backup: null,
			tools: readOnlyCodingTools(ctx),
			maxIterations: exploreMaxSteps(),
			budgetBlocked: () => getBudgetStatus().blocked,
			// The parent's tool call is what "finishes" here; the job is a vehicle.
			autoComplete: false,
			buildMessages: () => [
				{ role: 'system', content: systemPrompt(cfg?.systemPrompt ?? '', ctx) },
				{ role: 'user', content: hint ? `${question}\n\nStart by looking at: ${hint}` : question }
			],
			onDone: (text, _usage, _choice, summary) => {
				answer = text.trim();
				steps = summary.steps;
			}
		});
	} finally {
		off();
		ctx.parentJob.controller.signal.removeEventListener('abort', onAbort);
	}

	emitEvent({
		userId: ctx.userId,
		chatId: ctx.chatId,
		task: 'subagent',
		type: 'job',
		name: 'subagent.explore',
		status: answer ? 'ok' : 'error',
		durationMs: Date.now() - started,
		detail: { question, steps, answerChars: answer.length, model: choice.model.modelKey }
	});

	if (!answer) return 'The sub-agent found nothing to report. Look yourself if it matters.';
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
