import { SLUG } from './shelf';

/**
 * Where an agent may read and write on the Shelf.
 *
 * Every Shelf path an agent names goes through here, and the answer is decided
 * by code rather than by the prompt: research content is untrusted, and a page
 * that tells the reader to "also update the other project's brief" should meet
 * a refusal, not a judgement call. A refusal throws, which the loop records as
 * a failed tool call, so it shows red in the Observatory.
 */

export class ShelfScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ShelfScopeError';
	}
}

export interface ShelfScope {
	slug: string;
	/** Folders inside the project a write may land in, e.g. `notes/`. Empty means read-only. */
	writable: string[];
}

/**
 * The repository path for a path an agent gave, relative to its project.
 *
 * `projects/<slug>/…` is accepted too, since a model that has just listed the
 * folder will often echo the full path back; any other project is refused by
 * name so the Observatory shows what was attempted.
 */
export function resolveShelfPath(scope: ShelfScope, raw: string, mode: 'read' | 'write'): string {
	if (!SLUG.test(scope.slug)) throw new ShelfScopeError('This run has no valid project.');
	let rel = String(raw ?? '').trim();
	if (/[\\\0%]/.test(rel)) throw new ShelfScopeError(`Refused "${raw}": backslashes, percent-encoding and NUL are not allowed in a Shelf path.`);
	if (rel.startsWith('/')) throw new ShelfScopeError(`Refused "${raw}": use a path inside the project folder, not an absolute one.`);

	const own = `projects/${scope.slug}/`;
	if (rel.startsWith('projects/')) {
		if (!rel.startsWith(own) && rel !== own.slice(0, -1)) {
			throw new ShelfScopeError(`Refused "${raw}": this run may only touch projects/${scope.slug}/, not another project's folder.`);
		}
		rel = rel.slice(own.length);
	}
	const segments = rel.split('/');
	if (segments.some((s, i) => s === '..' || s === '.' || (s === '' && i < segments.length - 1))) {
		throw new ShelfScopeError(`Refused "${raw}": "." and ".." are not allowed in a Shelf path.`);
	}

	if (mode === 'write') {
		const name = segments.at(-1) ?? '';
		const dir = segments.slice(0, -1).join('/') + '/';
		if (!scope.writable.includes(dir)) {
			const where = scope.writable.length ? scope.writable.map((w) => own + w).join(', ') : 'nowhere';
			throw new ShelfScopeError(`Refused "${raw}": this run may write only in ${where}.`);
		}
		if (!/^[A-Za-z0-9][\w.-]*\.md$/.test(name)) {
			throw new ShelfScopeError(`Refused "${raw}": a Shelf file name is letters, digits, dots, dashes and underscores, ending in .md.`);
		}
	}
	return own + rel;
}
