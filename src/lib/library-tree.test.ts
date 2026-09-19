import { describe, expect, it } from 'vitest';
import { buildShelf, flattenTree, parentOptions, UNFILED, type TreeDoc } from './library-tree';

const doc = (id: string, title: string, parentId: string | null = null, folder = ''): TreeDoc => ({
	id,
	title,
	folder,
	parentId
});

const shut = () => true;
const openAll = () => false;

describe('buildShelf', () => {
	it('groups a doc with nothing under it by its folder, not as its own tree', () => {
		// Every doc is its own root after the backfill, so a shelf that predates
		// the tree would otherwise go from two headings to three rows of heading.
		const sections = buildShelf([
			doc('a', 'Roast potatoes', null, 'Recipes'),
			doc('b', 'Bread', null, 'Recipes'),
			doc('c', 'Odd note')
		]);
		expect(sections.map((s) => [s.kind, s.name])).toEqual([
			['folder', 'Recipes'],
			['folder', UNFILED]
		]);
		expect(sections[0].count).toBe(2);
	});

	it('makes a root with children a tree, keyed by that root', () => {
		const sections = buildShelf([
			doc('epic', 'Galaxy mobile'),
			doc('s1', 'Sprint 1', 'epic'),
			doc('t1', 'Task 1', 's1')
		]);
		expect(sections).toHaveLength(1);
		expect(sections[0].kind).toBe('tree');
		// The key is the root's own id, so one collapse map serves the section and
		// every node inside it.
		expect(sections[0].key).toBe('epic');
		expect(sections[0].count).toBe(2);
	});

	it('puts Unfiled last, after folders and trees', () => {
		const sections = buildShelf([
			doc('loose', 'Loose'),
			doc('a', 'Filed', null, 'Admin'),
			doc('epic', 'Epic'),
			doc('kid', 'Kid', 'epic')
		]);
		expect(sections.map((s) => s.name)).toEqual(['Epic', 'Admin', UNFILED]);
	});

	it('treats a doc whose parent is absent as a root', () => {
		// Search results and a personal parent both produce this: the child is in
		// the list, the parent is not, and hiding the child would lose it.
		const sections = buildShelf([doc('orphan', 'Orphan', 'not-here')]);
		expect(sections.map((s) => s.name)).toEqual([UNFILED]);
	});

	it('does not hang on a cycle', () => {
		const sections = buildShelf([doc('a', 'A', 'b'), doc('b', 'B', 'a')]);
		expect(sections).toEqual([]);
	});
});

describe('flattenTree', () => {
	const docs = [
		doc('epic', 'Epic'),
		doc('s1', 'Sprint 1', 'epic'),
		doc('t1', 'Task 1', 's1'),
		doc('s2', 'Sprint 2', 'epic')
	];

	it('shows only the root while everything is shut', () => {
		const [tree] = buildShelf(docs);
		if (tree.kind !== 'tree') throw new Error('expected a tree');
		const rows = flattenTree(tree.nodes, shut);
		expect(rows.map((r) => r.doc.id)).toEqual(['epic']);
		expect(rows[0]).toMatchObject({ depth: 0, hasChildren: true, descendants: 3 });
	});

	it('indents each level once opened', () => {
		const [tree] = buildShelf(docs);
		if (tree.kind !== 'tree') throw new Error('expected a tree');
		expect(flattenTree(tree.nodes, openAll).map((r) => [r.doc.id, r.depth])).toEqual([
			['epic', 0],
			['s1', 1],
			['t1', 2],
			['s2', 1]
		]);
	});

	it('hides a shut node’s children without hiding its siblings', () => {
		const [tree] = buildShelf(docs);
		if (tree.kind !== 'tree') throw new Error('expected a tree');
		const rows = flattenTree(tree.nodes, (id) => id === 's1');
		expect(rows.map((r) => r.doc.id)).toEqual(['epic', 's1', 's2']);
	});
});

describe('parentOptions', () => {
	const docs = [
		doc('epic', 'Epic'),
		doc('s1', 'Sprint 1', 'epic'),
		doc('t1', 'Task 1', 's1'),
		doc('other', 'Other')
	];

	it('excludes the doc itself and everything under it', () => {
		// Offering a descendant means the cycle is refused on save instead of
		// never being offered, which is a worse way to learn the rule.
		expect(parentOptions(docs, 'epic').map((o) => o.id)).toEqual(['other']);
		expect(parentOptions(docs, 's1').map((o) => o.id).sort()).toEqual(['epic', 'other']);
	});

	it('indents by depth so the list reads as a tree', () => {
		const labels = Object.fromEntries(parentOptions(docs, 'other').map((o) => [o.id, o.label]));
		expect(labels.epic).toBe('Epic');
		expect(labels.s1).toBe('— Sprint 1');
		expect(labels.t1).toBe('— — Task 1');
	});

	it('drops a doc already too deep to take a child', () => {
		// Five levels are allowed, so the fourth may still take a child and the
		// fifth may not. Matches canPlace on the server, which is the rule this
		// list exists to avoid running into on save.
		const deep = [
			doc('l1', 'L1'),
			doc('l2', 'L2', 'l1'),
			doc('l3', 'L3', 'l2'),
			doc('l4', 'L4', 'l3'),
			doc('l5', 'L5', 'l4')
		];
		expect(parentOptions(deep, null).map((o) => o.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
	});

	it('offers everything when nothing is selected yet', () => {
		expect(parentOptions(docs, null)).toHaveLength(4);
	});
});
