<script lang="ts">
	import { onMount } from 'svelte';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import { swipeToClose } from '$lib/list-sheet.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';
	import ListPill from '$lib/components/ListPill.svelte';
	import { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT } from '$lib/library-search';
	import {
		buildShelf,
		filingDest,
		filingOptions,
		filingValue,
		flattenTree,
		UNFILED
	} from '$lib/library-tree';
	import { dropDestination, HOLD_MS, MOVE_TOLERANCE, type DropTarget } from '$lib/library-drag';
	import { movedBeyond } from '$lib/board-drag';
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
		/** Which folder it is in; '' is Unfiled. A nested doc inherits its root's. */
		folder: string;
		/** Null is a root of its folder. Anything else hangs under that doc. */
		parentId: string | null;
		updatedAt: number;
		match?: string;
	}

	let docs = $state<Doc[]>([]);
	/**
	 * Folder names from the server rather than from the docs on screen, because a
	 * folder with nothing in it exists and a shelf built from documents alone
	 * cannot know about it.
	 */
	let folders = $state<string[]>([]);
	let query = $state('');
	let currentId = $state<string | null>(null);
	let title = $state('');
	let body = $state('');
	/**
	 * Where the doc is filed, as the picker's own value: `folder:<name>` or
	 * `doc:<id>`, with Unfiled as the empty label.
	 *
	 * One value rather than the folder box and parent picker this replaced.
	 * Those were two controls answering one question, and filling in both said
	 * nothing about which won — the answer was buried in saveDoc.
	 */
	let filing = $state(filingValue({ folder: '', parentId: null }));
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
	const setShut = (key: string, shut: boolean) => (collapsed = { ...collapsed, [key]: shut });

	const sections = $derived(buildShelf(docs, folders));

	/** Every place this doc could be filed: a folder, or inside another doc. */
	const filings = $derived(filingOptions(docs, folders, currentId));
	const folderChoices = $derived(filings.filter((o) => o.kind === 'folder'));
	const docChoices = $derived(filings.filter((o) => o.kind === 'doc'));

	/**
	 * The doc this one sits under, named from the breadcrumb the server sends.
	 *
	 * The options are built from the list on screen, and a search replaces that
	 * list with the matches — so opening a nested result can leave the picker
	 * with no option for where the document actually is. A select whose value
	 * matches nothing shows blank, which reads as "nowhere".
	 */
	let parentLabel = $state('');
	const strandedAt = $derived(
		filing.startsWith('doc:') && !filings.some((o) => o.value === filing)
			? parentLabel || 'Where it is now'
			: ''
	);

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
	/**
	 * A document opens as the thing it is rather than as its source. Editing is
	 * the Edit button, or a double-click in the text.
	 *
	 * False to start with, because arriving at the page with nothing open is the
	 * same situation as pressing New: there is nothing to read, and the first
	 * thing anyone does is type.
	 */
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
		JSON.stringify({ title: effectiveTitle(), body, filing, visibility });
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
		void loadFolders();

		const onKey = (e: KeyboardEvent) => {
			// People press this reflexively in anything shaped like a document, and
			// the browser's own Save dialog is a bad answer to it. It flushes rather
			// than doing anything a plain wait would not.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				void flush();
			}
			// Escape lets go of a drag without filing anything, which is the only
			// way out once a finger is already moving.
			if (e.key === 'Escape' && (drag || pending)) abandon();
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
			// The drag's listeners are on the window as well, and a preventDefault
			// left attached would kill every click in the app for the session.
			detach();
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

	/**
	 * Its own request, and not part of `load`: searching runs one of those per
	 * debounced keystroke, and the folder list does not change while you type.
	 */
	async function loadFolders() {
		const res = await fetch('/api/library/folders').catch(() => null);
		if (res?.ok) folders = await res.json();
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

	/** What the server said it refused, when it said anything. */
	async function refusal(res: Response | null, fallback: string): Promise<string> {
		const said = await res?.json().catch(() => null);
		return typeof said?.message === 'string' ? said.message : fallback;
	}

	/** A drag that ends on a row produces a click on it; opening the document you
	 * have just moved is not what the gesture asked for. */
	function openRow(id: string) {
		if (justDragged) {
			justDragged = false;
			return;
		}
		void open(id);
	}

	async function open(id: string) {
		// The outgoing document's last edit has to land before its state is gone.
		await flush();
		const res = await fetch(`/api/library/${id}`);
		if (!res.ok) return;
		const doc = await res.json();
		currentId = doc.meta.id;
		title = doc.meta.title;
		visibility = doc.meta.visibility;
		filing = filingValue({ folder: doc.meta.folder ?? '', parentId: doc.meta.parentId ?? null });
		parentLabel = (doc.path ?? []).slice(0, -1).pop() ?? '';
		editable = doc.canEdit !== false;
		body = doc.body;
		preview = true;
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
	 * `place` pre-files a doc created from a section's or a row's own + button: a
	 * picker value, so a folder heading and a document row say where in the same
	 * language the editor's own control does.
	 */
	async function startNew(place?: string) {
		await flush();
		currentId = null;
		title = '';
		body = '';
		filing = place ?? filingValue({ folder: '', parentId: null });
		parentLabel = '';
		// New docs start personal; sharing is a deliberate act.
		visibility = 'personal';
		editable = true;
		// The one document that does not open in preview: there is nothing in it
		// to read, and the first thing anybody does with it is type.
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
		const dest = filingDest(filing);
		// A folder is also an instruction to come out of whatever it was nested
		// in, and the server reads an empty parentId as exactly that. Sending the
		// folder alone would leave a nested doc nested.
		const place =
			'parentId' in dest ? { parentId: dest.parentId } : { folder: dest.folder, parentId: '' };
		return {
			url: creating ? '/api/library' : `/api/library/${currentId}`,
			init: {
				method: creating ? 'POST' : 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: name,
					content: body,
					visibility,
					...place,
					...(creating ? {} : { baseUpdatedAt })
				})
			},
			name,
			// Built from the resolved name rather than the field, so that marking the
			// editor clean afterwards compares like with like — including the first
			// save of a document whose title was derived rather than typed.
			sending: JSON.stringify({ title: name, body, filing, visibility })
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

	// --- folders -------------------------------------------------------------

	/**
	 * The name being typed into, or null when the field is shut.
	 *
	 * An inline field rather than `prompt()`, because the name can be refused —
	 * a duplicate, or Unfiled — and a browser dialog has nowhere to say why.
	 */
	let newFolder = $state<string | null>(null);
	/** The folder being renamed, and what it is being renamed to. */
	let renaming = $state<string | null>(null);
	let renameTo = $state('');
	let folderError = $state<string | null>(null);

	async function makeFolder() {
		const name = (newFolder ?? '').trim();
		if (!name) {
			newFolder = null;
			folderError = null;
			return;
		}
		const res = await fetch('/api/library/folders', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name })
		}).catch(() => null);
		if (!res?.ok) {
			folderError = await refusal(res, 'Could not make that folder.');
			return;
		}
		const made = await res.json();
		newFolder = null;
		folderError = null;
		await loadFolders();
		// Open it: a new folder that arrives shut looks like nothing happened.
		setShut(`folder:${made.name}`, false);
	}

	async function renameFolderTo(from: string) {
		const name = renameTo.trim();
		if (!name || name === from) {
			renaming = null;
			folderError = null;
			return;
		}
		const res = await fetch(`/api/library/folders/${encodeURIComponent(from)}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name })
		}).catch(() => null);
		if (!res?.ok) {
			folderError = await refusal(res, 'Could not rename that folder.');
			return;
		}
		renaming = null;
		folderError = null;
		await refile();
	}

	async function dropFolder(name: string) {
		if (!confirm(`Delete the folder "${name}"? Its documents move to ${UNFILED}.`)) return;
		const res = await fetch(`/api/library/folders/${encodeURIComponent(name)}`, {
			method: 'DELETE'
		}).catch(() => null);
		if (!res?.ok) {
			folderError = await refusal(res, 'Could not delete that folder.');
			return;
		}
		folderError = null;
		await refile();
	}

	/**
	 * Take the shelf again after something moved on it, and bring the open
	 * document's own filing with it.
	 *
	 * Without the second half, renaming the folder the open document is in would
	 * leave the editor holding the old label — and its next autosave would write
	 * that label back, re-creating the folder that was just renamed away.
	 */
	async function refile() {
		await Promise.all([load(), loadFolders()]);
		const mine = docs.find((d) => d.id === currentId);
		if (!mine) return;
		filing = filingValue(mine);
		// Only the filing field of the snapshot: the rest of it is what the server
		// holds, and rebuilding the whole thing from the screen would mark unsaved
		// typing as saved.
		const held = JSON.parse(savedSnapshot || '{}');
		savedSnapshot = JSON.stringify({ ...held, filing });
	}

	// --- press and hold to re-file a document ---------------------------------

	type Pending = { id: string; x: number; y: number; el: HTMLElement };
	let pending: Pending | null = null;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let drag = $state<{
		id: string;
		title: string;
		at: { x: number; y: number };
		grab: { x: number; y: number };
		width: number;
		target: DropTarget;
	} | null>(null);
	/** Set while a drag is live, and consumed by the click that ends it. */
	let justDragged = false;

	/** What the drop under the pointer would ask for, and null when it asks nothing. */
	const landing = $derived(drag ? dropDestination(docs, drag.id, drag.target) : null);
	const overDoc = (id: string) =>
		!!landing && !!drag?.target && 'docId' in drag.target && drag.target.docId === id;
	const overFolder = (name: string) =>
		!!landing && !!drag?.target && 'folder' in drag.target && drag.target.folder === name;

	function onRowPointerDown(e: PointerEvent, doc: Doc) {
		// A secondary click is never a drag, and a search result has no shelf to
		// be dragged around — the list is ranked, not filed.
		if (e.button !== 0 || query.trim()) return;
		justDragged = false;
		pending = { id: doc.id, x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement };
		holdTimer = setTimeout(() => beginDrag(doc.title), HOLD_MS);
		window.addEventListener('pointermove', onPointerMove, { passive: false });
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', abandon);
	}

	function beginDrag(name: string) {
		if (!pending) return;
		const rect = pending.el.getBoundingClientRect();
		drag = {
			id: pending.id,
			title: name,
			at: { x: pending.x, y: pending.y },
			grab: { x: pending.x - rect.left, y: pending.y - rect.top },
			width: rect.width,
			target: null
		};
		justDragged = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag) {
			// Still deciding. Movement before the hold fires means the person is
			// clicking or scrolling, not dragging.
			if (pending && movedBeyond(pending, { x: e.clientX, y: e.clientY }, MOVE_TOLERANCE)) {
				abandon();
			}
			return;
		}
		// Holds the page still under a finger once the drag is real.
		e.preventDefault();
		drag = { ...drag, at: { x: e.clientX, y: e.clientY }, target: targetAt(e.clientX, e.clientY) };
	}

	/** The row or folder heading under the pointer, whichever is nearer. */
	function targetAt(x: number, y: number): DropTarget {
		const el = document.elementFromPoint(x, y);
		const row = el?.closest<HTMLElement>('[data-doc]');
		if (row?.dataset.doc) return { docId: row.dataset.doc };
		const head = el?.closest<HTMLElement>('[data-folder]');
		return head?.dataset.folder ? { folder: head.dataset.folder } : null;
	}

	function onPointerUp() {
		if (!drag) return abandon();
		const { id } = drag;
		const dest = landing;
		detach();
		drag = null;
		if (dest) void moveTo(id, dest);
	}

	/** Give up on the gesture entirely — a scroll, a cancelled touch, Escape. */
	function abandon() {
		detach();
		drag = null;
	}

	function detach() {
		clearTimeout(holdTimer);
		pending = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', abandon);
	}

	async function moveTo(id: string, dest: { parentId: string } | { folder: string }) {
		const res = await fetch(`/api/library/${id}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(dest)
		}).catch(() => null);
		if (!res?.ok) {
			error = await refusal(res, 'Could not move that document.');
			return;
		}
		error = null;
		// Open where it landed, or the row it was just dragged into vanishes into
		// something shut and the move reads as a delete. Both levels: the doc it
		// went under, and the folder that doc is in.
		if ('parentId' in dest) {
			setShut(dest.parentId, false);
			const under = docs.find((d) => d.id === dest.parentId);
			if (under) setShut(`folder:${under.folder || UNFILED}`, false);
		} else {
			setShut(`folder:${dest.folder || UNFILED}`, false);
		}
		await refile();
	}
</script>

<div class="lib-shell">
	<aside
		class="doc-list page-list"
		class:open={listOpen}
		class:dragging={!!drag}
		style={`--list-width:${listPane.width}px`}
		use:swipeToClose={() => {
			// A row dragged leftwards is not a swipe to close the sheet, which is
			// what the same gesture means everywhere else on this pane.
			if (!drag) listOpen = false;
		}}
	>
		<div class="list-actions">
			<!-- Wrapped, or the click event arrives as the place to file it under. -->
			<button class="btn primary" onclick={() => startNew()}>+ New doc</button>
			<button
				class="btn ghost"
				onclick={() => {
					newFolder = '';
					folderError = null;
				}}>+ Folder</button
			>
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
		{#if newFolder !== null}
			<div class="folder-new">
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="search"
					placeholder="Folder name"
					autofocus
					bind:value={newFolder}
					onkeydown={(e) => {
						if (e.key === 'Enter') void makeFolder();
						if (e.key === 'Escape') {
							newFolder = null;
							folderError = null;
						}
					}}
				/>
				<button class="btn primary" onclick={() => void makeFolder()}>Make</button>
			</div>
		{/if}
		{#if folderError}
			<p class="capped alarm" role="alert">{folderError}</p>
		{/if}
		<div class="search-row">
			<input class="search" placeholder="Search library…" bind:value={query} oninput={onSearchInput} />
			{#if query}
				<button class="clear" aria-label="Clear search" onclick={clearSearch}>✕</button>
			{/if}
		</div>
		{#snippet docRow(doc: Doc, depth: number, hasChildren: boolean)}
			<li
				class:selected={currentId === doc.id}
				class:over={overDoc(doc.id)}
				class:lifted={drag?.id === doc.id}
				style={`--depth:${depth}`}
				data-doc={doc.id}
			>
				{#if hasChildren}
					<button
						class="node-caret"
						aria-expanded={!isShut(doc.id)}
						title={isShut(doc.id) ? `Show what is under ${doc.title}` : `Hide what is under ${doc.title}`}
						aria-label={isShut(doc.id) ? `Show what is under ${doc.title}` : `Hide what is under ${doc.title}`}
						onclick={() => setShut(doc.id, !isShut(doc.id))}
					>
						{isShut(doc.id) ? '▸' : '▾'}
					</button>
				{/if}
				<button
					class="row"
					onpointerdown={(e) => onRowPointerDown(e, doc)}
					onclick={() => openRow(doc.id)}
				>
					<span class="doc-title">
						<span class="doc-name">{doc.title}</span>
						<!-- Right-aligned as a group, so the tags line up down the pane
						     however long the titles beside them are. -->
						<span class="badges">
							{#if doc.author === 'agent'}<span class="badge">agent</span>{/if}
							{#if doc.visibility === 'shared'}<span class="badge">shared</span>{/if}
						</span>
					</span>
					<span class="doc-snippet">{doc.match ?? doc.snippet}</span>
				</button>
				<button
					class="icon node-add"
					title="New doc under {doc.title}"
					aria-label="New doc under {doc.title}"
					onclick={() => startNew(`doc:${doc.id}`)}>+</button
				>
			</li>
		{/snippet}

		{#if capped}
			<p class="capped">First {SEARCH_LIMIT} matches. Narrow the search to see others.</p>
		{/if}
		{#if !listLoaded}
			<ul>
				<li class="empty">Loading…</li>
			</ul>
		{:else if listFailed}
			<!-- Three states that all used to read "No documents yet", which for the
			     store the agents take their context from is the most alarming
			     possible way to be wrong. -->
			<ul>
				<li class="empty">Could not load your documents.</li>
			</ul>
		{:else if query.trim()}
			<!-- Results are ranked by relevance; folders would fight that ordering. -->
			<ul>
				{#if !docs.length}
					<li class="empty">No documents match.</li>
				{/if}
				{#each docs as doc (doc.id)}{@render docRow(doc, 0, false)}{/each}
			</ul>
		{:else}
			{#each sections as section (section.key)}
				<!-- The whole section takes a drop, not only its heading: aiming at
				     the one row of text an empty folder has is a poor target, and
				     the gap under the last row is plainly inside the folder. A row
				     inside it still wins, being the nearer thing under the pointer. -->
				<section class="folder" class:nested={section.nested} data-folder={section.name}>
					<div class="folder-head" class:over={overFolder(section.name)}>
						{#if renaming === section.name}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								class="search rename"
								autofocus
								bind:value={renameTo}
								onkeydown={(e) => {
									if (e.key === 'Enter') void renameFolderTo(section.name);
									if (e.key === 'Escape') {
										renaming = null;
										folderError = null;
									}
								}}
								onblur={() => void renameFolderTo(section.name)}
							/>
						{:else}
							<button
								class="folder-name"
								aria-expanded={!isShut(section.key)}
								onclick={() => setShut(section.key, !isShut(section.key))}
							>
								<span class="caret">{isShut(section.key) ? '▸' : '▾'}</span>
								{section.name}
								<span class="count">{section.count}</span>
							</button>
							<button
								class="icon"
								title="New doc in {section.name}"
								aria-label="New doc in {section.name}"
								onclick={() =>
									startNew(`folder:${section.name === UNFILED ? '' : section.name}`)}>+</button
							>
							<!-- Unfiled is the overflow every shelf has rather than one
							     somebody made, so it is not theirs to rename or remove. -->
							{#if section.name !== UNFILED}
								<button
									class="icon"
									title="Rename {section.name}"
									aria-label="Rename {section.name}"
									onclick={() => {
										renaming = section.name;
										renameTo = section.name;
										folderError = null;
									}}>✎</button
								>
								<button
									class="icon"
									title="Delete {section.name}"
									aria-label="Delete {section.name}"
									onclick={() => void dropFolder(section.name)}>✕</button
								>
							{/if}
						{/if}
					</div>
					{#if !isShut(section.key)}
						<ul>
							{#each flattenTree(section.nodes, isShut) as row (row.doc.id)}
								{@render docRow(row.doc, row.depth, row.hasChildren)}
							{/each}
							{#if !section.nodes.length}
								<li class="empty">
									{section.name === UNFILED
										? 'Nothing loose.'
										: 'Empty — drag a document in, or press +.'}
								</li>
							{/if}
						</ul>
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
				class="filing"
				title="Where this document sits: in a folder, or inside another document. A document inside another costs the agents' index nothing; one more in a folder costs it a line."
				aria-label="Filed under"
				disabled={!editable}
				bind:value={filing}
				onchange={touch}
			>
				<optgroup label="Folders">
					{#each folderChoices as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</optgroup>
				{#if docChoices.length || strandedAt}
					<optgroup label="Inside a document">
						{#if strandedAt}<option value={filing}>{strandedAt}</option>{/if}
						{#each docChoices as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</optgroup>
				{/if}
			</select>
			<div class="actions">
				<!-- A switch with a word at each end, rather than one button whose
				     label was the state it was already in. -->
				<div class="vis">
					<span class="vis-end" class:live={visibility !== 'shared'}>Private</span>
					<button
						class="vis-track"
						class:on={visibility === 'shared'}
						role="switch"
						aria-checked={visibility === 'shared'}
						aria-label="Share this document"
						disabled={!editable}
						title={editable
							? 'Shared docs appear in every user’s library and feed their agents’ context'
							: 'This document belongs to another user'}
						onclick={() => {
							visibility = visibility === 'shared' ? 'personal' : 'shared';
							touch();
						}}><span class="vis-knob"></span></button
					>
					<span class="vis-end" class:live={visibility === 'shared'}>Shared</span>
				</div>
				<!-- Named for where it takes you, both ways round, so neither label
				     is a description of the state you are already in. -->
				{#if editable}
					<button class="chip" onclick={() => (preview = !preview)}>
						{preview ? 'Edit' : 'Preview'}
					</button>
				{/if}
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
			<!-- The Edit button is the way in that a keyboard and a screen reader
			     get; the double-click is a shortcut for a pointer, not the only
			     route, so this stays a plain region. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="preview"
				ondblclick={(e) => {
					// Not on a link, a rendered block's own controls, or someone
					// else's document — a double-click on a word inside a link is a
					// click on the link.
					if (!editable) return;
					if ((e.target as HTMLElement).closest('a, button, pre, .mermaid')) return;
					preview = false;
				}}
			>
				<Markdown text={body} />
			</div>
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

{#if drag}
	<!-- Follows the pointer rather than moving the row, so the list underneath
	     keeps still and the row you are aiming at does not shuffle away. -->
	<div
		class="drag-ghost"
		style={`transform:translate(${drag.at.x - drag.grab.x}px, ${drag.at.y - drag.grab.y}px); width:${drag.width}px`}
	>
		{drag.title}
	</div>
{/if}

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
	/* A drag that selects the titles it passes over reads as a broken gesture. */
	.doc-list.dragging {
		user-select: none;
	}
	.list-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
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
	.folder-new {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.6rem;
	}
	.doc-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* Depth shows as indentation alone: a nested row is a document like any
	   other, and giving it its own chrome made the shelf read as two lists. */
	.doc-list li {
		position: relative;
	}
	/* The caret's gutter, reserved on every row of a folder that holds a tree so
	   titles line up whether or not a row has children. Only such folders: a
	   flat folder has no carets at all, and indenting its rows for one would
	   spend a sixth of a 290px pane on empty space. */
	.nested .row {
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
		   cortex panel's group headings already are. It is also the drop target
		   for the folder, which is a second reason for it to stay on screen. */
		position: sticky;
		top: 0;
		z-index: var(--z-base);
		background: var(--bg-pane);
		border-radius: 4px;
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
	.capped.alarm {
		color: var(--danger);
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
	.folder-head:hover .icon,
	.folder-head .icon:focus-visible {
		opacity: 1;
	}
	.folder-head .icon:hover {
		box-shadow: none;
		color: var(--accent);
		text-shadow: 0 0 var(--glow-size) var(--glow);
	}
	.rename {
		font-size: var(--text-sm);
		padding: 0.25rem 0.4rem;
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
	/* Where a drop would land. Only ever set when the move is legal, so a
	   refused target simply stays dark rather than accepting and then erroring. */
	.doc-list li.over,
	.folder-head.over {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.doc-list li.lifted {
		opacity: 0.4;
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
	/* The title gives way, not the tags: a long name ellipsises where it meets
	   them instead of pushing them off the end of the pane. */
	.doc-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.badges {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-left: auto;
	}
	.badge {
		font-size: var(--text-xs);
		border: 1px solid var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		color: var(--accent);
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

	/* Translated rather than positioned, so following the pointer costs no
	   layout, and pointer-events:none so elementFromPoint sees the row
	   underneath rather than this.

	   Above --z-drag, which is what the board's ghost uses: below 721px this
	   shelf is the off-canvas sheet, and a ghost dragged around inside it has
	   to be above --z-sheet or it is dragged invisibly. */
	.drag-ghost {
		position: fixed;
		top: 0;
		left: 0;
		box-sizing: border-box;
		z-index: var(--z-modal);
		pointer-events: none;
		background: var(--bg-pane);
		border: 1px solid var(--accent);
		border-radius: 6px;
		color: var(--fg);
		font-size: var(--text-md);
		padding: 0.45rem 0.5rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		box-shadow: 0 2px 10px rgb(0 0 0 / 0.35);
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
	.filing {
		width: 11rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.3rem 0.5rem;
	}
	.filing:focus {
		border-color: var(--accent);
	}
	.filing:disabled {
		opacity: 0.5;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.vis {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: var(--text-sm);
	}
	.vis-end {
		color: var(--fg-dim);
	}
	/* Which end is live is the whole message, so it carries the colour and the
	   dim end recedes. */
	.vis-end.live {
		color: var(--accent);
	}
	.vis-track {
		position: relative;
		width: 2.2rem;
		height: 1.2rem;
		flex-shrink: 0;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
		padding: 0;
	}
	.vis-track.on {
		border-color: var(--accent);
	}
	.vis-track:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.vis-knob {
		position: absolute;
		top: 50%;
		left: 0.15rem;
		width: 0.8rem;
		height: 0.8rem;
		margin-top: -0.4rem;
		border-radius: 50%;
		background: var(--fg-dim);
		transition: left 0.12s ease, background 0.12s ease;
	}
	.vis-track.on .vis-knob {
		left: calc(100% - 0.95rem);
		background: var(--accent);
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
