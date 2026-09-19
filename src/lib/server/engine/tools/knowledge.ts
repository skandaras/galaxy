import type { LoopTool } from '../loop';
import { getSkill, skillIndexText } from '$lib/server/skills';
import {
	docPath,
	findDocByTitle,
	getDoc,
	libraryDigest,
	listChildren,
	saveDoc,
	searchDocs,
	subtreeCounts
} from '$lib/server/library';
import { toolResultMaxChars } from '../limits';
import { cortexDigest } from '$lib/server/cortex';
import { memoryDigest } from '../memory';
import { boardsDigest } from './boards';

/**
 * The context bootstrap: appended to every agent's system prompt so it knows
 * what skills and Library knowledge exist. Bodies load on demand through the
 * knowledge tools (progressive disclosure — the index stays cheap).
 */
export function bootstrapContext(userId: string): string {
	return [
		'',
		'[Available skills — load the full instructions with skill_load when one applies]',
		skillIndexText(),
		'',
		'[Library index — the top of each tree, never its leaves. These are the docs you can see: your own plus anything shared. A line saying "N documents beneath it" is a whole subtree collapsed to one line: open it with library_tree to see what is in there. This is a catalogue, not their contents: search inside them with library_search, read one with library_read, save durable knowledge with library_write]',
		libraryDigest(userId),
		'',
		'[Task boards — yours plus any shared with you. Read them with board_read, one card in full with card_read]',
		boardsDigest(userId),
		// Ahead of the memory digest on purpose. Placed after it, Cortex read as
		// more of the same — another record of things that already happened — and
		// an agent that takes it for an archive never thinks to consult it before
		// answering. The map comes first, then the log.
		cortexDigest(userId),
		// Only this user's memories — never another user's observations.
		memoryDigest(userId)
	].join('\n');
}

/**
 * Tools shared by every agent: skills + Library access.
 *
 * `userId` scopes every Library call to what that person may see. It is not
 * optional — the Library is the one store whose contents reach a *different*
 * user's prompt, so an unscoped read here leaks one person's notes into
 * another's context.
 */
export function knowledgeTools(userId: string): LoopTool[] {
	return [
		{
			parallelSafe: true,
			def: {
				name: 'skill_load',
				description: 'Load the full instructions of a skill from the skill index.',
				parameters: {
					type: 'object',
					properties: { name: { type: 'string' } },
					required: ['name']
				}
			},
			describe: (a) => String(a.name ?? ''),
			execute: async (a) => {
				const skill = getSkill(String(a.name ?? ''));
				if (!skill || !skill.meta.enabled) throw new Error(`No such skill: ${a.name}`);
				return skill.body;
			}
		},
		{
			parallelSafe: true,
			lookup: true,
			def: {
				name: 'library_search',
				description:
					'Search inside the Library. Matches on document titles and full text, and returns ' +
					'the matching fragments with their document ids — not whole documents. Use this ' +
					'to find which doc holds something, then library_read to open it.',
				parameters: {
					type: 'object',
					properties: { query: { type: 'string' } },
					required: ['query']
				}
			},
			describe: (a) => String(a.query ?? ''),
			execute: async (a) => {
				const results = searchDocs(String(a.query ?? ''), userId);
				if (!results.length) return 'No matches.';
				return results.map((r) => `- ${r.title} (id: ${r.id}): ${r.match}`).join('\n');
			}
		},
		{
			parallelSafe: true,
			lookup: true,
			def: {
				name: 'library_tree',
				description:
					'List what sits directly under a Library document, one line each. Called with no ' +
					'id it lists the tops of every tree. This is how you open a subtree the index ' +
					'collapsed to a count — the index deliberately carries roots rather than every ' +
					'document, so a deep tree costs one line there and is expanded here on demand.',
				parameters: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Document id. Omit to list the tops.' }
					},
					required: []
				}
			},
			describe: (a) => String(a.id ?? '(top level)'),
			execute: async (a) => {
				const parentId = String(a.id ?? '').trim() || null;
				if (parentId && !getDoc(parentId, userId)) throw new Error(`No Library doc with id "${parentId}"`);
				const children = listChildren(parentId, userId);
				if (!children.length) return parentId ? 'Nothing is filed under it.' : '(library is empty)';
				const counts = subtreeCounts(userId);
				return children
					.map((c) => {
						// A child's own subtree count needs its root, and a child is only a
						// root when it has no parent — so anything listed here reports what
						// is under *it* by asking for its own id, which the map only holds
						// for roots. Below the top level the count is the child listing.
						const under = (counts.get(c.id) ?? 1) - 1;
						const tail = under > 0 ? ` — ${under} beneath it` : '';
						return `- ${c.title} (id: ${c.id})${c.author === 'agent' ? ' [agent]' : ''}${tail}`;
					})
					.join('\n');
			}
		},
		{
			parallelSafe: true,
			lookup: true,
			def: {
				name: 'library_read',
				description: 'Read a Library document by title or id.',
				parameters: {
					type: 'object',
					properties: { title: { type: 'string' } },
					required: ['title']
				}
			},
			describe: (a) => String(a.title ?? ''),
			execute: async (a) => {
				const ref = String(a.title ?? '');
				const meta = findDocByTitle(ref, userId);
				const doc = meta ? getDoc(meta.id, userId) : getDoc(ref, userId);
				if (!doc) throw new Error(`No Library doc matching "${ref}"`);
				// Where it sits, so an agent reading a task record knows which sprint
				// and which epic it belongs to without walking back up by hand.
				const path = docPath(doc.meta.id, userId);
				const where = path.length > 1 ? `[Filed under: ${path.slice(0, -1).join(' › ')}]\n\n` : '';
				// Held to the same per-call budget as a file read in a coding turn.
				// A hardcoded 60k could put twice the whole tool budget into context
				// from one call, and every later iteration re-sent it.
				const cap = toolResultMaxChars();
				const body =
					doc.body.length > cap
						? `${doc.body.slice(0, cap)}\n\n[truncated at ${cap} characters — search this doc for the part you need]`
						: doc.body;
				return where + body;
			}
		},
		{
			def: {
				name: 'library_write',
				description:
					'Create or update a Library document (markdown). Use for durable knowledge worth ' +
					'keeping across conversations, not scratch notes. Filing it under a parent is what ' +
					'keeps the index cheap: a document inside a tree costs the index nothing, where a ' +
					'new top-level document costs it a line on every turn.',
				parameters: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						content: { type: 'string', description: 'Full markdown body' },
						parentId: {
							type: 'string',
							description: 'Id of the document this one belongs under. Omit for a top-level document.'
						},
						folder: { type: 'string', description: 'Shelf label for a top-level document.' }
					},
					required: ['title', 'content']
				}
			},
			describe: (a) => String(a.title ?? ''),
			execute: async (a) => {
				const title = String(a.title ?? '').trim();
				if (!title) throw new Error('title is required');
				const existing = findDocByTitle(title, userId);
				const parentId = String(a.parentId ?? '').trim();
				const folder = String(a.folder ?? '').trim();
				const doc = saveDoc({
					id: existing?.id,
					title,
					body: String(a.content ?? ''),
					author: 'agent',
					ownerId: userId,
					// Both omitted mean "leave it where it is", which is what saveDoc
					// already does with undefined — passing '' would unfile it.
					...(parentId ? { parentId } : {}),
					...(folder ? { folder } : {})
				});
				return `Saved Library doc "${doc.title}" (id: ${doc.id})`;
			}
		}
	];
}
