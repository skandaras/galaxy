import { liveActivity, type TimelineItem } from './run-timeline';

/**
 * What the Orrery shows: one state for whatever a turn is doing, read from the
 * live timeline and the page's own fields rather than kept as a second copy.
 * See liveActivity for why: a reconnecting client replays the timeline and
 * must land on the same answer as one that watched the whole run.
 */
export type Presence =
	| 'idle'
	| 'typing'
	| 'thinking'
	| 'searching'
	| 'tool'
	| 'streaming'
	| 'waiting'
	| 'error'
	| 'done';

/** Which colour a running call's satellite takes. */
export type ToolKind = 'web' | 'knowledge' | 'code' | 'media' | 'boards' | 'other';

/**
 * Built-in tool name to kind, following the groups registry.ts files them
 * under (registry.test.ts holds the two together, so a new tool cannot be left
 * out). The browser sees only names; an MCP tool, or one this list has never
 * heard of, is `other`.
 */
export const TOOL_KIND: Record<string, ToolKind> = {
	skill_load: 'knowledge',
	skill_read: 'knowledge',
	propose_skill: 'knowledge',
	propose_skill_update: 'knowledge',
	library_search: 'knowledge',
	library_tree: 'knowledge',
	library_read: 'knowledge',
	library_write: 'knowledge',
	profile_lookup: 'knowledge',
	profile_note: 'knowledge',
	list_attachments: 'knowledge',
	read_attachment: 'knowledge',
	web_search: 'web',
	fetch_url: 'web',
	board_read: 'boards',
	card_read: 'boards',
	card_add: 'boards',
	card_update: 'boards',
	card_comment: 'boards',
	lane_add: 'boards',
	lane_rename: 'boards',
	project_add: 'boards',
	board_add: 'boards',
	ask_user: 'boards',
	generate_image: 'media',
	save_svg: 'media',
	view_image: 'media',
	create_pdf: 'media',
	run_history: 'other',
	set_chat_title: 'other',
	glob: 'code',
	list_files: 'code',
	read_file: 'code',
	grep_files: 'code',
	git_status: 'code',
	write_file: 'code',
	edit_file: 'code',
	bash: 'code',
	git_commit: 'code',
	git_push: 'code',
	update_plan: 'code',
	open_pull_request: 'code',
	dispatch_explore: 'code',
	dispatch_task: 'code'
};

/** How each registry group shows, for the test that keeps TOOL_KIND in step with the registry. */
export const GROUP_KIND: Record<string, ToolKind> = {
	knowledge: 'knowledge',
	attachments: 'knowledge',
	web: 'web',
	boards: 'boards',
	visual: 'media',
	coding: 'code'
};

export const toolKind = (name: string): ToolKind => TOOL_KIND[name] ?? 'other';

const TOOL_LABEL: Record<ToolKind, string> = {
	web: 'Reading the web',
	knowledge: 'Checking the library',
	code: 'Working in the repository',
	media: 'Making an image',
	boards: 'Working on the board',
	other: 'Using a tool'
};

/** More satellites than this stop reading as separate calls and start reading as a cloud. */
export const MAX_SATELLITES = 4;

export interface PresenceView {
	state: Presence;
	/** One per running call, newest last, for the satellites. Keyed by call so a returning one leaves by itself. */
	calls: { id: string; kind: ToolKind }[];
	/** What to call it. Absent for thinking, which the page names after the model. */
	label?: string;
}

/**
 * The state of a turn in flight, in order of what the person most needs to
 * know: a question waiting on them outranks everything, a search outranks the
 * other tools (it has its own pattern and its own words), any running tool
 * outranks the text streaming beside it, and thinking is what is left.
 */
export function presenceOf(input: {
	timeline: TimelineItem[];
	question: boolean;
	/**
	 * What the current leg has streamed: the text past the page's stream mark.
	 * The whole buffer will not do, because a leg that wrote something before
	 * calling a tool keeps its text in the reply, and the next leg's thinking
	 * then read as writing.
	 */
	legText: string;
}): PresenceView {
	const running: PresenceView['calls'] = [];
	for (const item of input.timeline) {
		if (item.kind !== 'step') continue;
		item.tools.forEach((tool, i) => {
			// The question itself is a running call, but it is the person's turn,
			// not work; a satellite beside the waiting ring would say otherwise.
			if (tool.status !== 'running' || tool.name === 'ask_user') return;
			running.push({ id: tool.callId ?? `${item.id}:${i}`, kind: toolKind(tool.name) });
		});
	}
	const calls = running.slice(-MAX_SATELLITES);
	if (input.question) return { state: 'waiting', calls, label: 'Waiting on your answer' };
	const activity = liveActivity(input.timeline);
	if (activity.mode === 'searching') return { state: 'searching', calls, label: activity.label };
	if (calls.length) return { state: 'tool', calls, label: TOOL_LABEL[calls[calls.length - 1].kind] };
	if (input.legText) return { state: 'streaming', calls, label: 'Writing' };
	return { state: 'thinking', calls };
}

/**
 * How long the Orrery stays after a turn ends: long enough for the settle to
 * be seen, or for the red pose to register beside the error, and short enough
 * not to sit under a finished reply looking busy.
 */
export const ENDING_MS = { done: 1400, error: 2400 } as const;

/** How long after the last keystroke the empty-chat Orrery still counts as listening. */
export const TYPING_MS = 1200;
