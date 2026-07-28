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

	// Backstop only: the event stream below is what normally keeps this current.
	const POLL_MS = 120_000;
	let status = $state<Status | null>(null);

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
			const e = JSON.parse(ev.data);
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

{#if status}
	<div class="budget" class:blocked={status.blocked} title={title(status)}>
		<span class="amount">
			{money(status.spentUsd)}{#if status.enabled}<span class="of"
					>/{money(status.limitUsd)}</span
				>{/if}
		</span>
		{#if status.enabled}
			<span class="track" aria-hidden="true">
				<span class="fill" style="width: {pct(status)}%"></span>
			</span>
		{/if}
		{#if status.unpricedCalls}<span class="warn" aria-hidden="true">*</span>{/if}
	</div>
{/if}

<style>
	.budget {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.62rem;
		color: var(--fg-dim);
	}
	.amount {
		white-space: nowrap;
	}
	.of {
		opacity: 0.6;
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
	.warn {
		color: var(--accent);
	}
</style>
