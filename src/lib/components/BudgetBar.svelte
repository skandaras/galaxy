<script lang="ts">
	import { onMount } from 'svelte';

	interface Status {
		enabled: boolean;
		limitUsd: number;
		period: 'day' | 'week' | 'month';
		spentUsd: number;
		blocked: boolean;
		unpricedCalls: number;
	}

	interface Props {
		isAdmin: boolean;
	}
	let { isAdmin }: Props = $props();

	// Backstop only: the event stream below is what normally keeps this current.
	const POLL_MS = 120_000;
	let status = $state<Status | null>(null);

	/**
	 * Everyone sees the figure once it matters, and admins always do.
	 *
	 * The cap blocks everyone's turns, so the figure is not admin-only (see
	 * /api/usage/budget). But a dollar amount on every page, explained only by a
	 * hover tooltip a phone cannot show, told most people nothing they could act
	 * on until the day it said everything. Half the cap is when it starts to.
	 */
	const SHOW_AT = 0.5;
	const visible = (s: Status) =>
		isAdmin || s.blocked || (s.enabled && s.limitUsd > 0 && s.spentUsd / s.limitUsd >= SHOW_AT);
	const PERIOD_WORDS: Record<Status['period'], string> = {
		day: 'today',
		week: 'this week',
		month: 'this month'
	};

	async function load() {
		const res = await fetch('/api/usage/budget');
		if (res.ok) status = await res.json();
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => void load(), POLL_MS);
		// Usage is logged before a turn's completion event, so refetching when one
		// lands shows the spend that turn just added.
		const source = new EventSource('/api/events/stream');
		source.onmessage = (ev) => {
			// A frame that will not parse is not worth a thrown handler: these
			// streams reconnect after every backgrounded resume, and an exception
			// here is one more uncaught error in a page that has no console.
			let e;
			try {
				e = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (e.type === 'job' && e.status !== 'running') void load();
		};
		return () => {
			clearInterval(timer);
			source.close();
		};
	});

	// A real-but-tiny spend must not render as a flat $0.00, which reads as
	// "nothing has run".
	const money = (n: number) =>
		n > 0 && n < 0.01 ? '<$0.01' : `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
	// Clamped so an overspend still renders as a full bar rather than overflowing.
	const pct = (s: Status) =>
		s.limitUsd > 0 ? Math.min(100, (s.spentUsd / s.limitUsd) * 100) : 0;

	const title = (s: Status) => {
		const base = s.enabled
			? `${money(s.spentUsd)} of ${money(s.limitUsd)} spent this ${s.period} across the instance`
			: `${money(s.spentUsd)} spent this ${s.period} across the instance (no cap set)`;
		// A $0.00 reading is misleading when the model in use has no pricing, so
		// say so rather than letting it read as "nothing has been spent".
		return s.unpricedCalls
			? `${base}. ${s.unpricedCalls} call${s.unpricedCalls === 1 ? '' : 's'} not counted — no pricing configured for that model.`
			: base;
	};
</script>

{#if status && visible(status)}
	<div class="budget" class:blocked={status.blocked} title={title(status)}>
		<span class="amount">
			<span class="num">{money(status.spentUsd)}</span>
			{#if status.enabled}<span class="of">of <span class="num">{money(status.limitUsd)}</span></span>{/if}
			<span class="when">{PERIOD_WORDS[status.period]}{#if !status.enabled}, no cap{/if}</span>
		</span>
		{#if status.enabled}
			<span class="track" aria-hidden="true">
				<span class="fill" style="width: {pct(status)}%"></span>
			</span>
		{/if}
	</div>
	<!-- Said in words rather than as a bare asterisk explained only on hover,
	     and only to the people who can price a model. -->
	{#if isAdmin && status.unpricedCalls}
		<div class="unpriced">
			{status.unpricedCalls} call{status.unpricedCalls === 1 ? '' : 's'} not priced
		</div>
	{/if}
{/if}

<style>
	.budget {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.amount {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.3rem;
	}
	.of,
	.when {
		opacity: 0.75;
	}
	.track {
		flex: 1;
		min-width: 2.5rem;
		height: 3px;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.blocked {
		color: var(--danger);
	}
	.blocked .fill {
		background: var(--danger);
	}
	.unpriced {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-top: 0.15rem;
	}
</style>
