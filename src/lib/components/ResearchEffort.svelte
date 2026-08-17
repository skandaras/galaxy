<script lang="ts">
	/**
	 * How hard this one research run should work.
	 *
	 * Admin sets the ceiling; this picks a fraction of it, per message. The
	 * resolved numbers come from the server rather than being computed here, so
	 * a page left open overnight cannot promise rounds an admin has since taken
	 * away.
	 */
	import { EFFORT_LABEL, RESEARCH_EFFORTS, type ResearchEffort } from '$lib/research-effort';

	interface Budget {
		rounds: number;
		queriesPerRound: number;
		pagesPerRound: number;
		searchBudget: number;
	}

	interface Props {
		effort: ResearchEffort;
		onchange: (effort: ResearchEffort) => void;
		/** Null when the budgets could not be fetched — labels still work. */
		levels?: Record<ResearchEffort, Budget> | null;
	}
	let { effort, onchange, levels = null }: Props = $props();

	let open = $state(false);
	let chipEl = $state<HTMLElement | null>(null);
	/**
	 * Where to pin the panel, in viewport coordinates.
	 *
	 * Fixed rather than absolute for the same reason the notification panel is:
	 * the composer sits inside a scroll container, which clips a child that
	 * sticks out of it. See NotificationBell.
	 */
	let at = $state({ left: 0, bottom: 0, width: 0 });

	const PANEL_WIDTH = 300;
	const MARGIN = 8;

	const index = $derived(RESEARCH_EFFORTS.indexOf(effort));
	const budget = $derived(levels?.[effort] ?? null);
	/**
	 * True when the admin ceiling is too low for the levels to differ. The
	 * slider still works, it just cannot buy anything — better to say so than
	 * to leave it looking broken.
	 */
	const collapsed = $derived(
		levels ? new Set(RESEARCH_EFFORTS.map((e) => levels[e].rounds)).size === 1 : false
	);

	function place() {
		const rect = chipEl?.getBoundingClientRect();
		if (!rect) return;
		const width = Math.min(PANEL_WIDTH, window.innerWidth - MARGIN * 2);
		at = {
			// Clamped to the viewport, so a narrow window shifts the panel left
			// rather than pushing it off the edge.
			left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN)),
			bottom: Math.max(MARGIN, window.innerHeight - rect.top + 6),
			width
		};
	}

	function toggle() {
		open = !open;
		if (open) place();
	}

	function pick(next: ResearchEffort) {
		if (next !== effort) onchange(next);
	}
</script>

<svelte:window onresize={() => open && place()} />

<div class="effort-wrap" bind:this={chipEl}>
	<button
		class="chip on"
		aria-expanded={open}
		aria-haspopup="dialog"
		title="How many rounds of searching this run gets"
		onclick={toggle}
	>
		<!-- A brain with a rising arrow: more thinking, dialled up. currentColor
		     so it takes the chip's accent without a second rule. -->
		<svg
			class="glyph"
			viewBox="0 0 16 16"
			width="13"
			height="13"
			fill="none"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M7.4 3.1a2 2 0 0 0-3.3 1.2 1.9 1.9 0 0 0-1 3.2 2 2 0 0 0 .6 2.9 2 2 0 0 0 3.7.7Z" />
			<path d="M7.4 3.1v9.9" />
			<path d="M9.6 11.4a1.9 1.9 0 0 0 1.5-1.7" />
			<path d="M10.6 6.6 14 3.2" />
			<path d="M11.2 3h3v3" />
		</svg>
		{EFFORT_LABEL[effort]}
	</button>

	{#if open}
		<!-- Click-away and reposition-on-resize, so a fixed panel cannot be left
		     stranded away from the chip it belongs to. -->
		<div
			class="scrim"
			role="presentation"
			onclick={() => (open = false)}
			onkeydown={(e) => e.key === 'Escape' && (open = false)}
		></div>
		<div
			class="panel"
			role="dialog"
			aria-label="Research effort"
			style={`left:${at.left}px; bottom:${at.bottom}px; width:${at.width}px`}
		>
			<p class="title">Research effort</p>
			<input
				type="range"
				min="0"
				max={RESEARCH_EFFORTS.length - 1}
				step="1"
				value={index}
				aria-label="Research effort"
				oninput={(e) => pick(RESEARCH_EFFORTS[Number(e.currentTarget.value)])}
			/>
			<div class="ticks">
				{#each RESEARCH_EFFORTS as level (level)}
					<button class="tick" class:on={level === effort} onclick={() => pick(level)}>
						{EFFORT_LABEL[level]}
					</button>
				{/each}
			</div>
			{#if budget}
				<p class="resolved">
					{budget.rounds}
					{budget.rounds === 1 ? 'round' : 'rounds'} · up to {budget.searchBudget} searches · {budget.pagesPerRound}
					pages a round
				</p>
			{/if}
			<p class="hint">Each round reads what it found, then searches the gaps.</p>
			{#if collapsed && budget}
				<p class="hint warn">
					Admin caps research at {budget.rounds}
					{budget.rounds === 1 ? 'round' : 'rounds'}, so effort has nothing to scale here.
				</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.effort-wrap {
		display: inline-flex;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: 0.72rem;
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}
	.glyph {
		flex-shrink: 0;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
	}
	.panel {
		position: fixed;
		z-index: 61;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.4);
		padding: 0.7rem 0.8rem 0.8rem;
	}
	.title {
		margin: 0 0 0.5rem;
		font-size: 0.62rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--accent);
	}
	input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
		margin: 0;
	}
	.ticks {
		display: flex;
		justify-content: space-between;
		gap: 0.2rem;
		margin-top: 0.2rem;
	}
	.tick {
		background: transparent;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: 0.68rem;
		padding: 0.15rem 0;
		cursor: pointer;
	}
	.tick.on {
		color: var(--accent);
	}
	.resolved {
		margin: 0.5rem 0 0;
		font-size: 0.72rem;
		color: var(--fg);
	}
	.hint {
		margin: 0.35rem 0 0;
		font-size: 0.66rem;
		line-height: 1.45;
		color: var(--fg-dim);
	}
	.hint.warn {
		color: var(--fg);
	}
	@media (max-width: 720px) {
		.panel {
			left: 0 !important;
			width: 100% !important;
			border-radius: 8px 8px 0 0;
		}
	}
</style>
