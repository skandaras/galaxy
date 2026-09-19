/**
 * Shelf shapes for the Library, kept out of the page so they can be tested.
 *
 * There is no DOM in the test environment on purpose (`vite.config.ts` sets no
 * environment), so anything worth asserting comes out of `.svelte` and lives
 * here — the same reason `run-timeline.ts` and `theme.ts` exist.
 */

/** Everything the shelf needs off a document row to place it. */
export interface TreeDoc {
	id: string;
	title: string;
	folder: string;
	parentId: string | null;
}

export interface ShelfNode<D extends TreeDoc> {
	doc: D;
	children: ShelfNode<D>[];
	/** Documents beneath this one at any depth. */
	descendants: number;
}

export type ShelfSection<D extends TreeDoc> =
	| { kind: 'tree'; key: string; name: string; count: number; nodes: ShelfNode<D>[] }
	| { kind: 'folder'; key: string; name: string; count: number; docs: D[] };

export const UNFILED = 'Unfiled';

/**
 * Deep enough for epic → sprint → task → note, matching MAX_DEPTH on the server.
 * Repeated rather than imported because this module must not reach into
 * `$lib/server`, and the number is a guard here rather than the rule.
 */
const MAX_DEPTH = 5;

/**
 * Group the shelf.
 *
 * A root with nothing under it is a document, not a tree, so it groups by its
 * folder label exactly as it did before there were trees. Without that, a shelf
 * where every document is its own root — which is every shelf that predates
 * this — would go from a handful of folder headings to one heading per
 * document.
 *
 * Unfiled sits last: it is the overflow, not the headline, and putting it first
 * buries the folders somebody made on purpose.
 */
export function buildShelf<D extends TreeDoc>(docs: D[]): ShelfSection<D>[] {
	const byParent = new Map<string, D[]>();
	const ids = new Set(docs.map((d) => d.id));
	for (const doc of docs) {
		// A parent that is not in this list — someone else's, or filtered out —
		// makes the child a root here rather than hiding it.
		const key = doc.parentId && ids.has(doc.parentId) ? doc.parentId : '';
		byParent.set(key, [...(byParent.get(key) ?? []), doc]);
	}

	const seen = new Set<string>();
	const build = (doc: D, depth: number): ShelfNode<D> => {
		// Cyclic rows cannot be rendered, and the server refuses to write them —
		// but a shelf that hangs is a worse way to find that out than one that
		// stops.
		if (depth >= MAX_DEPTH || seen.has(doc.id)) return { doc, children: [], descendants: 0 };
		seen.add(doc.id);
		const children = (byParent.get(doc.id) ?? []).map((c) => build(c, depth + 1));
		return {
			doc,
			children,
			descendants: children.reduce((n, c) => n + c.descendants + 1, 0)
		};
	};

	const roots = (byParent.get('') ?? []).map((d) => build(d, 0));
	// A tree's key is its root's own id, so one collapse map serves both the
	// section and every node inside it — the root is a row like any other rather
	// than a heading that happens to be a document.
	const sections: ShelfSection<D>[] = roots
		.filter((n) => n.descendants > 0)
		.sort((a, b) => a.doc.title.localeCompare(b.doc.title))
		.map((n) => ({
			kind: 'tree',
			key: n.doc.id,
			name: n.doc.title,
			count: n.descendants,
			nodes: [n]
		}));

	const byFolder = new Map<string, D[]>();
	for (const n of roots) {
		if (n.descendants > 0) continue;
		const key = n.doc.folder || UNFILED;
		byFolder.set(key, [...(byFolder.get(key) ?? []), n.doc]);
	}
	sections.push(
		...[...byFolder.entries()]
			.sort(([a], [b]) => (a === UNFILED ? 1 : b === UNFILED ? -1 : a.localeCompare(b)))
			.map(([name, items]) => ({
				kind: 'folder' as const,
				key: `folder:${name}`,
				name,
				count: items.length,
				docs: items
			}))
	);
	return sections;
}

export interface ShelfRow<D extends TreeDoc> {
	doc: D;
	depth: number;
	hasChildren: boolean;
	descendants: number;
}

/**
 * A tree section as a flat list of rows with a depth each.
 *
 * Flat rather than a recursive snippet because collapse state is per node and a
 * flat list makes "is this row's ancestor shut" a decision taken once, here,
 * instead of threaded through a component that renders itself.
 */
export function flattenTree<D extends TreeDoc>(
	nodes: ShelfNode<D>[],
	isShut: (id: string) => boolean,
	depth = 0
): ShelfRow<D>[] {
	const rows: ShelfRow<D>[] = [];
	for (const node of nodes) {
		rows.push({
			doc: node.doc,
			depth,
			hasChildren: node.children.length > 0,
			descendants: node.descendants
		});
		if (node.children.length && !isShut(node.doc.id)) {
			rows.push(...flattenTree(node.children, isShut, depth + 1));
		}
	}
	return rows;
}

export interface ParentOption {
	id: string;
	label: string;
}

/**
 * What a document may be filed under.
 *
 * Its own descendants are excluded, and so is itself: filing a document under
 * its own child is the cycle the server refuses, and offering it in a picker
 * means the refusal arrives as an error on save rather than as an option that
 * was never there.
 */
export function parentOptions<D extends TreeDoc>(docs: D[], currentId: string | null): ParentOption[] {
	const barred = new Set<string>(currentId ? [currentId] : []);
	if (currentId) {
		// Walk down from the current document, bounded like everything else here.
		let level = [currentId];
		for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
			level = docs.filter((d) => d.parentId && level.includes(d.parentId)).map((d) => d.id);
			for (const id of level) barred.add(id);
		}
	}

	const depthOf = (doc: D): number => {
		let depth = 0;
		let cursor = doc.parentId;
		for (let i = 0; i < MAX_DEPTH && cursor; i++) {
			depth++;
			cursor = docs.find((d) => d.id === cursor)?.parentId ?? null;
		}
		return depth;
	};

	return docs
		.filter((d) => !barred.has(d.id))
		// A document already at the floor cannot take a child without breaching it.
		.filter((d) => depthOf(d) < MAX_DEPTH - 1)
		.sort((a, b) => a.title.localeCompare(b.title))
		.map((d) => ({ id: d.id, label: `${'— '.repeat(depthOf(d))}${d.title}` }));
}
