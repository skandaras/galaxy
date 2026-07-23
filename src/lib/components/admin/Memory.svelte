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
		category: string;
		description: string;
		triggers: string;
		body: string;
		rationale: string;
		status: 'pending' | 'approved' | 'rejected';
	}

	let settings = $state({ enabled: true, intervalHours: 12 });
	let lastRun = $state(0);
	let nextDue = $state(0);
	let items = $state<MemoryItem[]>([]);
	let candidates = $state<Candidate[]>([]);
	let expandedCand = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let notice = $state<string | null>(null);

	async function load() {
		const data = await (await fetch('/api/admin/memory')).json();
		settings = { ...data.settings };
		lastRun = data.lastRun;
		nextDue = data.nextDue;
		items = data.items;
		candidates = data.candidates;
	}
	$effect(() => {
		void load();
	});

	async function saveSettings() {
		await fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key: 'memory', value: settings })
		});
		notice = 'Settings saved';
		await load();
	}

	async function run(kind: 'memory' | 'optimise') {
		busy = kind;
		notice = null;
		const res = await fetch(`/api/admin/memory/run${kind === 'optimise' ? '?kind=optimise' : ''}`, {
			method: 'POST'
		});
		const result = await res.json();
		busy = null;
		notice = result.ran
			? `Run complete: ${result.memories ?? 0} memories, ${result.candidates ?? 0} skill candidates`
			: `Skipped: ${result.reason}`;
		await load();
	}

	async function itemAction(item: MemoryItem, method: 'PATCH' | 'DELETE') {
		await fetch(`/api/admin/memory/items/${item.id}`, { method });
		await load();
	}

	async function decide(c: Candidate, action: 'approve' | 'reject') {
		await fetch(`/api/admin/memory/candidates/${c.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action })
		});
		await load();
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
	const pending = $derived(candidates.filter((c) => c.status === 'pending'));
	const decided = $derived(candidates.filter((c) => c.status !== 'pending'));
</script>

<section>
	{#if notice}<p class="notice">{notice}</p>{/if}

	<article class="card">
		<h3>Schedule</h3>
		<div class="grid">
			<label class="row"><input type="checkbox" bind:checked={settings.enabled} /> run automatically</label>
			<label>
				every (hours)
				<input type="number" min="1" max="168" bind:value={settings.intervalHours} />
			</label>
			<div class="status">
				<div>last run: {when(lastRun)}</div>
				<div>next due: {settings.enabled ? when(nextDue) : '—'}</div>
			</div>
		</div>
		<div class="row-buttons">
			<button class="btn primary" onclick={saveSettings}>Save</button>
			<button class="btn" disabled={busy !== null} onclick={() => run('memory')}>
				{busy === 'memory' ? 'Running…' : 'Run memory audit now'}
			</button>
			<button class="btn" disabled={busy !== null} onclick={() => run('optimise')}>
				{busy === 'optimise' ? 'Running…' : 'Run skill optimiser'}
			</button>
		</div>
		<p class="hint">
			The audit only reads activity newer than the watermark and skips entirely when nothing
			happened. Hidden chats are excluded by construction.
		</p>
	</article>

	<article class="card">
		<h3>Skill candidates {pending.length ? `(${pending.length} pending)` : ''}</h3>
		{#each pending as c (c.id)}
			<div class="cand">
				<div class="cand-head">
					<span class="cand-name">{c.name}</span>
					<span class="cand-cat">{c.category}</span>
					<span class="spacer"></span>
					<button class="btn primary" onclick={() => decide(c, 'approve')}>Approve</button>
					<button class="btn danger" onclick={() => decide(c, 'reject')}>Reject</button>
				</div>
				<div class="cand-desc">{c.description}</div>
				<div class="cand-rat">rationale: {c.rationale}</div>
				<button class="link" onclick={() => (expandedCand = expandedCand === c.id ? null : c.id)}>
					{expandedCand === c.id ? 'hide body' : 'show body'}
				</button>
				{#if expandedCand === c.id}<pre class="cand-body">{c.body}</pre>{/if}
			</div>
		{:else}
			<p class="hint">No pending candidates. Approving a candidate creates the real skill (agent-authored, git-versioned); nothing activates without you.</p>
		{/each}
		{#if decided.length}
			<details>
				<summary>{decided.length} decided</summary>
				{#each decided as c (c.id)}
					<div class="decided">{c.status === 'approved' ? '✓' : '✗'} {c.name}</div>
				{/each}
			</details>
		{/if}
	</article>

	<article class="card">
		<h3>Memory items</h3>
		<table>
			<tbody>
				{#each items as item (item.id)}
					<tr class:archived={item.status === 'archived'}>
						<td class="kind">{item.kind}</td>
						<td>{item.content}</td>
						<td class="actions">
							{#if item.status === 'active'}
								<button class="btn" onclick={() => itemAction(item, 'PATCH')}>Archive</button>
							{/if}
							<button class="btn danger" onclick={() => itemAction(item, 'DELETE')}>Delete</button>
						</td>
					</tr>
				{:else}
					<tr><td class="hint">No memories yet — they appear after the first audit with activity.</td></tr>
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
		color: var(--accent);
	}
	.grid {
		display: flex;
		gap: 1.2rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 0.6rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	input[type='number'] {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		padding: 0.3rem 0.5rem;
		width: 5rem;
	}
	.status {
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	.row-buttons {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		margin: 0.5rem 0 0;
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
		padding: 0.32rem 0.65rem;
		font-family: inherit;
		font-size: 0.72rem;
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
	.btn:disabled {
		opacity: 0.5;
	}
	.link {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.7rem;
		font-family: inherit;
		padding: 0;
	}

	.cand {
		border-top: 1px solid var(--border);
		padding: 0.6rem 0;
	}
	.cand-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.cand-name {
		font-size: 0.82rem;
		color: var(--fg);
	}
	.cand-cat {
		font-size: 0.62rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 0.3rem;
		color: var(--fg-dim);
	}
	.spacer {
		flex: 1;
	}
	.cand-desc {
		font-size: 0.75rem;
		margin-top: 0.25rem;
	}
	.cand-rat {
		font-size: 0.68rem;
		color: var(--fg-dim);
		font-style: italic;
		margin: 0.15rem 0 0.25rem;
	}
	.cand-body {
		background: var(--bg-pane);
		border-radius: 6px;
		font-size: 0.7rem;
		padding: 0.6rem;
		overflow-x: auto;
	}
	.decided {
		font-size: 0.72rem;
		color: var(--fg-dim);
		padding: 0.15rem 0;
	}
	details summary {
		font-size: 0.72rem;
		color: var(--fg-dim);
		cursor: pointer;
		margin-top: 0.5rem;
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
		opacity: 0.45;
	}
	.kind {
		color: var(--accent);
		font-size: 0.68rem;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.actions {
		white-space: nowrap;
		text-align: right;
	}
</style>
