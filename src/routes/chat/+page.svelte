<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { ATTACHMENT_ACCEPT, attachmentIcon, screenFiles } from '$lib/attachment-types';
	import { clearDraft, draftKey, getDraft, setDraft } from '$lib/composer-drafts.svelte';
	import { createAutoscroll } from '$lib/autoscroll.svelte';
	import { autoresize } from '$lib/autoresize';
	import { hasFinePointer } from '$lib/pointer';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import AskSheet from '$lib/components/AskSheet.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';
	import ResearchEffort from '$lib/components/ResearchEffort.svelte';
	import RunTimeline from '$lib/components/RunTimeline.svelte';
	import type { ResearchEffort as Effort } from '$lib/research-effort';
	import {
		applyChunk,
		itemsFromTrace,
		unfinishedNote,
		type MessageTrace,
		type TimelineItem
	} from '$lib/run-timeline';

	interface ChatMeta {
		id: string;
		title: string;
		hidden: boolean;
		modelId?: string | null;
		titleCustom?: boolean;
		archivedAt?: number | null;
		updatedAt: number;
	}
	interface AttachmentRef {
		id: string;
		name: string;
		mime: string;
		kind?: 'image' | 'document';
		textChars?: number;
	}
	interface ResearchBudget {
		rounds: number;
		queriesPerRound: number;
		pagesPerRound: number;
		searchBudget: number;
	}
	interface Msg {
		id: string;
		role: 'user' | 'assistant' | 'tool';
		content: string;
		modelKey: string | null;
		attachments: AttachmentRef[] | null;
		/** What the agent did to produce this reply, when it used tools. */
		trace?: MessageTrace | null;
	}
	interface ModelOption {
		id: string;
		displayName: string;
		providerName: string;
		supportsTools: boolean;
		supportsVision: boolean;
	}

	let chats = $state<ChatMeta[]>([]);
	/** Loaded alongside the active list; rendered in the accordion beneath it. */
	let archived = $state<ChatMeta[]>([]);
	let models = $state<ModelOption[]>([]);
	let currentChat = $state<ChatMeta | null>(null);
	let messages = $state<Msg[]>([]);
	let listOpen = $state(false);

	const NEW_KEY = draftKey('chat', null);
	let activeKey = $state(NEW_KEY);
	let input = $state(getDraft(NEW_KEY));

	let selectedModelId = $state<string>('');
	/** Task default, used when a chat has no remembered model. */
	let defaultModelId = $state<string>('');
	let webSearch = $state(true);
	let deepResearch = $state(false);
	/**
	 * How much of the admin's research ceiling this message may spend. Like the
	 * toggle it arms, this is a decision about one message rather than a mode.
	 */
	let researchEffort = $state<Effort>('balanced');
	/** What each level resolves to, from the server. Null until loaded. */
	let researchLevels = $state<Record<Effort, ResearchBudget> | null>(null);
	let pendingFiles = $state<File[]>([]);
	/**
	 * Attachments already uploaded for the pending message. Kept so a failed
	 * send (e.g. 409 while a reply is still running) can be retried without
	 * uploading — and orphaning — the same files again.
	 */
	let uploadedRefs = $state<AttachmentRef[]>([]);
	let fileInput: HTMLInputElement | null = $state(null);

	const scroll = createAutoscroll();
	let threadEl = $state<HTMLElement | null>(null);

	const selectedModel = $derived(models.find((m) => m.id === selectedModelId) ?? null);
	const pendingImages = $derived(pendingFiles.filter((f) => f.type.startsWith('image/')).length);
	/** Images are dropped by non-vision models; warn instead of failing quietly. */
	const visionWarning = $derived(
		pendingImages > 0 && selectedModel && !selectedModel.supportsVision
			? `${selectedModel.displayName} can't read images — attached image${pendingImages > 1 ? 's' : ''} will be ignored.`
			: null
	);

	let streaming = $state(false);
	/** Job currently streaming, so it can be stopped. */
	let activeJobId = $state<string | null>(null);
	/**
	 * The question an agent is currently waiting on, if any. Chunk replay means a
	 * reconnecting client re-reads the whole stream, so an `answer` chunk clears
	 * the question it names rather than the sheet reopening on every reattach.
	 */
	let question = $state<{ id: string; prompt: string; options: string[] } | null>(null);
	let stopping = $state(false);
	let streamText = $state('');
	let streamModel = $state('');
	/**
	 * Steps and their tool calls for the turn in flight. Stages stay separate
	 * below — they are the deep-research pipeline's breadcrumb, a different
	 * thing from an agent's steps, and they render as one.
	 */
	let timeline = $state<TimelineItem[]>([]);
	/**
	 * How the last turn ended, when that was not "it finished". Chat never had
	 * any signal for this: the "ran out of steps" notice is pushed by the coding
	 * driver, so a chat turn that spent its whole budget fetching pages simply
	 * stopped with no explanation.
	 */
	let lastStopReason = $state<string | null>(null);
	let stages = $state<{ name: string; detail?: string }[]>([]);
	/**
	 * A research run at full effort emits a stage per round plus the fixed ones,
	 * which ran the breadcrumb off the edge of the composer. The round numbers
	 * live in each stage's detail, so the tail is the part worth showing.
	 */
	const VISIBLE_STAGES = 6;
	const shownStages = $derived(stages.slice(-VISIBLE_STAGES));
	let notices = $state<string[]>([]);
	let errorBanner = $state<string | null>(null);
	/** Set when a send was refused because another run holds this chat. */
	let blockingJobId = $state<string | null>(null);
	let savedDocId = $state<string | null>(null);
	let source: EventSource | null = null;
	/**
	 * Reconnects spent on the current turn. Recovery reattaches to a run that is
	 * still going, so a stream endpoint that is broken rather than merely
	 * interrupted would otherwise reattach, fail, and reattach forever.
	 */
	let recoveries = 0;
	const MAX_RECOVERIES = 3;

	/**
	 * Width of the chat list, draggable by the divider. Clamped so it can never
	 * be dragged to nothing or wide enough to squeeze the conversation out.
	 * The row carries four actions on hover, which at 250px left the title with
	 * about three legible characters — hence the floor.
	 */
	const listPane = createResizablePane({
		key: 'galaxy:chat-list-width',
		min: 220,
		max: 520,
		initial: 340
	});

	/** Mirrors the guard at the top of send(), so the button can't look live and do nothing. */
	const canSend = $derived(
		Boolean(input.trim() || pendingFiles.length || uploadedRefs.length) && !streaming
	);

	onMount(async () => {
		const [chatsRes, archivedRes, modelsRes] = await Promise.all([
			fetch('/api/chats'),
			fetch('/api/chats?archived=1'),
			fetch('/api/models')
		]);
		chats = filterChatMode(await chatsRes.json());
		archived = filterChatMode(await archivedRes.json());
		const m = await modelsRes.json();
		models = m.models;
		defaultModelId = m.defaultModelId ?? models[0]?.id ?? '';
		selectedModelId = defaultModelId;

		// Only feeds the numbers in the effort popover, so a failure here must not
		// hold up the page — the control degrades to bare labels.
		void fetch('/api/research/effort')
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => (researchLevels = data?.levels ?? null))
			.catch(() => (researchLevels = null));

		// ?chat=<id> is how the board hands work over: it starts the turn, then
		// sends the user here to watch it — including to answer any question the
		// agent asks, since selectChat reattaches to the running job.
		const wanted = new URLSearchParams(location.search).get('chat');
		if (wanted) await selectChat(wanted);
	});

	/**
	 * Restore the model a chat last used. Falls back to the task default when
	 * the chat has none (older chats) or names one that has since been deleted
	 * or disabled — `models` only contains enabled ones, so membership is the
	 * check.
	 */
	function applyChatModel(chat: ChatMeta | null) {
		const remembered = chat?.modelId;
		selectedModelId =
			remembered && models.some((m) => m.id === remembered) ? remembered : defaultModelId;
	}

	$effect(() => (threadEl ? scroll.attach(threadEl) : undefined));

	// Follow the reply as it streams, unless the user has scrolled up to read.
	$effect(() => {
		streamText;
		messages.length;
		if (scroll.pinned) void scroll.toBottom('auto');
	});

	/** Park the current composer text against the chat it was written for. */
	function stashDraft() {
		setDraft(activeKey, input, { ephemeral: currentChat?.hidden === true });
	}

	function loadDraft(key: string) {
		activeKey = key;
		input = getDraft(key);
	}

	/**
	 * Per-message composer choices, cleared when the user goes somewhere else.
	 *
	 * Deep research is a decision about one message, not a mode the session
	 * stays in, so opening another conversation must not inherit it armed or
	 * the effort it was armed at. Creating a chat in order to send is NOT such
	 * a move — see loadChat.
	 */
	function resetComposerIntent() {
		deepResearch = false;
		researchEffort = 'balanced';
	}

	/**
	 * Load a conversation into the pane. Deliberately free of the per-message
	 * reset: `newChat` calls this, and a chat created *by pressing send* must
	 * not have the send's own options cleared out from under it.
	 */
	async function loadChat(id: string) {
		stashDraft();
		closeStream();
		errorBanner = null;
		blockingJobId = null;
		const res = await fetch(`/api/chats/${id}`);
		if (!res.ok) return;
		const data = await res.json();
		currentChat = { ...data.chat };
		messages = data.messages;
		listOpen = false;
		applyChatModel(currentChat);
		loadDraft(draftKey('chat', id));
		// Open on the newest message rather than the top of the history.
		void scroll.toBottom('auto');
		if (data.runningJobId) attachStream(data.runningJobId);
	}

	/** Navigate to another conversation: load it, and drop per-message intent. */
	async function selectChat(id: string) {
		resetComposerIntent();
		await loadChat(id);
	}

	async function newChat(hidden: boolean) {
		// A brand-new chat has no remembered model, so loadChat's applyChatModel
		// would reset the picker to the task default — discarding a model the
		// user chose before there was a conversation to hang it on. The server
		// records it on the first turn, so keeping it here is enough.
		const chosen = selectedModelId;
		const res = await fetch('/api/chats', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hidden })
		});
		const chat = await res.json();
		chats = [chat, ...chats];
		await loadChat(chat.id);
		if (chosen) selectedModelId = chosen;
	}

	/**
	 * `text` is an override used by the Continue button; it must not touch the
	 * user's draft, which may hold a half-written follow-up.
	 */
	async function send(text?: string) {
		const override = text !== undefined;
		const content = (text ?? input).trim();
		if ((!content && !pendingFiles.length && !uploadedRefs.length) || streaming) return;
		errorBanner = null;

		// What the user had armed at the moment they pressed send, read once.
		// Everything below is behind an await while the composer stays live, and
		// creating the chat is itself one of those awaits — reading these at the
		// point the body is built is how an armed Deep research toggle used to be
		// silently downgraded to an ordinary web search on a new chat's first
		// message.
		const intent = {
			deepResearch,
			effort: researchEffort,
			modelId: selectedModelId || undefined,
			webSearch
		};

		if (!currentChat) await newChat(false);
		const chat = currentChat;
		if (!chat) return;

		// Files already uploaded on a previous attempt are reused rather than
		// sent again, so a retry doesn't leave duplicates behind.
		const failed: File[] = [];
		for (const file of pendingFiles) {
			const form = new FormData();
			form.append('file', file);
			const res = await fetch(`/api/chats/${chat.id}/attachments`, {
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
		const res = await fetch(`/api/chats/${chat.id}/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				content,
				modelId: intent.modelId,
				webSearch: intent.webSearch,
				deepResearch: intent.deepResearch,
				effort: intent.effort,
				attachments: attachments.length ? attachments : undefined
			})
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ message: res.statusText }));
			errorBanner = err.message ?? 'Failed to send';
			// A chat blocked by a run that will not end is only fixable by stopping
			// that run, so offer it here rather than leaving a dead end.
			blockingJobId = res.status === 409 && err.jobId ? err.jobId : null;
			// uploadedRefs deliberately survives so a retry reuses the uploads.
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
			clearDraft(NEW_KEY);
		}
		void scroll.toBottom('auto');
		const { jobId } = await res.json();
		// The run that is actually going, not whatever the toggle says now.
		researchRunning = intent.deepResearch;
		attachStream(jobId);
	}

	/**
	 * Ask the server to stop the run. The reply already streamed is kept, so we
	 * don't tear down the EventSource here — the server sends a final chunk.
	 */
	async function stopRun() {
		if (!activeJobId || stopping) return;
		stopping = true;
		await fetch(`/api/jobs/${activeJobId}/cancel`, { method: 'POST' }).catch(() => {});
	}

	/** Stop the run that refused this send, so the chat is usable again. */
	async function stopBlockingRun() {
		const jobId = blockingJobId;
		if (!jobId) return;
		blockingJobId = null;
		await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
		errorBanner = 'Stopping that run — try sending again in a moment.';
	}

	/**
	 * Whether the run now streaming is a research run.
	 *
	 * Captured at send rather than read at completion, because the toggle can be
	 * flipped while the run streams and it is the run that finished, not the
	 * button's current state, that decides whether to clear it.
	 */
	let researchRunning = $state(false);

	/** `carriedRecoveries` keeps the reconnect budget across a reattach. */
	function attachStream(jobId: string, carriedRecoveries = 0) {
		closeStream();
		recoveries = carriedRecoveries;
		activeJobId = jobId;
		stopping = false;
		streaming = true;
		streamText = '';
		streamModel = '';
		timeline = [];
		lastStopReason = null;
		stages = [];
		notices = [];
		question = null;
		source = new EventSource(`/api/jobs/${jobId}/stream`);
		source.onmessage = (ev) => {
			const chunk = JSON.parse(ev.data);
			if (chunk.type === 'meta') {
				// A meta chunk marks the start of a (re)attempt — discard any
				// partial text from a failed attempt so it isn't duplicated.
				streamModel = chunk.model;
				streamText = '';
			} else if (chunk.type === 'delta') streamText += chunk.text;
			else if (chunk.type === 'stage') stages = [...stages, { name: chunk.name, detail: chunk.detail }];
			else if (chunk.type === 'step' || chunk.type === 'tool') {
				// Only drop the buffered text when the server says it became this
				// step's label — see the same guard on the code page. Text the model
				// wrote for the user before calling a tool is the reply.
				if (chunk.type === 'step' && chunk.consumedText) streamText = '';
				timeline = applyChunk(timeline, chunk);
			} else if (chunk.type === 'notice') notices = [...notices, chunk.text];
			else if (chunk.type === 'question') {
				question = { id: chunk.id, prompt: chunk.prompt, options: chunk.options ?? [] };
			} else if (chunk.type === 'answer') {
				if (question?.id === chunk.id) question = null;
			}
			else if (chunk.type === 'done') {
				// Read before finalizeStream appends the reply: zero assistant
				// messages means the turn that just ended was this chat's first,
				// which is the only one the auto-titler acts on.
				const chat = currentChat;
				const wasFirstTurn = !messages.some((m) => m.role === 'assistant');
				lastStopReason = chunk.stopReason ?? null;
				// Deep research is a per-run choice, not a mode: leaving it armed
				// sent every following message down the research pipeline, which is
				// slow and expensive and was never asked for.
				if (researchRunning) {
					researchRunning = false;
					deepResearch = false;
					researchEffort = 'balanced';
					notices = [
						...notices,
						'Deep research finished — the toggle is off. Turn it back on for another research run.'
					];
				}
				finalizeStream();
				if (chat) void reconcile(chat.id);
				if (chat && wasFirstTurn && !chat.titleCustom) void pickUpAutoTitle(chat.id);
			}
			else if (chunk.type === 'error') {
				errorBanner = chunk.message;
				// A failed research run leaves the toggle on — the work did not
				// happen, so retrying should not need it switched back — but the
				// flag must not survive to clear the toggle after some later run.
				researchRunning = false;
				finalizeStream(false);
			}
		};
		source.onerror = () => {
			// The connection dropped mid-reply. The turn almost always finished
			// server-side anyway, so recover it rather than leaving the screen
			// blank — that silence was indistinguishable from "the model never
			// answered", and it was worst in hidden chats, which have no
			// Observatory trail to check afterwards.
			if (streaming) void recoverStream();
		};
	}

	/**
	 * Reconcile with the server after an interrupted stream: keep whatever text
	 * arrived, then re-read the conversation so a reply that did complete shows
	 * up. Re-fetching is what actually fixes this — the message is already
	 * stored (or, for a hidden chat, held in memory server-side); nothing was
	 * reading it back.
	 */
	async function recoverStream() {
		const chatId = currentChat?.id;
		const partial = streamText;
		const partialModel = streamModel;
		// Don't commit the partial yet — the server's copy is authoritative and
		// usually complete. It is only worth keeping if the server has nothing.
		finalizeStream(false);
		if (!chatId) return;

		const res = await fetch(`/api/chats/${chatId}`).catch(() => null);
		if (!res?.ok) {
			if (partial) appendLocalAssistant(partial, partialModel);
			errorBanner = 'Lost the connection to this run — reopen the chat to see how it ended.';
			return;
		}

		const data = await res.json();
		messages = data.messages;
		if (data.runningJobId && recoveries < MAX_RECOVERIES) {
			// Still going: reattach rather than stranding the user on a dead view.
			recoveries++;
			attachStream(data.runningJobId, recoveries);
			return;
		}
		if (data.runningJobId) {
			errorBanner = 'Kept losing the connection to this run — reopen the chat to catch up.';
			return;
		}
		const answered = messages.at(-1)?.role === 'assistant';
		if (!answered && partial) {
			// The turn died before the reply was saved. Show what did arrive rather
			// than throwing it away, but say that it is unfinished.
			appendLocalAssistant(partial, partialModel);
			errorBanner = 'The connection dropped mid-reply — this answer is incomplete.';
		} else if (!answered) {
			errorBanner = 'That run ended without a reply. Check the Observatory for the reason.';
		}
	}

	/**
	 * Re-read the thread once a turn ends.
	 *
	 * The browser rebuilds the reply from deltas and commits its own copy, which
	 * is right until the server's version differs. It stays on screen until this
	 * lands and stands if it fails, so this can only improve on it — same
	 * reconciliation `recoverStream` does on a dropped connection, on the
	 * success path.
	 */
	async function reconcile(chatId: string) {
		const res = await fetch(`/api/chats/${chatId}`).catch(() => null);
		if (!res?.ok) return;
		const data = await res.json();
		// The user may have switched chats while this was in flight.
		if (currentChat?.id !== chatId) return;
		messages = data.messages;
	}

	function appendLocalAssistant(content: string, modelKey: string) {
		messages = [
			...messages,
			{
				id: `local-a-${Date.now()}`,
				role: 'assistant',
				content,
				modelKey: modelKey || null,
				attachments: null,
				trace: localTrace()
			}
		];
	}

	/**
	 * The turn just watched, in the shape the server stores it, so the reply
	 * keeps its steps on screen without a refetch.
	 */
	function localTrace(): MessageTrace | null {
		const steps = timeline
			.filter((i) => i.kind === 'step')
			.map((s) => ({
				id: s.id,
				label: s.label,
				status: s.status === 'error' ? ('error' as const) : ('ok' as const),
				toolCalls: s.tools.map((t) => ({
					name: t.name,
					summary: t.detail,
					status: t.status === 'error' ? ('error' as const) : ('ok' as const)
				}))
			}));
		return steps.length ? { steps } : null;
	}

	/**
	 * Wait for the title the server writes *after* the reply.
	 *
	 * Titling runs off the streaming path deliberately, so the refresh in
	 * finalizeStream races it — and against a remote model it always loses,
	 * leaving the sidebar on the truncated first message until the next reload.
	 * A handful of cheap re-reads, only ever on a chat's first turn, and only
	 * until the name actually changes.
	 */
	async function pickUpAutoTitle(chatId: string) {
		// Only the active list, not refreshChats(), which also pulls the archive —
		// nothing here can change it, and this runs several times.
		const readTitle = async (): Promise<string | undefined> => {
			const res = await fetch('/api/chats').catch(() => null);
			if (!res?.ok) return undefined;
			const list = filterChatMode(await res.json());
			const found = list.find((c) => c.id === chatId);
			if (found) {
				chats = list;
				if (currentChat?.id === chatId) currentChat = { ...currentChat, title: found.title };
			}
			return found?.title;
		};

		const before = await readTitle();
		// ~15s of grace in total, which covers a slow model on a small prompt.
		// Past that the name still lands server-side; it just waits for a reload.
		for (const wait of [800, 1500, 2500, 4000, 6000]) {
			await new Promise((resolve) => setTimeout(resolve, wait));
			if ((await readTitle()) !== before) return;
		}
	}

	function finalizeStream(commit = true) {
		if (commit && streamText) {
			messages = [
				...messages,
				{
					id: `local-a-${Date.now()}`,
					role: 'assistant',
					content: streamText,
					modelKey: streamModel || null,
					attachments: null,
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
		stages = [];
		closeStream();
		void refreshChats();
	}

	/**
	 * Resolve the waiting tool call. The sheet closes on the `answer` chunk the
	 * server pushes back, not here — so what the screen shows is what the run
	 * actually received.
	 */
	async function answerQuestion(answer: string) {
		if (!activeJobId || !question) return;
		await fetch(`/api/jobs/${activeJobId}/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ questionId: question.id, answer })
		}).catch(() => {});
	}

	async function saveToLibrary(msg: Msg) {
		const res = await fetch('/api/library', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				title: (currentChat?.title ?? 'Chat output').replace(/^🔭 /, ''),
				content: msg.content
			})
		});
		if (res.ok) {
			savedDocId = msg.id;
			setTimeout(() => (savedDocId = null), 2000);
		}
	}

	function closeStream() {
		source?.close();
		source = null;
		streaming = false;
	}

	// Coding sessions live on the Code page; this pane is chat-mode only.
	function filterChatMode(list: (ChatMeta & { mode?: string })[]): ChatMeta[] {
		return list.filter((c) => !c.mode || c.mode === 'chat');
	}

	async function refreshChats() {
		const [activeRes, archivedRes] = await Promise.all([
			fetch('/api/chats'),
			fetch('/api/chats?archived=1')
		]);
		if (activeRes.ok) {
			chats = filterChatMode(await activeRes.json());
			if (currentChat) {
				const updated = chats.find((c) => c.id === currentChat!.id);
				if (updated) currentChat = { ...updated };
			}
		}
		if (archivedRes.ok) archived = filterChatMode(await archivedRes.json());
	}

	/** Chat being renamed inline, and the text as typed. */
	let renamingId = $state<string | null>(null);
	let renameText = $state('');

	function startRename(chat: ChatMeta, ev?: Event) {
		ev?.stopPropagation();
		renamingId = chat.id;
		renameText = chat.title;
	}

	async function commitRename() {
		const id = renamingId;
		const title = renameText.trim();
		renamingId = null;
		if (!id || !title) return;
		const existing = [...chats, ...archived].find((c) => c.id === id);
		if (existing?.title === title) return;
		await fetch(`/api/chats/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title })
		});
		await refreshChats();
		if (currentChat?.id === id) currentChat = { ...currentChat, title };
	}

	function onRenameKey(ev: KeyboardEvent) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			void commitRename();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			renamingId = null;
		}
	}

	async function toggleArchived(chat: ChatMeta, ev?: Event) {
		ev?.stopPropagation();
		await fetch(`/api/chats/${chat.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ archived: !chat.archivedAt })
		});
		// Archiving the open chat leaves it on screen deliberately: it is still a
		// perfectly good conversation, just no longer in the list.
		await refreshChats();
	}

	async function toggleHidden(chat: ChatMeta, evOrNull?: Event) {
		evOrNull?.stopPropagation();
		await fetch(`/api/chats/${chat.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hidden: !chat.hidden })
		});
		await refreshChats();
	}

	async function removeChat(chat: ChatMeta, ev?: Event) {
		ev?.stopPropagation();
		// The row actions are always visible on touch (no hover to reveal them),
		// which puts an unlabelled × a thumb's width from the row you meant to open.
		if (!confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
		await fetch(`/api/chats/${chat.id}`, { method: 'DELETE' });
		clearDraft(draftKey('chat', chat.id));
		if (currentChat?.id === chat.id) {
			currentChat = null;
			messages = [];
			uploadedRefs = [];
			pendingFiles = [];
			loadDraft(NEW_KEY);
			closeStream();
		}
		await refreshChats();
	}

	function onFilesPicked(ev: Event) {
		const target = ev.target as HTMLInputElement;
		const { accepted, rejected } = screenFiles([...(target.files ?? [])]);
		if (accepted.length) pendingFiles = [...pendingFiles, ...accepted];
		errorBanner = rejected.length ? rejected.join(' ') : null;
		target.value = '';
	}

	/**
	 * Enter sends on a keyboard, and inserts a newline on a touch screen — where
	 * there is no Shift-Enter, so Enter-to-send left no way to write a second
	 * line at all. On touch the send button is the only way to send, which is
	 * what every phone messaging app does.
	 */
	function onKeydown(ev: KeyboardEvent) {
		// Mid-composition Enter commits the IME candidate; it must never send.
		if (ev.key !== 'Enter' || ev.isComposing) return;
		if (ev.shiftKey || !hasFinePointer()) return;
		ev.preventDefault();
		void send();
	}

</script>

<div class="chat-shell">
	<button class="list-toggle" onclick={() => (listOpen = !listOpen)} aria-label="Toggle chat list">
		☰
	</button>

	<aside class="chat-list" class:open={listOpen} style={`--list-width:${listPane.width}px`}>
		<div class="list-actions">
			<button class="btn" onclick={() => newChat(false)}>+ New chat</button>
			<button class="btn ghost" title="Hidden: not stored, invisible to memory" onclick={() => newChat(true)}>
				+ Hidden
			</button>
		</div>
		<ul>
			{#each chats as chat (chat.id)}
				<li class:selected={currentChat?.id === chat.id}>
					{#if renamingId === chat.id}
						<!-- svelte-ignore a11y_autofocus -->
						<input
							class="rename"
							bind:value={renameText}
							onkeydown={onRenameKey}
							onblur={commitRename}
							autofocus
							maxlength="120"
							aria-label="Chat name"
						/>
					{:else}
						<button class="chat-row" onclick={() => selectChat(chat.id)} ondblclick={(e) => startRename(chat, e)}>
							<span class="title">{chat.hidden ? '◌ ' : ''}{chat.title}</span>
						</button>
						<span class="row-actions">
							<button class="icon" title="Rename" onclick={(e) => startRename(chat, e)}>✎</button>
							<button
								class="icon"
								title="Archive — keeps the chat, removes it from this list"
								onclick={(e) => toggleArchived(chat, e)}>▤</button
							>
							<button
								class="icon"
								title={chat.hidden ? 'Make visible (persist)' : 'Make hidden (forget)'}
								onclick={(e) => toggleHidden(chat, e)}>{chat.hidden ? '◉' : '◌'}</button
							>
							<button class="icon" title="Delete" onclick={(e) => removeChat(chat, e)}>×</button>
						</span>
					{/if}
				</li>
			{/each}
		</ul>

		{#if archived.length}
			<details class="archive">
				<summary>Archived ({archived.length})</summary>
				<ul>
					{#each archived as chat (chat.id)}
						<li class:selected={currentChat?.id === chat.id}>
							<button class="chat-row" onclick={() => selectChat(chat.id)}>
								<span class="title">{chat.hidden ? '◌ ' : ''}{chat.title}</span>
							</button>
							<span class="row-actions">
								<button
									class="icon"
									title="Restore to the main list"
									onclick={(e) => toggleArchived(chat, e)}>↩</button
								>
								<button class="icon" title="Delete" onclick={(e) => removeChat(chat, e)}>×</button>
							</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</aside>

	<PaneResizer pane={listPane} label="Resize the chat list" />

	<section class="thread-area">
		{#if errorBanner}
			<div class="banner error">
				{errorBanner}
				{#if blockingJobId}
					<button class="banner-action" onclick={stopBlockingRun}>Stop it</button>
				{/if}
			</div>
		{/if}
		{#each notices as notice (notice)}
			<div class="banner">{notice}</div>
		{/each}

		<div class="thread" bind:this={threadEl}>
			{#if !currentChat && !messages.length}
				<div class="empty">
					<p>Start a conversation — it will appear in the pane on the left.</p>
				</div>
			{/if}
			{#each messages as msg (msg.id)}
				{#if msg.role !== 'tool'}
					<div class="msg {msg.role}">
						{#if msg.role === 'assistant'}
							{#if msg.trace?.steps?.length}
								<details class="past-run">
									<summary>{msg.trace.summary || `${msg.trace.steps.length} steps`}</summary>
									<RunTimeline items={itemsFromTrace(msg.trace)} />
								</details>
							{/if}
							<Markdown text={msg.content} />
							<span class="msg-meta">
								{#if msg.modelKey}<span class="msg-model">{msg.modelKey}</span>{/if}
								<button class="save-doc" title="Save to Library" onclick={() => saveToLibrary(msg)}>
									{savedDocId === msg.id ? '✓ saved' : '⌘ save to library'}
								</button>
							</span>
						{:else}
							<p class="user-text">{msg.content}</p>
							{#each msg.attachments ?? [] as att (att.id)}
								<span class="att-chip">{attachmentIcon(att.kind)} {att.name}</span>
							{/each}
						{/if}
					</div>
				{/if}
			{/each}
			{#if streaming}
				<div class="msg assistant">
					{#if stages.length}
						<div class="stages">
							{#if stages.length > VISIBLE_STAGES}<span class="stage-sep">…</span>{/if}
							{#each shownStages as s, i (stages.length - shownStages.length + i)}
								<span class="stage" class:current={i === shownStages.length - 1}>
									{s.name}{s.detail ? ` (${s.detail})` : ''}
								</span>
								{#if i < shownStages.length - 1}<span class="stage-sep">→</span>{/if}
							{/each}
						</div>
					{/if}
					{#if timeline.length}
						<RunTimeline items={timeline} live />
					{/if}
					{#if streamText}
						<Markdown text={streamText} />
					{:else if question}
						<span class="thinking">waiting on your answer</span>
					{:else if !stages.length && !timeline.length}
						<span class="thinking">{streamModel || '…'} is thinking</span>
					{/if}
				</div>
			{/if}
			{#if unfinishedNote(lastStopReason) && !streaming}
				<div class="run-ended">
					<span>{unfinishedNote(lastStopReason)}</span>
					<button class="chip" onclick={() => send('continue')}>Continue</button>
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
					placeholder={currentChat?.hidden
						? 'Hidden chat — nothing here is stored'
						: 'Message Galaxy…'}
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
						title="Stop generating"
						aria-label="Stop generating">{stopping ? '…' : '■'}</button
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
				<button
					class="chip"
					class:on={deepResearch}
					title="Multi-step research with sources and citations"
					onclick={() => (deepResearch = !deepResearch)}
				>
					🔭 Deep research
				</button>
				{#if deepResearch}
					<ResearchEffort
						effort={researchEffort}
						levels={researchLevels}
						onchange={(next) => (researchEffort = next)}
					/>
				{/if}
				<select
					class="model-select"
					bind:value={selectedModelId}
					disabled={deepResearch}
					title={deepResearch
						? 'Deep research uses the model configured for it in Admin → Tasks'
						: 'Model for this conversation'}
				>
					{#if !models.length}
						<option value="">No models — add a provider in Admin</option>
					{/if}
					{#each models as model (model.id)}
						<option value={model.id}>{model.displayName} · {model.providerName}</option>
					{/each}
				</select>
			</div>
		</footer>
	</section>
</div>

{#if question}
	<AskSheet prompt={question.prompt} options={question.options} onanswer={answerQuestion} />
{/if}

<style>
	.chat-shell {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.chat-list {
		/* Set from the drag handle and remembered per browser — see PaneResizer. */
		width: var(--list-width, 340px);
		flex-shrink: 0;
		padding: 0.75rem;
		box-sizing: border-box;
		overflow-y: auto;
	}
	.list-toggle {
		display: none;
	}
	.list-actions {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.75rem;
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
	.btn.ghost {
		background: transparent;
		border: 1px dashed var(--fg-dim);
		color: var(--fg-dim);
	}
	.btn.send {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.stop {
		background: var(--danger);
		color: var(--bg);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.chat-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* Holds the archive down the pane rather than letting it ride up under a
	   short list, where it reads as another chat rather than a separate shelf. */
	.chat-list > ul {
		min-height: 45vh;
	}
	.chat-list li {
		display: flex;
		align-items: center;
		border-radius: 5px;
	}
	.chat-list li.selected {
		background: var(--border);
	}
	.chat-row {
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
	}
	.chat-row .title {
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row-actions {
		display: none;
		gap: 0.1rem;
		padding-right: 0.15rem;
	}
	.chat-list li:hover .row-actions {
		display: inline-flex;
	}
	/* Sized as a target rather than a glyph: at 0.8rem with 0.1rem of padding
	   these were a ~13px tap area, which is a miss waiting to happen next to
	   a Delete. */
	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.5rem;
		min-height: 1.5rem;
		background: none;
		border: none;
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-size: var(--text-xl);
		line-height: 1;
		padding: 0.2rem;
	}
	.icon:hover {
		color: var(--fg);
		background: var(--bg-pane);
	}
	.rename {
		flex: 1;
		min-width: 0;
		background: var(--bg-pane);
		border: 1px solid var(--accent);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.4rem 0.45rem;
		margin: 0.05rem;
		outline: none;
	}
	.archive {
		margin-top: 0.9rem;
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
	}
	.archive summary {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		cursor: pointer;
		padding: 0.25rem 0.15rem;
		letter-spacing: 0.06em;
	}
	.archive summary:hover {
		color: var(--fg);
	}
	.archive .chat-row {
		color: var(--fg-dim);
	}

	.thread-area {
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
	.banner-action {
		background: transparent;
		border: 1px solid currentColor;
		border-radius: var(--radius);
		color: inherit;
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.1rem 0.5rem;
		margin-left: 0.5rem;
		cursor: pointer;
	}
	.thread {
		flex: 1;
		overflow-y: auto;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.empty {
		margin: auto;
		text-align: center;
		color: var(--fg-dim);
		font-size: var(--text-md);
	}
	.msg {
		max-width: 46rem;
		font-size: var(--text-lg);
		line-height: 1.55;
		position: relative;
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
	}
	.user-text {
		margin: 0;
		white-space: pre-wrap;
	}
	.msg-meta {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-top: 0.25rem;
	}
	.msg-model {
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	.save-doc {
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-xs);
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.msg.assistant:hover .save-doc {
		opacity: 1;
	}
	.save-doc:hover {
		color: var(--accent);
	}
	.stages {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin-bottom: 0.5rem;
	}
	.stage.current {
		color: var(--accent);
		animation: pulse 1.4s ease-in-out infinite;
	}
	.stage-sep {
		opacity: 0.5;
	}
	.thinking {
		color: var(--fg-dim);
		font-size: var(--text-md);
		animation: pulse 1.4s ease-in-out infinite;
	}
	/* Stays put after the turn ends. Chat had no signal at all for a turn that
	   ran out of steps — it just stopped. */
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
	/* What the agent did, kept with the reply and folded away. */
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
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
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
	.att-chip.uploaded {
		border-color: var(--accent);
	}
	.composer-hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
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
		   at up to roughly eight, then scrolls — so pasting a long brief doesn't
		   leave you typing through a letterbox, and doesn't swallow the thread
		   either. The cap is here rather than in JS so it holds before hydration. */
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
		flex-wrap: wrap;
	}
	.chip {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}
	.chip:disabled {
		opacity: 0.45;
		cursor: default;
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

	@media (max-width: 720px) {
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
		.chat-list {
			position: fixed;
			width: auto;
			inset: 0 30% 0 0;
			background: var(--bg-pane);
			z-index: 20;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
		}
		.chat-list.open {
			transform: translateX(0);
		}
	}

	/* Reveal-on-hover hides these controls permanently on a touch screen, where
	   there is no hover to reveal them with — the same reason CodeBlock.svelte
	   unhides its copy button here. Deleting a chat asks for confirmation, since
	   the × is now always a thumb away from the row it sits on. */
	@media (hover: none) {
		.row-actions {
			display: inline-flex;
		}
		.save-doc {
			opacity: 1;
		}
	}
</style>
