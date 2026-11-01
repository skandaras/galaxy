import type { ShelfClient } from './github';
import { ensureLabels, labelSet } from './board';
import { listPaths, listProjects, writeShelfFile } from './shelf';

/**
 * The Shelf's starting files, read from `docs/ivory-tower/seed/` at build time.
 *
 * Kept as files in the repository rather than strings in code so there is one
 * copy of each template: the one a person reads in `docs/` is the one Galaxy
 * writes to the Shelf.
 */
const SEED: Record<string, string> = Object.fromEntries(
	Object.entries(
		import.meta.glob('/docs/ivory-tower/seed/**/*.md', {
			query: '?raw',
			import: 'default',
			eager: true
		}) as Record<string, string>
	).map(([k, v]) => [k.replace('/docs/ivory-tower/seed/', ''), v])
);

export function seedFiles(): Record<string, string> {
	return { ...SEED };
}

export interface SetupResult {
	written: string[];
	labelsCreated: string[];
}

/**
 * Write whichever seed files are missing, then create the labels.
 *
 * Never overwrites: a template the owner has edited stays edited. The sample
 * project is written only while the Shelf has no projects at all, so deleting
 * it once real projects exist is not undone by running this again.
 */
export async function setupShelf(client: ShelfClient): Promise<SetupResult> {
	const existing = new Set(await listPaths(client, { fresh: true }));
	const hasProjects = [...existing].some((p) => /^projects\/[^/]+\/brief\.md$/.test(p));
	const written: string[] = [];
	// Code-point order, so README.md lands first and an empty repository opens on it.
	for (const [path, content] of Object.entries(SEED).sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (existing.has(path)) continue;
		if (path.startsWith('projects/') && hasProjects) continue;
		await writeShelfFile(client, path, content, `Seed ${path} from Galaxy`);
		written.push(path);
	}
	const labelsCreated = await ensureLabels(client, labelSet(await listProjects(client)));
	return { written, labelsCreated };
}
