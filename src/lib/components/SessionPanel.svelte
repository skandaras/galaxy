<script lang="ts">
	/**
	 * What a coding session is working on, with, and towards: the column beside
	 * the thread on a wide screen and a sheet over it on anything narrower.
	 *
	 * Most of this was already on the server and never reached the screen: the
	 * agent's checklist, the files it wrote, the hook results, how full the
	 * model's context was. The rest moved here from the header, where repo,
	 * branch and the agent readout took the room the session title needed.
	 */
	import type { Snippet } from 'svelte';
	import { swipeToClose } from '$lib/list-sheet.svelte';
	import type { TimelineItem } from '$lib/run-timeline';
	import {
		contextShare,
		formatAgo,
		formatElapsed,
		mergeOutputs,
		planProgress,
		prNumber,
		type AgentRow,
		type SessionOverview
	} from '$lib/session-panel';

	interface Props {
		overview: SessionOverview | null;
		/** The latest fetch failed. A previous overview, if any, stays on screen. */
		failed: boolean;
		onretry: () => void;
		/** The run in flight, for files written since the last stored snapshot. */
		timeline: TimelineItem[];
		streaming: boolean;
		runStartedAt: number | null;
		/** One line on what the main agent is doing, from the page's timeline. */
		activity: string;
		/** The run is waiting on the person's answer, not working. */
		parked: boolean;
		agents: AgentRow[];
		onopenfile: (path: string) => void;
		/** Drawn as a sheet over the thread rather than a column beside it. */
		sheet: boolean;
		/** Whether the sheet is out. Ignored as a column, which is shown or not by the page. */
		open: boolean;
		onclose: () => void;
		/** The column's width in px, from the page's drag handle. */
		width: number;
	}
	let {
		overview,
		failed,
		onretry,
		timeline,
		streaming,
		runStartedAt,
		activity,
		parked,
		agents,
		onopenfile,
		sheet,
		open,
		onclose,
		width
	}: Props = $props();

	/**
	 * Which sections are folded. Context and Connectors start folded, as they do
	 * in the panel this follows: their summaries say most of it. Not remembered
	 * between visits, like the library's folders.
	 */
	let shut = $state<Record<string, boolean>>({ context: true, connectors: true });
	const toggle = (id: string) => (shut[id] = !shut[id]);

	/**
	 * One clock for the elapsed and "ago" figures: every second while a run is
	 * going, every half minute otherwise, where nothing finer than minutes shows.
	 */
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), streaming ? 1000 : 30_000);
		return () => clearInterval(timer);
	});

	const liveAgents = $derived(agents.filter((a) => a.status === 'running'));
	const finishedAgents = $derived(agents.length - liveAgents.length);
	/** Defensive: toolConcurrency caps dispatches at 4, but not from in here. */
	const MAX_AGENT_ROWS = 4;
	const shownAgents = $derived(liveAgents.slice(0, MAX_AGENT_ROWS));
	const hiddenAgents = $derived(liveAgents.length - shownAgents.length);
	const agentCount = $derived(streaming ? 1 + liveAgents.length : 0);

	const context = $derived(overview?.context ?? null);
	const share = $derived(context ? contextShare(context.usedTokens, context.contextWindow) : null);
	const outputs = $derived(mergeOutputs(overview?.filesChanged ?? [], timeline));
	const totals = $derived(overview?.changes.totals ?? null);
	const pr = $derived(overview?.changes.prUrl ?? null);

	const STAGE_LABEL = { pre_commit: 'Before commit', pre_push: 'Before push' } as const;
	const MARK = { done: '✓', doing: '◐', todo: '○' } as const;
	const MARK_LABEL = { done: 'Done', doing: 'In progress', todo: 'To do' } as const;

	let closeButton = $state<HTMLButtonElement | null>(null);
	// Into the sheet when it opens, so a keyboard is where the eyes are. The
	// page puts focus back on Details when it closes.
	$effect(() => {
		if (sheet && open) closeButton?.focus();
	});

	const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
	const basename = (path: string) => path.split('/').at(-1) ?? path;
	const dirname = (path: string) => path.split('/').slice(0, -1).join('/');
</script>

<svelte:window
	onkeydown={(e) => {
		if (sheet && open && e.key === 'Escape') onclose();
	}}
/>

{#if sheet && open}
	<!-- A dismiss surface, as the session drawer's scrim is; Escape and the
	     Close button are the ways out offered to a keyboard. -->
	<div class="scrim" role="presentation" onclick={onclose}></div>
{/if}

<aside
	id="session-panel"
	class="panel"
	class:sheet
	class:open
	aria-label="Session details"
	inert={sheet && !open}
	style={sheet ? undefined : `width:${width}px`}
	use:swipeToClose={{ close: () => sheet && onclose(), side: 'right' }}
>
	{#if sheet}
		<div class="sheet-head">
			<span class="sheet-title">Session details</span>
			<button class="chip" bind:this={closeButton} onclick={onclose}>Close</button>
		</div>
	{/if}

	{#if failed}
		<div class="notice error load-error" role="alert">
			{overview
				? 'Could not refresh the session details. Showing the last ones.'
				: 'Could not load the session details.'}
			<button class="chip" onclick={onretry}>Retry</button>
		</div>
	{/if}

	{#if !overview}
		{#if !failed}<p class="hint pad">Loading…</p>{/if}
	{:else}
		{#if overview.goal}
			<div class="goal">
				<span class="label">Goal</span>
				<p>{overview.goal}</p>
			</div>
		{/if}

		{#snippet backgroundBody()}
			{#if !streaming}
				<p class="hint">No agent running</p>
			{:else}
				<div class="agent-row">
					<span class="dot" class:parked></span>
					<span class="agent-name">coding</span>
					{#if runStartedAt !== null}<span class="age num">{formatElapsed(runStartedAt, now)}</span>{/if}
				</div>
				<p class="agent-doing" title={activity}>{activity}</p>
				{#each shownAgents as agent (agent.id)}
					<div class="agent-row sub">
						<span class="branch-mark">└</span>
						<span class="dot"></span>
						<span class="agent-name" title={agent.label}>{agent.kind}</span>
						<span class="age num">{formatElapsed(agent.startedAt, now)}</span>
					</div>
					<p class="agent-doing sub" title={agent.detail || agent.label}>
						{agent.detail || agent.label}
					</p>
				{/each}
				{#if hiddenAgents > 0}
					<p class="agent-doing sub">+{hiddenAgents} more</p>
				{/if}
				{#if finishedAgents > 0}
					<p class="hint">{finishedAgents} finished</p>
				{/if}
			{/if}
		{/snippet}
		{@render section(
			'background',
			'Background',
			agentCount ? `${agentCount} running` : '',
			backgroundBody,
			null
		)}

		{#snippet environmentBody()}
			<dl>
				<dt>Runs in</dt>
				<dd>
					{overview.environment.executor === 'docker' ? 'Runner container' : 'Local workspace'}
				</dd>
				<dt>Repository</dt>
				<dd>
					{#if overview.environment.repoWebUrl}
						<a href={overview.environment.repoWebUrl} target="_blank" rel="noreferrer"
							>{overview.environment.repoName} ↗</a
						>
					{:else}
						{overview.environment.repoName}
					{/if}
				</dd>
				<dt>Branch</dt>
				<dd class="mono">
					{overview.environment.baseBranch} → {overview.environment.workBranch}
				</dd>
			</dl>
		{/snippet}
		{@render section('environment', 'Environment', '', environmentBody, null)}

		{#snippet contextBody()}
			{#if !context}
				<p class="hint">No usage reported yet.</p>
			{:else}
				<p>
					<span class="num">{context.usedTokens.toLocaleString()}</span>
					{#if context.contextWindow}
						of <span class="num">{context.contextWindow.toLocaleString()}</span> tokens
					{:else}
						tokens (window unknown)
					{/if}
					at the last model call, {formatAgo(context.at, now)}.
				</p>
				<p class="hint mono" title={context.modelKey}>{context.modelKey}</p>
			{/if}
		{/snippet}
		{#snippet contextMeter()}
			{#if share?.percent != null}
				<span class="meter" class:high={share.high} aria-hidden="true">
					<span style={`width:${share.percent}%`}></span>
				</span>
			{/if}
		{/snippet}
		{@render section(
			'context',
			'Context',
			share?.percent != null
				? `${share.percent}%`
				: context
					? `${Math.round(context.usedTokens / 1000)}k tokens`
					: '',
			contextBody,
			contextMeter
		)}

		{#snippet connectorsBody()}
			{#if !overview.connectors.length}
				<p class="hint">None.</p>
			{:else}
				<ul class="rows">
					{#each overview.connectors as c (c.name)}
						<li>
							<span class="grow">{c.name}</span>
							<span class="hint num">{plural(c.tools, 'tool')}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/snippet}
		{@render section(
			'connectors',
			'Connectors',
			overview.connectors.length ? `${overview.connectors.length} available` : '',
			connectorsBody,
			null
		)}

		{#snippet checklistBody()}
			{#if !overview.plan.length}
				<p class="hint">The agent keeps a checklist when the work runs to several steps.</p>
			{:else}
				<ul class="rows checklist">
					{#each overview.plan as item, i (i)}
						<li class={item.status}>
							<span class="mark" role="img" aria-label={MARK_LABEL[item.status]}
								>{MARK[item.status]}</span
							>
							<span class="grow">{item.text}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/snippet}
		{@render section(
			'checklist',
			'Checklist',
			overview.plan.length ? planProgress(overview.plan) : '',
			checklistBody,
			null
		)}

		{#snippet outputsBody()}
			{#if !outputs.length}
				<p class="hint">No files written yet.</p>
			{:else}
				<ul class="rows">
					{#each outputs as path (path)}
						<li>
							<button class="file" title={`Show ${path} in the diff`} onclick={() => onopenfile(path)}>
								<span class="mono">{basename(path)}</span>
								{#if dirname(path)}<span class="hint dir">{dirname(path)}</span>{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{/snippet}
		{@render section('outputs', 'Outputs', outputs.length ? `${outputs.length}` : '', outputsBody, null)}

		{#snippet changesBody()}
			{#if pr}
				<p>
					<a href={pr} target="_blank" rel="noreferrer"
						>Pull request{prNumber(pr) ? ` #${prNumber(pr)}` : ''} ↗</a
					>
				</p>
			{/if}
			{#if totals}
				{#if totals.commits}
					<details class="commits">
						<summary>{plural(totals.commits, 'commit')}</summary>
						<ul class="mono">
							{#each overview.changes.commits as line, i (i)}
								<li title={line}>{line}</li>
							{/each}
						</ul>
						{#if overview.changes.commits.length < totals.commits}
							<p class="hint">+{totals.commits - overview.changes.commits.length} more</p>
						{/if}
					</details>
				{:else}
					<p>No commits yet</p>
				{/if}
				{#if totals.files}
					<p>
						<span class="add num">+{totals.insertions.toLocaleString()}</span>
						<span class="del num">−{totals.deletions.toLocaleString()}</span>
						across {plural(totals.files, 'file')}
					</p>
				{/if}
				{#if totals.uncommitted}
					<p>{totals.uncommitted.toLocaleString()} uncommitted</p>
				{/if}
				<p class="hint">As of the end of the last turn, {formatAgo(totals.at, now)}.</p>
			{:else if !pr}
				<p class="hint">Counted at the end of each turn.</p>
			{/if}
		{/snippet}
		{@render section(
			'changes',
			'Changes',
			pr && prNumber(pr) ? `#${prNumber(pr)}` : totals?.commits ? plural(totals.commits, 'commit') : '',
			changesBody,
			null
		)}

		{#snippet checksBody()}
			{#if !overview.checks.length}
				<p class="hint">No checks have run.</p>
			{:else}
				{#each overview.checks as check (check.stage)}
					<div class="stage">
						<p class="stage-head">
							{STAGE_LABEL[check.stage]}
							<span class="hint">{formatAgo(check.at, now)}</span>
						</p>
						{#if check.error}
							<p class="fail">✗ {check.error}</p>
						{/if}
						<ul class="rows">
							{#each check.runs as run, i (i)}
								<li class:fail={run.code !== 0}>
									<span class="mark" role="img" aria-label={run.code === 0 ? 'Passed' : 'Failed'}
										>{run.code === 0 ? '✓' : '✗'}</span
									>
									<span class="grow mono" title={run.command}>{run.command}</span>
									<span class="hint num"
										>{run.code === null
											? (run.error ?? 'did not run')
											: run.code === 0
												? `${Math.round(run.durationMs / 1000)}s`
												: `exit ${run.code}`}</span
									>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			{/if}
			<p class="hint">Automatic checkpoint commits do not run these checks.</p>
		{/snippet}
		{@render section(
			'checks',
			'Checks',
			!overview.checks.length
				? ''
				: overview.checks.some((c) => c.error || c.runs.some((r) => r.code !== 0))
					? 'failed'
					: 'passed',
			checksBody,
			null
		)}
	{/if}
</aside>

{#snippet section(
	id: string,
	title: string,
	summary: string,
	body: Snippet,
	trailing: Snippet | null
)}
	<section class="sec">
		<h2>
			<button
				class="sec-head"
				aria-expanded={!shut[id]}
				aria-controls={shut[id] ? undefined : `session-panel-${id}`}
				onclick={() => toggle(id)}
			>
				<span class="caret" aria-hidden="true">{shut[id] ? '▸' : '▾'}</span>
				<span class="sec-title">{title}</span>
				{#if summary}<span class="sec-summary num">{summary}</span>{/if}
				{#if trailing}{@render trailing()}{/if}
			</button>
		</h2>
		{#if !shut[id]}
			<div class="sec-body" id={`session-panel-${id}`}>{@render body()}</div>
		{/if}
	</section>
{/snippet}

<style>
	.panel {
		flex-shrink: 0;
		box-sizing: border-box;
		overflow-y: auto;
		padding: 0.6rem 0.75rem;
		background: var(--bg-pane);
		font-size: var(--text-base);
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	/* Over the thread rather than beside it, from the right. The insets clear
	   the fixed chrome the same way the session drawer's do. */
	.panel.sheet {
		position: fixed;
		inset: var(--chrome-top) 0 var(--above-bar) auto;
		width: min(24rem, 88vw);
		z-index: var(--z-drawer);
		border-left: 1px solid var(--border);
		transform: translateX(100%);
		transition: transform 0.2s ease;
		overscroll-behavior: contain;
	}
	.panel.sheet.open {
		transform: translateX(0);
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: var(--z-drawer);
		background: rgb(0 0 0 / 0.35);
	}
	.sheet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.sheet-title {
		color: var(--heading);
		font-size: var(--text-md);
	}
	.load-error {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.pad {
		margin: 0.4rem 0;
	}
	.goal .label {
		color: var(--label);
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	.goal p {
		margin: 0.15rem 0 0;
		color: var(--fg);
	}

	/* A card per section, as in the panel this follows: the header row folds it,
	   and says the one figure worth seeing when it is folded. */
	.sec {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg);
	}
	.sec h2 {
		margin: 0;
		font-size: inherit;
		font-weight: inherit;
	}
	.sec-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		min-height: var(--tap);
		padding: 0.35rem 0.6rem;
		background: none;
		border: none;
		color: var(--heading);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.caret {
		color: var(--fg-dim);
		width: 0.8rem;
	}
	.sec-title {
		flex: 1;
	}
	.sec-summary {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.sec-body {
		padding: 0 0.7rem 0.6rem;
		line-height: 1.4;
	}
	.sec-body p {
		margin: 0.2rem 0;
	}
	.meter {
		display: inline-block;
		width: 2.4rem;
		height: 0.35rem;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.meter.high span {
		background: var(--danger);
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 0.7rem;
		margin: 0.2rem 0;
	}
	dt {
		color: var(--fg-dim);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	a {
		color: var(--accent);
	}

	.rows {
		list-style: none;
		margin: 0.2rem 0;
		padding: 0;
	}
	.rows li {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		padding: 0.12rem 0;
		min-width: 0;
	}
	.grow {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.checklist .grow {
		white-space: normal;
	}
	.checklist .done .grow {
		color: var(--fg-dim);
		text-decoration: line-through;
	}
	.checklist .doing .grow {
		color: var(--fg);
	}
	.mark {
		flex: 0 0 1rem;
		color: var(--fg-dim);
	}
	.checklist .done .mark,
	.checklist .doing .mark {
		color: var(--accent);
	}
	.fail,
	.fail .mark {
		color: var(--danger);
	}
	.file {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		min-width: 0;
		width: 100%;
		padding: 0.1rem 0;
		background: none;
		border: none;
		color: var(--fg);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.file:hover .mono {
		color: var(--accent);
		text-decoration: underline;
	}
	.dir {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.add {
		color: var(--accent);
	}
	.del {
		color: var(--danger);
	}
	.commits summary {
		cursor: pointer;
	}
	.commits ul {
		list-style: none;
		margin: 0.2rem 0 0;
		padding: 0;
	}
	.commits li {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.stage + .stage {
		margin-top: 0.4rem;
	}
	.stage-head {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
	}

	/* The agent readout, moved from the header. Every row is one line with an
	   ellipsis and the full text on `title`: a model's narration is capped at
	   100 characters server side, which is still three lines in a column this
	   narrow. */
	.agent-row {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
	}
	.agent-row.sub {
		padding-left: 0.5rem;
	}
	.branch-mark {
		color: var(--fg-dim);
	}
	.dot {
		flex: 0 0 auto;
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.4s ease-in-out infinite;
	}
	.dot.parked {
		background: var(--danger);
	}
	.agent-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.age {
		flex: 0 0 auto;
		color: var(--fg-dim);
	}
	.agent-doing {
		color: var(--fg-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-left: 0.8rem;
	}
	.agent-doing.sub {
		padding-left: 1.75rem;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none;
		}
		.panel.sheet {
			transition: none;
		}
	}
</style>
