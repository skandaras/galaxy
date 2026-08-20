<script lang="ts">
	import { onMount } from 'svelte';

	interface Ev {
		id: string;
		ts: number;
		type: string;
		name: string;
		status: 'ok' | 'error' | 'running';
		durationMs: number | null;
	}

	const MAX_ROWS = 14;
	let open = $state(false);
	let rows = $state<Ev[]>([]);
	let unseenErrors = $state(0);
	let live = $state(false);

	onMount(() => {
		void (async () => {
			const res = await fetch(`/api/events?limit=${MAX_ROWS}`);
			if (res.ok) rows = await res.json();
		})();
		const source = new EventSource('/api/events/stream');
		source.onopen = () => (live = true);
		source.onerror = () => (live = false);
		source.onmessage = (ev) => {
			const e: Ev = JSON.parse(ev.data);
			rows = [e, ...rows].slice(0, MAX_ROWS);
			if (e.status === 'error' && !open) unseenErrors++;
		};
		return () => source.close();
	});

	function toggle() {
		open = !open;
		if (open) unseenErrors = 0;
	}

	const dot = (s: string) => (s === 'error' ? 'err' : s === 'running' ? 'run' : 'ok');
	const time = (ts: number) =>
		new Date(ts).toLocaleTimeString(undefined, { hour12: false });
</script>

<div class="observatory" class:open>
	<button class="head" onclick={toggle} title="Observatory — live view of the machinery">
		<span class="pulse" class:live></span>
		<span class="label">OBSERVATORY</span>
		{#if unseenErrors}<span class="err-badge">{unseenErrors}</span>{/if}
		<span class="caret">{open ? '▾' : '▸'}</span>
	</button>
	{#if open}
		<ul>
			{#each rows as e (e.id)}
				<li>
					<span class="dot {dot(e.status)}"></span>
					<span class="name" title="{e.type} · {e.name}">{e.name}</span>
					<span class="meta">
						{e.durationMs != null ? `${e.durationMs}ms` : time(e.ts)}
					</span>
				</li>
			{:else}
				<li class="empty">No activity yet.</li>
			{/each}
		</ul>
		<a class="expand" href="/observatory">open full view ⤢</a>
	{/if}
</div>

<style>
	.observatory {
		border-top: 1px solid var(--border);
		margin-top: 0.75rem;
		padding-top: 0.5rem;
		font-size: var(--text-sm);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-xs);
		letter-spacing: 0.25em;
		cursor: pointer;
		padding: 0.2rem 0;
	}
	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--fg-dim);
	}
	.pulse.live {
		background: var(--accent);
		animation: glow 2.4s ease-in-out infinite;
	}
	@keyframes glow {
		50% {
			opacity: 0.35;
		}
	}
	.err-badge {
		background: var(--danger);
		color: var(--bg);
		border-radius: 999px;
		padding: 0 0.35rem;
		font-size: var(--text-xs);
		letter-spacing: 0;
	}
	.caret {
		margin-left: auto;
		letter-spacing: 0;
	}
	ul {
		list-style: none;
		margin: 0.4rem 0 0;
		padding: 0;
		max-height: 11rem;
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.18rem 0;
		color: var(--fg-dim);
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.dot.ok {
		background: var(--fg-dim);
	}
	.dot.err {
		background: var(--danger);
	}
	.dot.run {
		background: var(--accent);
	}
	.name {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		flex-shrink: 0;
		font-size: var(--text-xs);
	}
	.empty {
		justify-content: center;
	}
	.expand {
		display: block;
		color: var(--accent);
		text-decoration: none;
		font-size: var(--text-xs);
		margin-top: 0.35rem;
	}
</style>
