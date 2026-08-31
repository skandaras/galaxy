<script lang="ts">
	import type { SearchResultRow, TimelineItem, TimelineTool } from '$lib/run-timeline';

	/**
	 * A run as a list of steps, stages and notices in the order they happened.
	 *
	 * Used twice: live while a run streams, and collapsed under a finished reply.
	 * `live` is what separates them — a running step keeps its tool calls open so
	 * there is something to watch, while a finished one is closed unless it
	 * failed, which is the only case anyone wants to reopen.
	 */
	let { items, live = false }: { items: TimelineItem[]; live?: boolean } = $props();

	const mark = (status: string) => (status === 'ok' ? '✓' : status === 'error' ? '✗' : '');

	const plural = (n: number) => `${n} result${n === 1 ? '' : 's'}`;

	/**
	 * Whether a step has something to look at rather than merely something to
	 * report.
	 *
	 * The collapse rule below hides machinery once it has succeeded, which is
	 * right for a file read whose one-line summary says everything. A list of
	 * search results is not machinery — it is the thing the reader wants — and
	 * folding it away the instant the search returned made the box unreachable
	 * without a click nobody knew to make.
	 */
	const drawsResults = (tools: TimelineTool[]) => tools.some((t) => t.results?.length);

	/**
	 * The host a result sits on, shown beside its title.
	 *
	 * The full hostname rather than the registrable domain: `docs.` and `blog.` of
	 * one company are different sources to a reader deciding what to trust, and
	 * collapsing them hides the thing the column exists to show. Research's own
	 * domain cap works on the registrable domain, which is a different judgement
	 * for a different purpose.
	 */
	function host(url: string): string {
		try {
			return new URL(url).hostname;
		} catch {
			return '';
		}
	}
</script>

{#snippet resultBox(results: SearchResultRow[])}
	<!-- Scrolls within itself: twenty results is worth having and worth not
	     pushing the rest of the run off the screen. -->
	<ol class="results">
		{#each results as r, i (`${i}-${r.url}`)}
			<li>
				<a class="r-title" href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a>
				<span class="r-host">{host(r.url)}</span>
			</li>
		{/each}
	</ol>
{/snippet}

<ul class="timeline">
	{#each items as item, i (item.kind === 'step' ? item.id : `${item.kind}-${i}`)}
		{#if item.kind === 'step'}
			<li class="step s-{item.status}">
				<!-- A note is reason enough to open: a step whose lead-in ran to a
				     paragraph has something to read even before its first call
				     lands, and it used to render as a flat line with the rest of
				     what the model wrote nowhere at all. -->
				{#if item.tools.length || item.note}
					<!-- A step whose only call drew a box already says that call's name
					     and query in its own label — describeBatch built it from exactly
					     that. Repeating it underneath was invisible while the step
					     collapsed on success, and became a doubled header the moment
					     boxes started keeping it open. -->
					{@const solo =
						item.tools.length === 1 && item.tools[0].status !== 'error' && item.tools[0].results
							? item.tools[0]
							: null}
					<!-- Open while it runs so the work is visible, closed once it
					     succeeded, left open on failure — the one state worth reading —
					     and left open when it drew results, which are worth reading too. -->
					<details
						open={drawsResults(item.tools) ||
							(live ? item.status !== 'ok' : item.status === 'error')}
					>
						<summary>
							<span class="mark">{mark(item.status)}</span>
							<span class="label">{item.label || `${item.tools.length} tool calls`}</span>
							{#if solo?.results}<span class="r-count">{plural(solo.results.length)}</span>{/if}
						</summary>
						<!-- What the model said it was doing, in full. The summary above
						     carries only its first sentence. -->
						{#if item.note}<p class="note">{item.note}</p>{/if}
						<ul class="tools">
							{#each item.tools as tool, t (tool.callId ?? `${tool.name}-${t}`)}
								<li class="t-{tool.status}">
									{#if tool !== solo}
										<div class="t-line">
											<span class="t-name">{tool.name}</span>
											{#if tool.detail}<span class="t-detail">{tool.detail}</span>{/if}
											{#if tool.results}<span class="r-count">{plural(tool.results.length)}</span>{/if}
										</div>
									{/if}
									{#if tool.results?.length}{@render resultBox(tool.results)}{/if}
								</li>
							{/each}
						</ul>
					</details>
				{:else}
					<div class="summary-line">
						<span class="mark">{mark(item.status)}</span>
						<span class="label">{item.label}</span>
					</div>
				{/if}
			</li>
		{:else if item.kind === 'search'}
			<li class="search" class:t-error={item.failed}>
				<div class="t-line">
					<span class="t-name">web_search</span>
					<span class="t-detail">{item.query}{item.language ? ` [${item.language}]` : ''}</span>
					<!-- "failed" rather than "0 results": a search that broke and a
					     search that genuinely found nothing are different claims. -->
					<span class="r-count">{item.failed ? 'failed' : plural(item.results.length)}</span>
				</div>
				{#if item.results.length}{@render resultBox(item.results)}{/if}
			</li>
		{:else if item.kind === 'stage'}
			<li class="stage">{item.name}{item.detail ? ` · ${item.detail}` : ''}</li>
		{:else}
			<li class="notice">{item.text}</li>
		{/if}
	{/each}
</ul>

<style>
	.timeline {
		list-style: none;
		margin: 0 0 0.6rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: var(--text-base);
	}
	.step summary,
	.summary-line {
		display: flex;
		gap: 0.45rem;
		align-items: baseline;
		padding: 0.12rem 0;
	}
	.step summary {
		cursor: pointer;
		list-style: none;
	}
	/* The disclosure triangle is drawn by ::before below, so the native marker
	   has to go in both engines. */
	.step summary::-webkit-details-marker {
		display: none;
	}
	.step summary::before {
		content: '▸';
		color: var(--fg-dim);
		font-size: var(--text-xs);
		line-height: 1.5;
	}
	.step details[open] > summary::before {
		content: '▾';
	}
	.mark {
		width: 0.7rem;
		flex-shrink: 0;
		color: var(--fg-dim);
	}
	.s-ok .mark {
		color: var(--accent);
	}
	.s-error .mark,
	.s-error .label {
		color: var(--danger);
	}
	.label {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* A step with nothing under it yet is the live one: pulse it rather than
	   leaving a static line that looks finished. */
	.s-running .label {
		animation: pulse 1.4s ease-in-out infinite;
	}
	.tools {
		list-style: none;
		margin: 0 0 0.2rem;
		padding: 0 0 0 1.55rem;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		border-left: 1px solid var(--border);
		margin-left: 0.28rem;
	}
	/* Prose, so unlike a tool line it wraps rather than being cut with an
	   ellipsis — the whole point of keeping it is that all of it can be read.
	   Shares the tools' rail so it reads as part of the same step. */
	.note {
		margin: 0.15rem 0 0.25rem 0.28rem;
		padding: 0 0.5rem 0 1.55rem;
		border-left: 1px solid var(--border);
		color: var(--fg-dim);
		white-space: pre-wrap;
	}
	/* A column, so a call that carries a result box can put it under its own
	   line rather than beside it. Without a box this renders as it always did.
	   Direct children only: the result rows nested inside are `li`s too, and an
	   unscoped `.tools li` turned every one of them into a column, breaking the
	   title beside its domain onto two lines. */
	.tools > li,
	.search {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.t-line {
		display: flex;
		gap: 0.45rem;
		align-items: baseline;
		min-width: 0;
	}
	.t-name {
		color: var(--accent);
		flex-shrink: 0;
	}
	.t-running .t-name {
		animation: pulse 1.2s ease-in-out infinite;
	}
	.t-error .t-name,
	.t-error .t-detail,
	.t-error .r-count {
		color: var(--danger);
	}
	.t-detail {
		color: var(--fg-dim);
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* Pushed to the far end so the counts line up down a round of searches. */
	.r-count {
		margin-left: auto;
		padding-left: 0.6rem;
		flex-shrink: 0;
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	.search {
		padding: 0.12rem 0 0.12rem 0.28rem;
	}
	.results {
		list-style: none;
		margin: 0.25rem 0 0.35rem;
		padding: 0.15rem 0;
		border: 1px solid var(--border);
		border-radius: 0.35rem;
		max-height: 9.5rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.results li {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		min-width: 0;
		padding: 0.16rem 0.55rem;
	}
	.r-title {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: inherit;
		text-decoration: none;
	}
	.r-title:hover,
	.r-title:focus-visible {
		text-decoration: underline;
	}
	.r-host {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	.stage {
		color: var(--fg-dim);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-size: var(--text-xs);
		padding: 0.3rem 0 0.1rem;
	}
	/* Inline and in position, rather than a banner at the top of the page
	   detached from the step that raised it. */
	.notice {
		color: var(--fg-dim);
		border-left: 2px solid var(--border);
		padding: 0.1rem 0 0.1rem 0.5rem;
		margin: 0.15rem 0;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
</style>
