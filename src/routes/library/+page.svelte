<script lang="ts">
	import { onMount } from 'svelte';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';

	interface Doc {
		id: string;
		title: string;
		snippet: string;
		author: 'user' | 'agent';
		/** Null on docs that predate ownership — those stay visible to everyone. */
		ownerId: string | null;
		visibility: 'personal' | 'shared';
		/** Cosmetic grouping; '' means unfiled. */
		folder: string;
		updatedAt: number;
		match?: string;
	}

	const UNFILED = 'Unfiled';

	let docs = $state<Doc[]>([]);
	let query = $state('');
	let currentId = $state<string | null>(null);
	let title = $state('');
	let body = $state('');
	let folder = $state('');
	let visibility = $state<'personal' | 'shared'>('personal');
	/**
	 * Per-folder overrides on top of the default, which is shut for everything
	 * except Unfiled — a shelf that opens with every folder expanded is a wall
	 * of documents, and Unfiled is the overflow people actually browse.
	 *
	 * Deliberately not remembered between visits: "collapsed on arrival" is the
	 * point, and a persisted expansion would quietly undo it.
	 */
	let collapsed = $state<Record<string, boolean>>({});
	const isShut = (name: string) => collapsed[name] ?? name !== UNFILED;

	/**
	 * The shelf, grouped. Unfiled sits last: it is the overflow, not the
	 * headline, and putting it first buries the folders someone made on purpose.
	 */
	const grouped = $derived.by(() => {
		const by = new Map<string, Doc[]>();
		for (const doc of docs) {
			const key = doc.folder || UNFILED;
			by.set(key, [...(by.get(key) ?? []), doc]);
		}
		return [...by.entries()].sort(([a], [b]) =>
			a === UNFILED ? 1 : b === UNFILED ? -1 : a.localeCompare(b)
		);
	});

	/** Existing folder names, so the picker suggests rather than demands. */
	const folders = $derived([...new Set(docs.map((d) => d.folder).filter(Boolean))].sort());

	/** Shut everything, or open everything once it already is. */
	const allShut = $derived(grouped.every(([name]) => isShut(name)));

	/**
	 * Written as an explicit entry per folder rather than by clearing the map:
	 * the default is per-name, so "open all" has to say so for each one or
	 * Unfiled would be the only thing that moved.
	 */
	function setAllCollapsed(shut: boolean) {
		collapsed = Object.fromEntries(grouped.map(([name]) => [name, shut]));
	}

	/** False for someone else's shared doc: readable, not editable. */
	let editable = $state(true);
	let preview = $state(false);
	let saved = $state(false);
	let listOpen = $state(false);

	/**
	 * Width of the document list, draggable by the divider. The floor keeps the
	 * folder headings and the two-line document rows readable.
	 */
	const listPane = createResizablePane({
		key: 'galaxy:library-list-width',
		min: 220,
		max: 500,
		initial: 290
	});

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
		visibility = doc.meta.visibility;
		folder = doc.meta.folder ?? '';
		editable = doc.canEdit !== false;
		body = doc.body;
		preview = false;
		listOpen = false;
	}

	/** `into` pre-files a doc created from a folder's own + button. */
	function startNew(into = '') {
		currentId = null;
		title = '';
		body = '';
		folder = into;
		// New docs start personal; sharing is a deliberate act.
		visibility = 'personal';
		editable = true;
		preview = false;
		listOpen = false;
	}

	async function save() {
		if (!title.trim()) return;
		const res = currentId
			? await fetch(`/api/library/${currentId}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title, content: body, visibility, folder })
				})
			: await fetch('/api/library', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title, content: body, visibility, folder })
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

	<aside class="doc-list" class:open={listOpen} style={`--list-width:${listPane.width}px`}>
		<div class="list-actions">
			<!-- Wrapped, or the click event arrives as the folder to file it under. -->
			<button class="btn primary" onclick={() => startNew()}>+ New doc</button>
			<label class="btn ghost upload">
				Upload .md
				<input type="file" accept=".md,.txt,text/markdown,text/plain" hidden onchange={upload} />
			</label>
			<!-- Only ever useful when there is grouping to act on, and search
			     replaces the folders with a flat ranked list. -->
			{#if !query.trim() && grouped.length > 1}
				<button
					class="collapse-all"
					title={allShut ? 'Expand all folders' : 'Collapse all folders'}
					aria-label={allShut ? 'Expand all folders' : 'Collapse all folders'}
					onclick={() => setAllCollapsed(!allShut)}
				>
					{allShut ? '⊞' : '⊟'}
				</button>
			{/if}
		</div>
		<input
			class="search"
			placeholder="Search library…"
			bind:value={query}
			oninput={() => load()}
		/>
		{#snippet docRow(doc: Doc)}
			<li class:selected={currentId === doc.id}>
				<button class="row" onclick={() => open(doc.id)}>
					<span class="doc-title">
						{doc.title}
						{#if doc.author === 'agent'}<span class="agent-badge">agent</span>{/if}
						{#if doc.visibility === 'shared'}<span class="vis-badge">shared</span>{/if}
					</span>
					<span class="doc-snippet">{doc.match ?? doc.snippet}</span>
				</button>
			</li>
		{/snippet}

		{#if !docs.length}
			<ul><li class="empty">No documents{query ? ' match' : ' yet'}.</li></ul>
		{:else if query.trim()}
			<!-- Results are ranked by relevance; folders would fight that ordering. -->
			<ul>
				{#each docs as doc (doc.id)}{@render docRow(doc)}{/each}
			</ul>
		{:else}
			{#each grouped as [name, items] (name)}
				<section class="folder">
					<div class="folder-head">
						<button
							class="folder-name"
							aria-expanded={!isShut(name)}
							onclick={() => (collapsed = { ...collapsed, [name]: !isShut(name) })}
						>
							<span class="caret">{isShut(name) ? '▸' : '▾'}</span>
							{name}
							<span class="count">{items.length}</span>
						</button>
						{#if name !== UNFILED}
							<button
								class="icon"
								title="New doc in {name}"
								aria-label="New doc in {name}"
								onclick={() => startNew(name)}>+</button
							>
						{/if}
					</div>
					{#if !isShut(name)}
						<ul>
							{#each items as doc (doc.id)}{@render docRow(doc)}{/each}
						</ul>
					{/if}
				</section>
			{/each}
		{/if}
	</aside>

	<PaneResizer pane={listPane} label="Resize the document list" />

	<section class="editor">
		<header>
			<input class="title" placeholder="Document title" bind:value={title} />
			<input
				class="folder-input"
				list="library-folders"
				placeholder="Folder"
				title="Group this doc on the shelf. Type a new name or pick an existing one; leave it empty to keep it unfiled."
				disabled={!editable}
				bind:value={folder}
			/>
			<datalist id="library-folders">
				{#each folders as f (f)}<option value={f}></option>{/each}
			</datalist>
			<div class="actions">
				<button
					class="chip"
					class:on={visibility === 'shared'}
					disabled={!editable}
					title={editable
						? 'Shared docs appear in every user\u2019s library and feed their agents\u2019 context'
						: 'This document belongs to another user'}
					onclick={() => (visibility = visibility === 'shared' ? 'personal' : 'shared')}
				>
					{visibility === 'shared' ? '\u25c9 Widely viewable' : '\u25cc Personal'}
				</button>
				<button class="chip" class:on={preview} onclick={() => (preview = !preview)}>
					{preview ? 'edit' : 'preview'}
				</button>
				<button class="btn primary" disabled={!editable} onclick={save}>
					{saved ? 'Saved \u2713' : 'Save'}
				</button>
				{#if currentId}
					<button class="btn danger" disabled={!editable} onclick={remove}>Delete</button>
				{/if}
			</div>
		</header>
		{#if preview}
			<div class="preview"><Markdown text={body} /></div>
		{:else}
			<textarea
				placeholder={visibility === 'shared'
					? 'Markdown content… readable by every user and every agent.'
					: 'Markdown content… yours alone, and only your agents see it.'}
				readonly={!editable}
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
		/* Set from the drag handle and remembered per browser — see PaneResizer,
		   which also draws the dividing line this used to carry as a border. */
		width: var(--list-width, 290px);
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
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.6rem;
	}
	/* Pane-level control, so unlike the per-folder + button it is visible
	   without hovering — there is nothing to hover over to find it. */
	.collapse-all {
		margin-left: auto;
		background: none;
		border: none;
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: var(--text-lg);
		line-height: 1;
		padding: 0.2rem 0.3rem;
	}
	.collapse-all:hover {
		color: var(--accent);
	}
	.search {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.4rem 0.6rem;
		margin-bottom: 0.6rem;
	}
	.doc-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* Grouping only — a folder holds no permission and nests nowhere. */
	.folder + .folder {
		margin-top: 0.35rem;
	}
	.folder-head {
		display: flex;
		align-items: center;
		gap: 0.2rem;
	}
	.folder-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: var(--text-sm);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		text-align: left;
		padding: 0.35rem 0.2rem 0.2rem;
	}
	.folder-name:hover {
		color: var(--fg);
	}
	.caret {
		font-size: var(--text-xs);
	}
	.count {
		margin-left: auto;
		opacity: 0.6;
		letter-spacing: 0;
	}
	.folder-head .icon {
		background: none;
		border: none;
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-size: var(--text-lg);
		line-height: 1;
		padding: 0.15rem 0.3rem;
		opacity: 0;
	}
	.folder-head:hover .icon {
		opacity: 1;
	}
	.folder-head .icon:hover {
		color: var(--accent);
	}
	.folder-input {
		width: 9rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.3rem 0.5rem;
	}
	.folder-input:focus {
		border-color: var(--accent);
		outline: none;
	}
	.folder-input:disabled {
		opacity: 0.5;
	}
	/* No hover on a touch screen to reveal the per-folder add button. */
	@media (hover: none) {
		.folder-head .icon {
			opacity: 1;
		}
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
		font-size: var(--text-md);
	}
	.vis-badge {
		font-size: var(--text-xs);
		border: 1px solid var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		margin-left: 0.3rem;
		color: var(--accent);
		vertical-align: middle;
	}
	.agent-badge {
		font-size: var(--text-xs);
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		text-transform: uppercase;
	}
	.doc-snippet {
		display: block;
		color: var(--fg-dim);
		font-size: var(--text-sm);
		margin-top: 0.15rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.empty {
		color: var(--fg-dim);
		font-size: var(--text-base);
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
		font-size: var(--text-xl);
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
		font-size: var(--text-lg);
		line-height: 1.6;
		padding: 1rem;
		resize: none;
		outline: none;
	}
	.preview {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		font-size: var(--text-lg);
	}

	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: var(--text-base);
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
		font-size: var(--text-sm);
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
			/* Beats the inline --list-width: this is a slide-over sheet here, not
			   a resizable column. */
			width: auto;
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
