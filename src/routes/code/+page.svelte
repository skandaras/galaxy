<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { ATTACHMENT_ACCEPT, attachmentIcon, screenFiles } from '$lib/attachment-types';
	import { clearDraft, draftKey, getDraft, setDraft } from '$lib/composer-drafts.svelte';
	import { createAutoscroll } from '$lib/autoscroll.svelte';
	import { autoresize } from '$lib/autoresize';
	import { hasFinePointer } from '$lib/pointer';
	import { copyText } from '$lib/clipboard';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import AskSheet from '$lib/components/AskSheet.svelte';
	import GalaxySpinner from '$lib/components/GalaxySpinner.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';
	import RunTimeline from '$lib/components/RunTimeline.svelte';
	import {
		applyChunk,
		isTimelineChunk,
		itemsFromTrace,
		unfinishedNote,
		type MessageTrace,
		type TimelineItem
	} from '$lib/run-timeline';

	interface ChatMeta {
		id: string;
		title: string;
		mode: string;
		updatedAt: number;
		/** An agent is working on this session right now — see /api/chats. */
		running?: boolean;
	}
	interface AttachmentRef {
		id: string;
		name: string;
		mime: string;
		kind?: 'image' | 'document';
		textChars?: number;
	}
	interface Session {
		chatId: string;
		modelId?: string | null;
		repoName: string;
		baseBranch: string;
		workBranch: string;
		mode: 'plan' | 'implement';
	}
	interface Msg {
		id: string;
		role: string;
		content: string;
		modelKey: string | null;
		attachments?: AttachmentRef[] | null;
		/** What the agent did to produce this reply, kept with it. */
		trace?: MessageTrace | null;
	}
	interface ModelOption {
		id: string;
		displayName: string;
		providerName: string;
		supportsTools: boolean;
		supportsVision: boolean;
	}
	interface Repo {
		fullName: string;
		cloneUrl: string;
		private: boolean;
	}
	let sessions = $state<ChatMeta[]>([]);
	let models = $state<ModelOption[]>([]);
	let repos = $state<Repo[]>([]);
	let githubConfigured = $state(false);

	let current = $state<Session | null>(null);
	let messages = $state<Msg[]>([]);
	let listOpen = $state(false);

	/**
	 * Width of the session list, draggable by the divider. Session titles are
	 * repo-and-branch shaped and ran out of room at the old fixed 250px.
	 */
	const listPane = createResizablePane({
		key: 'galaxy:code-list-width',
		min: 200,
		max: 460,
		initial: 250
	});

	// new session form
	let creating = $state(false);
	let createBusy = $state(false);
	let repoChoice = $state('');
	let manualUrl = $state('');
	let newMode = $state<'plan' | 'implement'>('plan');

	const NEW_KEY = draftKey('code', null);
	let activeKey = $state(NEW_KEY);
	let input = $state(getDraft(NEW_KEY));

	let pendingFiles = $state<File[]>([]);
	/** Uploads that already succeeded, so a failed send can retry cheaply. */
	let uploadedRefs = $state<AttachmentRef[]>([]);
	let fileInput: HTMLInputElement | null = $state(null);

	interface DiffFile {
		path: string;
		additions: number | null;
		deletions: number | null;
		patch: string;
	}
	interface SessionDiff {
		commits: string;
		files: DiffFile[];
		truncated: boolean;
	}

	const scroll = createAutoscroll();
	let threadEl = $state<HTMLElement | null>(null);
	let diffCopied = $state(false);
	/** Paths whose patch is expanded. Everything starts collapsed. */
	let openFiles = $state<Set<string>>(new Set());
	/** Result of the last PR attempt, shown next to the button. */
	let prUrl = $state<string | null>(null);
	let prBusy = $state(false);

	interface AgentRow {
		id: string;
		kind: string;
		label: string;
		status: 'running' | 'ok' | 'error';
		detail?: string;
		startedAt: number;
	}
	/** Sub-agents this run has out, keyed by id so an update converges. */
	let subAgents = $state<AgentRow[]>([]);
	/** Server time the running turn began; null when nothing is running. */
	let runStartedAt = $state<number | null>(null);
	/** Ticks the elapsed clocks once a second while anything is running. */
	let now = $state(Date.now());

	let selectedModelId = $state('');
	let webSearch = $state(true);
	/** Task default, used when a session has no remembered model. */
	let defaultModelId = $state('');
	let streaming = $state(false);
	/** Job currently streaming, so it can be stopped. */
	let activeJobId = $state<string | null>(null);
	/** Open question from ask_user; cleared by the server's `answer` chunk. */
	let question = $state<{ id: string; prompt: string; options: string[] } | null>(null);
	let stopping = $state(false);
	let streamText = $state('');
	let streamModel = $state('');
	/** Steps, stages and notices for the run in flight, in the order they arrived. */
	let timeline = $state<TimelineItem[]>([]);
	/**
	 * How the last run ended, when that was not "it finished". Held in page
	 * state rather than on the message: it describes the run, and it is gone on
	 * a reload, where the Observatory is the record.
	 */
	let lastStopReason = $state<string | null>(null);
	let errorBanner = $state<string | null>(null);
	let diff = $state<SessionDiff | null>(null);
	let source: EventSource | null = null;
	/**
	 * Consecutive failed reattaches. Any chunk arriving resets it, so a run that
	 * reconnects cleanly and then streams for ten minutes starts from a full
	 * allowance if it drops again.
	 *
	 * It used to be a lifetime count carried across every reattach and never
	 * reset, so three drops spread over a long run exhausted it however healthy
	 * the stream had been in between — and reattaching was immediate, so an
	 * endpoint failing instantly burned all three inside a second.
	 */
	let recoveries = 0;
	const MAX_RECOVERIES = 6;
	/** Backoff between reattaches, capped so a long run keeps trying. */
	const recoveryDelayMs = (attempt: number) => Math.min(15_000, 500 * 2 ** attempt);

	onMount(async () => {
		const [chatsRes, modelsRes, reposRes] = await Promise.all([
			fetch('/api/chats'),
			fetch('/api/models?task=coding'),
			fetch('/api/github/repos')
		]);
		sessions = ((await chatsRes.json()) as ChatMeta[]).filter((c) => c.mode === 'code');
		const m = await modelsRes.json();
		models = m.models.filter((x: ModelOption) => x.supportsTools);
		// The default must itself be tool-capable, or coding refuses the turn.
		const preferred = m.defaultModelId;
		defaultModelId =
			preferred && models.some((x: ModelOption) => x.id === preferred)
				? preferred
				: (models[0]?.id ?? '');
		selectedModelId = defaultModelId;
		const g = await reposRes.json().catch(() => ({ configured: false, repos: [] }));
		githubConfigured = g.configured;
		repos = g.repos;
	});

	/**
	 * How often the session list re-asks which sessions have a run in flight.
	 *
	 * A run started in another tab, on the phone, or before this page was opened
	 * is invisible to the local `streaming` flag — which is the whole point of
	 * the mark, so it cannot be derived from this page's own state alone.
	 */
	const RUNNING_POLL_MS = 10_000;

	async function refreshRunning() {
		const res = await fetch('/api/chats').catch(() => null);
		if (!res?.ok) return;
		const running = new Set(
			((await res.json()) as ChatMeta[]).filter((c) => c.running).map((c) => c.id)
		);
		// Only the flag is taken from the response: the list itself is owned
		// locally, and a session created a moment ago may not be in it yet.
		sessions = sessions.map((s) => ({ ...s, running: running.has(s.id) }));
	}

	$effect(() => {
		// A hidden tab has nobody looking at the dot this would repaint.
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void refreshRunning();
		}, RUNNING_POLL_MS);
		return () => clearInterval(timer);
	});

	/**
	 * The session being watched in this tab is known immediately; everything
	 * else waits for the poll. Without the first half the dot on the session you
	 * just messaged would take up to ten seconds to appear.
	 */
	const isWorking = (s: ChatMeta) => (streaming && current?.chatId === s.id) || Boolean(s.running);

	$effect(() => (threadEl ? scroll.attach(threadEl) : undefined));

	// Follow the run as it streams, unless the user has scrolled up to read.
	$effect(() => {
		streamText;
		messages.length;
		timeline.length;
		if (scroll.pinned) void scroll.toBottom('auto');
	});

	/** Park the current composer text against the session it was written for. */
	function stashDraft() {
		setDraft(activeKey, input);
	}

	function loadDraft(key: string) {
		activeKey = key;
		input = getDraft(key);
	}

	/**
	 * Restore the model this session last used, falling back to the default when
	 * it has none or names a model that is gone, disabled, or no longer
	 * tool-capable — `models` is already filtered to usable ones.
	 */
	function applySessionModel(session: Session | null) {
		const remembered = session?.modelId;
		selectedModelId =
			remembered && models.some((m) => m.id === remembered) ? remembered : defaultModelId;
	}

	async function select(chatId: string) {
		stashDraft();
		closeStream();
		errorBanner = null;
		diff = null;
		openFiles = new Set();
		prUrl = null;
		// The pane is session-scoped: nothing from the session being left may
		// survive into the one being opened.
		subAgents = [];
		runStartedAt = null;
		const res = await fetch(`/api/code/sessions/${chatId}`);
		if (!res.ok) return;
		const data = await res.json();
		current = data.session;
		applySessionModel(current);
		messages = data.messages.filter((m: Msg) => m.role !== 'tool');
		listOpen = false;
		creating = false;
		pendingFiles = [];
		uploadedRefs = [];
		loadDraft(draftKey('code', chatId));
		// Open on the newest message rather than the top of the history.
		void scroll.toBottom('auto');
		if (data.runningJobId) attach(data.runningJobId, 0, data.runningSince);
	}

	async function createSession() {
		const repoUrl = manualUrl.trim() || repoChoice;
		if (!repoUrl) return;
		createBusy = true;
		errorBanner = null;
		const repoName = manualUrl.trim()
			? manualUrl.replace(/\.git$/, '').split('/').slice(-2).join('/')
			: (repos.find((r) => r.cloneUrl === repoChoice)?.fullName ?? repoUrl);
		const res = await fetch('/api/code/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ repoUrl, repoName, mode: newMode })
		});
		createBusy = false;
		if (!res.ok) {
			errorBanner = (await res.json().catch(() => ({})))?.message ?? 'Session creation failed';
			return;
		}
		const session = await res.json();
		sessions = [
			{ id: session.chatId, title: session.repoName, mode: 'code', updatedAt: Date.now() },
			...sessions
		];
		await select(session.chatId);
	}

	/**
	 * `text` is an override used by the approve-plan button; it must not touch
	 * the user's draft, which may hold a half-written follow-up.
	 */
	async function send(text?: string) {
		const override = text !== undefined;
		const content = (text ?? input).trim();
		if (!current || streaming) return;
		if (!content && !pendingFiles.length && !uploadedRefs.length) return;
		errorBanner = null;

		const failed: File[] = [];
		for (const file of pendingFiles) {
			const form = new FormData();
			form.append('file', file);
			// A code session is a chat row, so the chat attachment endpoint serves
			// both modes.
			const res = await fetch(`/api/chats/${current.chatId}/attachments`, {
				method: 'POST',
				body: form
			});
			if (res.ok) {
				uploadedRefs = [...uploadedRefs, await res.json()];
			} else {
				const err = await res.json().catch(() => ({ message: res.statusText }));
				errorBanner = `${file.name}: ${err.message ?? 'upload failed'}`;
				failed.push(file);
			}
		}
		pendingFiles = failed;
		if (failed.length) return;

		const attachments = uploadedRefs;
		const res = await fetch(`/api/code/sessions/${current.chatId}/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				content,
				modelId: selectedModelId || undefined,
				webSearch,
				attachments: attachments.length ? attachments : undefined
			})
		});
		if (!res.ok) {
			errorBanner = (await res.json().catch(() => ({})))?.message ?? 'Failed to send';
			return;
		}
		messages = [
			...messages,
			{
				id: `local-${Date.now()}`,
				role: 'user',
				content,
				modelKey: null,
				attachments: attachments.length ? attachments : null
			}
		];
		uploadedRefs = [];
		if (!override) {
			input = '';
			clearDraft(activeKey);
		}
		void scroll.toBottom('auto');
		attach((await res.json()).jobId);
	}

	/** Stop the run; the work already done is kept and the server closes out. */
	async function stopRun() {
		if (!activeJobId || stopping) return;
		stopping = true;
		await fetch(`/api/jobs/${activeJobId}/cancel`, { method: 'POST' }).catch(() => {});
	}

	/**
	 * `carriedRecoveries` keeps the reconnect budget across a reattach.
	 * `startedAt` is the server's idea of when the run began — a reattach after
	 * a reload must not report the agent as having just started.
	 */
	function attach(jobId: string, carriedRecoveries = 0, startedAt?: number | null) {
		closeStream();
		// Clears the reconnecting notice; a real failure sets its own.
		errorBanner = null;
		recoveries = carriedRecoveries;
		activeJobId = jobId;
		stopping = false;
		streaming = true;
		streamText = '';
		streamModel = '';
		timeline = [];
		// Refilled from the replayed chunks; a stale row from a previous attach
		// would otherwise sit there claiming to be running.
		subAgents = [];
		runStartedAt = startedAt ?? Date.now();
		now = Date.now();
		lastStopReason = null;
		question = null;
		source = new EventSource(`/api/jobs/${jobId}/stream`);
		source.onmessage = (ev) => {
			const chunk = JSON.parse(ev.data);
			// Proof the stream works: whatever it cost to get here, it is spent.
			recoveries = 0;
			if (chunk.type === 'meta') {
				// New (re)attempt: drop partial text from a failed attempt. The
				// timeline is left alone — "tried, failed over, retried" is exactly
				// what it is for.
				streamModel = chunk.model;
				streamText = '';
			} else if (chunk.type === 'delta') streamText += chunk.text;
			else if (isTimelineChunk(chunk)) {
				// Only drop the buffered text when the server says it became this
				// step's label. A model that writes something substantial and then
				// calls a tool — a redrafted email, say — is writing the reply, and
				// clearing it here threw that work away.
				if (chunk.type === 'step' && chunk.consumedText) streamText = '';
				timeline = applyChunk(timeline, chunk);
			} else if (chunk.type === 'agent') {
				// Same id on every update, so replay after a reconnect converges
				// rather than stacking one row per change.
				const row: AgentRow = {
					id: chunk.id,
					kind: chunk.kind,
					label: chunk.label,
					status: chunk.status,
					detail: chunk.detail,
					startedAt: chunk.startedAt
				};
				const at = subAgents.findIndex((a) => a.id === row.id);
				subAgents =
					at === -1
						? [...subAgents, row]
						: subAgents.map((a, i) => (i === at ? { ...a, ...row } : a));
			} else if (chunk.type === 'question') {
				question = { id: chunk.id, prompt: chunk.prompt, options: chunk.options ?? [] };
			} else if (chunk.type === 'answer') {
				if (question?.id === chunk.id) question = null;
			} else if (chunk.type === 'done') {
				lastStopReason = chunk.stopReason ?? null;
				const chatId = current?.chatId;
				finalize();
				if (chatId) void reconcile(chatId);
			}
			else if (chunk.type === 'error') {
				errorBanner = chunk.message;
				finalize(false);
			}
		};
		source.onerror = () => {
			// The connection dropped mid-run. The turn usually finished
			// server-side, so reconcile rather than leaving the view blank.
			if (streaming) void recoverStream();
		};
	}

	/**
	 * Reconcile with the server after an interrupted stream: re-read the session
	 * so a reply that did complete shows up, reattach if the run is still going,
	 * and only fall back to the partial text when the server has nothing.
	 */
	async function recoverStream() {
		const chatId = current?.chatId;
		const partial = streamText;
		const partialModel = streamModel;
		finalize(false);
		if (!chatId) return;

		const res = await fetch(`/api/code/sessions/${chatId}`).catch(() => null);
		if (!res?.ok) {
			if (partial) appendLocalAssistant(partial, partialModel);
			errorBanner = 'Lost the connection to this run — reopen the session to see how it ended.';
			return;
		}

		const data = await res.json();
		messages = data.messages.filter((m: Msg) => m.role !== 'tool');
		if (data.runningJobId && recoveries < MAX_RECOVERIES) {
			// Still going: reattach rather than stranding the user on a dead view.
			const wait = recoveryDelayMs(recoveries);
			recoveries++;
			errorBanner = `Reconnecting to this run…`;
			await new Promise((resolve) => setTimeout(resolve, wait));
			attach(data.runningJobId, recoveries, data.runningSince);
			return;
		}
		if (data.runningJobId) {
			errorBanner = 'Kept losing the connection to this run — reopen the session to catch up.';
			return;
		}
		const answered = messages.at(-1)?.role === 'assistant';
		if (!answered && partial) {
			appendLocalAssistant(partial, partialModel);
			errorBanner = 'The connection dropped mid-run — this reply is incomplete.';
		} else if (!answered) {
			errorBanner = 'That run ended without a reply. Check the Observatory for the reason.';
		}
	}

	/**
	 * Re-read the thread once a run ends.
	 *
	 * The browser rebuilds a reply from deltas and commits its own copy, which
	 * is right until the server's version differs — and on a coding turn it
	 * routinely does. A run that auto-continues saves one message per leg with
	 * a "continue from where you left off" message between them, and a leg
	 * summary rewrites a stand-in reply seconds after the fact. The local commit
	 * stays on screen until this lands, and stands if it fails, so there is no
	 * flicker and no worse-than-before.
	 */
	async function reconcile(chatId: string) {
		const res = await fetch(`/api/code/sessions/${chatId}`).catch(() => null);
		if (!res?.ok) return;
		const data = await res.json();
		// The user may have switched sessions while this was in flight.
		if (current?.chatId !== chatId) return;
		messages = data.messages.filter((m: Msg) => m.role !== 'tool');
	}

	function appendLocalAssistant(content: string, modelKey: string) {
		messages = [
			...messages,
			{ id: `local-a-${Date.now()}`, role: 'assistant', content, modelKey, trace: localTrace() }
		];
	}

	/**
	 * The run just watched, in the shape the server stores it — so the reply
	 * keeps its timeline on screen without a refetch. A reload reads the
	 * server's copy, which also carries the leg summary.
	 */
	function localTrace(): MessageTrace | null {
		const steps = timeline
			.filter((i) => i.kind === 'step')
			.map((s) => ({
				id: s.id,
				status: s.status === 'error' ? ('error' as const) : ('ok' as const),
				label: s.label,
				toolCalls: s.tools.map((t) => ({
					name: t.name,
					summary: t.detail,
					status: t.status === 'error' ? ('error' as const) : ('ok' as const)
				}))
			}));
		return steps.length ? { steps } : null;
	}

	function finalize(commit = true) {
		if (commit && streamText) {
			messages = [
				...messages,
				{
					id: `local-a-${Date.now()}`,
					role: 'assistant',
					content: streamText,
					modelKey: streamModel,
					trace: localTrace()
				}
			];
		}
		streaming = false;
		activeJobId = null;
		stopping = false;
		question = null;
		streamText = '';
		timeline = [];
		subAgents = [];
		runStartedAt = null;
		closeStream();
	}

	/** Resolves the waiting tool call; the sheet closes on the server's reply. */
	async function answerQuestion(answer: string) {
		if (!activeJobId || !question) return;
		await fetch(`/api/jobs/${activeJobId}/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ questionId: question.id, answer })
		}).catch(() => {});
	}

	function closeStream() {
		source?.close();
		source = null;
		streaming = false;
	}

	async function approvePlan() {
		if (!current) return;
		await fetch(`/api/code/sessions/${current.chatId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mode: 'implement' })
		});
		current = { ...current, mode: 'implement' };
		await send('The plan is approved — implement it now.');
	}

	async function setMode(mode: 'plan' | 'implement') {
		if (!current) return;
		await fetch(`/api/code/sessions/${current.chatId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mode })
		});
		current = { ...current, mode };
	}

	async function loadDiff() {
		if (!current) return;
		if (diff !== null) {
			diff = null;
			return;
		}
		const res = await fetch(`/api/code/sessions/${current.chatId}/diff`);
		if (!res.ok) {
			errorBanner = 'Could not read the diff for this session.';
			return;
		}
		diff = await res.json();
		// One changed file is the common case and there is nothing to choose
		// between, so open it rather than making them click.
		openFiles = diff && diff.files.length === 1 ? new Set([diff.files[0].path]) : new Set();
	}

	function toggleFile(path: string) {
		const next = new Set(openFiles);
		if (!next.delete(path)) next.add(path);
		openFiles = next;
	}

	/** Open the pull request for this session's branch. */
	async function openPr() {
		if (!current || prBusy) return;
		prBusy = true;
		errorBanner = null;
		const res = await fetch(`/api/code/sessions/${current.chatId}/pr`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		prBusy = false;
		if (!res.ok) {
			errorBanner = (await res.json().catch(() => ({})))?.message ?? 'Could not open a pull request';
			return;
		}
		prUrl = (await res.json()).url;
	}

	async function removeSession(chatId: string, ev?: Event) {
		ev?.stopPropagation();
		if (!confirm('Delete this session and its workspace?')) return;
		await fetch(`/api/code/sessions/${chatId}`, { method: 'DELETE' });
		sessions = sessions.filter((s) => s.id !== chatId);
		clearDraft(draftKey('code', chatId));
		if (current?.chatId === chatId) {
			current = null;
			messages = [];
			pendingFiles = [];
			uploadedRefs = [];
			loadDraft(NEW_KEY);
		}
	}

	function onFilesPicked(ev: Event) {
		const target = ev.target as HTMLInputElement;
		const { accepted, rejected } = screenFiles([...(target.files ?? [])]);
		if (accepted.length) pendingFiles = [...pendingFiles, ...accepted];
		errorBanner = rejected.length ? rejected.join(' ') : null;
		target.value = '';
	}

	async function copyDiff() {
		if (!diff) return;
		diffCopied = await copyText(diff.files.map((f) => f.patch).join('\n'));
		setTimeout(() => (diffCopied = false), 2000);
	}

	/**
	 * Enter sends on a keyboard, and inserts a newline on a touch screen — where
	 * there is no Shift-Enter, so Enter-to-send left no way to write a second
	 * line at all. Coding briefs are the longest thing anyone types here, which
	 * makes it the worse place to lose multi-line input.
	 */
	function onKeydown(ev: KeyboardEvent) {
		// Mid-composition Enter commits the IME candidate; it must never send.
		if (ev.key !== 'Enter' || ev.isComposing) return;
		if (ev.shiftKey || !hasFinePointer()) return;
		ev.preventDefault();
		void send();
	}

	// One interval for the whole pane, and only while something is running.
	$effect(() => {
		if (!streaming) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	/**
	 * "1m 12s", rolling to "1h 04m" — always two segments, so the column keeps
	 * its width and a row does not shuffle sideways once a second.
	 */
	function elapsed(from: number): string {
		const total = Math.max(0, Math.round((now - from) / 1000));
		if (total < 3600) {
			return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
		}
		const hours = Math.floor(total / 3600);
		return `${hours}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
	}

	/** Only the sub-agents still working; a finished one is history, not status. */
	const liveAgents = $derived(subAgents.filter((a) => a.status === 'running'));
	/** Defensive: toolConcurrency caps dispatches at 4, but not from in here. */
	const MAX_AGENT_ROWS = 4;
	const shownAgents = $derived(liveAgents.slice(0, MAX_AGENT_ROWS));
	const hiddenAgents = $derived(liveAgents.length - shownAgents.length);
	const agentCount = $derived(streaming ? 1 + liveAgents.length : 0);

	/**
	 * One line saying what the main agent is doing, from what the run is already
	 * reporting: the model's own narration became this step's label back in the
	 * loop (see stepLabel), so there is nothing extra to generate here.
	 */
	const mainActivity = $derived.by(() => {
		if (question) return 'Waiting on your answer';
		const step = timeline.findLast((i) => i.kind === 'step');
		if (step?.kind === 'step') {
			if (step.label) return step.label;
			const tool = step.tools.at(-1);
			if (tool) return tool.detail ? `${tool.name} ${tool.detail}` : tool.name;
		}
		const stage = timeline.findLast((i) => i.kind === 'stage');
		if (stage?.kind === 'stage') {
			return stage.detail ? `${stage.name} · ${stage.detail}` : stage.name;
		}
		return streamText ? 'Writing the reply' : 'Starting up';
	});

	const lastAssistantExists = $derived(messages.some((m) => m.role === 'assistant'));
	/** Mirrors the guard at the top of send(), so the button can't look live and do nothing. */
	const canSend = $derived(
		Boolean(input.trim() || pendingFiles.length || uploadedRefs.length) && !streaming && !!current
	);

	const selectedModel = $derived(models.find((m) => m.id === selectedModelId) ?? null);
	const pendingImages = $derived(pendingFiles.filter((f) => f.type.startsWith('image/')).length);
	/** Images are dropped by non-vision models; warn instead of failing quietly. */
	const visionWarning = $derived(
		pendingImages > 0 && selectedModel && !selectedModel.supportsVision
			? `${selectedModel.displayName} can't read images — attached image${pendingImages > 1 ? 's' : ''} will be ignored.`
			: null
	);
</script>

<div class="code-shell">
	<button class="list-toggle" onclick={() => (listOpen = !listOpen)} aria-label="Toggle sessions">
		☰
	</button>

	<aside class="session-list" class:open={listOpen} style={`--list-width:${listPane.width}px`}>
		<button class="btn primary wide" onclick={() => ((creating = true), (current = null))}>
			+ New session
		</button>
		<ul>
			{#each sessions as s (s.id)}
				<li class:selected={current?.chatId === s.id}>
					<!-- Rendered on every row, coloured only when there is a run: the
					     space is held so titles stay aligned as runs come and go. -->
					{#if isWorking(s)}
						<span class="dot" role="img" aria-label="An agent is working"></span>
					{:else}
						<span class="dot idle" aria-hidden="true"></span>
					{/if}
					<button class="row" onclick={() => select(s.id)}>{s.title}</button>
					<button class="icon" title="Delete session" onclick={(e) => removeSession(s.id, e)}
						>×</button
					>
				</li>
			{/each}
		</ul>
	</aside>

	<PaneResizer pane={listPane} label="Resize the session list" />

	<section class="work-area">
		<!-- Notices used to stack here as full-width banners, detached in space and
		     time from the step that raised them. They are now inline in the
		     timeline; only a terminal error still earns the top of the page. -->
		{#if errorBanner}<div class="banner error">{errorBanner}</div>{/if}

		{#if creating}
			<div class="new-session">
				<h2>New coding session</h2>
				{#if githubConfigured}
					<label>
						repository
						<select bind:value={repoChoice}>
							<option value="">— choose a repo —</option>
							{#each repos as r (r.cloneUrl)}
								<option value={r.cloneUrl}>{r.fullName}{r.private ? ' 🔒' : ''}</option>
							{/each}
						</select>
					</label>
					<p class="dim">or paste a git URL:</p>
				{:else}
					<p class="dim">
						No GitHub token configured (Admin → Settings → GitHub) — paste a git URL:
					</p>
				{/if}
				<input placeholder="https://github.com/owner/repo.git" bind:value={manualUrl} />
				<div class="mode-pick">
					<button class="chip" class:on={newMode === 'plan'} onclick={() => (newMode = 'plan')}>
						Plan first
					</button>
					<button
						class="chip"
						class:on={newMode === 'implement'}
						onclick={() => (newMode = 'implement')}
					>
						Straight to implement
					</button>
				</div>
				<button class="btn primary" disabled={createBusy} onclick={createSession}>
					{createBusy ? 'Cloning…' : 'Create session'}
				</button>
			</div>
		{:else if current}
			<header class="session-head">
				<div class="head-main">
					<span class="repo">{current.repoName}</span>
					<span class="branch">{current.workBranch}</span>
					<span class="mode-badge {current.mode}">{current.mode}</span>
					{#if current.mode === 'implement'}
						<button class="chip" onclick={() => setMode('plan')}>back to plan</button>
					{/if}
					<button class="chip" onclick={loadDiff}>{diff === null ? 'view diff' : 'hide diff'}</button>
					{#if prUrl}
						<a class="chip pr-link" href={prUrl} target="_blank" rel="noreferrer">pull request ↗</a>
					{:else}
						<button class="chip" disabled={prBusy} onclick={openPr}>
							{prBusy ? 'opening…' : 'open pull request'}
						</button>
					{/if}
				</div>

				<!-- What this session has working right now. Session-scoped on purpose:
				     another session's run is not this session's business. -->
				<aside class="agents" aria-label="Agents working on this session">
					{#if !streaming}
						<p class="agents-idle">No agent running</p>
					{:else}
						<!-- The count only. The coding row below carries the run's age,
						     and showing the same number twice reads as two facts. -->
						<p class="agents-count">{agentCount} agent{agentCount === 1 ? '' : 's'}</p>
						<div class="agent-row">
							<span class="dot" class:parked={!!question}></span>
							<span class="agent-name">coding</span>
							{#if runStartedAt !== null}<span class="age">{elapsed(runStartedAt)}</span>{/if}
						</div>
						<p class="agent-doing" title={mainActivity}>{mainActivity}</p>
						{#each shownAgents as agent (agent.id)}
							<div class="agent-row sub">
								<span class="branch-mark">└</span>
								<span class="dot"></span>
								<span class="agent-name" title={agent.label}>{agent.kind}</span>
								<span class="age">{elapsed(agent.startedAt)}</span>
							</div>
							<p class="agent-doing sub" title={agent.detail || agent.label}>
								{agent.detail || agent.label}
							</p>
						{/each}
						{#if hiddenAgents > 0}
							<p class="agent-doing sub">+{hiddenAgents} more</p>
						{/if}
					{/if}
				</aside>
			</header>

			{#if diff !== null}
				<div class="diff-wrap">
					<div class="diff-head">
						<span class="dim">
							{diff.files.length} file{diff.files.length === 1 ? '' : 's'} changed
							{#if diff.truncated}· diff truncated{/if}
						</span>
						<button
							class="diff-copy"
							class:ok={diffCopied}
							onclick={copyDiff}
							title="Copy the whole diff to clipboard"
							aria-label="Copy the whole diff to clipboard">{diffCopied ? '✓' : '⧉'}</button
						>
					</div>
					{#if diff.commits}
						<pre class="commits">{diff.commits}</pre>
					{/if}
					{#if !diff.files.length}
						<p class="dim no-changes">Nothing has changed on this branch yet.</p>
					{/if}
					<!-- Collapsed by default: a session touching twenty files used to render
					     as one scrolling block, which is where reviewing it stops happening. -->
					{#each diff.files as file (file.path)}
						<div class="file">
							<button class="file-head" onclick={() => toggleFile(file.path)}>
								<span class="caret">{openFiles.has(file.path) ? '▾' : '▸'}</span>
								<span class="file-path">{file.path}</span>
								<span class="stat">
									{#if file.additions === null}
										binary
									{:else}
										<span class="add">+{file.additions}</span>
										<span class="del">−{file.deletions ?? 0}</span>
									{/if}
								</span>
							</button>
							{#if openFiles.has(file.path)}
								<pre class="diff">{@html renderDiff(file.patch)}</pre>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="thread" bind:this={threadEl}>
				{#if !messages.length && !streaming}
					<div class="empty">
						{current.mode === 'plan'
							? 'Describe what you want built — the agent will explore the repo and propose a plan.'
							: 'Describe what you want done — the agent will implement, commit and push.'}
					</div>
				{/if}
				{#each messages as msg (msg.id)}
					<div class="msg {msg.role}">
						{#if msg.role === 'assistant'}
							{#if msg.trace?.steps?.length}
								<details class="past-run">
									<summary>
										{msg.trace.summary || `${msg.trace.steps.length} steps`}
									</summary>
									<RunTimeline items={itemsFromTrace(msg.trace)} />
								</details>
							{/if}
							<Markdown text={msg.content} />
							{#if msg.modelKey}<span class="msg-model">{msg.modelKey}</span>{/if}
						{:else}
							<p class="user-text">{msg.content}</p>
							{#each msg.attachments ?? [] as att (att.id)}
								<span class="att-chip">{attachmentIcon(att.kind)} {att.name}</span>
							{/each}
						{/if}
					</div>
				{/each}
				{#if streaming}
					<div class="msg assistant">
						{#if timeline.length}
							<RunTimeline items={timeline} live />
						{/if}
						{#if streamText}
							<Markdown text={streamText} />
						{:else if !timeline.length}
							<span class="thinking working">
								<GalaxySpinner label="Working" />
								{streamModel || '…'} is working
							</span>
						{/if}
					</div>
				{/if}
				{#if unfinishedNote(lastStopReason) && !streaming}
					<div class="run-ended">
						<span>{unfinishedNote(lastStopReason)}</span>
						<button class="chip" onclick={() => send('continue')}>Continue</button>
					</div>
				{/if}
				{#if current.mode === 'plan' && lastAssistantExists && !streaming}
					<div class="plan-actions">
						<button class="btn primary" onclick={approvePlan}>Approve plan &amp; implement</button>
						<span class="dim">or reply below to tweak the plan</span>
					</div>
				{/if}
			</div>

			<footer class="composer">
				{#if !scroll.pinned}
					<button class="jump" onclick={() => scroll.toBottom('smooth')}>↓ Jump to latest</button>
				{/if}
				{#if pendingFiles.length || uploadedRefs.length}
					<div class="pending-files">
						{#each uploadedRefs as ref (ref.id)}
							<span class="att-chip uploaded" title="Uploaded — will be sent with your message">
								{attachmentIcon(ref.kind)}
								{ref.name}
								<button
									class="icon"
									aria-label="Remove {ref.name}"
									onclick={() => (uploadedRefs = uploadedRefs.filter((r) => r.id !== ref.id))}
									>×</button
								>
							</span>
						{/each}
						{#each pendingFiles as file, i (file.name + i)}
							<span class="att-chip">
								{file.type.startsWith('image/') ? '🖼' : '📄'}
								{file.name}
								<button
									class="icon"
									aria-label="Remove {file.name}"
									onclick={() => (pendingFiles = pendingFiles.filter((_, j) => j !== i))}>×</button
								>
							</span>
						{/each}
					</div>
				{/if}
				{#if visionWarning}
					<div class="composer-hint">⚠ {visionWarning}</div>
				{/if}
				<div class="composer-row">
					<textarea
						rows="2"
						placeholder={current.mode === 'plan' ? 'What should we build?' : 'What should we do?'}
						bind:value={input}
						use:autoresize={input}
						oninput={stashDraft}
						onkeydown={onKeydown}
					></textarea>
					{#if streaming}
						<button
							class="btn stop"
							onclick={stopRun}
							disabled={stopping}
							title="Stop the run"
							aria-label="Stop the run">{stopping ? '…' : '■'}</button
						>
					{:else}
						<button
							class="btn send"
							onclick={() => send()}
							disabled={!canSend}
							title={canSend ? 'Send message' : 'Type a message or attach a file first'}
							aria-label="Send message">➤</button
						>
					{/if}
				</div>
				<div class="composer-opts">
					<input
						type="file"
						accept={ATTACHMENT_ACCEPT}
						multiple
						hidden
						bind:this={fileInput}
						onchange={onFilesPicked}
					/>
					<button
						class="chip"
						title="Attach images, PDFs, Word docs, markdown or text files"
						aria-label="Attach files"
						onclick={() => fileInput?.click()}>📎</button
					>
					<button class="chip" class:on={webSearch} onclick={() => (webSearch = !webSearch)}>
						Web search
					</button>
					<select class="model-select" bind:value={selectedModelId}>
						{#if !models.length}
							<option value="">No tool-capable models enabled</option>
						{/if}
						{#each models as model (model.id)}
							<option value={model.id}>{model.displayName} · {model.providerName}</option>
						{/each}
					</select>
				</div>
			</footer>
		{:else}
			<div class="empty center">Select a session or start a new one.</div>
		{/if}
	</section>
</div>

{#if question}
	<AskSheet prompt={question.prompt} options={question.options} onanswer={answerQuestion} />
{/if}

<script module lang="ts">
	function esc(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	function renderDiff(diff: string): string {
		return diff
			.split('\n')
			.map((line) => {
				const cls =
					line.startsWith('+') && !line.startsWith('+++')
						? 'add'
						: line.startsWith('-') && !line.startsWith('---')
							? 'del'
							: line.startsWith('@@')
								? 'hunk'
								: '';
				return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
			})
			.join('\n');
	}
</script>

<style>
	.code-shell {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.session-list {
		/* Set from the drag handle and remembered per browser — see PaneResizer,
		   which also draws the dividing line this used to carry as a border. */
		width: var(--list-width, 250px);
		flex-shrink: 0;
		padding: 0.75rem;
		box-sizing: border-box;
		overflow-y: auto;
	}
	.list-toggle {
		display: none;
	}
	.session-list ul {
		list-style: none;
		margin: 0.7rem 0 0;
		padding: 0;
	}
	.session-list li {
		display: flex;
		align-items: center;
		border-radius: 5px;
	}
	.session-list li.selected {
		background: var(--border);
	}
	.session-list .dot {
		margin-left: 0.35rem;
	}
	.session-list .dot.idle {
		background: none;
		animation: none;
	}
	.row {
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		text-align: left;
		padding: 0.45rem 0.5rem;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Sized as a target rather than a glyph — see the chat list for the same fix. */
	.icon {
		align-items: center;
		justify-content: center;
		min-width: 1.6rem;
		min-height: 1.6rem;
		background: none;
		border: none;
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-size: var(--text-xl);
		line-height: 1;
		padding: 0.2rem;
		display: none;
	}
	.session-list li:hover .icon:hover {
		color: var(--fg);
		background: var(--bg-pane);
	}
	.session-list li:hover .icon {
		display: inline-flex;
	}

	.work-area {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.banner {
		padding: 0.4rem 1rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
		border-bottom: 1px solid var(--border);
	}
	.banner.error {
		color: var(--danger);
	}

	.new-session {
		margin: auto;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		width: min(26rem, 90%);
	}
	.new-session h2 {
		font-size: var(--text-lg);
		letter-spacing: 0.25em;
		color: var(--heading);
		margin: 0;
	}
	.new-session label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.new-session select,
	.new-session input {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.45rem 0.6rem;
	}
	.mode-pick {
		display: flex;
		gap: 0.4rem;
	}
	.dim {
		color: var(--fg-dim);
		font-size: var(--text-base);
		margin: 0;
	}

	.session-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.9rem;
		padding: 0.55rem 1rem;
		border-bottom: 1px solid var(--border);
	}
	.head-main {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		min-width: 0;
	}

	/* The agent readout. Every row is one line with an ellipsis and the full
	   text on `title`: a model's narration is capped at 100 characters server
	   side, which is still three lines in a column this narrow, and a wrapping
	   row would grow the header under the thread. */
	.agents {
		flex: 0 0 auto;
		width: clamp(13rem, 26%, 20rem);
		min-width: 0;
		border-left: 1px solid var(--border);
		padding-left: 0.7rem;
		font-size: var(--text-sm);
		line-height: 1.35;
	}
	.agents p {
		margin: 0;
	}
	.agents-idle {
		color: var(--fg-dim);
	}
	.agents-count {
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-size: var(--text-xs);
		margin-bottom: 0.2rem;
	}
	.agent-row {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
	}
	.agent-row.sub {
		padding-left: 0.5rem;
	}
	.branch-mark {
		color: var(--fg-dim);
	}
	.dot {
		flex: 0 0 auto;
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.4s ease-in-out infinite;
	}
	.dot.parked {
		background: var(--danger);
	}
	.agent-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.age {
		flex: 0 0 auto;
		color: var(--fg-dim);
		/* Fixed-width digits, so a row does not shuffle sideways every second. */
		font-variant-numeric: tabular-nums;
	}
	.agent-doing {
		color: var(--fg-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-left: 0.8rem;
	}
	.agent-doing.sub {
		padding-left: 1.75rem;
	}
	.repo {
		font-size: var(--text-md);
	}
	.branch {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.mode-badge {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.15em;
		border-radius: 3px;
		padding: 0.12rem 0.45rem;
	}
	.mode-badge.plan {
		border: 1px solid var(--accent);
		color: var(--accent);
	}
	.mode-badge.implement {
		background: var(--accent);
		color: var(--bg);
	}
	.diff-wrap {
		border-bottom: 1px solid var(--border);
		max-height: 60vh;
		overflow-y: auto;
	}
	.diff-copy {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: var(--text-base);
		line-height: 1;
		padding: 0.25rem 0.4rem;
	}
	.diff-copy:hover {
		color: var(--fg);
	}
	.diff-copy.ok {
		color: var(--accent);
		border-color: var(--accent);
	}
	.diff-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.4rem 1rem;
		background: var(--bg-pane);
	}
	.commits {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--fg-dim);
		background: var(--bg-pane);
		margin: 0;
		padding: 0 1rem 0.5rem;
		white-space: pre-wrap;
	}
	.no-changes {
		padding: 0 1rem 0.6rem;
	}
	.file {
		border-top: 1px solid var(--border);
	}
	.file-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		background: var(--bg-pane);
		border: none;
		color: var(--fg);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: var(--text-base);
		padding: 0.35rem 1rem;
		text-align: left;
	}
	.file-head:hover {
		color: var(--accent);
	}
	.caret {
		color: var(--fg-dim);
	}
	.file-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.stat {
		color: var(--fg-dim);
		font-size: var(--text-sm);
		white-space: nowrap;
	}
	.stat .add {
		color: #6fd08c;
	}
	.stat .del {
		color: var(--danger);
	}
	.pr-link {
		text-decoration: none;
	}
	.diff {
		/* A diff is columns of aligned text; a proportional font destroys it. */
		font-family: var(--font-mono);
		max-height: 40vh;
		overflow: auto;
		background: var(--bg-pane);
		border-bottom: 1px solid var(--border);
		margin: 0;
		padding: 0.7rem 1rem;
		font-size: var(--text-base);
		line-height: 1.4;
	}
	.diff :global(.add) {
		color: #6fd08c;
	}
	.diff :global(.del) {
		color: var(--danger);
	}
	.diff :global(.hunk) {
		color: var(--accent);
	}

	.thread {
		flex: 1;
		overflow-y: auto;
		padding: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.empty {
		color: var(--fg-dim);
		font-size: var(--text-md);
	}
	.empty.center {
		margin: auto;
	}
	.msg {
		max-width: 50rem;
		font-size: var(--text-lg);
		line-height: 1.55;
	}
	.msg.user {
		align-self: flex-end;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 10px 10px 2px 10px;
		padding: 0.55rem 0.85rem;
	}
	.msg.assistant {
		align-self: flex-start;
		width: 100%;
	}
	.user-text {
		margin: 0;
		white-space: pre-wrap;
	}
	.msg-model {
		display: block;
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin-top: 0.25rem;
	}
	.thinking {
		color: var(--fg-dim);
		font-size: var(--text-md);
		animation: pulse 1.4s ease-in-out infinite;
	}
	/* The spinner is the animation on this line — see the same rule in chat. */
	.thinking.working {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		animation: none;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.thinking,
		.dot {
			animation: none;
		}
	}
	/* What the agent did, kept with the reply and folded away. Scrolled-back
	   history used to show the prose and no evidence at all. */
	.past-run {
		margin-bottom: 0.4rem;
	}
	.past-run > summary {
		color: var(--fg-dim);
		cursor: pointer;
		font-size: var(--text-sm);
		padding: 0.1rem 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.past-run > summary:hover {
		color: var(--fg);
	}
	.plan-actions {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.4rem 0;
	}
	/* Stays put after the run ends, unlike the notice it replaces — which lived
	   in the timeline and was cleared at exactly the moment it mattered. */
	.run-ended {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		flex-wrap: wrap;
		color: var(--fg-dim);
		font-size: var(--text-base);
		border-left: 2px solid var(--border);
		padding: 0.2rem 0 0.2rem 0.6rem;
	}

	.composer {
		border-top: 1px solid var(--border);
		padding: 0.7rem 1rem max(0.9rem, env(safe-area-inset-bottom));
	}
	.jump {
		display: block;
		margin: 0 auto 0.5rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}
	.jump:hover {
		color: var(--fg);
		border-color: var(--accent);
	}
	.pending-files {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		margin-bottom: 0.4rem;
	}
	.att-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: var(--text-sm);
		padding: 0.15rem 0.4rem;
		margin-top: 0.3rem;
	}
	.att-chip.uploaded {
		border-color: var(--accent);
	}
	.composer-hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
		margin-bottom: 0.4rem;
	}
	.composer-row {
		display: flex;
		gap: 0.5rem;
		align-items: flex-end;
	}
	textarea {
		flex: 1;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-lg);
		line-height: 1.45;
		padding: 0.6rem 0.8rem;
		/* Grows with the text (see $lib/autoresize) from the two rows it starts
		   at up to roughly eight, then scrolls. Coding briefs are the longest
		   thing anyone types here, so this is the composer that needed it most.
		   The cap is here rather than in JS so it holds before hydration. */
		max-height: 12rem;
		resize: none;
		outline: none;
		overflow-y: auto;
	}
	textarea:focus {
		border-color: var(--accent);
	}
	.composer-opts {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-top: 0.5rem;
	}
	.model-select {
		margin-left: auto;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.3rem 0.4rem;
		max-width: 16rem;
	}

	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.4rem 0.7rem;
		font-family: inherit;
		font-size: var(--text-md);
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.send {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.stop {
		background: var(--danger);
		color: var(--bg);
	}
	.btn.wide {
		width: 100%;
	}
	.btn:disabled {
		opacity: 0.5;
	}
	.chip {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.22rem 0.65rem;
		cursor: pointer;
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}

	@media (max-width: 720px) {
		/* One column: the pane drops full width under the chips rather than
		   squeezing them into half a phone. */
		.session-head {
			flex-direction: column;
			align-items: stretch;
			gap: 0.5rem;
		}
		.agents {
			width: auto;
			border-left: none;
			border-top: 1px solid var(--border);
			padding-left: 0;
			padding-top: 0.45rem;
		}
		.list-toggle {
			display: block;
			position: fixed;
			top: 0.55rem;
			right: 0.75rem;
			z-index: 30;
			background: var(--bg-pane);
			color: var(--fg);
			border: 1px solid var(--border);
			border-radius: 5px;
			padding: 0.25rem 0.5rem;
		}
		.session-list {
			position: fixed;
			/* Beats the inline --list-width: this is a slide-over sheet here, not
			   a resizable column. */
			width: auto;
			inset: 0 30% 0 0;
			background: var(--bg-pane);
			z-index: 20;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
		}
		.session-list.open {
			transform: translateX(0);
		}
	}

	/* Reveal-on-hover hides these controls permanently on a touch screen, where
	   there is no hover to reveal them with — same treatment as the chat list
	   and CodeBlock's copy button. Deleting a session already confirms. */
	@media (hover: none) {
		.session-list .icon {
			display: inline-flex;
		}
	}
</style>
