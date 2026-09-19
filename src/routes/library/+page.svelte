<script lang="ts">
	import { onMount } from 'svelte';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import { swipeToClose } from '$lib/list-sheet.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';
	import ListPill from '$lib/components/ListPill.svelte';
	import { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT } from '$lib/library-search';
	import { buildShelf, flattenTree, parentOptions, UNFILED } from '$lib/library-tree';
	import {
		AUTOSAVE_IDLE_MS,
		AUTOSAVE_MAX_MS,
		hasContent,
		retryDelay,
		titleForNew
	} from '$lib/library-autosave';

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
	let listOpen = $state(false);

	/**
	 * Autosave.
	 *
	 * There was a Save button, and a document editor with a Save button loses
	 * work — someone types for ten minutes, closes the tab, and the text was only
	 * ever in the browser. Nothing else in this app autosaved, so the shape here
	 * is the one the search box already uses (debounce, and a sequence number so
	 * a slow answer cannot overwrite a newer one) with three additions: a ceiling
	 * for somebody who never pauses, a single-flight guard so two creations
	 * cannot race, and a version check so two writers cannot flatten each other.
	 */
	type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';
	let saveState = $state<SaveState>('idle');
	/** What the server currently holds, as the same string a change produces. */
	let savedSnapshot = $state('');
	/** Kept so clearing the title field cannot rename a document to its own id. */
	let savedTitle = $state('');
	/** The row version this editor is working from; sent back to detect a clash. */
	let baseUpdatedAt = $state<string | null>(null);
	let failures = 0;
	let saveSeq = 0;
	let inFlight = false;
	let queued = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * The title a save would actually send.
	 *
	 * Clearing the field on a document that exists means "leave it called what it
	 * is called", so the snapshot has to read it the same way the request does —
	 * otherwise emptying the box makes the editor permanently dirty against a
	 * name the server already holds.
	 */
	const effectiveTitle = () => (currentId ? title.trim() || savedTitle : title.trim());

	/** Everything a save writes. A change to any of it is a change. */
	const snapshotOf = () =>
		JSON.stringify({ title: effectiveTitle(), body, folder, parentId, visibility });
	const dirty = $derived(snapshotOf() !== savedSnapshot);

	/**
	 * Deliberately quiet. "Unsaved" while someone types is a flicker that resolves
	 * itself a second later, so the resting state stays put until a request is
	 * actually in the air — which is what Google Docs does and why it reads as
	 * calm rather than nervous.
	 */
	const statusText = $derived(
		!editable
			? ''
			: saveState === 'saving'
				? 'Saving…'
				: saveState === 'conflict'
					? 'Changed elsewhere'
					: saveState === 'failed'
						? 'Couldn’t save — retrying'
						: currentId
							? 'Saved'
							: ''
	);
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

	onMount(() => {
		void load();

		const onKey = (e: KeyboardEvent) => {
			// People press this reflexively in anything shaped like a document, and
			// the browser's own Save dialog is a bad answer to it. It flushes rather
			// than doing anything a plain wait would not.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				void flush();
			}
		};
		/**
		 * The last resort, and the only one that survives a tab closing mid-word.
		 *
		 * `keepalive` is what lets the request outlive the page — an ordinary fetch
		 * started here is cancelled with everything else. `pagehide` rather than
		 * `beforeunload`, which a phone browser may never fire at all.
		 */
		const onHide = () => {
			if (!editable || !dirty || saveState === 'conflict') return;
			if (!currentId && !hasContent(title, body)) return;
			const { url, init } = buildRequest();
			void fetch(url, { ...init, keepalive: true }).catch(() => {});
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('pagehide', onHide);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('pagehide', onHide);
			clearTimers();
		};
	});

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
		// The outgoing document's last edit has to land before its state is gone.
		await flush();
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
		settle(doc.meta.title, doc.meta.updatedAt ?? null);
	}

	/** Take what is on screen as what the server holds, and stop any pending write. */
	function settle(name: string, version: string | null) {
		clearTimers();
		saveSeq += 1;
		queued = false;
		failures = 0;
		savedSnapshot = snapshotOf();
		savedTitle = name;
		baseUpdatedAt = version;
		saveState = 'idle';
		error = null;
	}

	/**
	 * `into` pre-files a doc created from a section's own + button: a folder name
	 * for a folder heading, a doc id for a node in a tree.
	 */
	async function startNew(into: { folder?: string; parentId?: string } = {}) {
		await flush();
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
		// Empty is exactly what the server holds for a document that does not
		// exist, so nothing is dirty and nothing will be written until something
		// is typed — which is what stops New leaving a shell behind.
		settle('', null);
	}

	function clearTimers() {
		clearTimeout(idleTimer);
		clearTimeout(ceilingTimer);
		clearTimeout(retryTimer);
		idleTimer = ceilingTimer = retryTimer = undefined;
	}

	/** Called from every editable field. Typing is not a request; this arms one. */
	function touch() {
		if (!editable || saveState === 'conflict') return;
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => void flush(), AUTOSAVE_IDLE_MS);
		// Armed once per unsaved stretch rather than per keystroke: re-arming it
		// each time would make it a second idle timer with a bigger number, and
		// someone typing without pause — the person with most to lose — would
		// never reach either.
		if (ceilingTimer === undefined) {
			ceilingTimer = setTimeout(() => void flush(), AUTOSAVE_MAX_MS);
		}
	}

	/** The request a save makes, shared so the page-exit path cannot drift from it. */
	function buildRequest(): { url: string; init: RequestInit; name: string; sending: string } {
		const creating = !currentId;
		// An empty title on a document that exists means "leave it called what it
		// is called" — never the id, which is what the server would fall back to.
		const name = creating
			? titleForNew(title, body, docs.map((d) => d.title))
			: title.trim() || savedTitle;
		return {
			url: creating ? '/api/library' : `/api/library/${currentId}`,
			init: {
				method: creating ? 'POST' : 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: name,
					content: body,
					visibility,
					folder,
					parentId,
					...(creating ? {} : { baseUpdatedAt })
				})
			},
			name,
			// Built from the resolved name rather than the field, so that marking the
			// editor clean afterwards compares like with like — including the first
			// save of a document whose title was derived rather than typed.
			sending: JSON.stringify({ title: name, body, folder, parentId, visibility })
		};
	}

	/**
	 * Write once, if there is anything to write.
	 *
	 * Single-flight: a save asked for while one is in the air queues instead of
	 * starting, because two concurrent POSTs would each create a document and the
	 * second would inherit none of the first one's id.
	 */
	async function flush(): Promise<void> {
		clearTimers();
		if (!editable || saveState === 'conflict' || !dirty) return;
		// A document that does not exist yet has to have earned one. Pressing New,
		// or New under something, must not leave an empty shell on the shelf.
		if (!currentId && !hasContent(title, body)) return;
		if (inFlight) {
			queued = true;
			return;
		}
		inFlight = true;
		try {
			await writeOnce();
		} finally {
			inFlight = false;
		}
		if (queued) {
			queued = false;
			await flush();
		}
	}

	async function writeOnce(): Promise<void> {
		const seq = ++saveSeq;
		const { url, init, name, sending } = buildRequest();
		saveState = 'saving';
		const res = await fetch(url, init).catch(() => null);
		// Switching documents mid-request must not write this answer into the one
		// now on screen — the same rule the search box follows for its replies.
		if (seq !== saveSeq) return;

		if (res?.status === 409) {
			saveState = 'conflict';
			error =
				'This document changed somewhere else since you opened it. Your text is still here — reloading replaces it with the saved version.';
			return;
		}
		if (!res?.ok) {
			// A failed save used to be indistinguishable from a successful one: the
			// button simply went back to reading "Save". In a document editor that
			// means somebody keeps typing against a copy the server never took.
			failures += 1;
			saveState = 'failed';
			retryTimer = setTimeout(() => void flush(), retryDelay(failures - 1));
			return;
		}

		const doc = await res.json().catch(() => null);
		// A 200 carrying something that is not a document is not a save. Treating
		// it as one would mark the editor clean against a row that may not exist.
		if (!doc?.id) {
			failures += 1;
			saveState = 'failed';
			retryTimer = setTimeout(() => void flush(), retryDelay(failures - 1));
			return;
		}
		if (seq !== saveSeq) return;
		currentId = doc.id;
		savedSnapshot = sending;
		savedTitle = name;
		baseUpdatedAt = doc.updatedAt ?? null;
		failures = 0;
		error = null;
		saveState = 'saved';
		// Patched in place rather than reloading the list: at one save a second a
		// second round trip per burst is most of the cost of autosaving at all.
		// Skipped while searching, where the order is relevance and moving the
		// edited row to the front would fight it.
		if (!query.trim()) docs = [doc, ...docs.filter((d: Doc) => d.id !== doc.id)];
	}

	/** Discard what is on screen and take the version that won. */
	async function reloadConflicted() {
		if (!currentId) return;
		const id = currentId;
		saveState = 'idle';
		error = null;
		savedSnapshot = snapshotOf();
		await open(id);
	}

	async function remove() {
		if (!currentId || !confirm(`Delete "${title}"?`)) return;
		// Nothing pending may re-create what is about to be deleted.
		clearTimers();
		saveSeq += 1;
		queued = false;
		const res = await fetch(`/api/library/${currentId}`, { method: 'DELETE' }).catch(
			() => null
		);
		if (!res?.ok) {
			error = 'Could not delete this document.';
			return;
		}
		error = null;
		await startNew();
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
				<button class="row" onclick={() => open(doc.id)}>
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
				<section class="folder" class:tree={section.kind === 'tree'}>
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
			<input
				class="title"
				placeholder="Document title"
				disabled={!editable}
				bind:value={title}
				oninput={touch}
				onblur={() => {
					// A document that exists is never nameless: clearing the field and
					// walking away would otherwise leave the shelf showing one name and
					// the editor showing none.
					if (currentId && !title.trim()) title = savedTitle;
				}}
			/>
			<select
				class="folder-input parent-input"
				title="File this doc under another one. A doc inside a tree costs the agents' index nothing; a new top-level doc costs it a line on every turn."
				aria-label="Filed under"
				disabled={!editable}
				bind:value={parentId}
				onchange={touch}
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
					oninput={touch}
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
					onclick={() => {
						visibility = visibility === 'shared' ? 'personal' : 'shared';
						touch();
					}}
				>
					{visibility === 'shared' ? '\u25c9 Widely viewable' : '\u25cc Personal'}
				</button>
				<button class="chip" class:on={preview} onclick={() => (preview = !preview)}>
					{preview ? 'edit' : 'preview'}
				</button>
				<!-- No Save button: the editor writes as you type. The status is quiet
				     on purpose, and only ever says something that is true right now. -->
				{#if statusText}
					<span
						class="save-state"
						class:alarm={saveState === 'failed' || saveState === 'conflict'}
						aria-live="polite">{statusText}</span
					>
				{/if}
				{#if currentId}
					<button class="btn danger" disabled={!editable} onclick={remove}>Delete</button>
				{/if}
			</div>
		</header>
		{#if error}
			<p class="error" role="alert">
				{error}
				{#if saveState === 'conflict'}
					<button class="chip" onclick={reloadConflicted}>Discard mine and reload</button>
				{/if}
			</p>
		{/if}
		{#if preview}
			<div class="preview"><Markdown text={body} /></div>
		{:else}
			<textarea
				placeholder={visibility === 'shared'
					? 'Markdown content… readable by every user and every agent.'
					: 'Markdown content… yours alone, and only your agents see it.'}
				readonly={!editable}
				bind:value={body}
				oninput={touch}
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
	/* The caret's gutter, reserved on every row in a tree so titles line up
	   whether or not a row has children. Scoped to trees: under a folder heading
	   nothing ever has a caret, and indenting those rows for one would spend a
	   sixth of a 290px pane on empty space. */
	.tree .row {
		padding-left: calc(1.5rem + var(--depth, 0) * 0.9rem);
	}
	.node-caret,
	.node-add {
		position: absolute;
		/* Stretched to the row rather than offset into it: a row is two lines when
		   it has a snippet and one when it does not, so any fixed `top` is centred
		   for one of them and wrong for the other. */
		top: 0;
		bottom: 0;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 0;
		background: none;
		color: var(--fg-dim);
		font-family: inherit;
		line-height: 1;
		cursor: pointer;
	}
	/*
	 * The glow goes on the glyph, not around it.
	 *
	 * themeCss gives every button a hover glow as a box-shadow, and a box-shadow
	 * follows the border box — so on a bare `+` it draws a glowing rectangle with
	 * nothing in it but the corners. That box was the complaint. Same fix as the
	 * chat page's rate buttons, which trade it for a drop-shadow off the SVG's
	 * own alpha; for a text glyph the equivalent is text-shadow.
	 */
	.node-caret:hover,
	.node-add:hover {
		box-shadow: none;
		color: var(--accent);
		text-shadow: 0 0 var(--glow-size) var(--glow);
	}
	.node-caret {
		left: calc(var(--depth, 0) * 0.9rem);
		/* Height comes from the row and clears --tap comfortably. Width does not,
		   and deliberately: the caret lives in an indent gutter in a pane that
		   starts at 290px, and the chat sidebar already settled this trade — tall
		   to the floor, not wide to it, where the horizontal room is not there. */
		width: 1.5rem;
		font-size: var(--text-md);
	}
	.node-add {
		right: 0;
		width: var(--tap);
		font-size: var(--text-xl);
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
	.save-state {
		align-self: center;
		color: var(--fg-dim);
		font-size: var(--text-sm);
		/* Enough to hold "Saving…" and "Saved" at the same width, so the resting
		   state does not nudge the buttons beside it on every keystroke burst. */
		min-width: 4.5rem;
		text-align: right;
	}
	.save-state.alarm {
		color: var(--danger);
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
	/* Reveal-on-hover hides a control permanently on a touch screen, where there
	   is no hover to reveal it with — the same reason CodeBlock and the chat row
	   actions unhide theirs here. The per-row + shipped without this block and
	   was unreachable on a phone. */
	@media (hover: none) {
		.folder-head .icon,
		.node-add {
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
		/* Right side reserved for the + that overlays it, so a long title
		   ellipsises before it reaches the button rather than under it. */
		padding: 0.45rem var(--tap) 0.45rem 0.5rem;
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
