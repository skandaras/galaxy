<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';

	interface ChatMeta {
		id: string;
		title: string;
		hidden: boolean;
		updatedAt: number;
	}
	interface Msg {
		id: string;
		role: 'user' | 'assistant' | 'tool';
		content: string;
		modelKey: string | null;
		attachments: { id: string; name: string; mime: string }[] | null;
	}
	interface ModelOption {
		id: string;
		displayName: string;
		providerName: string;
		supportsTools: boolean;
		supportsVision: boolean;
	}

	let chats = $state<ChatMeta[]>([]);
	let models = $state<ModelOption[]>([]);
	let currentChat = $state<ChatMeta | null>(null);
	let messages = $state<Msg[]>([]);
	let listOpen = $state(false);

	let input = $state('');
	let selectedModelId = $state<string>('');
	let webSearch = $state(true);
	let deepResearch = $state(false);
	let pendingFiles = $state<File[]>([]);

	let streaming = $state(false);
	let streamText = $state('');
	let streamModel = $state('');
	let toolActivity = $state<string | null>(null);
	let stages = $state<{ name: string; detail?: string }[]>([]);
	let notices = $state<string[]>([]);
	let errorBanner = $state<string | null>(null);
	let savedDocId = $state<string | null>(null);
	let source: EventSource | null = null;

	onMount(async () => {
		const [chatsRes, modelsRes] = await Promise.all([
			fetch('/api/chats'),
			fetch('/api/models')
		]);
		chats = filterChatMode(await chatsRes.json());
		const m = await modelsRes.json();
		models = m.models;
		selectedModelId = m.defaultModelId ?? models[0]?.id ?? '';
	});

	async function selectChat(id: string) {
		closeStream();
		errorBanner = null;
		const res = await fetch(`/api/chats/${id}`);
		if (!res.ok) return;
		const data = await res.json();
		currentChat = { ...data.chat };
		messages = data.messages;
		listOpen = false;
		if (data.runningJobId) attachStream(data.runningJobId);
	}

	async function newChat(hidden: boolean) {
		const res = await fetch('/api/chats', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hidden })
		});
		const chat = await res.json();
		chats = [chat, ...chats];
		await selectChat(chat.id);
	}

	async function send() {
		const content = input.trim();
		if ((!content && !pendingFiles.length) || streaming) return;
		errorBanner = null;

		if (!currentChat) await newChat(false);
		if (!currentChat) return;

		const attachments: { id: string; name: string; mime: string }[] = [];
		for (const file of pendingFiles) {
			const form = new FormData();
			form.append('file', file);
			const res = await fetch(`/api/chats/${currentChat.id}/attachments`, {
				method: 'POST',
				body: form
			});
			if (res.ok) attachments.push(await res.json());
			else errorBanner = `Upload failed for ${file.name}`;
		}

		const res = await fetch(`/api/chats/${currentChat.id}/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				content,
				modelId: selectedModelId || undefined,
				webSearch,
				deepResearch,
				attachments: attachments.length ? attachments : undefined
			})
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ message: res.statusText }));
			errorBanner = err.message ?? 'Failed to send';
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
		input = '';
		pendingFiles = [];
		const { jobId } = await res.json();
		attachStream(jobId);
	}

	function attachStream(jobId: string) {
		closeStream();
		streaming = true;
		streamText = '';
		streamModel = '';
		toolActivity = null;
		stages = [];
		notices = [];
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
			else if (chunk.type === 'tool') {
				toolActivity =
					chunk.status === 'running'
						? `${chunk.name}…`
						: chunk.status === 'error'
							? `${chunk.name} failed`
							: null;
			} else if (chunk.type === 'notice') notices = [...notices, chunk.text];
			else if (chunk.type === 'done') finalizeStream();
			else if (chunk.type === 'error') {
				errorBanner = chunk.message;
				finalizeStream(false);
			}
		};
		source.onerror = () => {
			// Server closed or network dropped; if a reply was mid-flight the
			// job keeps running server-side — reselecting the chat reattaches.
			if (streaming) finalizeStream(false);
		};
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
					attachments: null
				}
			];
		}
		streaming = false;
		streamText = '';
		toolActivity = null;
		stages = [];
		closeStream();
		void refreshChats();
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
		const res = await fetch('/api/chats');
		if (res.ok) {
			chats = filterChatMode(await res.json());
			if (currentChat) {
				const updated = chats.find((c) => c.id === currentChat!.id);
				if (updated) currentChat = { ...updated };
			}
		}
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
		await fetch(`/api/chats/${chat.id}`, { method: 'DELETE' });
		if (currentChat?.id === chat.id) {
			currentChat = null;
			messages = [];
			closeStream();
		}
		await refreshChats();
	}

	function onFilesPicked(ev: Event) {
		const files = (ev.target as HTMLInputElement).files;
		if (files) pendingFiles = [...pendingFiles, ...files];
		(ev.target as HTMLInputElement).value = '';
	}

	function onKeydown(ev: KeyboardEvent) {
		if (ev.key === 'Enter' && !ev.shiftKey) {
			ev.preventDefault();
			void send();
		}
	}

	import { GALAXY_SMALL } from '$lib/galaxy-art';
</script>

<div class="chat-shell">
	<button class="list-toggle" onclick={() => (listOpen = !listOpen)} aria-label="Toggle chat list">
		☰
	</button>

	<aside class="chat-list" class:open={listOpen}>
		<div class="list-actions">
			<button class="btn" onclick={() => newChat(false)}>+ New chat</button>
			<button class="btn ghost" title="Hidden: not stored, invisible to memory" onclick={() => newChat(true)}>
				+ Hidden
			</button>
		</div>
		<ul>
			{#each chats as chat (chat.id)}
				<li class:selected={currentChat?.id === chat.id}>
					<button class="chat-row" onclick={() => selectChat(chat.id)}>
						<span class="title">{chat.hidden ? '◌ ' : ''}{chat.title}</span>
					</button>
					<span class="row-actions">
						<button
							class="icon"
							title={chat.hidden ? 'Make visible (persist)' : 'Make hidden (forget)'}
							onclick={(e) => toggleHidden(chat, e)}>{chat.hidden ? '◉' : '◌'}</button
						>
						<button class="icon" title="Delete" onclick={(e) => removeChat(chat, e)}>×</button>
					</span>
				</li>
			{/each}
		</ul>
	</aside>

	<section class="thread-area">
		{#if errorBanner}
			<div class="banner error">{errorBanner}</div>
		{/if}
		{#each notices as notice (notice)}
			<div class="banner">{notice}</div>
		{/each}

		<div class="thread">
			{#if !currentChat && !messages.length}
				<div class="empty">
					<pre class="galaxy-art" aria-hidden="true">{GALAXY_SMALL}</pre>
					<p>Start a conversation — it will appear in the pane on the left.</p>
				</div>
			{/if}
			{#each messages as msg (msg.id)}
				{#if msg.role !== 'tool'}
					<div class="msg {msg.role}">
						{#if msg.role === 'assistant'}
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
								<span class="att-chip">🖼 {att.name}</span>
							{/each}
						{/if}
					</div>
				{/if}
			{/each}
			{#if streaming}
				<div class="msg assistant">
					{#if stages.length}
						<div class="stages">
							{#each stages as s, i (i)}
								<span class="stage" class:current={i === stages.length - 1}>
									{s.name}{s.detail ? ` (${s.detail})` : ''}
								</span>
								{#if i < stages.length - 1}<span class="stage-sep">→</span>{/if}
							{/each}
						</div>
					{/if}
					{#if streamText}
						<Markdown text={streamText} />
					{:else if !stages.length}
						<span class="thinking">{streamModel || '…'} is thinking</span>
					{/if}
					{#if toolActivity}<span class="tool-activity">⚙ {toolActivity}</span>{/if}
				</div>
			{/if}
		</div>

		<footer class="composer">
			{#if pendingFiles.length}
				<div class="pending-files">
					{#each pendingFiles as file, i (file.name + i)}
						<span class="att-chip">
							🖼 {file.name}
							<button
								class="icon"
								onclick={() => (pendingFiles = pendingFiles.filter((_, j) => j !== i))}>×</button
							>
						</span>
					{/each}
				</div>
			{/if}
			<div class="composer-row">
				<textarea
					rows="2"
					placeholder={currentChat?.hidden
						? 'Hidden chat — nothing here is stored'
						: 'Message Galaxy…'}
					bind:value={input}
					onkeydown={onKeydown}
				></textarea>
				<button class="btn send" onclick={send} disabled={streaming}>➤</button>
			</div>
			<div class="composer-opts">
				<label class="opt">
					<input type="file" accept="image/*" multiple hidden onchange={onFilesPicked} />
					<span class="chip" role="button" tabindex="0" onclick={(e) => (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement)?.click()} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement)?.click()}>📎</span>
				</label>
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
				<select class="model-select" bind:value={selectedModelId}>
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

<style>
	.chat-shell {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.chat-list {
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
		font-size: 0.78rem;
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
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.chat-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
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
		font-size: 0.8rem;
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
		gap: 0.15rem;
	}
	.chat-list li:hover .row-actions {
		display: inline-flex;
	}
	.icon {
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.1rem 0.25rem;
	}
	.icon:hover {
		color: var(--fg);
	}

	.thread-area {
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
		font-size: 0.8rem;
	}
	.galaxy-art {
		color: var(--accent);
		opacity: 0.55;
		font-size: 0.6rem;
		line-height: 1.25;
		user-select: none;
		display: inline-block;
		text-align: left;
	}
	.msg {
		max-width: 46rem;
		font-size: 0.88rem;
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
		font-size: 0.65rem;
	}
	.save-doc {
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: 0.62rem;
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
		font-size: 0.7rem;
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
		font-size: 0.8rem;
		animation: pulse 1.4s ease-in-out infinite;
	}
	.tool-activity {
		display: block;
		color: var(--fg-dim);
		font-size: 0.72rem;
		margin-top: 0.3rem;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

	.composer {
		border-top: 1px solid var(--border);
		padding: 0.7rem 1rem 0.9rem;
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
		flex-wrap: wrap;
	}
	.chip {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: 0.72rem;
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
		font-size: 0.72rem;
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
</style>
