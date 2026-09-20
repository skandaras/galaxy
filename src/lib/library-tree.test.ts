import { describe, expect, it } from 'vitest';
import {
	buildShelf,
	filingDest,
	filingOptions,
	filingValue,
	flattenTree,
	nestableUnder,
	UNFILED,
	type TreeDoc
} from './library-tree';

const doc = (id: string, title: string, parentId: string | null = null, folder = ''): TreeDoc => ({
	id,
	title,
	folder,
	parentId
});

const shut = () => true;
const openAll = () => false;

describe('buildShelf', () => {
	it('groups documents by folder', () => {
		const sections = buildShelf([
			doc('a', 'Roast potatoes', null, 'Recipes'),
			doc('b', 'Bread', null, 'Recipes'),
			doc('c', 'Odd note')
		]);
		expect(sections.map((s) => s.name)).toEqual(['Recipes', UNFILED]);
		expect(sections[0].count).toBe(2);
	});

	it('keeps a document with children inside its folder rather than beside it', () => {
		// The confusion this whole shape exists to end: a root with children used
		// to be a section of its own at the top of the pane, which read as a file
		// that was somehow also a folder and sat in neither.
		const sections = buildShelf([
			doc('epic', 'Galaxy mobile', null, 'Epics'),
			doc('s1', 'Sprint 1', 'epic', 'Epics'),
			doc('t1', 'Task 1', 's1', 'Epics')
		]);
		expect(sections.map((s) => s.name)).toEqual(['Epics', UNFILED]);
		expect(sections[0].nodes.map((n) => n.doc.id)).toEqual(['epic']);
		// Counting only the roots said a folder holding a whole epic held one
		// thing, which is the opposite of what a shut folder is hiding.
		expect(sections[0].count).toBe(3);
		expect(sections[0].nested).toBe(true);
	});

	it('draws a folder with nothing in it', () => {
		// A name somebody just typed has to be on the shelf before anything is
		// filed under it, or New folder appears to do nothing.
		const sections = buildShelf([], ['Plans']);
		expect(sections.map((s) => s.name)).toEqual(['Plans', UNFILED]);
		expect(sections[0].count).toBe(0);
	});

	it('always draws Unfiled, and draws it last', () => {
		const sections = buildShelf([doc('a', 'Filed', null, 'Admin')], ['Zebra']);
		expect(sections.map((s) => s.name)).toEqual(['Admin', 'Zebra', UNFILED]);
	});

	it('reserves the caret gutter only where something is nested', () => {
		const flat = buildShelf([doc('a', 'A', null, 'Admin')]);
		expect(flat[0].nested).toBe(false);
	});

	it('treats a document whose parent is absent as a root', () => {
		// Search results and a personal parent both produce this: the child is in
		// the list, the parent is not, and hiding the child would lose it.
		const sections = buildShelf([doc('orphan', 'Orphan', 'not-here')]);
		expect(sections.map((s) => s.name)).toEqual([UNFILED]);
		expect(sections[0].count).toBe(1);
	});

	it('does not hang on a cycle', () => {
		const sections = buildShelf([doc('a', 'A', 'b'), doc('b', 'B', 'a')]);
		expect(sections.map((s) => s.name)).toEqual([UNFILED]);
		expect(sections[0].count).toBe(0);
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
		const rows = flattenTree(buildShelf(docs)[0].nodes, shut);
		expect(rows.map((r) => r.doc.id)).toEqual(['epic']);
		expect(rows[0]).toMatchObject({ depth: 0, hasChildren: true, descendants: 3 });
	});

	it('indents each level once opened', () => {
		expect(flattenTree(buildShelf(docs)[0].nodes, openAll).map((r) => [r.doc.id, r.depth])).toEqual(
			[
				['epic', 0],
				['s1', 1],
				['t1', 2],
				['s2', 1]
			]
		);
	});

	it('hides a shut node’s children without hiding its siblings', () => {
		const rows = flattenTree(buildShelf(docs)[0].nodes, (id) => id === 's1');
		expect(rows.map((r) => r.doc.id)).toEqual(['epic', 's1', 's2']);
	});
});

describe('filing a document', () => {
	const docs = [
		doc('epic', 'Epic', null, 'Epics'),
		doc('s1', 'Sprint 1', 'epic', 'Epics'),
		doc('t1', 'Task 1', 's1', 'Epics'),
		doc('other', 'Other')
	];

	it('offers every folder, Unfiled included and last of them', () => {
		const folders = filingOptions(docs, ['Plans'], 'other')
			.filter((o) => o.kind === 'folder')
			.map((o) => o.label);
		expect(folders).toEqual(['Epics', 'Plans', UNFILED]);
	});

	it('excludes the document itself and everything under it', () => {
		// Offering a descendant means the cycle is refused on save instead of
		// never being offered, which is a worse way to learn the rule.
		expect(nestableUnder(docs, 'epic').map((d) => d.id)).toEqual(['other']);
		expect(
			nestableUnder(docs, 's1')
				.map((d) => d.id)
				.sort()
		).toEqual(['epic', 'other']);
	});

	it('indents documents by depth so the list reads as a tree', () => {
		const labels = Object.fromEntries(
			filingOptions(docs, [], 'other')
				.filter((o) => o.kind === 'doc')
				.map((o) => [o.value, o.label])
		);
		expect(labels['doc:epic']).toBe('Epic');
		expect(labels['doc:s1']).toBe('— Sprint 1');
		expect(labels['doc:t1']).toBe('— — Task 1');
	});

	it('drops a document already too deep to take a child', () => {
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
		expect(nestableUnder(deep, null).map((d) => d.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
	});

	it('reads a document’s own place back off it', () => {
		expect(filingValue(docs[0])).toBe('folder:Epics');
		expect(filingValue(docs[1])).toBe('doc:epic');
		expect(filingValue(docs[3])).toBe('folder:');
	});

	it('turns a picked value into what the server is asked for', () => {
		expect(filingDest('doc:epic')).toEqual({ parentId: 'epic' });
		expect(filingDest('folder:Epics')).toEqual({ folder: 'Epics' });
		// Unfiled is the empty label, which is what the server stores for it.
		expect(filingDest('folder:')).toEqual({ folder: '' });
	});
});
