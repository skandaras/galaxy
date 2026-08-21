import { describe, expect, it } from 'vitest';
import {
	applyChunk,
	itemsFromTrace,
	type TimelineChunk,
	type TimelineItem,
	type TimelineSearch,
	type TimelineStep
} from './run-timeline';

const fold = (chunks: TimelineChunk[]): TimelineItem[] =>
	chunks.reduce<TimelineItem[]>((items, c) => applyChunk(items, c), []);

const steps = (items: TimelineItem[]) => items.filter((i): i is TimelineStep => i.kind === 'step');

/** One step with two overlapping calls to the same tool, then both finishing. */
const OVERLAPPING: TimelineChunk[] = [
	{ type: 'step', id: 's1', label: 'Reading both files', status: 'running' },
	{ type: 'tool', name: 'read_file', status: 'running', callId: 'a', stepId: 's1', detail: 'a.ts' },
	{ type: 'tool', name: 'read_file', status: 'running', callId: 'b', stepId: 's1', detail: 'b.ts' },
	{ type: 'tool', name: 'read_file', status: 'error', callId: 'a', stepId: 's1', detail: 'gone' },
	{ type: 'tool', name: 'read_file', status: 'ok', callId: 'b', stepId: 's1', detail: 'b.ts' },
	{ type: 'step', id: 's1', label: 'Reading both files', status: 'error' }
];

describe('applyChunk', () => {
	it('opens a step and nests its calls under it', () => {
		const items = fold([
			{ type: 'step', id: 's1', label: 'Reading the loop', status: 'running' },
			{ type: 'tool', name: 'read_file', status: 'running', callId: 'c1', stepId: 's1' },
			{ type: 'tool', name: 'read_file', status: 'ok', callId: 'c1', stepId: 's1' },
			{ type: 'step', id: 's1', label: 'Reading the loop', status: 'ok' }
		]);
		expect(items).toHaveLength(1);
		expect(steps(items)[0]).toMatchObject({ label: 'Reading the loop', status: 'ok' });
		expect(steps(items)[0].tools).toEqual([
			{ callId: 'c1', name: 'read_file', status: 'ok', detail: undefined }
		]);
	});

	it('matches a terminal call to its own running one, not the newest by name', () => {
		// The bug this replaces: findLastIndex on tool NAME resolved whichever
		// call happened to be last, so an error landed on the wrong row.
		const step = steps(fold(OVERLAPPING))[0];
		expect(step.tools).toHaveLength(2);
		expect(step.tools.find((t) => t.callId === 'a')).toMatchObject({
			status: 'error',
			detail: 'gone'
		});
		expect(step.tools.find((t) => t.callId === 'b')).toMatchObject({ status: 'ok' });
	});

	it('is idempotent under replay', () => {
		// subscribeJob replays the whole history to a reconnecting client, so
		// folding it twice from empty has to land in exactly the same place.
		const once = fold(OVERLAPPING);
		const twice = fold([...OVERLAPPING, ...OVERLAPPING]);
		expect(twice).toEqual(once);
	});

	it('interleaves stages and notices in the order they arrived', () => {
		const items = fold([
			{ type: 'stage', name: 'working', detail: 'leg 1' },
			{ type: 'step', id: 's1', label: 'Editing', status: 'running' },
			{ type: 'notice', text: 'Dropped 2 earlier tool results.' },
			{ type: 'step', id: 's1', label: 'Editing', status: 'ok' }
		]);
		expect(items.map((i) => i.kind)).toEqual(['stage', 'step', 'notice']);
	});

	it('never blanks a label a later chunk omits', () => {
		const items = fold([
			{ type: 'step', id: 's1', label: 'Running the tests', status: 'running' },
			{ type: 'step', id: 's1', label: '', status: 'ok' }
		]);
		expect(steps(items)[0].label).toBe('Running the tests');
	});

	it('still shows a tool call that arrives with no step', () => {
		const items = fold([{ type: 'tool', name: 'web_search', status: 'running' }]);
		expect(steps(items)[0].tools[0].name).toBe('web_search');
	});
});

describe('itemsFromTrace', () => {
	it('renders a stored trace as the same timeline shape', () => {
		const items = itemsFromTrace({
			summary: 'Fixed the loop',
			steps: [
				{
					id: 's1',
					label: 'Editing the loop',
					status: 'ok',
					toolCalls: [{ name: 'edit_file', summary: 'loop.ts', status: 'ok' }]
				}
			]
		});
		expect(steps(items)[0]).toMatchObject({ label: 'Editing the loop', status: 'ok' });
		expect(steps(items)[0].tools[0]).toMatchObject({ name: 'edit_file', detail: 'loop.ts' });
	});

	it('copes with a message that has no trace', () => {
		expect(itemsFromTrace(null)).toEqual([]);
		expect(itemsFromTrace(undefined)).toEqual([]);
	});
});


describe('search results in the timeline', () => {
	const ROWS = [
		{ title: 'How to Choose a Freight Forwarder', url: 'https://smartbuy.alibaba.com/guide' },
		{ title: 'Queenstown Customs Broker', url: 'https://platinumfreight.co.nz/queenstown' }
	];

	it('keeps the rows a terminal chunk does not repeat', () => {
		// The running chunk is not the one that carries results, and an `ok` chunk
		// that merely says the call finished must not blank the box it drew.
		const items = fold([
			{ type: 'step', id: 's1', label: 'Searching', status: 'running' },
			{ type: 'tool', name: 'web_search', status: 'running', callId: 'a', stepId: 's1', detail: 'freight' },
			{
				type: 'tool',
				name: 'web_search',
				status: 'ok',
				callId: 'a',
				stepId: 's1',
				detail: 'freight',
				results: ROWS
			},
			{ type: 'step', id: 's1', label: 'Searching', status: 'ok' }
		]);
		expect(steps(items)[0].tools[0].results).toEqual(ROWS);
	});

	it('does not erase results when a later chunk carries none', () => {
		const items = fold([
			{ type: 'step', id: 's1', label: 'Searching', status: 'running' },
			{ type: 'tool', name: 'web_search', status: 'running', callId: 'a', stepId: 's1', results: ROWS },
			{ type: 'tool', name: 'web_search', status: 'ok', callId: 'a', stepId: 's1', detail: 'freight' }
		]);
		expect(steps(items)[0].tools[0].results).toEqual(ROWS);
		expect(steps(items)[0].tools[0].detail).toBe('freight');
	});

	it('draws a pipeline search that belongs to no step', () => {
		// Deep research is not the agent loop: its queries are not tool calls and
		// arrive with no step to hang under.
		const items = fold([
			{ type: 'stage', name: 'searching', detail: 'round 1/4' },
			{ type: 'search', query: 'freight forwarder China to NZ', language: 'en', results: ROWS }
		]);
		const search = items.find((i): i is TimelineSearch => i.kind === 'search');
		expect(search).toMatchObject({ query: 'freight forwarder China to NZ', language: 'en' });
		expect(search?.results).toEqual(ROWS);
		// And it did not invent a step to hold it.
		expect(steps(items)).toHaveLength(0);
	});

	it('folds the same history twice to the same timeline', () => {
		// subscribeJob replays a job's whole chunk history to every reconnecting
		// client, so a round of searches must not double on reconnect.
		const history: TimelineChunk[] = [
			{ type: 'step', id: 's1', label: 'Searching', status: 'running' },
			{ type: 'tool', name: 'web_search', status: 'ok', callId: 'a', stepId: 's1', results: ROWS }
		];
		expect(fold(history)).toEqual(fold(history));
	});

	it('redraws boxes from a stored trace, and leaves older traces alone', () => {
		const items = itemsFromTrace({
			steps: [
				{
					id: 's1',
					label: 'Searching',
					status: 'ok',
					toolCalls: [
						{ name: 'web_search', summary: 'freight', status: 'ok', results: ROWS },
						{ name: 'fetch_url', summary: 'example.com', status: 'ok' }
					]
				}
			]
		});
		expect(steps(items)[0].tools[0].results).toEqual(ROWS);
		// A call that never had results still has none, rather than an empty box.
		expect(steps(items)[0].tools[1].results).toBeUndefined();
	});
});
