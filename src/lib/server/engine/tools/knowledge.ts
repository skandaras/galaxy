import type { LoopTool } from '../loop';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { skillCandidates, skills } from '$lib/server/db/schema';
import {
	getSkill,
	normalizeSkillName,
	normalizeTasks,
	readSkillFile,
	skillDir,
	skillFiles,
	skillIndexText
} from '$lib/server/skills';
import { repoSkills, safeJoin } from '../coding/workspace';
import {
	docPath,
	findDocByTitle,
	getDoc,
	libraryDigest,
	listChildren,
	listFolderCounts,
	listFolderRoots,
	saveDoc,
	searchDocs,
	subtreeCounts
} from '$lib/server/library';
import { UNFILED } from '$lib/library-tree';
import { toolResultMaxChars } from '../limits';
import { memoryDigest, memoryTitle, readMemory } from '../memory';
import { boardsDigest } from './boards';

/**
 * The context bootstrap: appended to every agent's system prompt so it knows
 * what skills and Library knowledge exist. Bodies load on demand through the
 * knowledge tools (progressive disclosure — the index stays cheap).
 */
export function bootstrapContext(userId: string, task?: string): string {
	return [
		'',
		'[Available skills: load the full instructions with skill_load when one applies]',
		// Only this person's skills and shared ones, and only those meant for
		// this task: a coding prompt has no use for the Figma skill's line.
		skillIndexText(userId, task),
		'',
		'[Library index: a line per folder, naming what sits at the top of it and nothing nested inside that. These are the docs you can see: your own plus anything shared. A "(N beneath)" is a whole subtree collapsed to one number: open it with library_tree. This is a catalogue, not their contents: search inside them with library_search, read one with library_read, save durable knowledge with library_write, filed inside an existing document wherever it belongs under one, which costs this block nothing]',
		libraryDigest(userId),
		'',
		'[Task boards: yours plus any shared with you. Read them with board_read, one card in full with card_read]',
		boardsDigest(userId),
		// Only this user's memories — never another user's observations.
		memoryDigest(userId)
	].join('\n');
}

/**
 * Tools shared by every agent: skills, memory and the Library.
 *
 * `userId` scopes every Library call to what that person may see. It is not
 * optional — the Library is the one store whose contents reach a *different*
 * user's prompt, so an unscoped read here leaks one person's notes into
 * another's context.
 */
export function knowledgeTools(
	userId: string,
	opts: {
		/**
		 * A coding session's workspace, whose own skills (`.agents/skills`,
		 * `.claude/skills`) load ahead of stored ones of the same name: the
		 * repository knows its own procedures better than a copy elsewhere.
		 */
		repo?: string;
		/**
		 * A hidden chat is never written to the database, so it is offered no
		 * way to propose a skill: the proposal would be a record of it.
		 */
		hidden?: boolean;
	} = {}
): LoopTool[] {
	/** The folder and body of a skill this person may load, repository first. */
	const resolveSkill = (name: string): { dir: string; body: string } | null => {
		if (opts.repo) {
			const found = repoSkills(opts.repo).find((s) => s.name === name);
			if (found) {
				const dir = safeJoin(opts.repo, found.dirRel);
				const raw = readSkillFile(dir, 'SKILL.md', toolResultMaxChars());
				return { dir, body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') };
			}
		}
		const stored = getSkill(name, userId);
		if (!stored || !stored.meta.enabled) return null;
		return { dir: skillDir(stored.meta), body: stored.body };
	};
	// One proposal a turn: a second in the same turn is a list, not a noticed pattern.
	let proposed = false;

	const tools: LoopTool[] = [
		{
			parallelSafe: true,
			def: {
				name: 'skill_load',
				description:
					'Load the full instructions of a skill from the skill index. Lists any files the ' +
					'skill carries beside its instructions; read one with skill_read when you need it.',
				parameters: {
					type: 'object',
					properties: { name: { type: 'string' } },
					required: ['name']
				}
			},
			describe: (a) => String(a.name ?? ''),
			execute: async (a) => {
				const skill = resolveSkill(String(a.name ?? ''));
				if (!skill) throw new Error(`No such skill: ${a.name}`);
				const files = skillFiles(skill.dir);
				return files.length
					? `${skill.body}\n\n[Files in this skill, for skill_read: ${files.join(', ')}]`
					: skill.body;
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'skill_read',
				description:
					'Read one file a skill carries beside its instructions: a reference, a template, a ' +
					'script. skill_load lists them.',
				parameters: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'The skill' },
						path: { type: 'string', description: 'The file, as skill_load listed it' }
					},
					required: ['name', 'path']
				}
			},
			describe: (a) => `${a.name ?? ''}/${a.path ?? ''}`,
			execute: async (a) => {
				const skill = resolveSkill(String(a.name ?? ''));
				if (!skill) throw new Error(`No such skill: ${a.name}`);
				return readSkillFile(skill.dir, String(a.path ?? ''), toolResultMaxChars());
			}
		},
		{
			def: {
				name: 'propose_skill',
				description:
					'Propose a skill: written instructions for a procedure, which agents load when it ' +
					'applies. Use it when this turn carried out a procedure the person is likely to want ' +
					'again, or they corrected how you went about something in a way that would hold next ' +
					'time. Not for a one-off answer. It goes to the person for approval and does nothing ' +
					'until they approve it. At most one a turn.',
				parameters: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'kebab-case' },
						description: {
							type: 'string',
							description: 'One line saying when an agent should use it'
						},
						body: {
							type: 'string',
							description: 'The instructions, in markdown: when to use it, then the steps'
						},
						rationale: {
							type: 'string',
							description: 'What in this conversation shows it will be needed again'
						},
						category: { type: 'string' },
						triggers: { type: 'string', description: 'Comma-separated keywords' },
						tasks: {
							type: 'string',
							description: 'The agents it is for (chat, coding); empty for all'
						}
					},
					required: ['name', 'description', 'body', 'rationale']
				}
			},
			describe: (a) => String(a.name ?? ''),
			execute: async (a) => {
				if (proposed) throw new Error('One skill proposal a turn. Mention any other in your reply.');
				const name = normalizeSkillName(String(a.name ?? ''));
				const body = String(a.body ?? '').trim();
				if (!name || !body) throw new Error('name and body are required');
				// Every name ever proposed, whatever became of it: a rejection is a
				// decision, and the memory job reads the same table for the same reason.
				const taken =
					db.select({ id: skills.id }).from(skills).where(eq(skills.name, name)).get() ??
					db
						.select({ id: skillCandidates.id })
						.from(skillCandidates)
						.where(eq(skillCandidates.name, name))
						.get();
				if (taken) throw new Error(`A skill called ${name} already exists or was already proposed`);
				db.insert(skillCandidates)
					.values({
						id: randomUUID(),
						userId,
						name,
						category: normalizeSkillName(String(a.category ?? '')) || 'general',
						description: String(a.description ?? '').trim().slice(0, 300),
						triggers: String(a.triggers ?? '').trim().slice(0, 300),
						tasks: normalizeTasks(a.tasks),
						body: body.slice(0, 20_000),
						rationale: String(a.rationale ?? '').trim().slice(0, 1000),
						status: 'pending',
						createdAt: new Date()
					})
					.run();
				proposed = true;
				return `Proposed ${name}. It waits for the person's approval on their Memory page; say so in your reply.`;
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'memory_read',
				description:
					"Read one of this person's memories in full, by the title the Memory index shows. " +
					'Only when it bears on the reply: most turns need none of them.',
				parameters: {
					type: 'object',
					properties: { title: { type: 'string' } },
					required: ['title']
				}
			},
			describe: (a) => String(a.title ?? ''),
			execute: async (a) => {
				// Scoped to this person: readMemory only ever reads their own rows.
				const found = readMemory(userId, String(a.title ?? ''));
				if (!found.length) throw new Error(`No memory titled "${a.title}"`);
				return found.map((m) => `${memoryTitle(m)} (${m.kind})\n${m.content}`).join('\n\n');
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'library_search',
				description:
					'Search inside the Library. Matches on document titles and full text, and returns ' +
					'the matching fragments with their document ids, not whole documents. Use this ' +
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
				name: 'library_tree',
				description:
					'Open one level of the Library. With no arguments it lists the folders, which is ' +
					'the top of the shelf: there is nothing above a folder and no document sits ' +
					'outside one. With a folder it lists the documents at the top of that folder; ' +
					'with a document id, what is filed under that document. This is how you open a ' +
					'subtree the index collapsed to a count: the index carries a line per folder, so ' +
					'a deep tree costs nothing there and is expanded here on demand.',
				parameters: {
					type: 'object',
					properties: {
						folder: { type: 'string', description: 'Folder name, to list the documents in it.' },
						id: { type: 'string', description: 'Document id, to list what is filed under it.' }
					},
					required: []
				}
			},
			describe: (a) => String(a.id ?? a.folder ?? '(folders)'),
			execute: async (a) => {
				const parentId = String(a.id ?? '').trim();
				const folder = String(a.folder ?? '').trim();
				const counts = subtreeCounts(userId);
				const line = (d: { id: string; title: string; author: string }) => {
					// A document's own subtree count needs its root, and a document is
					// only a root when it has no parent — so the map only holds a count
					// for the roots. Below the top of a folder the count is the listing.
					const under = (counts.get(d.id) ?? 1) - 1;
					return `- ${d.title} (id: ${d.id})${d.author === 'agent' ? ' [agent]' : ''}${
						under > 0 ? `, ${under} beneath it` : ''
					}`;
				};

				if (parentId) {
					if (!getDoc(parentId, userId)) throw new Error(`No Library doc with id "${parentId}"`);
					const children = listChildren(parentId, userId);
					return children.length ? children.map(line).join('\n') : 'Nothing is filed under it.';
				}
				if (folder) {
					// Unfiled is the empty label on the row; the name is what a person
					// and this tool's own listing both call it.
					const roots = listFolderRoots(folder === UNFILED ? '' : folder, userId);
					return roots.length ? roots.map(line).join('\n') : 'That folder is empty.';
				}
				const folders = listFolderCounts(userId);
				if (!folders.length) return '(library is empty)';
				return folders
					.map((f) => `- ${f.name} (folder): ${f.count} document${f.count === 1 ? '' : 's'}`)
					.join('\n');
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
				// Where it sits, so an agent reading a nested document knows what it
				// belongs to without walking back up by hand.
				const path = docPath(doc.meta.id, userId);
				const where = path.length > 1 ? `[Filed under: ${path.slice(0, -1).join(' › ')}]\n\n` : '';
				// Held to the same per-call budget as a file read in a coding turn.
				// A hardcoded 60k could put twice the whole tool budget into context
				// from one call, and every later iteration re-sent it.
				const cap = toolResultMaxChars();
				const body =
					doc.body.length > cap
						? `${doc.body.slice(0, cap)}\n\n[truncated at ${cap} characters. Search this doc for the part you need]`
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
					'keeps the index cheap: a document nested inside another costs the index nothing, ' +
					'where one more at the top of a folder is named on every turn.',
				parameters: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						content: { type: 'string', description: 'Full markdown body' },
						parentId: {
							type: 'string',
							description:
								'Id of the document this one belongs under. Omit to leave it at the top of a folder.'
						},
						folder: {
							type: 'string',
							description:
								'Folder it sits in, when it is not inside another document. A parent decides ' +
								'the folder on its own, so this is ignored alongside parentId.'
						}
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
	return opts.hidden ? tools.filter((t) => t.def.name !== 'propose_skill') : tools;
}
