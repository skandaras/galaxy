import { describe, it, expect } from 'vitest';
import { groupByArea, UNFILED_KEY } from './cortex-grouping';

const area = (id: string, name = id, colour = '') => ({ id, name, colour });
const node = (name: string, circuits: string[] | null = null) => ({ name, circuits });

describe('groupByArea', () => {
	it('puts what is unfiled first, because it is the reason to look', () => {
		const groups = groupByArea(
			[node('Loose'), node('Tide pools', ['coastal'])],
			[area('coastal')]
		);
		expect(groups.map((g) => g.key)).toEqual([UNFILED_KEY, 'coastal']);
		expect(groups[0].nodes.map((n) => n.name)).toEqual(['Loose']);
	});

	it('leaves the unfiled bucket out when there is nothing in it', () => {
		const groups = groupByArea([node('Tide pools', ['coastal'])], [area('coastal')]);
		expect(groups.map((g) => g.id)).toEqual(['coastal']);
	});

	it('lists a concept filed under two areas under both', () => {
		// The same rule circuitIndex counts by, so these numbers are the numbers
		// the agent sees in its context index.
		const groups = groupByArea(
			[node('Ink chemistry', ['coastal', 'letterpress'])],
			[area('coastal'), area('letterpress')]
		);
		expect(groups).toHaveLength(2);
		for (const g of groups) expect(g.nodes.map((n) => n.name)).toEqual(['Ink chemistry']);
	});

	it('treats a label that is not one of your areas as unfiled', () => {
		// A shared node arrives carrying its owner's circuit ids, and since the
		// API takes free strings that id is usually their label. Not yours to
		// read, so from here the node is not filed.
		const groups = groupByArea(
			[node('Something ben shared', ['bens-private-area'])],
			[area('coastal')]
		);
		expect(groups[0].key).toBe(UNFILED_KEY);
		expect(groups[0].nodes.map((n) => n.name)).toEqual(['Something ben shared']);
		expect(groups.find((g) => g.id === 'bens-private-area')).toBeUndefined();
	});

	it('orders areas by size, then by name', () => {
		const groups = groupByArea(
			[node('a', ['small']), node('b', ['big']), node('c', ['big'])],
			[area('small', 'Small'), area('big', 'Big'), area('zero', 'Zero')]
		);
		expect(groups.map((g) => g.id)).toEqual(['big', 'small', 'zero']);
	});

	it('keeps an empty area, because an empty area is worth seeing', () => {
		const groups = groupByArea([], [area('coastal')]);
		expect(groups.map((g) => g.id)).toEqual(['coastal']);
	});

	it('drops an empty area while a search is running, because that is just noise', () => {
		const groups = groupByArea([], [area('coastal')], { dropEmpty: true });
		expect(groups).toEqual([]);
	});

	it('keeps the order it was given inside a group', () => {
		// The panel hands over its degree-sorted list, and no second sort runs
		// over it here — that is what stops the two views disagreeing.
		const groups = groupByArea(
			[node('first', ['a']), node('second', ['a']), node('third', ['a'])],
			[area('a')]
		);
		expect(groups[0].nodes.map((n) => n.name)).toEqual(['first', 'second', 'third']);
	});

	it('does not collide with an area somebody named "Unfiled"', () => {
		const groups = groupByArea(
			[node('loose'), node('filed', ['unfiled'])],
			[area('unfiled', 'Unfiled')]
		);
		expect(new Set(groups.map((g) => g.key)).size).toBe(2);
		expect(groups.find((g) => g.id === null)?.nodes.map((n) => n.name)).toEqual(['loose']);
		expect(groups.find((g) => g.id === 'unfiled')?.nodes.map((n) => n.name)).toEqual(['filed']);
	});

	it('carries the chosen colour through to the header', () => {
		const groups = groupByArea([node('a', ['x'])], [area('x', 'X', '#00ff00')]);
		expect(groups[0].colour).toBe('#00ff00');
	});
});
