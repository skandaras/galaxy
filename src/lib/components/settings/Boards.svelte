<script lang="ts">
	import { page } from '$app/state';
	import type { Board, BoardView, Lane, Member, Project, Status } from '$lib/board-types';

	/** Mirrors MAX_LANES in $lib/server/boards — the API is the real enforcement. */
	const MAX_LANES = 5;

	let boards = $state<Board[]>([]);
	let selectedId = $state<string | null>(null);
	let view = $state<BoardView | null>(null);
	let newBoardName = $state('');
	let newLaneName = $state('');
	let newStatusName = $state('');
	let newProjectName = $state('');
	let inviteName = $state('');
	let notice = $state<string | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		void loadBoards();
	});

	async function loadBoards() {
		boards = await (await fetch('/api/boards?archived=1')).json();
		if (boards.length && (!selectedId || !boards.some((b) => b.id === selectedId))) {
			selectedId = boards[0].id;
		}
		await loadBoard();
	}

	async function loadBoard() {
		if (!selectedId) return (view = null);
		const res = await fetch(`/api/boards/${selectedId}`);
		view = res.ok ? await res.json() : null;
	}

	/** Every mutation goes through here so one place reports what went wrong. */
	async function call(url: string, init: RequestInit, ok: string): Promise<boolean> {
		error = null;
		const res = await fetch(url, init);
		if (!res.ok) {
			error = (await res.json().catch(() => ({}))).message ?? `Failed (${res.status})`;
			return false;
		}
		notice = ok;
		return true;
	}

	const jsonInit = (method: string, body: unknown): RequestInit => ({
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

	async function createBoard() {
		const name = newBoardName.trim();
		if (!name) return;
		if (await call('/api/boards', jsonInit('POST', { name }), `Created ${name}`)) {
			newBoardName = '';
			selectedId = null;
			await loadBoards();
		}
	}

	async function renameBoard(name: string) {
		if (!selectedId || !name.trim()) return;
		await call(`/api/boards/${selectedId}`, jsonInit('PATCH', { name }), 'Renamed');
		await loadBoards();
	}

	async function setArchived(archived: boolean) {
		if (!selectedId) return;
		await call(
			`/api/boards/${selectedId}`,
			jsonInit('PATCH', { archived }),
			archived ? 'Board archived' : 'Board restored'
		);
		await loadBoards();
	}

	async function deleteBoard() {
		if (!selectedId || !view) return;
		if (!confirm(`Delete "${view.board.name}" and every card on it? This cannot be undone.`)) return;
		if (await call(`/api/boards/${selectedId}`, { method: 'DELETE' }, 'Board deleted')) {
			selectedId = null;
			await loadBoards();
		}
	}

	async function addLane() {
		const name = newLaneName.trim();
		if (!name || !selectedId) return;
		if (await call(`/api/boards/${selectedId}/lanes`, jsonInit('POST', { name }), 'Lane added')) {
			newLaneName = '';
			await loadBoard();
		}
	}

	async function renameLane(lane: Lane, name: string) {
		if (!name.trim() || name === lane.name) return;
		await call(`/api/boards/${selectedId}/lanes/${lane.id}`, jsonInit('PATCH', { name }), 'Renamed');
		await loadBoard();
	}

	async function removeLane(lane: Lane) {
		if (!confirm(`Remove "${lane.name}"? Its cards move to the next lane along.`)) return;
		await call(`/api/boards/${selectedId}/lanes/${lane.id}`, { method: 'DELETE' }, 'Lane removed');
		await loadBoard();
	}

	async function addStatus() {
		const name = newStatusName.trim();
		if (!name || !selectedId) return;
		if (
			await call(`/api/boards/${selectedId}/statuses`, jsonInit('POST', { name }), 'Status added')
		) {
			newStatusName = '';
			await loadBoard();
		}
	}

	async function patchStatus(status: Status, patch: Record<string, unknown>) {
		await call(
			`/api/boards/${selectedId}/statuses/${status.id}`,
			jsonInit('PATCH', patch),
			'Status updated'
		);
		await loadBoard();
	}

	async function removeStatus(status: Status) {
		if (!confirm(`Remove "${status.name}"? Its cards move to the first status.`)) return;
		await call(
			`/api/boards/${selectedId}/statuses/${status.id}`,
			{ method: 'DELETE' },
			'Status removed'
		);
		await loadBoard();
	}

	async function addProject() {
		const name = newProjectName.trim();
		if (!name || !selectedId) return;
		if (
			await call(`/api/boards/${selectedId}/projects`, jsonInit('POST', { name }), 'Project added')
		) {
			newProjectName = '';
			await loadBoard();
		}
	}

	async function patchProject(project: Project, patch: Record<string, unknown>) {
		await call(
			`/api/boards/${selectedId}/projects/${project.id}`,
			jsonInit('PATCH', patch),
			'Project updated'
		);
		await loadBoard();
	}

	async function removeProject(project: Project) {
		if (!confirm(`Remove "${project.name}"? Its cards stay on the board, they just lose the label.`))
			return;
		await call(
			`/api/boards/${selectedId}/projects/${project.id}`,
			{ method: 'DELETE' },
			'Project removed'
		);
		await loadBoard();
	}

	async function invite() {
		const username = inviteName.trim();
		if (!username || !selectedId) return;
		if (
			await call(
				`/api/boards/${selectedId}/members`,
				jsonInit('POST', { username }),
				`${username} can now see this board`
			)
		) {
			inviteName = '';
			await loadBoard();
		}
	}

	async function removeMember(member: Member) {
		await call(
			`/api/boards/${selectedId}/members?userId=${encodeURIComponent(member.userId)}`,
			{ method: 'DELETE' },
			`Removed ${member.username}`
		);
		await loadBoard();
	}

	const isOwner = $derived(view?.role === 'owner');
	const me = $derived(page.data.user?.id ?? '');
</script>

<section>
	{#if notice}<p class="notice">{notice}</p>{/if}
	{#if error}<p class="error">{error}</p>{/if}

	<article class="card">
		<h3>Boards</h3>
		<p class="hint">
			A board holds cards you and anyone you invite can both see — and so can your agents, when
			they are working for someone on the board.
		</p>
		<div class="row">
			<select bind:value={selectedId} onchange={loadBoard} aria-label="Board">
				{#each boards as b (b.id)}
					<option value={b.id}>{b.name}{b.archivedAt ? ' (archived)' : ''}</option>
				{/each}
			</select>
			<input placeholder="New board name" bind:value={newBoardName} />
			<button class="btn" onclick={createBoard}>Create</button>
		</div>
	</article>

	{#if view}
		<article class="card">
			<h3>{view.board.name}</h3>
			{#if !isOwner}
				<p class="hint">
					You are a collaborator here. You can add and change cards; renaming, sharing and
					archiving the board itself stay with its owner.
				</p>
			{/if}
			<div class="row">
				<input
					value={view.board.name}
					disabled={!isOwner}
					onblur={(e) => renameBoard(e.currentTarget.value)}
					aria-label="Board name"
				/>
				{#if isOwner}
					<button class="btn" onclick={() => setArchived(!view?.board.archivedAt)}>
						{view.board.archivedAt ? 'Restore' : 'Archive'}
					</button>
					<button class="btn danger" onclick={deleteBoard}>Delete</button>
				{/if}
			</div>
		</article>

		<article class="card">
			<h3>Lanes</h3>
			<p class="hint">
				Lanes are the columns. They group cards however suits you — status is a separate field, so
				lanes don't have to be "to do / doing / done". Up to {MAX_LANES}.
			</p>
			{#each view.lanes as lane (lane.id)}
				<div class="row">
					<input value={lane.name} onblur={(e) => renameLane(lane, e.currentTarget.value)} />
					<button class="btn danger" onclick={() => removeLane(lane)}>Remove</button>
				</div>
			{/each}
			{#if view.lanes.length < MAX_LANES}
				<div class="row">
					<input
						placeholder="New lane"
						bind:value={newLaneName}
						onkeydown={(e) => e.key === 'Enter' && addLane()}
					/>
					<button class="btn" onclick={addLane}>Add lane</button>
				</div>
			{:else}
				<p class="hint">That's the maximum — remove one to add another.</p>
			{/if}
		</article>

		<article class="card">
			<h3>Statuses</h3>
			<p class="hint">
				A card set to a <strong>done</strong> status is archived off the board automatically. You can
				have more than one — "Done" and "Won't do" both finish a card.
			</p>
			{#each view.statuses as status (status.id)}
				<div class="row">
					<input
						value={status.name}
						onblur={(e) => patchStatus(status, { name: e.currentTarget.value })}
					/>
					<input
						class="colour"
						type="color"
						value={status.colour || '#8a8f98'}
						onchange={(e) => patchStatus(status, { colour: e.currentTarget.value })}
						aria-label="Colour"
					/>
					<label class="toggle">
						<input
							type="checkbox"
							checked={status.isDone}
							onchange={(e) => patchStatus(status, { isDone: e.currentTarget.checked })}
						/>
						done
					</label>
					<button class="btn danger" onclick={() => removeStatus(status)}>Remove</button>
				</div>
			{/each}
			<div class="row">
				<input
					placeholder="New status"
					bind:value={newStatusName}
					onkeydown={(e) => e.key === 'Enter' && addStatus()}
				/>
				<button class="btn" onclick={addStatus}>Add status</button>
			</div>
		</article>

		<article class="card">
			<h3>Projects</h3>
			<p class="hint">
				Projects cut across lanes — a house move, a holiday, the tax return. A card belongs to at
				most one, and the colour becomes its border so the board is scannable at a glance. Hiding a
				project on the board only hides it from that view; nothing is archived or deleted.
			</p>
			{#each view.projects as project (project.id)}
				<div class="row">
					<input
						value={project.name}
						onblur={(e) => patchProject(project, { name: e.currentTarget.value })}
					/>
					<input
						class="colour"
						type="color"
						value={project.colour || '#5b8def'}
						onchange={(e) => patchProject(project, { colour: e.currentTarget.value })}
						aria-label="Colour"
					/>
					<button class="btn danger" onclick={() => removeProject(project)}>Remove</button>
				</div>
			{/each}
			<div class="row">
				<input
					placeholder="New project"
					bind:value={newProjectName}
					onkeydown={(e) => e.key === 'Enter' && addProject()}
				/>
				<button class="btn" onclick={addProject}>Add project</button>
			</div>
		</article>

		<article class="card">
			<h3>People</h3>
			<p class="hint">
				Invite by username. There is no email — they simply find the board in their picker. They
				need to have signed in to Galaxy at least once before they can be invited.
			</p>
			{#each view.members as member (member.userId)}
				<div class="row">
					<span class="member">
						{member.displayName || member.username}
						<span class="meta">{member.role}</span>
					</span>
					<!-- The owner can remove anyone else; anyone else can only leave. -->
					{#if member.role !== 'owner' && (isOwner || member.userId === me)}
						<button class="btn danger" onclick={() => removeMember(member)}>
							{member.userId === me && !isOwner ? 'Leave' : 'Remove'}
						</button>
					{/if}
				</div>
			{/each}
			{#if isOwner}
				<div class="row">
					<input
						placeholder="username"
						bind:value={inviteName}
						onkeydown={(e) => e.key === 'Enter' && invite()}
					/>
					<button class="btn" onclick={invite}>Invite</button>
				</div>
			{/if}
		</article>
	{/if}
</section>

<style>
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.4rem 0 0.6rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.4rem;
		flex-wrap: wrap;
	}
	input,
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.76rem;
		padding: 0.3rem 0.45rem;
		flex: 1;
		min-width: 8rem;
	}
	input.colour {
		flex: 0 0 2.4rem;
		min-width: 0;
		padding: 0.1rem;
		height: 1.7rem;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	.toggle input {
		flex: 0;
		min-width: 0;
	}
	.member {
		flex: 1;
		font-size: 0.78rem;
	}
	.meta {
		color: var(--fg-dim);
		font-size: 0.65rem;
		margin-left: 0.4rem;
	}
	.notice {
		color: var(--accent);
		font-size: 0.75rem;
	}
	.error {
		color: var(--danger);
		font-size: 0.75rem;
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
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
</style>
