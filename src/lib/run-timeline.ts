/**
 * The shape of an agent run, shared by the engine that produces it, the
 * database that stores it and the two pages that draw it.
 *
 * One definition rather than three: the loop's TurnSummary, the `trace` column
 * on a message and the live timeline are the same facts at different moments,
 * and they drifted apart the moment they were written down separately.
 */

export interface RunToolCall {
	name: string;
	/** Whatever the tool's `describe` yielded — a path, a command, a query. */
	summary?: string;
	/** Absent while the call is still running. */
	status?: 'ok' | 'error';
}

/** One model round-trip that ended in tool calls, and the calls it made. */
export interface RunStep {
	id: string;
	/** What the model said it was about to do, or the call it made. */
	label: string;
	status: 'ok' | 'error';
	toolCalls: RunToolCall[];
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
}

export interface TimelineStep {
	kind: 'step';
	id: string;
	label: string;
	status: 'running' | 'ok' | 'error';
	tools: TimelineTool[];
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

export type TimelineItem = TimelineStep | TimelineStage | TimelineNotice;

export type TimelineChunk =
	| {
			type: 'step';
			id: string;
			label: string;
			status: 'running' | 'ok' | 'error';
			/** The streamed text became this label and should leave the reply. */
			consumedText?: boolean;
	  }
	| {
			type: 'tool';
			name: string;
			status: 'running' | 'ok' | 'error';
			detail?: string;
			callId?: string;
			stepId?: string;
	  }
	| { type: 'stage'; name: string; detail?: string }
	| { type: 'notice'; text: string };

/** Chunks this reducer handles; anything else is somebody else's business. */
export function isTimelineChunk(chunk: { type?: string }): chunk is TimelineChunk {
	return (
		chunk.type === 'step' ||
		chunk.type === 'tool' ||
		chunk.type === 'stage' ||
		chunk.type === 'notice'
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

	if (chunk.type === 'step') {
		const idx = items.findIndex((i) => i.kind === 'step' && i.id === chunk.id);
		if (idx === -1) {
			return [
				...items,
				{ kind: 'step', id: chunk.id, label: chunk.label, status: chunk.status, tools: [] }
			];
		}
		const existing = items[idx] as TimelineStep;
		const next = [...items];
		// A later chunk may resolve the label, but must never blank one we have.
		next[idx] = { ...existing, label: chunk.label || existing.label, status: chunk.status };
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
		detail: chunk.detail
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
	else tools[toolIdx] = { ...tools[toolIdx], ...row, detail: chunk.detail ?? tools[toolIdx].detail };

	const next = [...items];
	next[stepIdx] = { ...step, tools };
	return next;
}

/** Render a finished run's stored trace as timeline items. */
export function itemsFromTrace(trace: MessageTrace | null | undefined): TimelineItem[] {
	return (trace?.steps ?? []).map((s) => ({
		kind: 'step' as const,
		id: s.id,
		label: s.label,
		status: s.status,
		tools: s.toolCalls.map((c) => ({
			name: c.name,
			status: c.status ?? 'ok',
			detail: c.summary
		}))
	}));
}
