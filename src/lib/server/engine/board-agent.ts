import { getCard, listCards, listLanes, listStatuses, logCard, type Board } from '$lib/server/boards';
import { createChat } from '$lib/server/chats';
import { getTaskConfig, startChatTurn } from './engine';
import type { LiveJob } from './jobs';

/**
 * Handing board work to an agent.
 *
 * This deliberately opens an ordinary chat rather than inventing a second place
 * where turns happen. The chat already streams, already recovers a dropped
 * connection, already shows the ask-user drawer, and is already where someone
 * would go to see what an agent is doing — a bespoke runner on the board would
 * have to grow all of that again, worse.
 *
 * The agent's model comes from the `board` task config, so Admin → Boards
 * governs it even though the turn itself runs as a chat.
 */

export type BoardAction = 'prioritise' | 'next-steps';

export const BOARD_ACTIONS: Record<BoardAction, string> = {
	prioritise: 'Prioritise the cards',
	'next-steps': 'Check the cards for next steps'
};

/** The model chosen for board work, or null to let the chat task decide. */
function boardModelId(): string | undefined {
	return getTaskConfig('board')?.primaryModelId ?? undefined;
}

export function startCardTurn(cardId: string, userId: string): { chatId: string; job: LiveJob } {
	const detail = getCard(cardId, userId);
	if (!detail) throw new Error('Card not found');
	const { card } = detail;
	const lane = listLanes(card.boardId).find((l) => l.id === card.laneId);
	const status = listStatuses(card.boardId).find((s) => s.id === card.statusId);

	const chat = createChat({
		userId,
		// Named after the card, so the history pane reads as a list of jobs
		// rather than a run of "New chat".
		title: `Card: ${card.title}`.slice(0, 64)
	});

	const content = [
		`I'm handing you a card from my task board. Its id is ${card.id}.`,
		'',
		`Title: ${card.title}`,
		`Lane: ${lane?.name ?? '?'} · Status: ${status?.name ?? '?'} · Priority: ${card.priority}`,
		'',
		card.description ? `Description:\n${card.description}` : '(No description was written.)',
		'',
		'Start by reading the card in full with card_read — its Log records what has already been tried.',
		'Before doing any work: if something you genuinely need is missing, or you have hit a blocker (a tool or access you do not have), ask me with ask_user. One question at a time, and only for things you cannot work out yourself.',
		'When you have done what you can, write what happened onto the card with card_comment, and only move it to a finishing status if the work is actually complete.'
	].join('\n');

	// Board work is about what is already on the board, not what is on the web.
	const job = startChatTurn({
		chatId: chat.id,
		userId,
		content,
		modelId: boardModelId(),
		webSearch: false
	});
	logCard(card.id, {
		actor: 'user',
		userId,
		event: 'handed to agent',
		detail: `working in chat ${chat.id}`
	});
	return { chatId: chat.id, job };
}

export function startBoardTurn(
	board: Board,
	action: BoardAction,
	userId: string
): { chatId: string; job: LiveJob } {
	const open = listCards(board.id);
	const chat = createChat({
		userId,
		title: `${BOARD_ACTIONS[action]} — ${board.name}`.slice(0, 64)
	});

	const intro = `You are working across the "${board.name}" board, which has ${open.length} open card${open.length === 1 ? '' : 's'}. Read it with board_read first.`;
	const instruction =
		action === 'prioritise'
			? [
					'Set each card’s priority so the order reflects what actually matters: what is time-bound, what is blocking something else, what has been sitting untouched.',
					'Use card_update to set the priorities, and say briefly in your reply why the top few are where they are.',
					'If two cards genuinely cannot be ranked without knowing something only I know, ask me with ask_user rather than guessing.'
				].join(' ')
			: [
					'For each card, work out what the actual next step is — the next concrete thing a person would do, not a restatement of the card.',
					'Write that onto the card with card_comment. Skip any card whose next step is already obvious from its description.',
					'Flag anything that is stuck, and say what it is stuck on.'
				].join(' ');

	const job = startChatTurn({
		chatId: chat.id,
		userId,
		content: `${intro}\n\n${instruction}`,
		modelId: boardModelId(),
		webSearch: false
	});
	return { chatId: chat.id, job };
}
