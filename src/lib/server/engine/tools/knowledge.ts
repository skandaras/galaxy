import type { LoopTool } from '../loop';
import { getSkill, skillIndexText } from '$lib/server/skills';
import {
	findDocByTitle,
	getDoc,
	libraryDigest,
	saveDoc,
	searchDocs
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
		'[Library index — titles only, grouped by folder. These are the docs you can see: your own plus anything shared. This is a catalogue, not their contents: search inside them with library_search, open one with library_read, save durable knowledge with library_write]',
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
				// Held to the same per-call budget as a file read in a coding turn.
				// A hardcoded 60k could put twice the whole tool budget into context
				// from one call, and every later iteration re-sent it.
				const cap = toolResultMaxChars();
				return doc.body.length > cap
					? `${doc.body.slice(0, cap)}\n\n[truncated at ${cap} characters — search this doc for the part you need]`
					: doc.body;
			}
		},
		{
			def: {
				name: 'library_write',
				description:
					'Create or update a Library document (markdown). Use for durable knowledge worth keeping across conversations, not scratch notes.',
				parameters: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						content: { type: 'string', description: 'Full markdown body' }
					},
					required: ['title', 'content']
				}
			},
			describe: (a) => String(a.title ?? ''),
			execute: async (a) => {
				const title = String(a.title ?? '').trim();
				if (!title) throw new Error('title is required');
				const existing = findDocByTitle(title, userId);
				const doc = saveDoc({
					id: existing?.id,
					title,
					body: String(a.content ?? ''),
					author: 'agent',
					ownerId: userId
				});
				return `Saved Library doc "${doc.title}" (id: ${doc.id})`;
			}
		}
	];
}
