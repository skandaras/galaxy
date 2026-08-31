/**
 * The shape of an agent run, shared by the engine that produces it, the
 * database that stores it and the two pages that draw it.
 *
 * One definition rather than three: the loop's TurnSummary, the `trace` column
 * on a message and the live timeline are the same facts at different moments,
 * and they drifted apart the moment they were written down separately.
 */

/**
 * One row of a rendered search result list.
 *
 * Title and URL only. The domain shown beside each row is derived from the URL
 * client-side, and the snippet is deliberately absent: this shape travels over
 * SSE, is replayed in full to every reconnecting subscriber, and is stored on
 * the message trace, so it carries what the box draws and nothing more.
 *
 * Defined here rather than beside the search tool because both sides need it and
 * only this half of the tree is importable from client code — the same reason
 * RunToolCall lives here rather than in the engine.
 */
export interface SearchResultRow {
	title: string;
	url: string;
}

export interface RunToolCall {
	name: string;
	/** Whatever the tool's `describe` yielded — a path, a command, a query. */
	summary?: string;
	/** Absent while the call is still running. */
	status?: 'ok' | 'error';
	/**
	 * What a search returned, for the tools that return something worth drawing
	 * rather than describing. Absent on every other tool, and on traces written
	 * before searches were rendered — which is why it is optional rather than
	 * defaulted: an old row should draw as it always did, not as an empty box.
	 */
	results?: SearchResultRow[];
}

/** One model round-trip that ended in tool calls, and the calls it made. */
export interface RunStep {
	id: string;
	/** What the model said it was about to do, or the call it made. */
	label: string;
	status: 'ok' | 'error';
	toolCalls: RunToolCall[];
	/**
	 * The lead-in in full, when the model wrote more than fits on the label.
	 *
	 * The label is a glance — a first sentence, cut at 100 characters — and for
	 * a model that narrates in paragraphs that used to be the only thing kept:
	 * the rest was dropped from the reply and never written anywhere else.
	 * Holding it here is what lets the loop treat a long lead-in as narration at
	 * all, since doing so no longer loses anything.
	 */
	note?: string;
}

/** What is kept alongside an assistant message once the run is over. */
export interface MessageTrace {
	/** One line from the run-summary task, when there was one. */
	summary?: string;
	steps: RunStep[];
}

// --- live timeline ---------------------------------------------------------

export interface TimelineTool {
	callId?: string;
	name: string;
	status: 'running' | 'ok' | 'error';
	detail?: string;
	results?: SearchResultRow[];
}

export interface TimelineStep {
	kind: 'step';
	id: string;
	label: string;
	status: 'running' | 'ok' | 'error';
	tools: TimelineTool[];
	/** The lead-in in full — see RunStep.note. */
	note?: string;
}

export interface TimelineStage {
	kind: 'stage';
	name: string;
	detail?: string;
}

export interface TimelineNotice {
	kind: 'notice';
	text: string;
}

/**
 * A search drawn on its own, for producers that have no steps to hang it under.
 *
 * Deep research runs a hardcoded pipeline rather than the agent loop, so its
 * queries are not tool calls and never arrive with a step id. Folding them in as
 * orphan tool calls would open an unlabelled step per query; this draws the same
 * box without inventing a step that did not happen.
 */
export interface TimelineSearch {
	kind: 'search';
	query: string;
	language?: string;
	results: SearchResultRow[];
	/**
	 * The search failed, rather than running and finding nothing. Conflating the
	 * two is how an outage gets shown as a fact about the world.
	 */
	failed?: boolean;
}

export type TimelineItem = TimelineStep | TimelineStage | TimelineNotice | TimelineSearch;

export type TimelineChunk =
	| {
			type: 'step';
			id: string;
			label: string;
			status: 'running' | 'ok' | 'error';
			/** The streamed text became this label and should leave the reply. */
			consumedText?: boolean;
			/** That text in full, for the step's body — see RunStep.note. */
			note?: string;
	  }
	| {
			type: 'tool';
			name: string;
			status: 'running' | 'ok' | 'error';
			detail?: string;
			callId?: string;
			stepId?: string;
			results?: SearchResultRow[];
	  }
	| { type: 'stage'; name: string; detail?: string }
	| { type: 'notice'; text: string }
	| {
			type: 'search';
			query: string;
			language?: string;
			results: SearchResultRow[];
			failed?: boolean;
	  };

/** Chunks this reducer handles; anything else is somebody else's business. */
export function isTimelineChunk(chunk: { type?: string }): chunk is TimelineChunk {
	return (
		chunk.type === 'step' ||
		chunk.type === 'tool' ||
		chunk.type === 'stage' ||
		chunk.type === 'notice' ||
		chunk.type === 'search'
	);
}

/**
 * Fold one chunk into the timeline, returning a new array.
 *
 * Must be idempotent under replay: subscribeJob replays a job's entire chunk
 * history to every reconnecting client, so folding the same history twice from
 * an empty list has to land on the same timeline. Steps are therefore upserted
 * by id and tool calls by callId, never appended blindly.
 */
export function applyChunk(items: TimelineItem[], chunk: TimelineChunk): TimelineItem[] {
	if (chunk.type === 'stage') {
		return [...items, { kind: 'stage', name: chunk.name, detail: chunk.detail }];
	}
	if (chunk.type === 'notice') {
		return [...items, { kind: 'notice', text: chunk.text }];
	}
	if (chunk.type === 'search') {
		return [
			...items,
			{
				kind: 'search',
				query: chunk.query,
				language: chunk.language,
				results: chunk.results,
				...(chunk.failed ? { failed: true } : {})
			}
		];
	}

	if (chunk.type === 'step') {
		const idx = items.findIndex((i) => i.kind === 'step' && i.id === chunk.id);
		if (idx === -1) {
			return [
				...items,
				{
					kind: 'step',
					id: chunk.id,
					label: chunk.label,
					status: chunk.status,
					tools: [],
					...(chunk.note ? { note: chunk.note } : {})
				}
			];
		}
		const existing = items[idx] as TimelineStep;
		const next = [...items];
		// A later chunk may resolve the label, but must never blank one we have —
		// and the same goes for the note, since a step is pushed twice: once when
		// it opens and again when its calls have settled.
		next[idx] = {
			...existing,
			label: chunk.label || existing.label,
			note: chunk.note || existing.note,
			status: chunk.status
		};
		return next;
	}

	// A tool call. Find the step it belongs to, or the bucket for orphans —
	// producers outside the agent loop send tool chunks with no step at all.
	const stepIdx = chunk.stepId
		? items.findIndex((i) => i.kind === 'step' && i.id === chunk.stepId)
		: items.findLastIndex((i) => i.kind === 'step');
	const row: TimelineTool = {
		callId: chunk.callId,
		name: chunk.name,
		status: chunk.status,
		detail: chunk.detail,
		results: chunk.results
	};

	if (stepIdx === -1) {
		// No step to hang it on: open an unlabelled one so the call is still seen.
		return [
			...items,
			{
				kind: 'step',
				id: chunk.stepId ?? `orphan-${chunk.name}`,
				label: '',
				status: chunk.status === 'error' ? 'error' : 'running',
				tools: [row]
			}
		];
	}

	const step = items[stepIdx] as TimelineStep;
	const toolIdx = chunk.callId
		? step.tools.findIndex((t) => t.callId === chunk.callId)
		: // Without a call id the best available match is the newest running call
			// of the same name — which is exactly what mispairs when two overlap.
			step.tools.findLastIndex((t) => t.name === chunk.name && t.status === 'running');

	const tools = [...step.tools];
	if (toolIdx === -1) tools.push(row);
	else
		tools[toolIdx] = {
			...tools[toolIdx],
			...row,
			detail: chunk.detail ?? tools[toolIdx].detail,
			// Same reason as `detail`: the running chunk may be the one carrying the
			// results, and a terminal chunk without them must not erase the box.
			results: chunk.results ?? tools[toolIdx].results
		};

	const next = [...items];
	next[stepIdx] = { ...step, tools };
	return next;
}

/**
 * How a run ended, for the line shown under the thread once it has — or null
 * when it simply finished and there is nothing to say.
 *
 * This exists because the only signal an unfinished run gave was a `notice`,
 * and a notice is a live progress message: on the code page it now lives in
 * the timeline and goes when the timeline is cleared, and chat never raised
 * one at all — a chat turn that spent its whole step budget fetching pages
 * just stopped, with no explanation anywhere.
 */
export function unfinishedNote(stopReason: string | undefined | null): string | null {
	if (stopReason === 'exhausted') return 'That run used up its step budget before finishing.';
	if (stopReason === 'budget') return 'That run was cut off partway through by the spend cap.';
	if (stopReason === 'cancelled') return 'You stopped that run.';
	return null;
}

/** Render a finished run's stored trace as timeline items. */
export function itemsFromTrace(trace: MessageTrace | null | undefined): TimelineItem[] {
	return (trace?.steps ?? []).map((s) => ({
		kind: 'step' as const,
		id: s.id,
		label: s.label,
		status: s.status,
		...(s.note ? { note: s.note } : {}),
		tools: s.toolCalls.map((c) => ({
			name: c.name,
			status: c.status ?? 'ok',
			detail: c.summary,
			results: c.results
		}))
	}));
}

/**
 * The reply as it is being streamed, and how much of it is settled.
 *
 * `mark` is where the text kept by earlier legs ends. Everything after it is
 * the leg in flight, which may yet turn out to be a lead-in that belongs in the
 * timeline rather than in the reply.
 */
export interface StreamText {
	text: string;
	mark: number;
}

export const emptyStreamText = (): StreamText => ({ text: '', mark: 0 });

/**
 * Settle the streamed reply when a leg ends, per the server's verdict on
 * whether that leg's text became a step label.
 *
 * A leg the server consumed is dropped back to the mark — only *that* leg's
 * narration goes. Both pages used to clear the whole buffer instead, so a leg
 * that wrote something for the user followed by a leg that narrated lost the
 * writing too; it came back on the code page only because it re-reads the
 * thread afterwards, and on chat it did not come back at all.
 *
 * A leg that was kept ends with a blank line and moves the mark, which is what
 * puts a paragraph between one leg and the next — `assistantText` on the server
 * is assembled the same way, so the two agree byte for byte.
 */
export function applyStreamText(current: StreamText, chunk: TimelineChunk): StreamText {
	if (chunk.type !== 'step') return current;
	if (chunk.consumedText) return { text: current.text.slice(0, current.mark), mark: current.mark };
	// Nothing streamed this leg: no paragraph to open, and moving the mark past
	// a separator we did not write would strand the next consumed leg.
	if (current.text.length === current.mark) return current;
	const text = `${current.text.trimEnd()}\n\n`;
	return { text, mark: text.length };
}
