<script lang="ts">
	interface BoardRow {
		id: string;
		name: string;
		owner: string;
		archivedAt: number | null;
		createdAt: number;
		cards: number;
		members: number;
	}
	let rows = $state<BoardRow[]>([]);
	let limits = $state({ maxBoardsPerUser: 20, agentWrites: true });
	let notice = $state<string | null>(null);

	async function load() {
		const [boardsRes, settingsRes] = await Promise.all([
			fetch('/api/admin/boards'),
			fetch('/api/admin/settings')
		]);
		rows = await boardsRes.json();
		const settings = await settingsRes.json();
		if (settings.boards) limits = { ...limits, ...settings.boards };
	}
	$effect(() => {
		void load();
	});

	async function saveLimits() {
		await fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key: 'boards', value: limits })
		});
		notice = 'Limits saved';
		await load();
	}

	const when = (ts: number) => new Date(ts).toLocaleDateString();
</script>

<section>
	{#if notice}<p class="notice">{notice}</p>{/if}

	<article class="card">
		<h3>Model</h3>
		<p class="hint">
			The model and prompt for board work live in <strong>Tasks → board</strong>, with every other
			task's. They were editable here too, which just meant two controls writing the same row.
		</p>
	</article>

	<article class="card">
		<h3>Limits</h3>
		<div class="grid">
			<label>
				boards one person may own
				<input type="number" min="1" max="200" bind:value={limits.maxBoardsPerUser} />
			</label>
			<label class="row">
				<input type="checkbox" bind:checked={limits.agentWrites} /> agents may change cards
			</label>
		</div>
		<p class="hint">
			With writes off, agents can still read boards and cards — that is what makes them aware of
			what you are working on — but they cannot move, tick off or edit anything.
		</p>
		<button class="btn" onclick={saveLimits}>Save limits</button>
	</article>

	<article class="card">
		<h3>All boards</h3>
		<p class="hint">
			Names and counts only. Being an admin means running the platform, not being on everyone's
			boards — card contents stay with the people on them.
		</p>
		<table>
			<thead>
				<tr><th>Board</th><th>Owner</th><th>People</th><th>Cards</th><th>Created</th></tr>
			</thead>
			<tbody>
				{#each rows as b (b.id)}
					<tr class:archived={!!b.archivedAt}>
						<td>{b.name}{b.archivedAt ? ' (archived)' : ''}</td>
						<td>{b.owner}</td>
						<td>{b.members}</td>
						<td>{b.cards}</td>
						<td class="meta">{when(b.createdAt)}</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="hint">No boards yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</article>
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
		color: var(--heading);
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.4rem 0 0.6rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.6rem;
		margin-bottom: 0.5rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.7rem;
		color: var(--label);
	}
	label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	input {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.76rem;
		padding: 0.3rem 0.45rem;
	}
	label.row input {
		width: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--fg-dim);
		font-weight: normal;
	}
	tr.archived td {
		color: var(--fg-dim);
	}
	.meta {
		color: var(--fg-dim);
		font-size: 0.68rem;
	}
	.notice {
		color: var(--accent);
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
</style>
