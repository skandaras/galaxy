<script lang="ts">
	import type { TimelineItem } from '$lib/run-timeline';

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
</script>

<ul class="timeline">
	{#each items as item, i (item.kind === 'step' ? item.id : `${item.kind}-${i}`)}
		{#if item.kind === 'step'}
			<li class="step s-{item.status}">
				{#if item.tools.length}
					<!-- Open while it runs so the work is visible, closed once it
					     succeeded, left open on failure — the one state worth reading. -->
					<details open={live ? item.status !== 'ok' : item.status === 'error'}>
						<summary>
							<span class="mark">{mark(item.status)}</span>
							<span class="label">{item.label || `${item.tools.length} tool calls`}</span>
						</summary>
						<ul class="tools">
							{#each item.tools as tool, t (tool.callId ?? `${tool.name}-${t}`)}
								<li class="t-{tool.status}">
									<span class="t-name">{tool.name}</span>
									{#if tool.detail}<span class="t-detail">{tool.detail}</span>{/if}
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
		font-size: 0.72rem;
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
		font-size: 0.6rem;
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
	.tools li {
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
	.t-error .t-detail {
		color: var(--danger);
	}
	.t-detail {
		color: var(--fg-dim);
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.stage {
		color: var(--fg-dim);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-size: 0.62rem;
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
