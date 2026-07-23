<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';

	interface Doc {
		id: string;
		title: string;
		snippet: string;
		author: 'user' | 'agent';
		updatedAt: number;
		match?: string;
	}

	let docs = $state<Doc[]>([]);
	let query = $state('');
	let currentId = $state<string | null>(null);
	let title = $state('');
	let body = $state('');
	let author = $state<'user' | 'agent'>('user');
	let preview = $state(false);
	let saved = $state(false);
	let listOpen = $state(false);

	onMount(load);

	async function load() {
		const url = query.trim() ? `/api/library?q=${encodeURIComponent(query)}` : '/api/library';
		docs = await (await fetch(url)).json();
	}

	async function open(id: string) {
		const res = await fetch(`/api/library/${id}`);
		if (!res.ok) return;
		const doc = await res.json();
		currentId = doc.meta.id;
		title = doc.meta.title;
		author = doc.meta.author;
		body = doc.body;
		preview = false;
		listOpen = false;
	}

	function startNew() {
		currentId = null;
		title = '';
		body = '';
		author = 'user';
		preview = false;
		listOpen = false;
	}

	async function save() {
		if (!title.trim()) return;
		const res = currentId
			? await fetch(`/api/library/${currentId}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title, content: body })
				})
			: await fetch('/api/library', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title, content: body })
				});
		if (res.ok) {
			const doc = await res.json();
			currentId = doc.id;
			saved = true;
			setTimeout(() => (saved = false), 1500);
			await load();
		}
	}

	async function remove() {
		if (!currentId || !confirm(`Delete "${title}"?`)) return;
		await fetch(`/api/library/${currentId}`, { method: 'DELETE' });
		startNew();
		await load();
	}

	function upload(ev: Event) {
		const file = (ev.target as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = async () => {
			await fetch('/api/library', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: file.name.replace(/\.(md|txt)$/i, ''),
					content: String(reader.result ?? '')
				})
			});
			await load();
		};
		reader.readAsText(file);
		(ev.target as HTMLInputElement).value = '';
	}
</script>

<div class="lib-shell">
	<button class="list-toggle" onclick={() => (listOpen = !listOpen)} aria-label="Toggle list">☰</button>

	<aside class="doc-list" class:open={listOpen}>
		<div class="list-actions">
			<button class="btn primary" onclick={startNew}>+ New doc</button>
			<label class="btn ghost upload">
				Upload .md
				<input type="file" accept=".md,.txt,text/markdown,text/plain" hidden onchange={upload} />
			</label>
		</div>
		<input
			class="search"
			placeholder="Search library…"
			bind:value={query}
			oninput={() => load()}
		/>
		<ul>
			{#each docs as doc (doc.id)}
				<li class:selected={currentId === doc.id}>
					<button class="row" onclick={() => open(doc.id)}>
						<span class="doc-title">
							{doc.title}
							{#if doc.author === 'agent'}<span class="agent-badge">agent</span>{/if}
						</span>
						<span class="doc-snippet">{doc.match ?? doc.snippet}</span>
					</button>
				</li>
			{:else}
				<li class="empty">No documents{query ? ' match' : ' yet'}.</li>
			{/each}
		</ul>
	</aside>

	<section class="editor">
		<header>
			<input class="title" placeholder="Document title" bind:value={title} />
			<div class="actions">
				<button class="chip" class:on={preview} onclick={() => (preview = !preview)}>
					{preview ? 'edit' : 'preview'}
				</button>
				<button class="btn primary" onclick={save}>{saved ? 'Saved ✓' : 'Save'}</button>
				{#if currentId}<button class="btn danger" onclick={remove}>Delete</button>{/if}
			</div>
		</header>
		{#if preview}
			<div class="preview"><Markdown text={body} /></div>
		{:else}
			<textarea
				placeholder="Markdown content… readable by every agent as shared knowledge."
				bind:value={body}
			></textarea>
		{/if}
	</section>
</div>

<style>
	.lib-shell {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.doc-list {
		width: 290px;
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
		margin-bottom: 0.6rem;
	}
	.search {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.4rem 0.6rem;
		margin-bottom: 0.6rem;
	}
	.doc-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.doc-list li {
		border-radius: 6px;
	}
	.doc-list li.selected {
		background: var(--border);
	}
	.row {
		width: 100%;
		background: none;
		border: none;
		color: var(--fg);
		font-family: inherit;
		text-align: left;
		padding: 0.45rem 0.5rem;
		cursor: pointer;
	}
	.doc-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
	}
	.agent-badge {
		font-size: 0.58rem;
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		text-transform: uppercase;
	}
	.doc-snippet {
		display: block;
		color: var(--fg-dim);
		font-size: 0.68rem;
		margin-top: 0.15rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.empty {
		color: var(--fg-dim);
		font-size: 0.75rem;
		padding: 0.5rem;
	}

	.editor {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.editor header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.6rem 1rem;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.title {
		flex: 1;
		min-width: 12rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid transparent;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.95rem;
		padding: 0.3rem 0;
		outline: none;
	}
	.title:focus {
		border-bottom-color: var(--accent);
	}
	.actions {
		display: flex;
		gap: 0.4rem;
	}
	textarea {
		flex: 1;
		background: transparent;
		border: none;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.85rem;
		line-height: 1.6;
		padding: 1rem;
		resize: none;
		outline: none;
	}
	.preview {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		font-size: 0.88rem;
	}

	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
	.btn.ghost {
		background: transparent;
		border: 1px dashed var(--fg-dim);
		color: var(--fg-dim);
	}
	.upload {
		display: inline-flex;
		align-items: center;
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
		.doc-list {
			position: fixed;
			inset: 0 25% 0 0;
			background: var(--bg-pane);
			z-index: 20;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
		}
		.doc-list.open {
			transform: translateX(0);
		}
	}
</style>
