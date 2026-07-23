import type { LoopTool } from '../loop';
import { getSkill, skillIndexText } from '$lib/server/skills';
import {
	findDocByTitle,
	getDoc,
	libraryDigest,
	saveDoc,
	searchDocs
} from '$lib/server/library';
import { memoryDigest } from '../memory';

/**
 * The context bootstrap: appended to every agent's system prompt so it knows
 * what skills and Library knowledge exist. Bodies load on demand through the
 * knowledge tools (progressive disclosure — the index stays cheap).
 */
export function bootstrapContext(): string {
	return [
		'',
		'[Available skills — load the full instructions with skill_load when one applies]',
		skillIndexText(),
		'',
		'[Library — shared knowledge docs; read with library_read, search with library_search, save durable knowledge with library_write]',
		libraryDigest(),
		memoryDigest()
	].join('\n');
}

/** Tools shared by every agent: skills + Library access. */
export function knowledgeTools(): LoopTool[] {
	return [
		{
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
			def: {
				name: 'library_search',
				description: 'Full-text search across the Library documents.',
				parameters: {
					type: 'object',
					properties: { query: { type: 'string' } },
					required: ['query']
				}
			},
			describe: (a) => String(a.query ?? ''),
			execute: async (a) => {
				const results = searchDocs(String(a.query ?? ''));
				if (!results.length) return 'No matches.';
				return results
					.map((r) => `- ${r.title} (id: ${r.id}): ${r.match}`)
					.join('\n');
			}
		},
		{
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
				const meta = findDocByTitle(ref);
				const doc = meta ? getDoc(meta.id) : getDoc(ref);
				if (!doc) throw new Error(`No Library doc matching "${ref}"`);
				return doc.body.slice(0, 60_000);
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
				const existing = findDocByTitle(title);
				const doc = saveDoc({
					id: existing?.id,
					title,
					body: String(a.content ?? ''),
					author: 'agent'
				});
				return `Saved Library doc "${doc.title}" (id: ${doc.id})`;
			}
		}
	];
}
