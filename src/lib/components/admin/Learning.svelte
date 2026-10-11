<script lang="ts">
	interface UserStatus {
		userId: string;
		username: string;
		lastRun: number;
		nextDue: number;
		enabled: boolean;
		entries: number;
		waiting: number;
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

	let profile = $state({ enabled: true, intervalHours: 12, timeoutSeconds: 180, briefChars: 2400 });
	let userStatus = $state<UserStatus[]>([]);
	let candidates = $state<Candidate[]>([]);
	let expandedCand = $state<string | null>(null);
	let busy = $state(false);
	let notice = $state<string | null>(null);
	let noticeFailed = $state(false);

	async function load() {
		const [status, settings] = await Promise.all([
			fetch('/api/admin/learning').then((r) => r.json()),
			fetch('/api/admin/settings').then((r) => r.json())
		]);
		profile = { ...settings.profile };
		userStatus = status.userStatus;
		candidates = status.candidates;
	}
	$effect(() => {
		void load();
	});

	const put = (key: string, value: unknown) =>
		fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key, value })
		})
			.then((r) => r.ok)
			.catch(() => false);

	async function saveSettings() {
		const saved = await put('profile', profile);
		notice = saved ? 'Saved' : 'Not saved. Try again.';
		noticeFailed = !saved;
		await load();
	}

	async function runOptimiser() {
		busy = true;
		notice = null;
		noticeFailed = false;
		const result = await (
			await fetch('/api/admin/skills/optimise', { method: 'POST' })
		).json();
		busy = false;
		notice = result.ran
			? `Optimiser proposed ${result.candidates ?? 0} candidate(s)`
			: `Skipped: ${result.reason}`;
		await load();
	}

	async function decide(c: Candidate, action: 'approve' | 'reject') {
		await fetch(`/api/admin/skills/candidates/${c.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action })
		});
		await load();
	}

	interface Probe {
		ran: boolean;
		reason?: string;
		results?: { question: string; flagged: string[]; excerpt: string }[];
		flagged?: number;
		asked?: number;
		stopped?: string;
		blockChars?: number;
		tokens?: { prompt: number; completion: number } | null;
	}
	let probe = $state<Probe | null>(null);
	let probing = $state(false);

	async function runProbe() {
		probing = true;
		probe = null;
		const res = await fetch('/api/admin/profile/probe', { method: 'POST' }).catch(() => null);
		probing = false;
		probe = res?.ok ? await res.json() : { ran: false, reason: 'The check did not run. Try again.' };
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
	const pending = $derived(candidates.filter((c) => c.status === 'pending'));
	const decided = $derived(candidates.filter((c) => c.status !== 'pending'));
</script>

<section>
	{#if notice}<p class="notice" class:error={noticeFailed} role={noticeFailed ? 'alert' : 'status'}>{notice}</p>{/if}

	<article class="card">
		<h3>Profile</h3>
		<div class="grid">
			<label class="row">
				<input type="checkbox" bind:checked={profile.enabled} /> learn from conversations automatically
			</label>
			<label>
				every (hours)
				<input type="number" min="1" max="168" bind:value={profile.intervalHours} />
			</label>
			<label>
				time limit (seconds)
				<input type="number" min="30" max="900" bind:value={profile.timeoutSeconds} />
			</label>
			<label>
				pinned brief (characters)
				<input type="number" min="800" max="4000" step="100" bind:value={profile.briefChars} />
			</label>
		</div>
		<div class="row-buttons">
			<button class="btn primary" onclick={saveSettings}>Save</button>
			<button class="btn" disabled={busy} onclick={runOptimiser}>
				{busy ? 'Running…' : 'Run skill optimiser'}
			</button>
		</div>
		<p class="hint">
			Applies to every user. Learning reads each person's own messages, never hidden chats and
			never tool output, and only proposes: they approve, edit or reject each line on their
			Profile page, and nothing reaches their agents before that. Each person can turn it off for
			themselves, or run it on demand.
		</p>
		<p class="hint">
			The pinned brief reaches every agent on every turn; lowering it unpins nothing, but no
			one can pin more until they are back under. The time limit is the whole of one model call:
			a background call is not streamed, so unlike a chat turn it gets no allowance for going
			quiet.
		</p>
	</article>

	<article class="card">
		<h3>Per-user status</h3>
		<p class="hint">
			A profile is private to its person and is not readable here: this is timing and counts
			only, for troubleshooting.
		</p>
		<table>
			<thead>
				<tr><th>User</th><th>Learning</th><th>Entries</th><th>Waiting</th><th>Last run</th><th>Next due</th></tr>
			</thead>
			<tbody>
				{#each userStatus as s (s.userId)}
					<tr class:off={!s.enabled}>
						<td>{s.username}</td>
						<td>{s.enabled ? 'on' : 'turned off'}</td>
						<td class="num">{s.entries}</td>
						<td class="num">{s.waiting}</td>
						<td class="num">{when(s.lastRun)}</td>
						<td class="num">{s.enabled && profile.enabled ? when(s.nextDue) : '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="hint">No users yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</article>

	<article class="card probe">
		<h3>Does the profile intrude?</h3>
		<p class="hint">
			Asks the chat model twelve everyday questions a profile has no bearing on, with your own profile
			in the prompt, and counts the replies that name one of your people or reach for a word from
			your pinned brief. A word match is crude, so each flag shows what matched. Twelve chat calls,
			one at a time, counted against the budget like any other.
		</p>
		<button class="btn" disabled={probing} onclick={runProbe}>
			{probing ? 'Asking…' : 'Run the check'}
		</button>
		{#if probe && !probe.ran}
			<p class="notice error" role="alert">{probe.reason}</p>
		{:else if probe?.results}
			<p class="notice" role="status">
				{probe.flagged} of {probe.asked} replies intruded{probe.stopped ? `; it stopped early: ${probe.stopped}` : ''}.
				Your block is {probe.blockChars?.toLocaleString('en-NZ')} characters{probe.tokens
					? `; ${probe.tokens.prompt.toLocaleString('en-NZ')} prompt and ${probe.tokens.completion.toLocaleString('en-NZ')} completion tokens in all`
					: ''}.
			</p>
			<table>
				<thead><tr><th>Question</th><th>What intruded</th></tr></thead>
				<tbody>
					{#each probe.results as r (r.question)}
						<tr class:intruded={r.flagged.length > 0}>
							<td>
								{r.question}
								{#if r.flagged.length}<div class="excerpt">{r.excerpt}</div>{/if}
							</td>
							<td>{r.flagged.join(', ') || 'nothing'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
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
				git-versioned), belonging to the person it was learnt from, who can also approve it
				themselves on their Profile page. Share it from Skills to give it to everyone; nothing
				activates without a person approving it.
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
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
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
		margin: 0.5rem 0 0;
	}
	.link {
		font-size: var(--text-sm);
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
	.probe table {
		margin-top: 0.6rem;
	}
	tr.intruded td {
		color: var(--danger);
	}
	.excerpt {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin-top: 0.2rem;
	}
	details summary {
		font-size: var(--text-base);
		color: var(--fg-dim);
		cursor: pointer;
		margin-top: 0.5rem;
	}
</style>
