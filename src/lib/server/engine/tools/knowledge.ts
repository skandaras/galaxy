import type { LoopTool } from '../loop';
import { randomUUID } from 'node:crypto';
import { db } from '$lib/server/db';
import { skillCandidates } from '$lib/server/db/schema';
import {
	getSkill,
	normalizeSkillName,
	normalizeTasks,
	proposeSkillPatch,
	readSkillFile,
	skillDir,
	skillFiles,
	skillIndexText,
	skillNameSeen
} from '$lib/server/skills';
import { readEdits } from '$lib/skill-patch';
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
import { profileBlock } from '$lib/server/profile';
import { boardsDigest } from './boards';
import { profileTools } from './profile';

/**
 * The context bootstrap: appended to every agent's system prompt so it knows
 * what skills and Library knowledge exist. Bodies load on demand through the
 * knowledge tools (progressive disclosure — the index stays cheap).
 */
export function bootstrapContext(
	userId: string,
	task?: string,
	/**
	 * Leave out the Library index and the boards digest, tools still offered.
	 * Only the evaluation runner asks for it, to measure whether a lighter
	 * prompt answers everyday questions better; nothing in production does.
	 */
	opts: { lean?: boolean } = {}
): string {
	const profile = task ? profileBlock(userId, task) : '';
	return [
		// First, because it changes least. A write to the Library or a board
		// rewrites everything after it in the prompt, and a provider caches only
		// the prefix up to the first change.
		...(profile ? ['', profile] : []),
		'',
		'[Available skills: load the full instructions with skill_load when one applies]',
		// Only this person's skills and shared ones, and only those meant for
		// this task: a coding prompt has no use for the Figma skill's line.
		skillIndexText(userId, task),
		...(opts.lean
			? []
			: [
					'',
					'[Library index: a line per folder, naming what sits at the top of it and nothing nested inside that. These are the docs you can see: your own plus anything shared. A "(N beneath)" is a whole subtree collapsed to one number: open it with library_tree. This is a catalogue, not their contents: search inside them with library_search, read one with library_read, save durable knowledge with library_write, filed inside an existing document wherever it belongs under one, which costs this block nothing]',
					libraryDigest(userId),
					'',
					'[Task boards: yours plus any shared with you. Read them with board_read, one card in full with card_read]',
					boardsDigest(userId)
				])
	].join('\n');
}

/**
 * Tools shared by every agent: skills, the Library and the Profile.
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
		/** Which agent this is, which decides what of the profile it can reach. */
		task?: string;
		/** The chat a profile note's quote is checked against. */
		chatId?: string;
	} = {}
): LoopTool[] {
	/** The folder and body of a skill this person may load, repository first. */
	const resolveSkill = (name: string): { dir: string; body: string; fromRepo: boolean } | null => {
		if (opts.repo) {
			const found = repoSkills(opts.repo).find((s) => s.name === name);
			if (found) {
				const dir = safeJoin(opts.repo, found.dirRel);
				const raw = readSkillFile(dir, 'SKILL.md', toolResultMaxChars());
				return { dir, body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''), fromRepo: true };
			}
		}
		const stored = getSkill(name, userId);
		if (!stored || !stored.meta.enabled) return null;
		return { dir: skillDir(stored.meta), body: stored.body, fromRepo: false };
	};
	// One proposal a turn: a second in the same turn is a list, not a noticed pattern.
	let proposed = false;
	/**
	 * The skills loaded this turn, and whether each came from the repository. A
	 * change may only be proposed to one of these: the agent has to have read
	 * the text its edits quote.
	 */
	const loaded = new Map<string, { fromRepo: boolean }>();

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
				loaded.set(String(a.name ?? ''), { fromRepo: skill.fromRepo });
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
				// Every name this person has, or has ever proposed: a rejection is a
				// decision. Only theirs, though; a name taken by someone else's
				// personal skill is not theirs to know about, and approval saves
				// under a free name instead (see decideCandidate).
				if (skillNameSeen(userId, name)) {
					throw new Error(
						`You already have a skill called ${name}, or proposed one. If it needs changing, load it with skill_load and propose the change with propose_skill_update.`
					);
				}
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
				return `Proposed ${name}. It waits for the person's approval on their Profile page; say so in your reply.`;
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
			// The reference alone. Who may see a document can change, and a re-read
			// goes back through the visibility check in SQL, where an excerpt kept
			// here would carry on outliving an unshare.
			evidence: (_a, _output, meta) =>
				typeof meta.docId === 'string'
					? { ref: meta.docId, title: String(meta.title ?? ''), excerpt: '' }
					: null,
			execute: async (a, report) => {
				const ref = String(a.title ?? '');
				const meta = findDocByTitle(ref, userId);
				const doc = meta ? getDoc(meta.id, userId) : getDoc(ref, userId);
				if (!doc) throw new Error(`No Library doc matching "${ref}"`);
				report?.({ docId: doc.meta.id, title: doc.meta.title });
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
	if (opts.task) {
		tools.push(...profileTools(userId, { task: opts.task, chatId: opts.chatId, hidden: opts.hidden }));
	}
	tools.push({
		def: {
			name: 'propose_skill_update',
			description:
				'Propose a change to a skill you loaded with skill_load this turn: exact edits, each ' +
				'replacing one passage of its instructions with new text. Use it when following the ' +
				'skill went wrong, or found a step it is missing, or the person corrected how it is ' +
				'done, in a way that will hold next time. Copy each old passage exactly from what ' +
				'skill_load returned, with enough of it to name one place. It goes to whoever decides ' +
				'that skill and changes nothing until they approve it. Shares the one proposal a turn ' +
				'with propose_skill.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The skill, as skill_load named it' },
					edits: {
						type: 'array',
						description: 'In order. Each old_string must appear exactly once in the skill.',
						items: {
							type: 'object',
							properties: {
								old_string: { type: 'string' },
								new_string: { type: 'string' }
							},
							required: ['old_string', 'new_string']
						}
					},
					rationale: {
						type: 'string',
						description: 'What in this conversation shows the skill needs this'
					},
					description: { type: 'string', description: 'A new one-line description, if it needs one' },
					triggers: { type: 'string', description: 'New comma-separated triggers, if they need changing' }
				},
				required: ['name', 'edits', 'rationale']
			}
		},
		describe: (a) => String(a.name ?? ''),
		execute: async (a) => {
			if (proposed) throw new Error('One skill proposal a turn. Mention any other in your reply.');
			const name = String(a.name ?? '').trim();
			const seen = loaded.get(name);
			if (!seen) throw new Error(`Load ${name || 'the skill'} with skill_load first, and quote your edits from it.`);
			if (seen.fromRepo) {
				throw new Error(
					`${name} is this repository's own skill. Edit .agents/skills/${name}/SKILL.md as part of the change instead.`
				);
			}
			const edits = readEdits(a.edits);
			if ('problem' in edits) throw new Error(edits.problem);
			const stored = getSkill(name, userId);
			if (!stored) throw new Error(`No such skill: ${name}`);
			proposeSkillPatch({
				userId,
				skill: stored,
				patch: {
					edits,
					...(typeof a.description === 'string' && a.description.trim()
						? { description: a.description.trim().slice(0, 300) }
						: {}),
					...(typeof a.triggers === 'string' && a.triggers.trim()
						? { triggers: a.triggers.trim().slice(0, 300) }
						: {})
				},
				rationale: String(a.rationale ?? '')
			});
			proposed = true;
			return stored.meta.ownerId === userId
				? `Proposed a change to ${name}. It waits for the person's approval on their Profile page; say so in your reply.`
				: `Proposed a change to ${name}. It is a shared skill, so an admin decides it in Admin; say so in your reply.`;
		}
	});
	// A hidden chat is never written to the database, and a proposal is a record of it.
	return opts.hidden
		? tools.filter((t) => t.def.name !== 'propose_skill' && t.def.name !== 'propose_skill_update')
		: tools;
}
