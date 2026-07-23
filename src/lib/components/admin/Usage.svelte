<script lang="ts">
	interface UsageData {
		days: number;
		totals: { prompt: number; completion: number; cost: number; calls: number };
		byDay: { day: string; prompt: number; completion: number; cost: number; calls: number }[];
		byModel: {
			modelKey: string;
			task: string;
			prompt: number;
			completion: number;
			cost: number;
			calls: number;
			errors: number;
		}[];
		byUser: { username: string; prompt: number; completion: number; cost: number; calls: number }[];
	}

	let days = $state(30);
	let data = $state<UsageData | null>(null);

	$effect(() => {
		void (async () => {
			data = await (await fetch(`/api/admin/usage?days=${days}`)).json();
		})();
	});

	const fmt = (n: number) => n.toLocaleString();
	const money = (n: number) => `$${n.toFixed(4)}`;
</script>

<section>
	<div class="bar">
		<select bind:value={days}>
			<option value={7}>last 7 days</option>
			<option value={30}>last 30 days</option>
			<option value={90}>last 90 days</option>
		</select>
	</div>

	{#if data}
		<div class="tiles">
			<div class="tile"><span>{money(data.totals.cost)}</span><small>estimated cost</small></div>
			<div class="tile"><span>{fmt(data.totals.calls)}</span><small>model calls</small></div>
			<div class="tile"><span>{fmt(data.totals.prompt)}</span><small>prompt tokens</small></div>
			<div class="tile">
				<span>{fmt(data.totals.completion)}</span><small>completion tokens</small>
			</div>
		</div>

		<h3>By model</h3>
		<table>
			<thead>
				<tr><th>Model</th><th>Task</th><th>Calls</th><th>Errors</th><th>Tokens in/out</th><th>Cost</th></tr>
			</thead>
			<tbody>
				{#each data.byModel as row (row.modelKey + row.task)}
					<tr>
						<td>{row.modelKey}</td>
						<td>{row.task}</td>
						<td>{fmt(row.calls)}</td>
						<td class:err={row.errors > 0}>{row.errors}</td>
						<td>{fmt(row.prompt)} / {fmt(row.completion)}</td>
						<td>{money(row.cost)}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="empty">No usage in this window.</td></tr>
				{/each}
			</tbody>
		</table>

		<h3>By user</h3>
		<table>
			<thead>
				<tr><th>User</th><th>Calls</th><th>Tokens in/out</th><th>Cost</th></tr>
			</thead>
			<tbody>
				{#each data.byUser as row (row.username)}
					<tr>
						<td>{row.username}</td>
						<td>{fmt(row.calls)}</td>
						<td>{fmt(row.prompt)} / {fmt(row.completion)}</td>
						<td>{money(row.cost)}</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<h3>By day</h3>
		<table>
			<thead>
				<tr><th>Day</th><th>Calls</th><th>Tokens in/out</th><th>Cost</th></tr>
			</thead>
			<tbody>
				{#each data.byDay as row (row.day)}
					<tr>
						<td>{row.day}</td>
						<td>{fmt(row.calls)}</td>
						<td>{fmt(row.prompt)} / {fmt(row.completion)}</td>
						<td>{money(row.cost)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.bar {
		margin-bottom: 0.8rem;
	}
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
	}
	.tiles {
		display: flex;
		gap: 0.7rem;
		flex-wrap: wrap;
		margin-bottom: 1.1rem;
	}
	.tile {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.7rem 1rem;
		min-width: 8rem;
	}
	.tile span {
		display: block;
		font-size: 1.15rem;
		color: var(--accent);
	}
	.tile small {
		font-size: 0.65rem;
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	h3 {
		font-size: 0.75rem;
		color: var(--fg-dim);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		margin: 1.1rem 0 0.4rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.35rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--fg-dim);
		font-weight: normal;
	}
	.err {
		color: var(--danger);
	}
	.empty {
		color: var(--fg-dim);
	}
</style>
