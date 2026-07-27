<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { ATTACHMENT_ACCEPT, attachmentIcon, screenFiles } from '$lib/attachment-types';
	import { clearDraft, draftKey, getDraft, setDraft } from '$lib/composer-drafts.svelte';
	import { createAutoscroll } from '$lib/autoscroll.svelte';
	import { copyText } from '$lib/clipboard';

	interface ChatMeta {
		id: string;
		title: string;
		mode: string;
		updatedAt: number;
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
	interface TraceRow {
		name: string;
		status: string;
		detail?: string;
	}

	let sessions = $state<ChatMeta[]>([]);
	let models = $state<ModelOption[]>([]);
	let repos = $state<Repo[]>([]);
	let githubConfigured = $state(false);

	let current = $state<Session | null>(null);
	let messages = $state<Msg[]>([]);
	let listOpen = $state(false);

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

	const scroll = createAutoscroll();
	let threadEl = $state<HTMLElement | null>(null);
	let diffCopied = $state(false);

	let selectedModelId = $state('');
	let streaming = $state(false);
	let streamText = $state('');
	let streamModel = $state('');
	let trace = $state<TraceRow[]>([]);
	let notices = $state<string[]>([]);
	let errorBanner = $state<string | null>(null);
	let diffText = $state<string | null>(null);
	let source: EventSource | null = null;

	onMount(async () => {
		const [chatsRes, modelsRes, reposRes] = await Promise.all([
			fetch('/api/chats'),
			fetch('/api/models?task=coding'),
			fetch('/api/github/repos')
		]);
		sessions = ((await chatsRes.json()) as ChatMeta[]).filter((c) => c.mode === 'code');
		const m = await modelsRes.json();
		models = m.models.filter((x: ModelOption) => x.supportsTools);
		selectedModelId = m.defaultModelId ?? models[0]?.id ?? '';
		const g = await reposRes.json().catch(() => ({ configured: false, repos: [] }));
		githubConfigured = g.configured;
		repos = g.repos;
	});

	$effect(() => (threadEl ? scroll.attach(threadEl) : undefined));

	// Follow the run as it streams, unless the user has scrolled up to read.
	$effect(() => {
		streamText;
		messages.length;
		trace.length;
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

	async function select(chatId: string) {
		stashDraft();
		closeStream();
		errorBanner = null;
		diffText = null;
		const res = await fetch(`/api/code/sessions/${chatId}`);
		if (!res.ok) return;
		const data = await res.json();
		current = data.session;
		messages = data.messages.filter((m: Msg) => m.role !== 'tool');
		listOpen = false;
		creating = false;
		pendingFiles = [];
		uploadedRefs = [];
		loadDraft(draftKey('code', chatId));
		// Open on the newest message rather than the top of the history.
		void scroll.toBottom('auto');
		if (data.runningJobId) attach(data.runningJobId);
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

	function attach(jobId: string) {
		closeStream();
		streaming = true;
		streamText = '';
		streamModel = '';
		trace = [];
		notices = [];
		source = new EventSource(`/api/jobs/${jobId}/stream`);
		source.onmessage = (ev) => {
			const chunk = JSON.parse(ev.data);
			if (chunk.type === 'meta') {
				// New (re)attempt: drop partial text from a failed attempt.
				streamModel = chunk.model;
				streamText = '';
			} else if (chunk.type === 'delta') streamText += chunk.text;
			else if (chunk.type === 'tool') {
				if (chunk.status === 'running') {
					trace = [...trace, { name: chunk.name, status: 'running', detail: chunk.detail }];
				} else {
					const idx = trace.findLastIndex((t) => t.name === chunk.name && t.status === 'running');
					if (idx >= 0) {
						trace[idx] = { ...trace[idx], status: chunk.status, detail: chunk.detail ?? trace[idx].detail };
					}
				}
			} else if (chunk.type === 'notice') notices = [...notices, chunk.text];
			else if (chunk.type === 'done') finalize();
			else if (chunk.type === 'error') {
				errorBanner = chunk.message;
				finalize(false);
			}
		};
		source.onerror = () => {
			if (streaming) finalize(false);
		};
	}

	function finalize(commit = true) {
		if (commit && streamText) {
			messages = [
				...messages,
				{ id: `local-a-${Date.now()}`, role: 'assistant', content: streamText, modelKey: streamModel }
			];
		}
		streaming = false;
		streamText = '';
		closeStream();
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
		if (diffText !== null) {
			diffText = null;
			return;
		}
		diffText = await (await fetch(`/api/code/sessions/${current.chatId}/diff`)).text();
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
		if (diffText === null) return;
		diffCopied = await copyText(diffText);
		setTimeout(() => (diffCopied = false), 2000);
	}

	function onKeydown(ev: KeyboardEvent) {
		if (ev.key === 'Enter' && !ev.shiftKey) {
			ev.preventDefault();
			void send();
		}
	}

	const lastAssistantExists = $derived(messages.some((m) => m.role === 'assistant'));

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

	<aside class="session-list" class:open={listOpen}>
		<button class="btn primary wide" onclick={() => ((creating = true), (current = null))}>
			+ New session
		</button>
		<ul>
			{#each sessions as s (s.id)}
				<li class:selected={current?.chatId === s.id}>
					<button class="row" onclick={() => select(s.id)}>{s.title}</button>
					<button class="icon" title="Delete session" onclick={(e) => removeSession(s.id, e)}
						>×</button
					>
				</li>
			{/each}
		</ul>
	</aside>

	<section class="work-area">
		{#if errorBanner}<div class="banner error">{errorBanner}</div>{/if}
		{#each notices as n (n)}<div class="banner">{n}</div>{/each}

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
				<span class="repo">{current.repoName}</span>
				<span class="branch">{current.workBranch}</span>
				<span class="mode-badge {current.mode}">{current.mode}</span>
				{#if current.mode === 'implement'}
					<button class="chip" onclick={() => setMode('plan')}>back to plan</button>
				{/if}
				<button class="chip" onclick={loadDiff}>{diffText === null ? 'view diff' : 'hide diff'}</button>
			</header>

			{#if diffText !== null}
				<div class="diff-wrap">
					<button
						class="diff-copy"
						class:ok={diffCopied}
						onclick={copyDiff}
						title="Copy diff to clipboard"
						aria-label="Copy diff to clipboard">{diffCopied ? '✓' : '⧉'}</button
					>
					<pre class="diff">{@html renderDiff(diffText)}</pre>
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
						{#if trace.length}
							<ul class="trace">
								{#each trace as t, i (i)}
									<li class="t-{t.status}">
										<span class="t-name">{t.name}</span>
										{#if t.detail}<span class="t-detail">{t.detail}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
						{#if streamText}
							<Markdown text={streamText} />
						{:else if !trace.length}
							<span class="thinking">{streamModel || '…'} is working</span>
						{/if}
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
						oninput={stashDraft}
						onkeydown={onKeydown}
					></textarea>
					<button class="btn send" onclick={() => send()} disabled={streaming}>➤</button>
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
		width: 250px;
		flex-shrink: 0;
		border-right: 1px solid var(--border);
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
	.row {
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.8rem;
		text-align: left;
		padding: 0.45rem 0.5rem;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.icon {
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		padding: 0.1rem 0.3rem;
		display: none;
	}
	.session-list li:hover .icon {
		display: inline;
	}

	.work-area {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.banner {
		padding: 0.4rem 1rem;
		font-size: 0.75rem;
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
		font-size: 0.9rem;
		letter-spacing: 0.25em;
		color: var(--accent);
		margin: 0;
	}
	.new-session label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	.new-session select,
	.new-session input {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.8rem;
		padding: 0.45rem 0.6rem;
	}
	.mode-pick {
		display: flex;
		gap: 0.4rem;
	}
	.dim {
		color: var(--fg-dim);
		font-size: 0.72rem;
		margin: 0;
	}

	.session-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.55rem 1rem;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.repo {
		font-size: 0.82rem;
	}
	.branch {
		color: var(--fg-dim);
		font-size: 0.7rem;
	}
	.mode-badge {
		font-size: 0.62rem;
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
		position: relative;
	}
	.diff-copy {
		position: absolute;
		top: 0.4rem;
		right: 0.6rem;
		z-index: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: 0.72rem;
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
	.diff {
		max-height: 40vh;
		overflow: auto;
		background: var(--bg-pane);
		border-bottom: 1px solid var(--border);
		margin: 0;
		padding: 0.7rem 1rem;
		font-size: 0.72rem;
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
		font-size: 0.8rem;
	}
	.empty.center {
		margin: auto;
	}
	.msg {
		max-width: 50rem;
		font-size: 0.88rem;
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
		font-size: 0.65rem;
		margin-top: 0.25rem;
	}
	.thinking {
		color: var(--fg-dim);
		font-size: 0.8rem;
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	.trace {
		list-style: none;
		margin: 0 0 0.6rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 0.72rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.trace li {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
	}
	.t-name {
		color: var(--accent);
	}
	.t-running .t-name {
		animation: pulse 1.2s ease-in-out infinite;
	}
	.t-error .t-name,
	.t-error .t-detail {
		color: var(--danger);
	}
	.t-detail {
		color: var(--fg-dim);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.plan-actions {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.4rem 0;
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
		font-size: 0.7rem;
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
		font-size: 0.7rem;
		padding: 0.15rem 0.4rem;
		margin-top: 0.3rem;
	}
	.att-chip.uploaded {
		border-color: var(--accent);
	}
	.composer-hint {
		color: var(--fg-dim);
		font-size: 0.7rem;
		margin-bottom: 0.4rem;
	}
	.composer-row {
		display: flex;
		gap: 0.5rem;
		align-items: flex-end;
	}
	textarea {
		flex: 1;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.88rem;
		padding: 0.6rem 0.8rem;
		resize: none;
		outline: none;
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
		font-size: 0.72rem;
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
		font-size: 0.78rem;
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
		font-size: 0.7rem;
		padding: 0.22rem 0.65rem;
		cursor: pointer;
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
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
		.session-list {
			position: fixed;
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
</style>
