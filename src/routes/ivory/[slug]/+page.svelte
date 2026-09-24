<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Markdown from '$lib/components/Markdown.svelte';

	interface Entry {
		path: string;
		name: string;
		url: string;
	}
	interface Claim extends Entry {
		id: string;
		title: string;
		status: string;
	}
	interface Issue {
		number: number;
		title: string;
		url: string;
		labels: string[];
		agent: string | null;
	}
	interface ProjectView {
		repo: string;
		project: {
			slug: string;
			title: string;
			disciplines: string[];
			board: string;
			validationTier: string;
		};
		briefBody: string;
		briefUrl: string;
		notes: Entry[];
		claims: Claim[];
		projectIssue: number | null;
		issues: Issue[];
		issuesUrl: string;
	}

	interface PlannedTask {
		title: string;
		body: string;
		agent: string;
		rationale: string;
	}
	interface PendingPlan {
		chatId: string;
		proposal: { tasks: PlannedTask[]; proposedBy: string; at: number };
	}
	const PLAN_AGENTS = ['ivory-read', 'ivory-synthesise', 'ivory-redteam', 'none'];

	const slug = $derived(page.params.slug);
	let view = $state<ProjectView | null>(null);
	let failure = $state<string | null>(null);

	async function load(s: string) {
		failure = null;
		const res = await fetch(`/api/ivory/projects/${encodeURIComponent(s)}`);
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			failure = body.message ?? `The project could not be read (${res.status})`;
			return;
		}
		view = body;
		await loadPlans(s);
	}

	let plans = $state<PendingPlan[]>([]);
	let planBusy = $state<string | null>(null);
	let planMsg = $state<string | null>(null);
	/**
	 * What the last approval put on the board, kept on screen until dismissed.
	 * A one-line "2 task(s) added" with no links was all an approval used to
	 * leave behind, and when the list below had not caught up either, the
	 * owner had no way to find the tasks at all.
	 */
	let approved = $state<{ created: { number: number; url: string; title: string }[]; failed?: string } | null>(
		null
	);

	async function loadPlans(s: string) {
		const res = await fetch(`/api/ivory/projects/${encodeURIComponent(s)}/plans`);
		plans = res.ok ? await res.json() : [];
	}

	async function startPlan() {
		planBusy = 'start';
		planMsg = null;
		const res = await fetch(`/api/ivory/projects/${encodeURIComponent(slug ?? '')}/plan`, { method: 'POST' });
		const body = await res.json().catch(() => ({}));
		planBusy = null;
		if (!res.ok) {
			planMsg = body.message ?? `The planner did not start (${res.status})`;
			return;
		}
		await goto(`/chat?chat=${body.chatId}`);
	}

	async function decide(plan: PendingPlan, decision: 'approve' | 'reject') {
		if (decision === 'reject' && !confirm('Reject this plan? Nothing will be added to the board.')) return;
		planBusy = plan.chatId;
		planMsg = null;
		approved = null;
		const res = await fetch(`/api/ivory/plans/${plan.chatId}/${decision}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: decision === 'approve' ? JSON.stringify({ tasks: plan.proposal.tasks }) : undefined
		});
		const body = await res.json().catch(() => ({}));
		planBusy = null;
		if (!res.ok) {
			planMsg = body.message ?? `That did not work (${res.status})`;
			return;
		}
		if (decision === 'reject') planMsg = 'Plan rejected. Nothing was added to the board.';
		else approved = { created: body.created, failed: body.failed };
		if (slug) await load(slug);
	}

	$effect(() => {
		if (slug) void load(slug);
	});

	/** The agents that can be started from here. The rest are labels for later phases. */
	const RUNNABLE = new Set(['ivory-read']);
	let starting = $state<number | null>(null);
	let runFailure = $state<string | null>(null);

	async function run(issue: Issue) {
		starting = issue.number;
		runFailure = null;
		const res = await fetch(
			`/api/ivory/projects/${encodeURIComponent(slug ?? '')}/issues/${issue.number}/run`,
			{ method: 'POST' }
		);
		const body = await res.json().catch(() => ({}));
		starting = null;
		if (!res.ok) {
			runFailure = body.message ?? `The run did not start (${res.status})`;
			return;
		}
		// The run is an ordinary chat, so it is followed there.
		await goto(`/chat?chat=${body.chatId}`);
	}
</script>

<div class="ivory-page">
	<header>
		<a class="back" href="/ivory">← Shelf</a>
		{#if view}
			<div class="title-row">
				<h2>{view.project.title}</h2>
				<button class="run" disabled={planBusy !== null} onclick={startPlan}>
					{planBusy === 'start' ? 'Starting…' : 'Plan tasks'}
				</button>
			</div>
			<p class="tags">
				{#each view.project.disciplines as d (d)}<span class="tag">{d}</span>{/each}
				{#if view.project.validationTier}<span class="tier">tier: {view.project.validationTier}</span>{/if}
			</p>
		{/if}
	</header>

	{#if failure}
		<p class="notice error" role="alert">{failure}</p>
	{:else if !view}
		<p class="notice">Reading the project…</p>
	{:else}
		{#if planMsg}<p class="notice" role="status">{planMsg}</p>{/if}
		{#if approved}
			<section class="approved" role="status" aria-label="Added to the board">
				<h3>Added to the board</h3>
				<ul>
					{#each approved.created as c (c.number)}
						<li>
							<a href={c.url} target="_blank" rel="noopener"><span class="num">#{c.number}</span> {c.title}</a>
						</li>
					{/each}
				</ul>
				<p class="plan-meta">
					They are GitHub issues on the Shelf, listed under Tasks below.
					{#if approved.failed}The rest could not be created ({approved.failed}) and are still waiting for approval.{/if}
				</p>
				<button class="link" onclick={() => (approved = null)}>Dismiss</button>
			</section>
		{/if}
		{#each plans as plan (plan.chatId)}
			<section class="plan" aria-label="Plan waiting for approval">
				<h3>Plan waiting for approval</h3>
				<p class="plan-meta">
					{plan.proposal.proposedBy} · {new Date(plan.proposal.at).toLocaleString()} ·
					<a href="/chat?chat={plan.chatId}">how it was made</a>
				</p>
				<ol>
					{#each plan.proposal.tasks as task, i (i)}
						<li class="planned">
							<div class="planned-head">
								<input bind:value={task.title} aria-label="Title of task {i + 1}" />
								<select bind:value={task.agent} aria-label="Agent for task {i + 1}">
									{#each PLAN_AGENTS as a (a)}<option value={a}>{a}</option>{/each}
								</select>
								<button class="link" onclick={() => plan.proposal.tasks.splice(i, 1)}>Remove</button>
							</div>
							<textarea bind:value={task.body} rows="4" aria-label="Body of task {i + 1}"></textarea>
							<p class="why">Why: {task.rationale}</p>
						</li>
					{/each}
				</ol>
				<div class="plan-actions">
					<button
						class="run primary"
						disabled={planBusy !== null || !plan.proposal.tasks.length}
						onclick={() => decide(plan, 'approve')}
					>
						{planBusy === plan.chatId ? 'Working…' : `Approve and create ${plan.proposal.tasks.length} issue(s)`}
					</button>
					<button class="run" disabled={planBusy !== null} onclick={() => decide(plan, 'reject')}>Reject</button>
				</div>
			</section>
		{/each}
		<section class="tasks">
			<div class="tasks-head">
				<h3>Tasks ({view.issues.length} open)</h3>
				<a href={view.issuesUrl} target="_blank" rel="noopener">All of this project's issues on GitHub</a>
			</div>
			{#if plans.length}
				<p class="plan-meta">
					{plans.length} plan{plans.length === 1 ? '' : 's'} waiting for approval above.
				</p>
			{/if}
			{#if runFailure}<p class="notice error" role="alert">{runFailure}</p>{/if}
			{#if view.issues.length}
				<ul>
					{#each view.issues as issue (issue.number)}
						<li class="issue">
							<a href={issue.url} target="_blank" rel="noopener">
								<span class="num">#{issue.number}</span>
								{issue.title}
							</a>
							{#if issue.agent}<span class="tag">{issue.agent}</span>{/if}
							{#if issue.agent && RUNNABLE.has(issue.agent)}
								<button
									class="run"
									disabled={starting !== null}
									onclick={() => run(issue)}
									aria-label="Run {issue.agent} on #{issue.number}"
								>
									{starting === issue.number ? 'Starting…' : 'Run'}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="empty">
					No open issues labelled <code>project:{view.project.slug}</code>. “Plan tasks” proposes some.
				</p>
			{/if}
		</section>
		<div class="columns">
			<article class="brief">
				<p class="source"><a href={view.briefUrl} target="_blank" rel="noopener">brief.md on GitHub</a></p>
				<Markdown text={view.briefBody} />
			</article>

			<aside>
				<section>
					<h3>Claims</h3>
					{#if view.claims.length}
						<ul>
							{#each view.claims as c (c.path)}
								<li>
									<a href={c.url} target="_blank" rel="noopener">{c.title || c.id || c.name}</a>
									<span class="status status-{c.status}">{c.status}</span>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="empty">No claims yet.</p>
					{/if}
				</section>

				<section>
					<h3>Notes</h3>
					{#if view.notes.length}
						<ul>
							{#each view.notes as n (n.path)}
								<li><a href={n.url} target="_blank" rel="noopener">{n.name}</a></li>
							{/each}
						</ul>
					{:else}
						<p class="empty">No notes yet.</p>
					{/if}
				</section>
			</aside>
		</div>
	{/if}
</div>

<style>
	.ivory-page {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	header {
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.6rem;
		margin-bottom: 0.8rem;
	}
	.back {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	h2 {
		margin: 0.3rem 0;
		font-size: var(--text-lg);
		color: var(--heading);
	}
	h3 {
		margin: 0 0 0.4rem;
		font-size: var(--text-sm);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 0;
	}
	.tag,
	.tier,
	.status {
		font-size: var(--text-xs);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0 0.35rem;
		color: var(--fg-dim);
	}
	.status-survived {
		color: var(--accent);
		border-color: var(--accent);
	}
	.status-refuted {
		color: var(--danger);
		border-color: var(--danger);
	}
	.notice {
		color: var(--fg-dim);
		max-width: 60ch;
	}
	.notice.error {
		color: var(--danger);
	}
	.columns {
		display: flex;
		gap: 1.5rem;
		flex-wrap: wrap;
		align-items: flex-start;
	}
	.brief {
		flex: 2 1 28rem;
		min-width: 0;
	}
	.source {
		font-size: var(--text-sm);
		margin: 0 0 0.5rem;
	}
	aside {
		flex: 1 1 18rem;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.num {
		font-family: var(--font-mono);
		color: var(--fg-dim);
	}
	.run {
		background: var(--border);
		color: var(--fg);
		border: 1px solid var(--control-border);
		border-radius: 5px;
		padding: 0.15rem 0.6rem;
		font-family: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
		min-height: 2rem;
	}
	.run.primary {
		border-color: var(--accent);
	}
	.title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.tasks {
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.8rem;
		margin-bottom: 1rem;
	}
	.tasks-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.8rem;
		flex-wrap: wrap;
		font-size: var(--text-sm);
	}
	.approved {
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		padding: 0.8rem;
		margin-bottom: 1rem;
	}
	.approved ul {
		margin-bottom: 0.5rem;
	}
	.plan {
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		padding: 0.8rem;
		margin-bottom: 1rem;
	}
	.plan-meta,
	.why {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin: 0 0 0.5rem;
	}
	.plan ol {
		margin: 0 0 0.6rem;
		padding-left: 1.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.planned {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.35rem;
	}
	.planned-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.planned input {
		flex: 1 1 16rem;
	}
	.planned input,
	.planned select,
	.planned textarea {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.3rem 0.45rem;
		min-width: 0;
		box-sizing: border-box;
	}
	.planned textarea {
		width: 100%;
		resize: vertical;
	}
	.link {
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-sm);
		text-decoration: underline;
		cursor: pointer;
		min-height: 2rem;
	}
	.plan-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.run:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.empty {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin: 0;
	}
</style>
