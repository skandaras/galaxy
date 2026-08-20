<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import CardDetail from '$lib/components/boards/CardDetail.svelte';
	import {
		EVERYONE,
		PRIORITY_MARK,
		UNASSIGNED,
		matchesAssignee,
		resolveAssignee,
		type Board,
		type BoardView,
		type Card
	} from '$lib/board-types';
	import { dropIndex, isNoOp, movedBeyond, type CardBox } from '$lib/board-drag';

	/**
	 * Which projects are showing. Hiding one only hides its cards from this
	 * view — every card is still on the board — so the choice is a per-browser
	 * preference rather than anything the server needs to know.
	 */
	const HIDDEN_KEY = (boardId: string) => `galaxy:board-hidden-projects:${boardId}`;
	let hidden = $state<Set<string>>(new Set());

	/**
	 * Whose cards are showing. Same reasoning as the project filter: it hides
	 * cards from this view rather than changing the board, so it is a
	 * per-browser preference — and a per-board one, because "just mine" makes
	 * sense on a shared board and not on a private one.
	 *
	 * '' is everyone; UNASSIGNED is the cards nobody has picked up, which would
	 * otherwise be unreachable once you filter by a person.
	 */
	const ASSIGNEE_KEY = (boardId: string) => `galaxy:board-assignee:${boardId}`;
	let assignee = $state(EVERYONE);

	let boards = $state<Board[]>([]);
	let view = $state<BoardView | null>(null);
	let selectedId = $state<string | null>(null);
	let openCardId = $state<string | null>(null);
	let showArchive = $state(false);
	/**
	 * A card in flight.
	 *
	 * Press-and-hold rather than the browser's own drag-and-drop: HTML5 DnD
	 * starts on the first pixel of movement (so a board is hard to scroll and a
	 * card hard to click), gives no control over the ghost, and cannot animate
	 * a rejected drop back to where it came from.
	 */
	interface DragState {
		id: string;
		title: string;
		from: { laneId: string; index: number };
		/** Pointer offset inside the card, so the ghost sits under the grab point. */
		grab: { x: number; y: number };
		size: { w: number; h: number };
		at: { x: number; y: number };
		/** Where it started, for the snap-back animation. */
		origin: { x: number; y: number };
		target: { laneId: string; index: number } | null;
		returning: boolean;
	}

	const HOLD_MS = 180;
	const MOVE_TOLERANCE = 8;

	let drag = $state<DragState | null>(null);
	/** Press that has not yet become a drag: still a click until the hold fires. */
	let pending: { card: Card; laneId: string; index: number; x: number; y: number; el: HTMLElement } | null =
		null;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	/** Set when a gesture became a drag, so the click that follows is ignored. */
	let justDragged = false;
	let newCardLane = $state<string | null>(null);
	let newCardTitle = $state('');
	let error = $state<string | null>(null);
	let running = $state(false);

	onMount(loadBoards);

	async function loadBoards() {
		boards = await (await fetch('/api/boards')).json();
		if (!boards.length) return;
		if (!selectedId || !boards.some((b) => b.id === selectedId)) selectedId = boards[0].id;
		await loadBoard();
	}

	async function loadBoard() {
		if (!selectedId) return (view = null);
		const res = await fetch(`/api/boards/${selectedId}?archived=1`);
		if (!res.ok) {
			view = null;
			return;
		}
		view = await res.json();
		hidden = new Set<string>(JSON.parse(localStorage.getItem(HIDDEN_KEY(selectedId)) ?? '[]'));
		assignee = resolveAssignee(localStorage.getItem(ASSIGNEE_KEY(selectedId)), view?.members ?? []);
	}

	function toggleProject(id: string) {
		const next = new Set(hidden);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		hidden = next;
		if (selectedId) localStorage.setItem(HIDDEN_KEY(selectedId), JSON.stringify([...next]));
	}

	function setAssignee(value: string) {
		assignee = value;
		if (selectedId) localStorage.setItem(ASSIGNEE_KEY(selectedId), value);
	}

	async function addProject() {
		const name = prompt('Name this project');
		if (!name?.trim() || !selectedId) return;
		const res = await fetch(`/api/boards/${selectedId}/projects`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name })
		});
		if (!res.ok) {
			error = (await res.json().catch(() => ({}))).message ?? 'Could not add the project';
			return;
		}
		await loadBoard();
	}

	async function select(id: string) {
		selectedId = id;
		openCardId = null;
		showArchive = false;
		await loadBoard();
	}

	async function createBoard() {
		const name = prompt('Name this board');
		if (!name?.trim()) return;
		const res = await fetch('/api/boards', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name })
		});
		if (!res.ok) return;
		const board = (await res.json()) as Board;
		boards = [...boards, board];
		await select(board.id);
	}

	async function addCard(laneId: string) {
		const title = newCardTitle.trim();
		if (!title || !selectedId) return;
		newCardTitle = '';
		newCardLane = null;
		const res = await fetch(`/api/boards/${selectedId}/cards`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title, laneId })
		});
		if (!res.ok) {
			error = (await res.json().catch(() => ({}))).message ?? 'Could not add the card';
			return;
		}
		await loadBoard();
	}

	async function moveTo(cardId: string, laneId: string, position?: number) {
		await fetch(`/api/cards/${cardId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ laneId, position })
		});
		await loadBoard();
	}

	async function setStatus(cardId: string, statusId: string) {
		await fetch(`/api/cards/${cardId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ statusId })
		});
		await loadBoard();
	}

	/**
	 * Run an agent across every open card. Like the per-card hand-off, the work
	 * happens in an ordinary chat rather than somewhere new — so this navigates
	 * there instead of running anything inside the board.
	 */
	async function boardAction(action: 'prioritise' | 'next-steps') {
		if (!selectedId || running) return;
		running = true;
		error = null;
		const res = await fetch(`/api/boards/${selectedId}/agent`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action })
		});
		running = false;
		if (!res.ok) {
			error = (await res.json().catch(() => ({}))).message ?? 'Could not start the agent';
			return;
		}
		const { chatId } = await res.json();
		await goto(`/chat?chat=${chatId}`);
	}

	// --- press and hold to drag a card ---------------------------------------

	function onCardPointerDown(e: PointerEvent, card: Card, laneId: string, index: number) {
		// The selects inside a card are controls in their own right, and a
		// secondary click is never a drag.
		if (e.button !== 0 || (e.target as HTMLElement).closest('select, input, textarea, a')) return;
		// Cleared here rather than in openCard: a drag that ends over another lane
		// produces no click at all, and the flag would swallow the next one.
		justDragged = false;
		pending = { card, laneId, index, x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement };
		holdTimer = setTimeout(beginDrag, HOLD_MS);
		window.addEventListener('pointermove', onPointerMove, { passive: false });
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', abandon);
	}

	function beginDrag() {
		if (!pending) return;
		const rect = pending.el.getBoundingClientRect();
		drag = {
			id: pending.card.id,
			title: pending.card.title,
			from: { laneId: pending.laneId, index: pending.index },
			grab: { x: pending.x - rect.left, y: pending.y - rect.top },
			size: { w: rect.width, h: rect.height },
			at: { x: pending.x, y: pending.y },
			origin: { x: rect.left, y: rect.top },
			target: { laneId: pending.laneId, index: pending.index },
			returning: false
		};
		justDragged = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag) {
			// Still deciding. Movement before the hold fires means the person is
			// clicking or scrolling, not dragging.
			if (pending && movedBeyond(pending, { x: e.clientX, y: e.clientY }, MOVE_TOLERANCE)) abandon();
			return;
		}
		// Holds the page still under a finger once the drag is real.
		e.preventDefault();
		drag.at = { x: e.clientX, y: e.clientY };
		drag.target = targetAt(e.clientX, e.clientY);
	}

	/** Which lane and slot the pointer is over, or null if it is over neither. */
	function targetAt(x: number, y: number): { laneId: string; index: number } | null {
		const laneEl = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-lane]');
		if (!laneEl?.dataset.lane || !drag) return null;
		const boxes: CardBox[] = [...laneEl.querySelectorAll<HTMLElement>('[data-card]')].map((el) => {
			const r = el.getBoundingClientRect();
			return { id: el.dataset.card ?? '', top: r.top, bottom: r.bottom };
		});
		return { laneId: laneEl.dataset.lane, index: dropIndex(boxes, y, drag.id) };
	}

	function onPointerUp() {
		if (!drag) return abandon();
		const { id, from, target } = drag;
		detach();
		if (!target || isNoOp(from, target)) {
			// Nowhere to land, or nowhere new: animate home rather than blinking.
			drag = { ...drag, returning: true, target: null };
			setTimeout(() => (drag = null), 180);
			return;
		}
		drag = null;
		void moveTo(id, target.laneId, target.index);
	}

	/** Give up on the gesture entirely — a scroll, a cancelled touch, Escape. */
	function abandon() {
		detach();
		if (drag) {
			drag = { ...drag, returning: true, target: null };
			setTimeout(() => (drag = null), 180);
		}
	}

	function detach() {
		clearTimeout(holdTimer);
		pending = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', abandon);
	}

	/** Opening a card must not fire on the click that ends a drag. */
	function openCard(id: string) {
		if (justDragged) {
			justDragged = false;
			return;
		}
		openCardId = id;
	}

	const showDropLine = (laneId: string, index: number) =>
		!!drag && !drag.returning && drag.target?.laneId === laneId && drag.target.index === index;

	/**
	 * A lane's cards, each tagged with the slot it occupies once the dragged
	 * card is discounted — which is the space `dropIndex` counts in and the
	 * server splices into, so the drop line lands where the card will.
	 *
	 * The dragged card stays in the list, dimmed. Taking it out reflowed the
	 * lane under the pointer mid-drag, which moved the very card you were
	 * aiming at and made a short lane jump as you picked something up.
	 */
	const laneRows = (laneId: string) => {
		let slot = 0;
		return cardsIn(laneId).map((card) => {
			const lifted = !!drag && !drag.returning && card.id === drag.id;
			return { card, lifted, slot: lifted ? -1 : slot++ };
		});
	};

	/** Slots in a lane once the dragged card is discounted. */
	const slotCount = (laneId: string) =>
		cardsIn(laneId).filter((c) => !(drag && !drag.returning && c.id === drag.id)).length;

	const cardsIn = (laneId: string) =>
		(view?.cards ?? [])
			.filter(
				(c) =>
					c.laneId === laneId &&
					!hidden.has(c.projectId ?? 'none') &&
					matchesAssignee(c, assignee)
			)
			.sort((a, b) => a.position - b.position);
	const projectOf = (card: Card) => view?.projects.find((p) => p.id === card.projectId);
	const statusOf = (card: Card) => view?.statuses.find((s) => s.id === card.statusId);
	const memberName = (id: string | null) =>
		id ? (view?.members.find((m) => m.userId === id)?.username ?? '') : '';
	const when = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : '');

	/** Whoever is looking, so their own row can say so. */
	const myUserId = $derived(page.data.user?.id ?? '');

	/**
	 * Cards the filters are keeping off the board. Counted with the same
	 * predicates the lanes use, so it cannot drift from what is on screen.
	 * `view.cards` is already live-only — the archive comes back separately.
	 */
	const hiddenCount = $derived(
		(view?.cards ?? []).filter(
			(c) => hidden.has(c.projectId ?? 'none') || !matchesAssignee(c, assignee)
		).length
	);

	function clearFilters() {
		hidden = new Set();
		setAssignee(EVERYONE);
		if (selectedId) localStorage.removeItem(HIDDEN_KEY(selectedId));
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && drag && abandon()} />

<div class="boards">
	<header class="bar">
		<select
			class="picker"
			value={selectedId ?? ''}
			onchange={(e) => select(e.currentTarget.value)}
			aria-label="Board"
		>
			{#each boards as b (b.id)}
				<option value={b.id}>{b.name}</option>
			{/each}
		</select>
		<button class="btn" onclick={createBoard}>New board</button>
		{#if view}<button class="btn" onclick={addProject}>+ Project</button>{/if}
		<span class="spacer"></span>
		{#if view}
			<button class="btn" disabled={running || !view.cards.length} onclick={() => boardAction('prioritise')}>
				✦ Prioritise
			</button>
			<button class="btn" disabled={running || !view.cards.length} onclick={() => boardAction('next-steps')}>
				✦ Next steps
			</button>
			<span class="members" title="Everyone who can see this board">
				{view.members.map((m) => m.username).join(', ')}
			</span>
			<a class="btn ghost" href="/settings">Configure</a>
		{/if}
	</header>

	{#if error}<p class="error">{error}</p>{/if}

	{#if view && (view.projects.length || view.members.length > 1)}
		<div class="filters">
			<span class="filter-label">Showing</span>

			{#if view.members.length > 1}
				<label class="assignee">
					<span class="sr-only">filter by who a card is assigned to</span>
					<select value={assignee} onchange={(e) => setAssignee(e.currentTarget.value)}>
							<option value={EVERYONE}>Everyone</option>
						{#each view.members as m (m.userId)}
							<option value={m.userId}>
								{m.username}{m.userId === myUserId ? ' (me)' : ''}
							</option>
						{/each}
						<option value={UNASSIGNED}>Unassigned</option>
					</select>
				</label>
			{/if}

			{#each view.projects as p (p.id)}
				<button
					class="chip"
					class:off={hidden.has(p.id)}
					style={`--chip:${p.colour || 'var(--fg-dim)'}`}
					onclick={() => toggleProject(p.id)}
					title={hidden.has(p.id) ? `Show ${p.name}` : `Hide ${p.name}`}
				>
					{p.name}
				</button>
			{/each}
			{#if view.projects.length}
				<button class="chip" class:off={hidden.has('none')} onclick={() => toggleProject('none')}>
					No project
				</button>
			{/if}

			{#if hiddenCount}
				<!-- Without this, a filter that matches nothing looks like a board
				     that lost its cards. -->
				<span class="filter-count num">{hiddenCount} hidden</span>
				<button class="link" onclick={clearFilters}>Show everything</button>
			{/if}
		</div>
	{/if}

	{#if !boards.length}
		<div class="empty-state">
			<h2>No boards yet</h2>
			<p>
				A board is a place to keep the things you actually need to do — errands, admin, projects —
				where an agent can read them too. Make one to start.
			</p>
			<button class="btn primary" onclick={createBoard}>Create a board</button>
		</div>
	{:else if view}
		<div class="surface">
			<div class="lanes">
				{#each view.lanes as lane (lane.id)}
					<section
						class="lane"
						role="group"
						aria-label={lane.name}
						data-lane={lane.id}
						class:over={drag?.target?.laneId === lane.id && !drag.returning}
					>
						<h3>{lane.name} <span class="count">{cardsIn(lane.id).length}</span></h3>

						{#each laneRows(lane.id) as row (row.card.id)}
							{@const card = row.card}
							{#if showDropLine(lane.id, row.slot)}<div class="drop-line"></div>{/if}
							<article
								class="card"
								class:projected={!!projectOf(card)}
								class:lifted={row.lifted}
								style={`--project:${projectOf(card)?.colour ?? 'transparent'}`}
								data-card={card.id}
								onpointerdown={(e) => onCardPointerDown(e, card, lane.id, row.slot)}
							>
								<button class="card-face" onclick={() => openCard(card.id)}>
									<span class="card-title">{card.title}</span>
									{#if card.priority !== 'none'}
										<span class="prio" data-p={card.priority}>{PRIORITY_MARK[card.priority]}</span>
									{/if}
								</button>
								<div class="card-foot">
									<select
										class="status"
										style={`--dot:${statusOf(card)?.colour || 'var(--fg-dim)'}`}
										value={card.statusId}
										onchange={(e) => setStatus(card.id, e.currentTarget.value)}
										aria-label="Status"
									>
										{#each view.statuses as s (s.id)}
											<option value={s.id}>{s.name}</option>
										{/each}
									</select>
									{#if card.assignedTo}
										<span class="who">{memberName(card.assignedTo)}</span>
									{/if}
								</div>
								<!-- Kept alongside dragging, not replaced by it: this is the
								     keyboard route, and the reliable one on a phone. -->
								<select
									class="lane-move"
									value={card.laneId}
									onchange={(e) => moveTo(card.id, e.currentTarget.value)}
									aria-label="Move to lane"
								>
									{#each view.lanes as l (l.id)}
										<option value={l.id}>{l.name}</option>
									{/each}
								</select>
							</article>
						{/each}
						{#if showDropLine(lane.id, slotCount(lane.id))}<div class="drop-line"></div>{/if}

						{#if newCardLane === lane.id}
							<input
								class="new-card"
								placeholder="Card title…"
								bind:value={newCardTitle}
								onkeydown={(e) => {
									if (e.key === 'Enter') addCard(lane.id);
									if (e.key === 'Escape') newCardLane = null;
								}}
								onblur={() => addCard(lane.id)}
							/>
						{:else}
							<button
								class="add"
								onclick={() => {
									newCardLane = lane.id;
									newCardTitle = '';
								}}>+ Add a card</button
							>
						{/if}
					</section>
				{/each}
			</div>

			{#if drag}
				<!-- Follows the pointer, or slides home when a drop is refused.
				     pointer-events:none matters: elementFromPoint has to see the
				     lane underneath, not this. -->
				<div
					class="drag-ghost"
					class:returning={drag.returning}
					style={`width:${drag.size.w}px; height:${drag.size.h}px; transform:translate(${
						drag.returning ? drag.origin.x : drag.at.x - drag.grab.x
					}px, ${drag.returning ? drag.origin.y : drag.at.y - drag.grab.y}px)`}
				>
					{drag.title}
				</div>
			{/if}

			{#if openCardId}
				<CardDetail
					cardId={openCardId}
					lanes={view.lanes}
					statuses={view.statuses}
					projects={view.projects}
					members={view.members}
					onclose={() => (openCardId = null)}
					onchanged={loadBoard}
				/>
			{/if}
		</div>

		<section class="archive">
			<button class="archive-toggle" onclick={() => (showArchive = !showArchive)}>
				{showArchive ? '▾' : '▸'} Archive
				<span class="count">{view.archived.length}</span>
			</button>
			{#if showArchive}
				<ul>
					{#each view.archived as card (card.id)}
						<li>
							<button class="archive-row" onclick={() => (openCardId = card.id)}>
								<span>{card.title}</span>
								<span class="meta">{when(card.archivedAt)}</span>
							</button>
						</li>
					{:else}
						<li class="hint">Nothing archived yet. Cards land here when you mark them done.</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<style>
	.boards {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1rem;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.members {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.picker {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.3rem 0.5rem;
		max-width: 14rem;
	}

	.surface {
		flex: 1;
		display: flex;
		min-height: 0;
	}
	.lanes {
		flex: 1;
		display: flex;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		overflow-x: auto;
		align-items: flex-start;
	}
	.lane {
		flex: 1 0 15rem;
		max-width: 22rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.6rem;
		box-sizing: border-box;
	}
	.lane.over {
		border-color: var(--accent);
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: var(--text-sm);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--heading);
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.count {
		color: var(--fg-dim);
		letter-spacing: normal;
	}

	.card {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.45rem 0.5rem;
		margin-bottom: 0.45rem;
	}
	/* Press and hold, so a press that is going to become a drag should not also
	   start a text selection. */
	.card {
		user-select: none;
		-webkit-user-select: none;
	}
	/* Left in place so the lane keeps its shape while the ghost is out. */
	.card.lifted {
		opacity: 0.3;
	}
	/* Where the card would land. Sized to leave the gap the card will fill, so
	   the lane doesn't jump when it lands. */
	.drop-line {
		height: 2px;
		background: var(--accent);
		border-radius: 2px;
		margin: 0 0 0.45rem;
		box-shadow: 0 0 6px var(--accent);
	}
	/* The card under the pointer. Fixed and transform-positioned so following
	   the pointer costs no layout, and pointer-events:none so elementFromPoint
	   sees the lane underneath rather than this. */
	/* Named for what it is, not just "ghost": this component already had a
	   .btn.ghost variant, and the bare .ghost selector matched it too — which
	   pinned the board's Configure link to the top-left corner of the window,
	   on top of the sidebar. */
	.drag-ghost {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 40;
		pointer-events: none;
		box-sizing: border-box;
		background: var(--bg);
		border: 1px solid var(--accent);
		border-radius: 6px;
		padding: 0.45rem 0.5rem;
		font-size: var(--text-md);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.45);
		transform-origin: top left;
		opacity: 0.95;
	}
	/* A refused drop slides home instead of vanishing, so it is clear nothing
	   was moved. */
	.drag-ghost.returning {
		transition: transform 0.18s ease-out;
		opacity: 0.6;
	}
	/* The project reads as the card's edge, so a board is scannable by colour
	   without a label on every card. */
	.card.projected {
		border-color: var(--project);
	}

	.filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem;
		padding: 0.5rem 1rem 0;
	}
	.assignee select {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.2rem 0.4rem;
	}
	.filter-count {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.filters .link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: var(--text-sm);
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}
	.filter-label {
		font-size: var(--text-xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--fg-dim);
		margin-right: 0.2rem;
	}
	.chip {
		background: transparent;
		border: 1px solid var(--chip, var(--border));
		border-left-width: 3px;
		border-radius: 999px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.15rem 0.6rem;
		cursor: pointer;
	}
	.chip.off {
		color: var(--fg-dim);
		border-color: var(--border);
		opacity: 0.6;
		text-decoration: line-through;
	}
	.card-face {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		text-align: left;
		padding: 0;
		cursor: pointer;
		line-height: 1.4;
	}
	.card-title {
		flex: 1;
		min-width: 0;
	}
	.prio {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		letter-spacing: -0.05em;
	}
	.prio[data-p='urgent'],
	.prio[data-p='high'] {
		color: var(--danger);
	}
	.card-foot {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.35rem;
	}
	.status {
		background: transparent;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0;
		cursor: pointer;
		/* The dot carries the status colour; the select itself stays plain so a
		   card face doesn't turn into a paint chart. */
		border-left: 3px solid var(--dot);
		padding-left: 0.3rem;
	}
	.who {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-left: auto;
	}
	.lane-move {
		display: none;
	}
	.new-card,
	.add {
		width: 100%;
		box-sizing: border-box;
		background: transparent;
		border: 1px dashed var(--border);
		border-radius: 6px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.35rem 0.5rem;
		cursor: pointer;
		text-align: left;
	}
	.new-card {
		color: var(--fg);
		border-style: solid;
		cursor: text;
	}

	.archive {
		border-top: 1px solid var(--border);
		padding: 0.5rem 1rem 1rem;
	}
	.archive-toggle {
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-base);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		cursor: pointer;
		padding: 0.3rem 0;
	}
	.archive ul {
		list-style: none;
		margin: 0.3rem 0 0;
		padding: 0;
		max-height: 14rem;
		overflow-y: auto;
	}
	.archive-row {
		display: flex;
		width: 100%;
		gap: 0.6rem;
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-base);
		text-align: left;
		padding: 0.25rem 0;
		cursor: pointer;
	}
	.archive-row span:first-child {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: var(--text-xs);
	}

	.empty-state {
		margin: 3rem auto;
		max-width: 26rem;
		text-align: center;
	}
	.empty-state h2 {
		font-size: var(--text-xl);
		margin-bottom: 0.4rem;
	}
	.empty-state p {
		color: var(--fg-dim);
		font-size: var(--text-md);
		line-height: 1.6;
		margin-bottom: 1rem;
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-base);
	}
	.error {
		color: var(--danger);
		font-size: var(--text-base);
		padding: 0 1rem;
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
		text-decoration: none;
		display: inline-block;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.ghost {
		background: transparent;
		border: 1px dashed var(--fg-dim);
		color: var(--fg-dim);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (hover: none) {
		/* Dragging a card is a mouse gesture; on touch, each card carries the
		   lane menu that does the same job. */
		.lane-move {
			display: block;
			width: 100%;
			margin-top: 0.35rem;
			background: transparent;
			border: 1px solid var(--border);
			border-radius: 4px;
			color: var(--fg-dim);
			font-family: inherit;
			font-size: var(--text-sm);
			padding: 0.2rem 0.3rem;
		}
	}
	@media (max-width: 720px) {
		.lanes {
			padding: 0.6rem 0.7rem;
		}
		.lane {
			flex: 1 0 85%;
		}
	}
</style>
