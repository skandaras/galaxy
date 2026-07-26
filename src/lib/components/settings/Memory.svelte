<script lang="ts">
	interface MemoryItem {
		id: string;
		kind: string;
		content: string;
		source: string | null;
		status: 'active' | 'archived';
		createdAt: number;
	}
	interface Candidate {
		id: string;
		name: string;
		description: string;
		status: 'pending' | 'approved' | 'rejected';
	}

	let items = $state<MemoryItem[]>([]);
	let myCandidates = $state<Candidate[]>([]);
	let enabled = $state(true);
	let scheduleEnabled = $state(true);
	let intervalHours = $state(12);
	let lastRun = $state(0);
	let nextDue = $state(0);
	let busy = $state(false);
	let notice = $state<string | null>(null);

	async function load() {
		const data = await (await fetch('/api/memory')).json();
		items = data.items;
		myCandidates = data.myCandidates ?? [];
		enabled = data.enabled;
		scheduleEnabled = data.scheduleEnabled;
		intervalHours = data.intervalHours;
		lastRun = data.lastRun;
		nextDue = data.nextDue;
	}
	$effect(() => {
		void load();
	});

	async function toggleEnabled() {
		const next = !enabled;
		const res = await fetch('/api/memory/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: next })
		});
		if (res.ok) enabled = next;
	}

	async function runNow() {
		busy = true;
		notice = null;
		const result = await (await fetch('/api/memory/run', { method: 'POST' })).json();
		busy = false;
		notice = result.ran
			? `Found ${result.memories ?? 0} new ${result.memories === 1 ? 'memory' : 'memories'}${result.candidates ? `, ${result.candidates} skill candidate(s)` : ''}`
			: `Nothing to do: ${result.reason}`;
		await load();
	}

	async function act(item: MemoryItem, method: 'PATCH' | 'DELETE') {
		await fetch(`/api/memory/items/${item.id}`, { method });
		await load();
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
	const active = $derived(items.filter((i) => i.status === 'active'));
	const archived = $derived(items.filter((i) => i.status === 'archived'));
</script>

<section class="memory-section">
	{#if notice}<p class="notice">{notice}</p>{/if}

	<article class="card">
		<h3>Your memory</h3>
		<p class="hint">
			Every {intervalHours}h the memory agent reviews <em>your</em> recent chats and coding
			sessions and notes durable preferences, patterns and facts. Those notes are added to your
			agents' context so they remember how you like to work. They are private to you — nobody
			else, including admins, can read them. Hidden chats are never looked at.
		</p>
		<div class="row">
			<label class="chk">
				<input type="checkbox" checked={enabled} onchange={toggleEnabled} />
				keep building my memory
			</label>
			<button class="btn" disabled={busy} onclick={runNow}>
				{busy ? 'Reviewing…' : 'Run now'}
			</button>
			<span class="meta">
				last run {when(lastRun)}
				{#if enabled && scheduleEnabled} · next {when(nextDue)}{/if}
				{#if !scheduleEnabled} · automatic runs are off platform-wide{/if}
			</span>
		</div>
	</article>

	<article class="card">
		<h3>What it remembers {active.length ? `(${active.length})` : ''}</h3>
		<table>
			<tbody>
				{#each active as item (item.id)}
					<tr>
						<td class="kind">{item.kind}</td>
						<td>{item.content}</td>
						<td class="actions">
							<button class="btn" onclick={() => act(item, 'PATCH')}>Archive</button>
							<button class="btn danger" onclick={() => act(item, 'DELETE')}>Delete</button>
						</td>
					</tr>
				{:else}
					<tr>
						<td class="hint">
							Nothing yet — memories appear after an audit finds something worth keeping.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if archived.length}
			<details>
				<summary>{archived.length} archived</summary>
				<table>
					<tbody>
						{#each archived as item (item.id)}
							<tr class="archived">
								<td class="kind">{item.kind}</td>
								<td>{item.content}</td>
								<td class="actions">
									<button class="btn danger" onclick={() => act(item, 'DELETE')}>Delete</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	</article>

	{#if myCandidates.length}
		<article class="card">
			<h3>Skills your activity proposed</h3>
			<p class="hint">
				Skills are shared platform-wide, so an admin approves these before they become active.
				Shown here so you can see what was suggested from your work.
			</p>
			{#each myCandidates as c (c.id)}
				<div class="cand">
					<span class="cand-name">{c.name}</span>
					<span class="cand-desc">{c.description}</span>
					<span class="cand-status {c.status}">{c.status}</span>
				</div>
			{/each}
		</article>
	{/if}
</section>

<style>
	.memory-section {
		max-width: 46rem;
	}
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
		font-size: 0.72rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0 0 0.7rem;
	}
	.notice {
		color: var(--accent);
		font-size: 0.75rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.chk {
		font-size: 0.75rem;
		color: var(--fg-dim);
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.meta {
		font-size: 0.68rem;
		color: var(--fg-dim);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}
	td {
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	tr.archived td {
		opacity: 0.5;
	}
	.kind {
		color: var(--accent);
		font-size: 0.65rem;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.actions {
		white-space: nowrap;
		text-align: right;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.3rem 0.6rem;
		font-family: inherit;
		font-size: 0.7rem;
		cursor: pointer;
	}
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
	.btn:disabled {
		opacity: 0.5;
	}
	details summary {
		font-size: 0.72rem;
		color: var(--fg-dim);
		cursor: pointer;
		margin-top: 0.6rem;
	}
	.cand {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.35rem 0;
		border-top: 1px solid var(--border);
		font-size: 0.75rem;
	}
	.cand-name {
		color: var(--fg);
	}
	.cand-desc {
		flex: 1;
		color: var(--fg-dim);
		font-size: 0.7rem;
	}
	.cand-status {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--fg-dim);
	}
	.cand-status.approved {
		color: var(--accent);
	}
	.cand-status.rejected {
		color: var(--danger);
	}
</style>
