<script lang="ts">
	import { onMount } from 'svelte';
	import CardDetail from '$lib/components/boards/CardDetail.svelte';
	import { PRIORITY_MARK, type Board, type BoardView, type Card } from '$lib/board-types';

	let boards = $state<Board[]>([]);
	let view = $state<BoardView | null>(null);
	let selectedId = $state<string | null>(null);
	let openCardId = $state<string | null>(null);
	let showArchive = $state(false);
	let draggingId = $state<string | null>(null);
	let dropLane = $state<string | null>(null);
	let newCardLane = $state<string | null>(null);
	let newCardTitle = $state('');
	let error = $state<string | null>(null);

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

	function onDrop(laneId: string) {
		const id = draggingId;
		draggingId = null;
		dropLane = null;
		if (id) void moveTo(id, laneId);
	}

	const cardsIn = (laneId: string) =>
		(view?.cards ?? []).filter((c) => c.laneId === laneId).sort((a, b) => a.position - b.position);
	const statusOf = (card: Card) => view?.statuses.find((s) => s.id === card.statusId);
	const memberName = (id: string | null) =>
		id ? (view?.members.find((m) => m.userId === id)?.username ?? '') : '';
	const when = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : '');
</script>

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
		<span class="spacer"></span>
		{#if view}
			<span class="members" title="Everyone who can see this board">
				{view.members.map((m) => m.username).join(', ')}
			</span>
			<a class="btn ghost" href="/settings">Configure</a>
		{/if}
	</header>

	{#if error}<p class="error">{error}</p>{/if}

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
						class:over={dropLane === lane.id}
						ondragover={(e) => {
							e.preventDefault();
							dropLane = lane.id;
						}}
						ondragleave={() => dropLane === lane.id && (dropLane = null)}
						ondrop={(e) => {
							e.preventDefault();
							onDrop(lane.id);
						}}
					>
						<h3>{lane.name} <span class="count">{cardsIn(lane.id).length}</span></h3>

						{#each cardsIn(lane.id) as card (card.id)}
							<article
								class="card"
								class:dragging={draggingId === card.id}
								draggable="true"
								ondragstart={() => (draggingId = card.id)}
								ondragend={() => (draggingId = null)}
							>
								<button class="card-face" onclick={() => (openCardId = card.id)}>
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
								<!-- Touch has no drag: the lane menu is how a card moves on a phone. -->
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

			{#if openCardId}
				<CardDetail
					cardId={openCardId}
					lanes={view.lanes}
					statuses={view.statuses}
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
		font-size: 0.68rem;
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
		font-size: 0.8rem;
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
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
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
	.card.dragging {
		opacity: 0.45;
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
		font-size: 0.8rem;
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
		font-size: 0.7rem;
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
		font-size: 0.66rem;
		padding: 0;
		cursor: pointer;
		/* The dot carries the status colour; the select itself stays plain so a
		   card face doesn't turn into a paint chart. */
		border-left: 3px solid var(--dot);
		padding-left: 0.3rem;
	}
	.who {
		font-size: 0.62rem;
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
		font-size: 0.74rem;
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
		font-size: 0.72rem;
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
		font-size: 0.75rem;
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
		font-size: 0.65rem;
	}

	.empty-state {
		margin: 3rem auto;
		max-width: 26rem;
		text-align: center;
	}
	.empty-state h2 {
		font-size: 1rem;
		margin-bottom: 0.4rem;
	}
	.empty-state p {
		color: var(--fg-dim);
		font-size: 0.8rem;
		line-height: 1.6;
		margin-bottom: 1rem;
	}
	.hint {
		color: var(--fg-dim);
		font-size: 0.72rem;
	}
	.error {
		color: var(--danger);
		font-size: 0.75rem;
		padding: 0 1rem;
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
			font-size: 0.66rem;
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
