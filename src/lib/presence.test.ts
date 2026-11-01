import { describe, expect, it } from 'vitest';
import { MAX_SATELLITES, presenceOf, toolKind } from './presence';
import { applyStreamText, type TimelineItem, type TimelineTool } from './run-timeline';

const step = (...tools: [string, TimelineTool['status']][]): TimelineItem => ({
	kind: 'step',
	id: `s${tools.length}`,
	label: 'step',
	status: 'running',
	tools: tools.map(([name, status]) => ({ name, status }))
});

const view = (timeline: TimelineItem[], over: { question?: boolean; legText?: string } = {}) =>
	presenceOf({ timeline, question: over.question ?? false, legText: over.legText ?? '' });

describe('presenceOf', () => {
	it('thinks when nothing is running and nothing has been written', () => {
		expect(view([])).toEqual({ state: 'thinking', calls: [] });
	});

	it('writes once text streams with no tool in flight', () => {
		expect(view([step(['fetch_url', 'ok'])], { legText: 'Here' })).toMatchObject({ state: 'streaming', label: 'Writing' });
	});

	it('thinks between legs even when an earlier leg left text in the reply', () => {
		// The page passes only the text past its stream mark; a kept leg moves the
		// mark to the end, so the next leg starts with nothing streamed.
		const kept = applyStreamText(
			{ text: 'Let me check that.', mark: 0 },
			{ type: 'step', id: 's1', label: 'Searching', status: 'ok' }
		);
		expect(kept.text).toContain('Let me check that.');
		expect(view([step(['web_search', 'ok'])], { legText: kept.text.slice(kept.mark) }).state).toBe('thinking');
	});

	it('names a running tool by its kind and puts a satellite up for each call', () => {
		const v = view([step(['library_read', 'running'], ['generate_image', 'running'])], { legText: 'partial' });
		expect(v.state).toBe('tool');
		expect(v.label).toBe('Making an image');
		expect(v.calls.map((c) => c.kind)).toEqual(['knowledge', 'media']);
		// Each satellite is its own call, so one returning leaves the others where they are.
		expect(new Set(v.calls.map((c) => c.id)).size).toBe(2);
	});

	it('lets a search outrank the other tools, with the search labels the thread already used', () => {
		const v = view([step(['bash', 'running'], ['web_search', 'running'])]);
		expect(v.state).toBe('searching');
		expect(v.label).toBe('Searching the web');
		expect(v.calls.map((c) => c.kind)).toEqual(['code', 'web']);
	});

	it('puts a question for the person above everything else', () => {
		const v = view([step(['web_search', 'running'])], { question: true, legText: 'x' });
		expect(v).toMatchObject({ state: 'waiting', label: 'Waiting on your answer' });
	});

	it('puts no satellite up for the question itself', () => {
		const v = view([step(['ask_user', 'running'])], { question: true });
		expect(v).toEqual({ state: 'waiting', calls: [], label: 'Waiting on your answer' });
	});

	it('caps the satellites, keeping the newest calls', () => {
		const calls = Array.from({ length: 7 }, (_, i): [string, 'running'] => [i % 2 ? 'bash' : 'card_add', 'running']);
		const v = view([step(...calls)]);
		expect(v.calls).toHaveLength(MAX_SATELLITES);
		expect(v.calls.at(-1)?.kind).toBe('boards');
	});

	it('calls a tool it has never heard of, an MCP tool among them, other', () => {
		expect(toolKind('figma__get_screenshot')).toBe('other');
		expect(view([step(['figma__get_screenshot', 'running'])]).label).toBe('Using a tool');
	});
});
