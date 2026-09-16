import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent, ToolCall } from '$lib/server/providers/types';
import { goDeeperTool } from './answer-first';
import { createJob } from './jobs';
import { runAgentLoop, turnBudgetNote, type LoopTool } from './loop';

/**
 * That a chat turn answers before it goes looking.
 *
 * The complaint: a plain question spent its first leg planning lookups while
 * every tool in the platform sat on the table, and five seconds of Googling
 * beat it. The fix is structural rather than written into a prompt, because
 * turnBudgetNote's own comment records what happens to an instruction that
 * disagrees with a louder one — so what is asserted here is the *toolset each
 * leg was offered*, which is the thing a model cannot argue with.
 */

beforeAll(() => runMigrations());

/** A model that runs a scripted list of legs, keeping every request it was sent. */
function scripted(legs: ({ text: string; calls?: ToolCall[] })[]) {
	const seen: ChatRequest[] = [];
	let leg = 0;
	const choice = {
		model: {
			modelKey: 'mock',
			displayName: 'Mock',
			supportsTools: true,
			supportsVision: false,
			supportsReasoning: false,
			reasoningMode: 'auto',
			promptCostPerMTok: null,
			completionCostPerMTok: null
		},
		provider: {},
		adapter: {
			async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
				seen.push(req);
				const step = legs[Math.min(leg++, legs.length - 1)];
				if (step.text) yield { type: 'text', delta: step.text };
				if (step.calls?.length) yield { type: 'tool_calls', calls: step.calls };
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
	return { choice, seen };
}

const namesOffered = (req: ChatRequest) => (req.tools ?? []).map((t) => t.name).sort();

const wideTool = (name: string, lookup = false): LoopTool => ({
	def: { name, description: name, parameters: {} },
	lookup,
	execute: async () => `${name} ran`
});

/** A chat toolset in miniature: one that goes looking, one that acts. */
const TOOLS = [wideTool('web_search', true), wideTool('generate_image')];

async function run(opts: {
	legs: ({ text: string; calls?: ToolCall[] })[];
	openingTools?: LoopTool[];
}) {
	const { choice, seen } = scripted(opts.legs);
	const job = createJob({ chatId: 'af1', userId: 'u1', task: 'chat', persist: false });
	let reply = '';
	await runAgentLoop({
		job,
		task: 'chat',
		userId: 'u1',
		chatId: 'af1',
		persist: false,
		primary: choice,
		backup: null,
		tools: TOOLS,
		openingTools: opts.openingTools,
		maxIterations: 4,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: (text) => {
			reply = text;
		}
	});
	return { seen, reply };
}

/** What engine.ts builds: everything that is not a lookup, plus the gate. */
const gate = () => [...TOOLS.filter((t) => !t.lookup), goDeeperTool()];
const callGate = (): ToolCall[] => [
	{ id: 'c1', name: 'look_into_it', arguments: JSON.stringify({ reason: 'need the docs' }) }
];

describe('the opening leg of a chat turn', () => {
	it('can act, but cannot go looking', async () => {
		// The distinction the smoke suite caught: "draw me a spiral galaxy" must
		// reach generate_image on the leg that wants to, while a search has to be
		// asked for.
		const { seen } = await run({ legs: [{ text: 'Here is the answer.' }], openingTools: gate() });
		expect(namesOffered(seen[0])).toEqual(['generate_image', 'look_into_it']);
		expect(namesOffered(seen[0])).not.toContain('web_search');
	});

	it('ends the turn there when the model just answers', async () => {
		// The case the whole thing is for: a question that needed nothing looked
		// up costs exactly one model call, as it did before any of this existed.
		const { seen, reply } = await run({
			legs: [{ text: 'Here is the answer.' }],
			openingTools: gate()
		});
		expect(seen).toHaveLength(1);
		expect(reply).toBe('Here is the answer.');
	});

	it('opens the full toolset once the gate is called', async () => {
		const { seen } = await run({
			legs: [{ text: 'Short answer first.', calls: callGate() }, { text: 'And the detail.' }],
			openingTools: gate()
		});
		expect(namesOffered(seen[0])).not.toContain('web_search');
		expect(namesOffered(seen[1])).toEqual(['generate_image', 'web_search']);
	});

	it('does not offer the gate a second time', async () => {
		// A gate offered twice is a turn that can keep announcing it is going
		// further without ever doing so.
		const { seen } = await run({
			legs: [{ text: 'First.', calls: callGate() }, { text: 'Second.' }],
			openingTools: gate()
		});
		expect(namesOffered(seen[1])).not.toContain('look_into_it');
	});

	it('keeps the answer it gave before going further', async () => {
		const { reply } = await run({
			legs: [{ text: 'Short answer first.', calls: callGate() }, { text: 'And the detail.' }],
			openingTools: gate()
		});
		expect(reply).toContain('Short answer first.');
		expect(reply).toContain('And the detail.');
	});

	it('behaves as it always did when no gate is given', async () => {
		// Which is what the coding paths still want, and what chat falls back to
		// if an admin disables the gate in Admin → Tools.
		const { seen } = await run({ legs: [{ text: 'Answer.' }] });
		expect(namesOffered(seen[0])).toEqual(['generate_image', 'web_search']);
	});
});

describe('the answer-first line in the turn-budget note', () => {
	/**
	 * Said in the note rather than the task prompt because this is the loudest
	 * place in the prompt by this codebase's own measurement — the comment beside
	 * it records the batching line beating both a tool description and the task
	 * prompt on the same question. Removing the looking-up tools was not enough on
	 * its own: a reasoning model thinks, calls the gate and writes no content at
	 * all, and reasoning can never become the reply.
	 */
	it('asks for an answer before the gate is called', () => {
		const note = turnBudgetNote(12, true, true);
		expect(note).toContain('Write something before you go looking');
		expect(note).toContain('look_into_it');
	});

	it('says nothing of the sort when there is no gate', () => {
		// The coding agent shares this loop, and its honest first move is reading
		// the repository. Telling it to answer from memory first would be wrong.
		const note = turnBudgetNote(50, false, false);
		expect(note).not.toContain('Write something before you go looking');
		expect(note).toContain('Turn budget');
	});

	it('defaults to no gate, so an existing caller cannot acquire one', () => {
		expect(turnBudgetNote(12)).not.toContain('Write something before you go looking');
	});
});
