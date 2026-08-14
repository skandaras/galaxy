<script lang="ts">
	interface Idea {
		id: string;
		title: string;
		area: string;
		severity: 'low' | 'medium' | 'high';
		effort: 's' | 'm' | 'l';
		problem: string;
		proposal: string;
		evidence: string;
		status: 'open' | 'actioned' | 'discarded';
		createdAt: number;
		decidedAt: number | null;
	}

	let settings = $state({ enabled: true, intervalHours: 168, maxIdeasPerRun: 8 });
	let ideas = $state<Idea[]>([]);
	let environment = $state('dev');
	/** 0 on prod, where the decision history is kept permanently. */
	let pruneDays = $state(0);
	let lastRun = $state(0);
	let nextDue = $state(0);
	let expanded = $state<string | null>(null);
	let busy = $state(false);
	let notice = $state<string | null>(null);

	async function load() {
		const data = await (await fetch('/api/admin/ux')).json();
		settings = { ...data.settings };
		ideas = data.ideas;
		environment = data.environment;
		pruneDays = data.pruneDays;
		lastRun = data.lastRun;
		nextDue = data.nextDue;
	}
	$effect(() => {
		void load();
	});

	async function saveSettings() {
		await fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key: 'uxaudit', value: settings })
		});
		notice = 'Schedule saved';
		await load();
	}

	async function runNow() {
		busy = true;
		notice = null;
		const result = await (await fetch('/api/admin/ux/run', { method: 'POST' })).json();
		busy = false;
		notice = result.ran
			? `Filed ${result.ideas ?? 0} new idea(s)` +
				(result.duplicates ? `, ${result.duplicates} already proposed` : '')
			: `Skipped: ${result.reason}`;
		await load();
	}

	async function decide(idea: Idea, action: 'actioned' | 'discard') {
		await fetch(`/api/admin/ux/ideas/${idea.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action })
		});
		await load();
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
	// Spelled out, because severity and effort share the word "medium" and two
	// bare chips reading "high" and "medium" give no clue which is which.
	const EFFORT = { s: 'small effort', m: 'medium effort', l: 'large effort' } as const;
	const open = $derived(ideas.filter((i) => i.status === 'open'));
	const decided = $derived(ideas.filter((i) => i.status !== 'open'));
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
				<input type="number" min="1" max="8760" bind:value={settings.intervalHours} />
			</label>
			<label>
				max ideas per run
				<input type="number" min="1" max="20" bind:value={settings.maxIdeasPerRun} />
			</label>
		</div>
		<div class="row-buttons">
			<button class="btn primary" onclick={saveSettings}>Save</button>
			<button class="btn" disabled={busy} onclick={runNow}>
				{busy ? 'Reviewing…' : 'Run audit now'}
			</button>
			<span class="meta">last run {when(lastRun)}{settings.enabled ? ` · next due ${when(nextDue)}` : ''}</span>
		</div>
		<p class="hint">
			168 hours is weekly. The audit reads aggregated usage telemetry and the interface source —
			never the content of anyone's chats or coding sessions. Choose its model and edit its brief
			under <strong>Tasks → ux-audit</strong>; a large-context reasoning model suits it best,
			since a run sends most of the UI in one call.
		</p>
	</article>

	<article class="card">
		<h3>
			Backlog {open.length ? `(${open.length} open)` : ''}
			<span class="env" class:prod={environment === 'prod'}>{environment}</span>
		</h3>
		<p class="hint">
			Ideas only — nothing here is ever built automatically. <strong>Actioned</strong> and
			<strong>Discard</strong> both dismiss an idea; the difference is only what it tells the next
			audit, which sees every past decision and won't raise the same thing twice.
		</p>
		<p class="hint">
			This backlog belongs to the <strong>{environment}</strong> instance alone — dev and prod keep
			separate databases, so an idea decided on one is invisible to the other.
			{#if pruneDays > 0}
				Ideas here are dropped after {pruneDays} days, since this instance exists to prove the
				audit still runs rather than to hold a backlog worth keeping.
			{/if}
		</p>
		{#each open as idea (idea.id)}
			<div class="idea">
				<div class="idea-head">
					<span class="idea-title">{idea.title}</span>
					<span class="tag">{idea.area}</span>
					<span class="tag sev-{idea.severity}">{idea.severity}</span>
					<span class="tag">{EFFORT[idea.effort]}</span>
					<span class="spacer"></span>
					<!-- Grouped so the pair wraps together: split across two lines on a
					     phone, "Discard" ends up under an unrelated chip row. -->
					<div class="decide">
						<button class="btn primary" onclick={() => decide(idea, 'actioned')}>Actioned</button>
						<button class="btn danger" onclick={() => decide(idea, 'discard')}>Discard</button>
					</div>
				</div>
				{#if idea.problem}<div class="idea-problem">{idea.problem}</div>{/if}
				{#if idea.proposal}<div class="idea-proposal">→ {idea.proposal}</div>{/if}
				{#if idea.evidence}
					<button class="link" onclick={() => (expanded = expanded === idea.id ? null : idea.id)}>
						{expanded === idea.id ? 'hide evidence' : 'show evidence'}
					</button>
					{#if expanded === idea.id}<pre class="idea-evidence">{idea.evidence}</pre>{/if}
				{/if}
			</div>
		{:else}
			<p class="hint">
				Nothing open. {lastRun
					? 'The last audit found nothing new, or everything it found has been decided.'
					: 'No audit has run yet — use “Run audit now” to try one.'}
			</p>
		{/each}
		{#if decided.length}
			<details>
				<summary>{decided.length} decided</summary>
				{#each decided as idea (idea.id)}
					<div class="decided">
						{idea.status === 'actioned' ? '✓' : '✗'}
						{idea.title}
						<span class="meta">{when(idea.decidedAt ?? 0)}</span>
					</div>
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
		font-size: 0.78rem;
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
		font-size: 0.7rem;
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
		align-items: center;
		flex-wrap: wrap;
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.5rem 0 0;
	}
	.notice {
		color: var(--accent);
		font-size: 0.75rem;
	}
	.meta {
		color: var(--fg-dim);
		font-size: 0.68rem;
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
	.idea {
		border-top: 1px solid var(--border);
		padding: 0.6rem 0;
	}
	.idea-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.idea-title {
		font-size: 0.82rem;
		color: var(--fg);
	}
	.tag {
		font-size: 0.62rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 0.3rem;
		color: var(--fg-dim);
	}
	.tag.sev-high {
		border-color: var(--danger);
		color: var(--danger);
	}
	.tag.sev-medium {
		border-color: var(--accent);
		color: var(--accent);
	}
	.spacer {
		flex: 1;
	}
	.decide {
		display: flex;
		gap: 0.4rem;
	}
	.env {
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 0.3rem;
		margin-left: 0.4rem;
		color: var(--fg-dim);
	}
	.env.prod {
		border-color: var(--accent);
		color: var(--accent);
	}
	.idea-problem {
		font-size: 0.75rem;
		margin-top: 0.3rem;
		line-height: 1.5;
	}
	.idea-proposal {
		font-size: 0.75rem;
		color: var(--fg-dim);
		margin: 0.2rem 0 0.3rem;
		line-height: 1.5;
	}
	.idea-evidence {
		background: var(--bg-pane);
		border-radius: 6px;
		font-size: 0.7rem;
		padding: 0.6rem;
		overflow-x: auto;
		white-space: pre-wrap;
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
</style>
