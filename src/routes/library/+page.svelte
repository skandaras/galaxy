<script lang="ts">
	import { onMount } from 'svelte';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import { swipeToClose } from '$lib/list-sheet.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';
	import ListPill from '$lib/components/ListPill.svelte';
	import { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT } from '$lib/library-search';
	import { buildShelf, flattenTree, parentOptions, UNFILED } from '$lib/library-tree';

	interface Doc {
		id: string;
		title: string;
		snippet: string;
		author: 'user' | 'agent';
		/** Null on docs that predate ownership — those stay visible to everyone. */
		ownerId: string | null;
		visibility: 'personal' | 'shared';
		/** Cosmetic grouping for a top-level doc; '' means unfiled. */
		folder: string;
		/** Null is a top-level doc. Anything else hangs under that doc. */
		parentId: string | null;
		updatedAt: number;
		match?: string;
	}

	let docs = $state<Doc[]>([]);
	let query = $state('');
	let currentId = $state<string | null>(null);
	let title = $state('');
	let body = $state('');
	let folder = $state('');
	/** '' is top level, which is what the server reads an empty string as. */
	let parentId = $state('');
	let visibility = $state<'personal' | 'shared'>('personal');
	/**
	 * Per-section and per-node overrides on top of the default, which is shut for
	 * everything except Unfiled — a shelf that opens with every folder expanded
	 * is a wall of documents, and Unfiled is the overflow people actually browse.
	 * A tree node starts shut for the same reason, and more so: a subtree is the
	 * thing whose whole point is that it does not have to be on screen.
	 *
	 * Deliberately not remembered between visits: "collapsed on arrival" is the
	 * point, and a persisted expansion would quietly undo it.
	 */
	let collapsed = $state<Record<string, boolean>>({});
	const isShut = (key: string) => collapsed[key] ?? key !== `folder:${UNFILED}`;

	const sections = $derived(buildShelf(docs));

	/** Existing folder names, so the picker suggests rather than demands. */
	const folders = $derived([...new Set(docs.map((d) => d.folder).filter(Boolean))].sort());

	/** Where this doc may be filed, excluding itself and everything under it. */
	const parents = $derived(parentOptions(docs, currentId));

	/** Shut everything, or open everything once it already is. */
	const allShut = $derived(sections.every((s) => isShut(s.key)));

	/**
	 * Written as an explicit entry per section rather than by clearing the map:
	 * the default is per-key, so "open all" has to say so for each one or
	 * Unfiled would be the only thing that moved.
	 */
	function setAllCollapsed(shut: boolean) {
		collapsed = Object.fromEntries(sections.map((s) => [s.key, shut]));
	}

	/** False for someone else's shared doc: readable, not editable. */
	let editable = $state(true);
	let preview = $state(false);
	let saved = $state(false);
	let listOpen = $state(false);
	/** Anything the server refused — this page had nowhere at all to say so. */
	let error = $state<string | null>(null);
	/**
	 * Whether the document list has arrived, and whether it arrived at all.
	 *
	 * "No documents yet" was shown for loading, empty and failed alike, so a
	 * dropped request read as an empty Library — which for the store the agents
	 * read their context from is the most alarming possible way to be wrong.
	 */
	let listLoaded = $state(false);
	let listFailed = $state(false);

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

	/** Bumped per request, so a stale answer can recognise itself. */
	let searchSeq = 0;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	async function load() {
		const seq = ++searchSeq;
		const url = query.trim() ? `/api/library?q=${encodeURIComponent(query)}` : '/api/library';
		const res = await fetch(url).catch(() => null);
		// A slow answer to an older query must not overwrite a newer one. Every
		// keystroke used to start a request with nothing ordering the replies,
		// which on a phone connection is not a hypothetical race.
		if (seq !== searchSeq) return;
		if (!res?.ok) {
			listFailed = true;
			listLoaded = true;
			return;
		}
		docs = await res.json();
		listFailed = false;
		listLoaded = true;
	}

	/** Typing is not a request. */
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
	}

	function clearSearch() {
		query = '';
		clearTimeout(searchTimer);
		void load();
	}

	/**
	 * The server returns at most SEARCH_LIMIT rows and never said so, which
	 * reads as "that is all there is" rather than "that is all it showed".
	 */
	const capped = $derived(query.trim() !== '' && docs.length >= SEARCH_LIMIT);

	async function open(id: string) {
		const res = await fetch(`/api/library/${id}`);
		if (!res.ok) return;
		const doc = await res.json();
		currentId = doc.meta.id;
		title = doc.meta.title;
		visibility = doc.meta.visibility;
		folder = doc.meta.folder ?? '';
		parentId = doc.meta.parentId ?? '';
		editable = doc.canEdit !== false;
		body = doc.body;
		preview = false;
		listOpen = false;
	}

	/**
	 * `into` pre-files a doc created from a section's own + button: a folder name
	 * for a folder heading, a doc id for a node in a tree.
	 */
	function startNew(into: { folder?: string; parentId?: string } = {}) {
		currentId = null;
		title = '';
		body = '';
		folder = into.folder ?? '';
		parentId = into.parentId ?? '';
		// New docs start personal; sharing is a deliberate act.
		visibility = 'personal';
		editable = true;
		preview = false;
		listOpen = false;
	}

	async function save() {
		if (!title.trim()) return;
		// Always explicit: the editor shows both controls, so what they say is what
		// the person means — an omitted field would mean "leave it where it was".
		const payload = JSON.stringify({ title, content: body, visibility, folder, parentId });
		const init = { headers: { 'content-type': 'application/json' }, body: payload };
		const res = await (currentId
			? fetch(`/api/library/${currentId}`, { method: 'PUT', ...init })
			: fetch('/api/library', { method: 'POST', ...init })
		).catch(() => null);
		// A failed save used to be indistinguishable from a successful one: the
		// button simply went back to reading "Save". In the app's document editor
		// that means somebody keeps typing against a copy the server never took.
		if (!res?.ok) {
			error = 'Could not save this document. Your text is still here — try again.';
			return;
		}
		error = null;
		const doc = await res.json();
		currentId = doc.id;
		saved = true;
		setTimeout(() => (saved = false), 1500);
		await load();
	}

	async function remove() {
		if (!currentId || !confirm(`Delete "${title}"?`)) return;
		const res = await fetch(`/api/library/${currentId}`, { method: 'DELETE' }).catch(
			() => null
		);
		if (!res?.ok) {
			error = 'Could not delete this document.';
			return;
		}
		error = null;
		startNew();
		await load();
	}

	function upload(ev: Event) {
		const file = (ev.target as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = async () => {
			const res = await fetch('/api/library', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: file.name.replace(/\.(md|txt)$/i, ''),
					content: String(reader.result ?? '')
				})
			}).catch(() => null);
			// Same shape as save() above: the file picker resets either way, so a
			// refused upload was a document that simply never appeared.
			if (!res?.ok) {
				error = `Could not upload ${file.name}.`;
				return;
			}
			error = null;
			await load();
		};
		reader.readAsText(file);
		(ev.target as HTMLInputElement).value = '';
	}
</script>

<div class="lib-shell">
	<aside
		class="doc-list page-list"
		class:open={listOpen}
		style={`--list-width:${listPane.width}px`}
		use:swipeToClose={() => (listOpen = false)}
	>
		<div class="list-actions">
			<!-- Wrapped, or the click event arrives as the folder to file it under. -->
			<button class="btn primary" onclick={() => startNew()}>+ New doc</button>
			<label class="btn ghost upload">
				Upload .md
				<input type="file" accept=".md,.txt,text/markdown,text/plain" hidden onchange={upload} />
			</label>
			<!-- Only ever useful when there is grouping to act on, and search
			     replaces the folders with a flat ranked list. -->
			{#if !query.trim() && sections.length > 1}
				<button
					class="collapse-all"
					title={allShut ? 'Expand everything' : 'Collapse everything'}
					aria-label={allShut ? 'Expand everything' : 'Collapse everything'}
					onclick={() => setAllCollapsed(!allShut)}
				>
					{allShut ? '⊞' : '⊟'}
				</button>
			{/if}
		</div>
		<div class="search-row">
			<input class="search" placeholder="Search library…" bind:value={query} oninput={onSearchInput} />
			{#if query}
				<button class="clear" aria-label="Clear search" onclick={clearSearch}>✕</button>
			{/if}
		</div>
		{#snippet docRow(doc: Doc, depth: number, hasChildren: boolean)}
			<li class:selected={currentId === doc.id} style={`--depth:${depth}`}>
				{#if hasChildren}
					<button
						class="node-caret"
						aria-expanded={!isShut(doc.id)}
						title={isShut(doc.id) ? `Show what is under ${doc.title}` : `Hide what is under ${doc.title}`}
						aria-label={isShut(doc.id) ? `Show what is under ${doc.title}` : `Hide what is under ${doc.title}`}
						onclick={() => (collapsed = { ...collapsed, [doc.id]: !isShut(doc.id) })}
					>
						{isShut(doc.id) ? '▸' : '▾'}
					</button>
				{/if}
				<button class="row" class:nested={depth > 0} onclick={() => open(doc.id)}>
					<span class="doc-title">
						{doc.title}
						{#if doc.author === 'agent'}<span class="agent-badge">agent</span>{/if}
						{#if doc.visibility === 'shared'}<span class="vis-badge">shared</span>{/if}
					</span>
					<span class="doc-snippet">{doc.match ?? doc.snippet}</span>
				</button>
				<button
					class="icon node-add"
					title="New doc under {doc.title}"
					aria-label="New doc under {doc.title}"
					onclick={() => startNew({ parentId: doc.id })}>+</button
				>
			</li>
		{/snippet}

		{#if capped}
			<p class="capped">First {SEARCH_LIMIT} matches. Narrow the search to see others.</p>
		{/if}
		{#if !docs.length}
			<ul>
				<li class="empty">
					{#if !listLoaded}
						Loading…
					{:else if listFailed}
						Could not load your documents.
					{:else}
						No documents{query ? ' match' : ' yet'}.
					{/if}
				</li>
			</ul>
		{:else if query.trim()}
			<!-- Results are ranked by relevance; folders would fight that ordering. -->
			<ul>
				{#each docs as doc (doc.id)}{@render docRow(doc, 0, false)}{/each}
			</ul>
		{:else}
			{#each sections as section (section.key)}
				<section class="folder">
					{#if section.kind === 'tree'}
						<!-- No heading: a tree's root is a document you can open, so it is a
						     row with a caret rather than a label above the rows. -->
						<ul>
							{#each flattenTree(section.nodes, isShut) as row (row.doc.id)}
								{@render docRow(row.doc, row.depth, row.hasChildren)}
							{/each}
						</ul>
					{:else}
						<div class="folder-head">
							<button
								class="folder-name"
								aria-expanded={!isShut(section.key)}
								onclick={() =>
									(collapsed = { ...collapsed, [section.key]: !isShut(section.key) })}
							>
								<span class="caret">{isShut(section.key) ? '▸' : '▾'}</span>
								{section.name}
								<span class="count">{section.count}</span>
							</button>
							{#if section.name !== UNFILED}
								<button
									class="icon"
									title="New doc in {section.name}"
									aria-label="New doc in {section.name}"
									onclick={() => startNew({ folder: section.name })}>+</button
								>
							{/if}
						</div>
						{#if !isShut(section.key)}
							<ul>
								{#each section.docs as doc (doc.id)}{@render docRow(doc, 0, false)}{/each}
							</ul>
						{/if}
					{/if}
				</section>
			{/each}
		{/if}
	</aside>

	<PaneResizer pane={listPane} label="Resize the document list" />

	<section class="editor">
		<div class="page-actions">
			<ListPill bind:open={listOpen} label="Documents" count={docs.length} />
			<button class="btn primary" onclick={() => startNew()}>+ New</button>
			<label class="btn ghost upload">
				Upload
				<input type="file" accept=".md,.txt,text/markdown,text/plain" hidden onchange={upload} />
			</label>
		</div>
		<header>
			<input class="title" placeholder="Document title" bind:value={title} />
			<select
				class="folder-input parent-input"
				title="File this doc under another one. A doc inside a tree costs the agents' index nothing; a new top-level doc costs it a line on every turn."
				aria-label="Filed under"
				disabled={!editable}
				bind:value={parentId}
			>
				<option value="">Top level</option>
				{#each parents as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
			</select>
			<!-- Only a top-level doc has a shelf label: inside a tree its place is
			     its parent, and showing both would be two answers to one question. -->
			{#if !parentId}
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
			{/if}
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
		{#if error}<p class="error" role="alert">{error}</p>{/if}
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
	.error {
		color: var(--danger);
		font-size: var(--text-sm);
		margin: 0 0.75rem;
	}
	.doc-list {
		flex-shrink: 0;
		padding: 0.75rem;
		box-sizing: border-box;
		overflow-y: auto;
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap);
		min-width: var(--tap);
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
	}
	.doc-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* Depth shows as indentation alone: a tree row is a document like any other,
	   and giving nested rows their own chrome made the shelf read as two lists. */
	.doc-list li {
		position: relative;
	}
	.doc-list li .row.nested {
		padding-left: calc(0.75rem + var(--depth, 0) * 0.85rem);
	}
	.node-caret {
		position: absolute;
		left: calc(var(--depth, 0) * 0.85rem - 0.1rem);
		top: 0.5rem;
		z-index: 1;
		padding: 0 0.15rem;
		border: 0;
		background: none;
		color: var(--muted);
		font-size: 0.7rem;
		line-height: 1;
		cursor: pointer;
	}
	.node-caret:hover {
		color: var(--fg);
	}
	/* Same treatment as the folder heading's + button, which is also hover-only
	   on a pointer and always present on a touch screen. */
	.node-add {
		position: absolute;
		right: 0.35rem;
		top: 0.45rem;
		opacity: 0;
	}
	.doc-list li:hover .node-add,
	.node-add:focus-visible {
		opacity: 1;
	}

	/* Grouping only — a folder holds no permission and nests nowhere. */
	.folder + .folder {
		margin-top: 0.35rem;
	}
	.folder-head {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		/* The shelf is the thing being scrolled, so the heading of whatever you
		   are inside should still be readable while you scroll it — as the
		   cortex panel's group headings already are. */
		position: sticky;
		top: 0;
		z-index: var(--z-base);
		background: var(--bg-pane);
	}
	.search-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.6rem;
	}
	.clear {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap);
		min-width: var(--tap);
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: var(--text-md);
	}
	.clear:hover {
		color: var(--fg);
	}
	.capped {
		margin: 0 0 0.5rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
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
	}
	.preview {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		font-size: var(--text-lg);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap);
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
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
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

	/* Set from the drag handle and remembered per browser — see PaneResizer, which
	   also draws the dividing line this used to carry as a border. Desktop only:
	   below the breakpoint this pane is the off-canvas sheet the layout draws,
	   sized from an inset. See the same block on the chat page for the failure
	   that moved it here. */
	@media (min-width: 721px) {
		.doc-list {
			width: var(--list-width, 290px);
		}
	}
</style>
