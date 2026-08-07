import type { LoopTool } from '../loop';
import {
	MAX_LANES,
	addLane,
	addProject,
	boardQuota,
	createBoard,
	createCard,
	getCard,
	listArchivedCards,
	listBoards,
	listCards,
	listLanes,
	listMembers,
	listProjects,
	listStatuses,
	logCard,
	renameLane,
	updateCard,
	type Board,
	type Card
} from '$lib/server/boards';
import { CARD_PRIORITIES, type CardPriority } from '$lib/server/db/schema';
import { DEFAULT_BOARDS, getSetting, type BoardSettings } from '$lib/server/settings';

/**
 * Board access for agents.
 *
 * Every read is scoped to the acting user through the same membership rule the
 * UI uses — an agent working for one person must not see the other's boards,
 * and there is no admin override here: running the platform is not the same as
 * being on someone's board.
 *
 * Writes are gated on the `agentWrites` setting. Reading is what makes an agent
 * aware of what you are doing; writing is what lets it tick things off, and not
 * everyone wants that from day one.
 */

const boardsById = (userId: string) => new Map(listBoards(userId).map((b) => [b.id, b]));

/** Short line for the context bootstrap, so the agent knows boards exist. */
export function boardsDigest(userId: string): string {
	const boards = listBoards(userId);
	if (!boards.length) return '(no boards)';
	return boards
		.map((b) => {
			const open = listCards(b.id).length;
			return `- ${b.name}${b.role === 'collaborator' ? ' [shared with you]' : ''}: ${open} open card${open === 1 ? '' : 's'}`;
		})
		.join('\n');
}

function describeCard(card: Card, boardName: string, userId: string): string {
	const lane = listLanes(card.boardId).find((l) => l.id === card.laneId);
	const status = listStatuses(card.boardId).find((s) => s.id === card.statusId);
	const detail = getCard(card.id, userId);
	const lines = [
		`# ${card.title}`,
		`board: ${boardName} · lane: ${lane?.name ?? '?'} · status: ${status?.name ?? '?'} · priority: ${card.priority}`,
		`id: ${card.id}`,
		card.archivedAt ? `archived: ${card.archivedAt.toISOString()}` : '',
		'',
		card.description || '(no description)'
	];
	if (detail?.attachments.length) {
		lines.push('', '## Attachments');
		for (const a of detail.attachments) {
			lines.push(`- ${a.name} (${a.mime})`);
			// The text was extracted at upload, so an agent reads the attachment
			// without a second round trip.
			if (a.extractedText) lines.push(a.extractedText.slice(0, 4000));
		}
	}
	if (detail?.log.length) {
		lines.push('', '## Log (oldest first)');
		for (const l of detail.log) {
			lines.push(
				`- ${l.createdAt.toISOString()} ${l.actor}: ${l.event}${l.detail ? ` — ${l.detail}` : ''}`
			);
		}
	}
	return lines.filter((l) => l !== '').join('\n');
}

function resolveCard(cardId: string, userId: string): { card: Card; board: Board } {
	const detail = getCard(cardId, userId);
	// Indistinguishable from a card that does not exist — an agent must not be
	// able to probe for ids on boards its user is not on.
	if (!detail) throw new Error(`No card with id ${cardId}`);
	const board = boardsById(userId).get(detail.card.boardId);
	if (!board) throw new Error(`No card with id ${cardId}`);
	return { card: detail.card, board };
}

/** Whether agents may change cards, or only read them. */
export function agentWritesAllowed(): boolean {
	return { ...DEFAULT_BOARDS, ...getSetting<Partial<BoardSettings>>('boards', {}) }.agentWrites;
}

/**
 * `writes` defaults to the admin setting. The admin catalogue passes true so
 * the write tools stay listed either way — a control that disappears when the
 * setting is off is a control nobody can find their way back to.
 */
export function boardTools(userId: string, writes = agentWritesAllowed()): LoopTool[] {
	const writesAllowed = writes;

	const read: LoopTool[] = [
		{
			def: {
				name: 'board_read',
				description:
					'Read a task board: its lanes, statuses and open cards. Call with no name to read every board you can see. Use this before answering anything about what someone has on, or what to do next.',
				parameters: {
					type: 'object',
					properties: {
						board: { type: 'string', description: 'Board name. Omit for all of them.' },
						archived: { type: 'boolean', description: 'Include finished cards. Default false.' }
					}
				}
			},
			describe: (a) => String(a.board ?? 'all boards'),
			execute: async (a) => {
				const wanted = String(a.board ?? '').trim().toLowerCase();
				const boards = listBoards(userId).filter(
					(b) => !wanted || b.name.toLowerCase() === wanted || b.id === a.board
				);
				if (!boards.length) {
					return wanted ? `No board called "${a.board}".` : 'You have no boards.';
				}
				return boards
					.map((b) => {
						const lanes = listLanes(b.id);
						const statuses = listStatuses(b.id);
						const projects = listProjects(b.id);
						const cards = a.archived === true ? listArchivedCards(b.id) : listCards(b.id);
						const people = (listMembers(b.id, userId) ?? []).map((m) => m.username).join(', ');
						const body = cards.length
							? cards
									.map((c) => {
										const lane = lanes.find((l) => l.id === c.laneId)?.name ?? '?';
										const status = statuses.find((s) => s.id === c.statusId)?.name ?? '?';
										const project = projects.find((p) => p.id === c.projectId);
										return `- [${c.id}] ${c.title} — ${lane} / ${status}${c.priority === 'none' ? '' : ` / ${c.priority}`}${project ? ` / ${project.name}` : ''}`;
									})
									.join('\n')
							: '(no cards)';
						return [
							`## ${b.name}`,
							`people: ${people}`,
							`lanes: ${lanes.map((l) => l.name).join(', ')}`,
							projects.length ? `projects: ${projects.map((p) => p.name).join(', ')}` : '',
							`statuses: ${statuses.map((s) => `${s.name}${s.isDone ? ' (finishes)' : ''}`).join(', ')}`,
							body
						].join('\n');
					})
					.join('\n\n');
			}
		},
		{
			def: {
				name: 'card_read',
				description:
					'Read one card in full — description, attachments and its whole activity Log. Read the Log before starting work: it records what has already been tried.',
				parameters: {
					type: 'object',
					properties: { cardId: { type: 'string' } },
					required: ['cardId']
				}
			},
			describe: (a) => String(a.cardId ?? ''),
			execute: async (a) => {
				const { card, board } = resolveCard(String(a.cardId ?? ''), userId);
				return describeCard(card, board.name, userId);
			}
		}
	];

	if (!writesAllowed) return read;

	const write: LoopTool[] = [
		{
			def: {
				name: 'card_add',
				description:
					'Add a card to a board. Only when the person has asked for something to be captured — do not file cards off your own initiative.',
				parameters: {
					type: 'object',
					properties: {
						board: { type: 'string', description: 'Board name.' },
						title: { type: 'string' },
						description: { type: 'string' },
						priority: { type: 'string', enum: [...CARD_PRIORITIES] },
						project: { type: 'string', description: 'Project name on that board.' }
					},
					required: ['board', 'title']
				}
			},
			describe: (a) => String(a.title ?? ''),
			execute: async (a) => {
				const board = findBoard(userId, a.board);
				const projects = listProjects(board.id);
				const project =
					typeof a.project === 'string'
						? projects.find(
								(p) => p.name.toLowerCase() === String(a.project).trim().toLowerCase()
							)
						: undefined;
				// Filing under a project that doesn't exist would silently drop the
				// label, which is worse than being told.
				if (a.project && !project) {
					throw new Error(
						`No project called "${a.project}" on ${board.name}. It has: ${projects.map((p) => p.name).join(', ') || 'none'}.`
					);
				}
				const card = createCard(board.id, userId, {
					title: String(a.title ?? ''),
					description: typeof a.description === 'string' ? a.description : '',
					projectId: project?.id ?? null,
					priority: CARD_PRIORITIES.includes(a.priority as CardPriority)
						? (a.priority as CardPriority)
						: undefined
				});
				if (!card) throw new Error('Could not add the card.');
				logCard(card.id, { actor: 'agent', userId, event: 'agent', detail: 'card created by agent' });
				return `Added "${card.title}" to ${board.name} (id ${card.id}).`;
			}
		},
		{
			def: {
				name: 'card_update',
				description:
					'Change a card: its status, lane, priority, title or description. Setting a status that finishes a card archives it off the board, so only do that when the work is genuinely done.',
				parameters: {
					type: 'object',
					properties: {
						cardId: { type: 'string' },
						status: { type: 'string', description: 'Status name on that card’s board.' },
						lane: { type: 'string', description: 'Lane name on that card’s board.' },
						priority: { type: 'string', enum: [...CARD_PRIORITIES] },
						project: {
							type: 'string',
							description: 'Project name on that card’s board, or "" to clear it.'
						},
						title: { type: 'string' },
						description: { type: 'string' }
					},
					required: ['cardId']
				}
			},
			describe: (a) => String(a.cardId ?? ''),
			execute: async (a) => {
				const { card } = resolveCard(String(a.cardId ?? ''), userId);
				const named = (list: { id: string; name: string }[], want: unknown) =>
					typeof want === 'string'
						? list.find((x) => x.name.toLowerCase() === want.trim().toLowerCase())?.id
						: undefined;

				const statusId = named(listStatuses(card.boardId), a.status);
				if (a.status && !statusId) {
					throw new Error(
						`No status called "${a.status}". This board has: ${listStatuses(card.boardId).map((s) => s.name).join(', ')}.`
					);
				}
				const projectId =
					a.project === '' ? null : (named(listProjects(card.boardId), a.project) ?? undefined);
				if (a.project && projectId === undefined) {
					throw new Error(
						`No project called "${a.project}". This board has: ${listProjects(card.boardId).map((p) => p.name).join(', ') || 'none'}.`
					);
				}
				const laneId = named(listLanes(card.boardId), a.lane);
				if (a.lane && !laneId) {
					throw new Error(
						`No lane called "${a.lane}". This board has: ${listLanes(card.boardId).map((l) => l.name).join(', ')}.`
					);
				}

				const updated = updateCard(
					card.id,
					userId,
					{
						statusId,
						laneId,
						projectId,
						priority: CARD_PRIORITIES.includes(a.priority as CardPriority)
							? (a.priority as CardPriority)
							: undefined,
						title: typeof a.title === 'string' ? a.title : undefined,
						description: typeof a.description === 'string' ? a.description : undefined
					},
					// Attributed to the agent in the Log, on behalf of this user.
					'agent'
				);
				if (!updated) throw new Error('Could not update the card.');
				const status = listStatuses(card.boardId).find((s) => s.id === updated.statusId);
				return `Updated "${updated.title}" — status ${status?.name ?? '?'}${updated.archivedAt ? ' (archived off the board)' : ''}.`;
			}
		},
		{
			def: {
				name: 'card_comment',
				description:
					'Write a note on a card’s Log. This is how you leave a record of what you did, what you found, or what is blocking you — the person will read it on the card.',
				parameters: {
					type: 'object',
					properties: { cardId: { type: 'string' }, note: { type: 'string' } },
					required: ['cardId', 'note']
				}
			},
			describe: (a) => String(a.cardId ?? ''),
			execute: async (a) => {
				const { card } = resolveCard(String(a.cardId ?? ''), userId);
				const note = String(a.note ?? '').trim();
				if (!note) throw new Error('note is required');
				logCard(card.id, { actor: 'agent', userId, event: 'comment', detail: note });
				return `Noted on "${card.title}".`;
			}
		}
	];

	/**
	 * Shaping the board, rather than filling it.
	 *
	 * Deliberately add-and-rename only. Deleting a lane moves its cards, deleting
	 * a board destroys every card on it, and neither is something an agent should
	 * reach for on its own reading of a situation — that stays a human action.
	 */
	const structure: LoopTool[] = [
		{
			def: {
				name: 'lane_add',
				description:
					'Add a lane (a column) to a board. Lanes group cards however the person likes — status is a separate field, so do not create lanes named after workflow states.',
				parameters: {
					type: 'object',
					properties: {
						board: { type: 'string', description: 'Board name.' },
						name: { type: 'string' }
					},
					required: ['board', 'name']
				}
			},
			describe: (a) => `${a.board}: ${a.name}`,
			execute: async (a) => {
				const board = findBoard(userId, a.board);
				const result = addLane(board.id, userId, String(a.name ?? ''));
				if (!result.ok) {
					throw new Error(
						result.reason === 'limit'
							? `${board.name} already has the maximum of ${MAX_LANES} lanes. Rename one instead, or ask the person which to drop.`
							: `You cannot change ${board.name}.`
					);
				}
				return `Added lane "${result.lane.name}" to ${board.name}.`;
			}
		},
		{
			def: {
				name: 'lane_rename',
				description: 'Rename a lane on a board.',
				parameters: {
					type: 'object',
					properties: {
						board: { type: 'string', description: 'Board name.' },
						lane: { type: 'string', description: 'Current lane name.' },
						name: { type: 'string', description: 'New name.' }
					},
					required: ['board', 'lane', 'name']
				}
			},
			describe: (a) => `${a.lane} → ${a.name}`,
			execute: async (a) => {
				const board = findBoard(userId, a.board);
				const lane = listLanes(board.id).find(
					(l) => l.name.toLowerCase() === String(a.lane ?? '').trim().toLowerCase()
				);
				if (!lane) {
					throw new Error(
						`No lane called "${a.lane}" on ${board.name}. It has: ${listLanes(board.id).map((l) => l.name).join(', ')}.`
					);
				}
				const renamed = renameLane(lane.id, userId, String(a.name ?? ''));
				if (!renamed) throw new Error('Could not rename that lane.');
				return `Renamed "${lane.name}" to "${renamed.name}" on ${board.name}.`;
			}
		},
		{
			def: {
				name: 'project_add',
				description:
					'Add a project to a board. Projects are a way of grouping and filtering cards across lanes — a house move, a holiday, the tax return. Cards are then filed against one with card_add or card_update.',
				parameters: {
					type: 'object',
					properties: {
						board: { type: 'string', description: 'Board name.' },
						name: { type: 'string' }
					},
					required: ['board', 'name']
				}
			},
			describe: (a) => `${a.board}: ${a.name}`,
			execute: async (a) => {
				const board = findBoard(userId, a.board);
				const project = addProject(board.id, userId, { name: String(a.name ?? '') });
				if (!project) throw new Error(`You cannot change ${board.name}.`);
				return `Added project "${project.name}" to ${board.name}.`;
			}
		},
		{
			def: {
				name: 'board_add',
				description:
					'Create a new board. Only when the person has asked for one — a board is a place they will have to tend, not a filing convenience. It arrives with default lanes and statuses.',
				parameters: {
					type: 'object',
					properties: { name: { type: 'string' }, description: { type: 'string' } },
					required: ['name']
				}
			},
			describe: (a) => String(a.name ?? ''),
			execute: async (a) => {
				// The cap lives in the service layer precisely so this path obeys it.
				const quota = boardQuota(userId);
				if (quota.exceeded) {
					throw new Error(
						`They already own ${quota.owned} boards, which is the limit an admin has set. Ask them which to archive.`
					);
				}
				const board = createBoard({
					ownerId: userId,
					name: String(a.name ?? ''),
					description: typeof a.description === 'string' ? a.description : ''
				});
				return `Created board "${board.name}" with lanes ${listLanes(board.id).map((l) => l.name).join(', ')}.`;
			}
		}
	];

	return [...read, ...write, ...structure];
}

/** Resolve a board by name for the tools, with the same "no such board" story. */
function findBoard(userId: string, name: unknown): Board {
	const wanted = String(name ?? '').trim().toLowerCase();
	const board = listBoards(userId).find((b) => b.name.toLowerCase() === wanted || b.id === name);
	if (!board) throw new Error(`No board called "${name}".`);
	return board;
}
