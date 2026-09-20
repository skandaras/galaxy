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

export interface ShelfSection<D extends TreeDoc> {
	key: string;
	name: string;
	/** Every document in the folder, nested ones included. */
	count: number;
	/** Whether anything here is nested, which is what earns the caret gutter. */
	nested: boolean;
	nodes: ShelfNode<D>[];
}

export const UNFILED = 'Unfiled';

/**
 * Deep enough for epic → sprint → task → note, matching MAX_DEPTH on the server.
 * Repeated rather than imported because this module must not reach into
 * `$lib/server`, and the number is a guard here rather than the rule.
 */
const MAX_DEPTH = 5;

/**
 * Group the shelf: a section per folder, documents inside them.
 *
 * Every top-level thing on the shelf is a folder. A root with children used to
 * become a section of its own, which put a document and a folder side by side
 * at the top of the pane and left that document belonging to neither — it read
 * as a file, and it was not in Unfiled. Such a document is a row inside its
 * folder now, with its subtree under it.
 *
 * `folders` carries the names of folders with nothing in them, which a shelf
 * built from documents alone has no way of knowing about.
 *
 * Unfiled sits last and is always drawn: it is the overflow, not the headline,
 * and it is where a document goes when it is dragged out of everything else.
 */
export function buildShelf<D extends TreeDoc>(docs: D[], folders: string[] = []): ShelfSection<D>[] {
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

	const byFolder = new Map<string, ShelfNode<D>[]>();
	for (const name of folders) if (name) byFolder.set(name, []);
	byFolder.set(UNFILED, []);
	for (const node of (byParent.get('') ?? []).map((d) => build(d, 0))) {
		const key = node.doc.folder || UNFILED;
		byFolder.set(key, [...(byFolder.get(key) ?? []), node]);
	}

	return [...byFolder.entries()]
		.sort(([a], [b]) => (a === UNFILED ? 1 : b === UNFILED ? -1 : a.localeCompare(b)))
		.map(([name, nodes]) => ({
			key: `folder:${name}`,
			name,
			// Everything inside, however deep. A collapsed folder is hiding the
			// subtrees as much as the roots, and counting only the roots said a
			// folder holding a 200-document epic had one thing in it.
			count: nodes.reduce((n, node) => n + node.descendants + 1, 0),
			nested: nodes.some((node) => node.children.length > 0),
			nodes
		}));
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

const depthOf = <D extends TreeDoc>(docs: D[], doc: D): number => {
	let depth = 0;
	let cursor = doc.parentId;
	for (let i = 0; i < MAX_DEPTH && cursor; i++) {
		depth++;
		cursor = docs.find((d) => d.id === cursor)?.parentId ?? null;
	}
	return depth;
};

/**
 * Which documents may take this one as a child.
 *
 * Its own descendants are excluded, and so is itself: filing a document under
 * its own child is the cycle the server refuses, and offering it — in the
 * picker or as a drop target — means the refusal arrives on save rather than
 * never being on offer. The drag and the picker share this for that reason:
 * two lists of legal parents would eventually disagree.
 */
export function nestableUnder<D extends TreeDoc>(docs: D[], currentId: string | null): D[] {
	const barred = new Set<string>(currentId ? [currentId] : []);
	if (currentId) {
		// Walk down from the current document, bounded like everything else here.
		let level = [currentId];
		for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
			level = docs.filter((d) => d.parentId && level.includes(d.parentId)).map((d) => d.id);
			for (const id of level) barred.add(id);
		}
	}
	return docs
		.filter((d) => !barred.has(d.id))
		// A document already at the floor cannot take a child without breaching it.
		.filter((d) => depthOf(docs, d) < MAX_DEPTH - 1);
}

/** A picker value naming a folder; the rest of the string is the folder's name. */
export const FOLDER_VALUE = 'folder:';
/** A picker value naming a document to nest inside; the rest is its id. */
export const DOC_VALUE = 'doc:';

export interface FilingOption {
	kind: 'folder' | 'doc';
	value: string;
	label: string;
}

/**
 * Everywhere a document may be filed: a folder, or inside another document.
 *
 * One list with two kinds rather than the two controls this replaced — a parent
 * picker that offered "Top level" beside a free-text folder box, where filling
 * in both was two answers to one question and neither said which won.
 */
export function filingOptions<D extends TreeDoc>(
	docs: D[],
	folders: string[],
	currentId: string | null
): FilingOption[] {
	const names = [...new Set([...folders, ...docs.map((d) => d.folder)].filter(Boolean))].sort(
		(a, b) => a.localeCompare(b)
	);
	return [
		// Unfiled last, as on the shelf, and named by the empty label the server
		// stores for it.
		...[...names, ''].map((name) => ({
			kind: 'folder' as const,
			value: `${FOLDER_VALUE}${name}`,
			label: name || UNFILED
		})),
		...nestableUnder(docs, currentId)
			.sort((a, b) => a.title.localeCompare(b.title))
			.map((d) => ({
				kind: 'doc' as const,
				value: `${DOC_VALUE}${d.id}`,
				label: `${'— '.repeat(depthOf(docs, d))}${d.title}`
			}))
	];
}

/** The picker value a document currently sits at. */
export function filingValue(doc: { folder: string; parentId: string | null }): string {
	return doc.parentId ? `${DOC_VALUE}${doc.parentId}` : `${FOLDER_VALUE}${doc.folder}`;
}

/** A picker value as the server reads it. */
export function filingDest(value: string): { parentId: string } | { folder: string } {
	return value.startsWith(DOC_VALUE)
		? { parentId: value.slice(DOC_VALUE.length) }
		: { folder: value.startsWith(FOLDER_VALUE) ? value.slice(FOLDER_VALUE.length) : '' };
}
