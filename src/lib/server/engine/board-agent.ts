import {
	getCard,
	listCards,
	listLanes,
	listStatuses,
	logCard,
	type Board,
	type Card
} from '$lib/server/boards';
import { createChat } from '$lib/server/chats';
import { EngineError, getTaskConfig, startChatTurn } from './engine';
import { createSession, startCodingTurn } from './coding/session';
import { notify } from '$lib/server/notifications';
import { subscribeJob, type LiveJob } from './jobs';

/**
 * Handing board work to an agent.
 *
 * This deliberately opens an ordinary chat rather than inventing a second place
 * where turns happen. The chat already streams, already recovers a dropped
 * connection, already shows the ask-user drawer, and is already where someone
 * would go to see what an agent is doing — a bespoke runner on the board would
 * have to grow all of that again, worse.
 *
 * The agent's model and its system prompt both come from the `board` task
 * config, so Admin governs the register board replies come out in even though
 * the turn itself runs as a chat. The prompt arrives through `chats.agentTask`
 * rather than this file — see that column, and `systemPromptFor`.
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
		title: `Card: ${card.title}`.slice(0, 64),
		// Carries the board prompt into every turn of this chat, the owner's
		// follow-up replies included. The task config used to supply only a model
		// here, which meant the board prompt in Admin -> Tasks reached nothing and
		// board replies came out in the chat agent's register.
		agentTask: 'board'
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
	notifyWhenFinished(job, card, userId);
	return { chatId: chat.id, job };
}

/**
 * Ring the bell when the agent a card was handed to has finished.
 *
 * You hand a card over and walk away, so the result would otherwise land
 * unannounced in the card's Log. Watching the job is enough: no engine hook
 * needed, and it costs one subscriber for the life of the run.
 */
function notifyWhenFinished(job: LiveJob, card: Card, userId: string): void {
	const off = subscribeJob(job, (chunk) => {
		if (chunk.type !== 'done' && chunk.type !== 'error') return;
		off();
		notify({
			userId,
			kind: 'card-done',
			title:
				chunk.type === 'error'
					? `An agent gave up on "${card.title}"`
					: `An agent finished with "${card.title}"`,
			body: chunk.type === 'error' ? chunk.message : 'Read what it did on the card.',
			link: `/boards?card=${card.id}`,
			entityId: card.id
		});
	});
}

/**
 * The first message of a coding session started from a card.
 *
 * The card is all the session knows about why it exists, so the brief carries
 * the card id: that is what lets the agent write back to it when it is done.
 */
export function cardCodingBrief(card: Pick<Card, 'id' | 'title' | 'description'>): string {
	return [
		`This coding session is for a card on my task board. Its id is ${card.id}.`,
		'',
		`## ${card.title}`,
		card.description || '(No description was written.)',
		'',
		'Read the card with card_read first: its Log records what has already been tried. If the description names a plan document in the repository, read that too before you start.',
		'Make the change, run the repository’s own checks, commit and push.',
		'When you are done, write what you changed onto the card with card_comment, and move it to a finishing status with card_update only if the work is actually complete.'
	].join('\n');
}

/**
 * Start a card as a coding session on the repository it was filed against.
 *
 * An ordinary session and an ordinary turn, so the Code page shows it the same
 * way as any other: streaming, the diff, the pull request button. Implement
 * mode, because a card filed from a plan is already the plan.
 */
export async function startCardCoding(
	cardId: string,
	userId: string
): Promise<{ chatId: string; job: LiveJob }> {
	const detail = getCard(cardId, userId);
	if (!detail) throw new Error('Card not found');
	const { card } = detail;
	if (!card.repoUrl) throw new EngineError('This card is not tied to a repository');

	const session = await createSession({
		userId,
		repoUrl: card.repoUrl,
		repoName: card.title.slice(0, 64),
		mode: 'implement'
	});
	const job = startCodingTurn({
		session,
		userId,
		content: cardCodingBrief(card),
		webSearch: false
	});
	logCard(card.id, {
		actor: 'user',
		userId,
		event: 'started in code',
		detail: `working in session ${session.chatId}`
	});
	notifyWhenFinished(job, card, userId);
	return { chatId: session.chatId, job };
}

export function startBoardTurn(
	board: Board,
	action: BoardAction,
	userId: string
): { chatId: string; job: LiveJob } {
	const open = listCards(board.id);
	const chat = createChat({
		userId,
		title: `${BOARD_ACTIONS[action]} — ${board.name}`.slice(0, 64),
		agentTask: 'board'
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
