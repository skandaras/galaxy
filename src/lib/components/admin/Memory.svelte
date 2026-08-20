<script lang="ts">
	interface UserStatus {
		userId: string;
		username: string;
		lastRun: number;
		nextDue: number;
		enabled: boolean;
		activeItems: number;
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
		proposedBy: string;
	}

	let settings = $state({ enabled: true, intervalHours: 12 });
	let userStatus = $state<UserStatus[]>([]);
	let candidates = $state<Candidate[]>([]);
	let expandedCand = $state<string | null>(null);
	let busy = $state(false);
	let notice = $state<string | null>(null);

	async function load() {
		const data = await (await fetch('/api/admin/memory')).json();
		settings = { ...data.settings };
		userStatus = data.userStatus;
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
		notice = 'Schedule saved';
		await load();
	}

	async function runOptimiser() {
		busy = true;
		notice = null;
		const result = await (
			await fetch('/api/admin/memory/run?kind=optimise', { method: 'POST' })
		).json();
		busy = false;
		notice = result.ran
			? `Optimiser proposed ${result.candidates ?? 0} candidate(s)`
			: `Skipped: ${result.reason}`;
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
			<label class="row">
				<input type="checkbox" bind:checked={settings.enabled} /> run audits automatically
			</label>
			<label>
				every (hours)
				<input type="number" min="1" max="168" bind:value={settings.intervalHours} />
			</label>
		</div>
		<div class="row-buttons">
			<button class="btn primary" onclick={saveSettings}>Save</button>
			<button class="btn" disabled={busy} onclick={runOptimiser}>
				{busy ? 'Running…' : 'Run skill optimiser'}
			</button>
		</div>
		<p class="hint">
			Applies to every user. Each person can opt their own audit out and run it on demand from
			Settings → Memory; an audit only reads that user's own activity, and never hidden chats.
		</p>
	</article>

	<article class="card">
		<h3>Per-user status</h3>
		<p class="hint">
			Memories are private to each user and are not readable here — this is timing and counts
			only, for troubleshooting.
		</p>
		<table>
			<thead>
				<tr><th>User</th><th>Auto</th><th>Memories</th><th>Last run</th><th>Next due</th></tr>
			</thead>
			<tbody>
				{#each userStatus as s (s.userId)}
					<tr class:off={!s.enabled}>
						<td>{s.username}</td>
						<td>{s.enabled ? 'on' : 'opted out'}</td>
						<td class="num">{s.activeItems}</td>
						<td class="num">{when(s.lastRun)}</td>
						<td class="num">{s.enabled && settings.enabled ? when(s.nextDue) : '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="hint">No users yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</article>

	<article class="card">
		<h3>Skill candidates {pending.length ? `(${pending.length} pending)` : ''}</h3>
		{#each pending as c (c.id)}
			<div class="cand">
				<div class="cand-head">
					<span class="cand-name">{c.name}</span>
					<span class="cand-cat">{c.category}</span>
					<span class="cand-by">from {c.proposedBy}</span>
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
			<p class="hint">
				No pending candidates. Approving one creates the real skill (agent-authored,
				git-versioned); nothing activates without you.
			</p>
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
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
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
		font-size: var(--text-sm);
		color: var(--label);
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
	.row-buttons {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.hint {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.5rem 0 0;
	}
	.notice {
		color: var(--accent);
		font-size: var(--text-base);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.32rem 0.65rem;
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
	.btn:disabled {
		opacity: 0.5;
	}
	.link {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font-size: var(--text-sm);
		font-family: inherit;
		padding: 0;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-md);
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
	tr.off td {
		opacity: 0.5;
	}
	.cand {
		border-top: 1px solid var(--border);
		padding: 0.6rem 0;
	}
	.cand-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.cand-name {
		font-size: var(--text-md);
		color: var(--fg);
	}
	.cand-cat,
	.cand-by {
		font-size: var(--text-xs);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 0.3rem;
		color: var(--fg-dim);
	}
	.spacer {
		flex: 1;
	}
	.cand-desc {
		font-size: var(--text-base);
		margin-top: 0.25rem;
	}
	.cand-rat {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		font-style: italic;
		margin: 0.15rem 0 0.25rem;
	}
	.cand-body {
		background: var(--bg-pane);
		border-radius: 6px;
		font-size: var(--text-sm);
		padding: 0.6rem;
		overflow-x: auto;
	}
	.decided {
		font-size: var(--text-base);
		color: var(--fg-dim);
		padding: 0.15rem 0;
	}
	details summary {
		font-size: var(--text-base);
		color: var(--fg-dim);
		cursor: pointer;
		margin-top: 0.5rem;
	}
</style>
