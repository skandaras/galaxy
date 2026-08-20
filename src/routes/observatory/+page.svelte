<script lang="ts">
	import { onMount } from 'svelte';

	interface Ev {
		id: string;
		ts: number;
		userId: string | null;
		chatId: string | null;
		task: string | null;
		type: string;
		name: string;
		status: 'ok' | 'error' | 'running';
		durationMs: number | null;
		detail: Record<string, unknown> | null;
	}

	const TYPES = ['', 'model.call', 'tool.call', 'job', 'failover', 'compaction', 'admin', 'budget'];
	let type = $state('');
	let status = $state('');
	let rows = $state<Ev[]>([]);
	let expanded = $state<string | null>(null);
	let paused = $state(false);

	async function load() {
		const params = new URLSearchParams({ limit: '200' });
		if (type) params.set('type', type);
		if (status) params.set('status', status);
		const res = await fetch(`/api/events?${params}`);
		if (res.ok) rows = await res.json();
	}

	$effect(() => {
		void type;
		void status;
		void load();
	});

	onMount(() => {
		const source = new EventSource('/api/events/stream');
		source.onmessage = (ev) => {
			if (paused) return;
			const e: Ev = JSON.parse(ev.data);
			if (type && e.type !== type) return;
			if (status && e.status !== status) return;
			rows = [e, ...rows].slice(0, 300);
		};
		return () => source.close();
	});

	const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });
</script>

<div class="obs-page">
	<header>
		<h2>Observatory</h2>
		<div class="filters">
			<select bind:value={type}>
				{#each TYPES as t (t)}
					<option value={t}>{t || 'all types'}</option>
				{/each}
			</select>
			<select bind:value={status}>
				<option value="">all statuses</option>
				<option value="ok">ok</option>
				<option value="error">error</option>
				<option value="running">running</option>
			</select>
			<button class="chip" class:on={paused} onclick={() => (paused = !paused)}>
				{paused ? 'paused' : 'live'}
			</button>
		</div>
	</header>

	<ul>
		{#each rows as e (e.id)}
			<li class:error={e.status === 'error'}>
				<button class="row" onclick={() => (expanded = expanded === e.id ? null : e.id)}>
					<span class="ts">{time(e.ts)}</span>
					<span class="type">{e.type}</span>
					<span class="name">{e.name}</span>
					{#if e.task}<span class="task">{e.task}</span>{/if}
					<span class="dur num">{e.durationMs != null ? `${e.durationMs}ms` : ''}</span>
					<span class="status {e.status}">{e.status}</span>
				</button>
				{#if expanded === e.id}
					<pre class="detail">{JSON.stringify(e.detail ?? {}, null, 2)}</pre>
				{/if}
			</li>
		{:else}
			<li class="empty">No events match.</li>
		{/each}
	</ul>
</div>

<style>
	.obs-page {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.6rem;
		margin-bottom: 0.6rem;
	}
	h2 {
		margin: 0;
		font-size: var(--text-lg);
		letter-spacing: 0.3em;
		color: var(--heading);
	}
	.filters {
		display: flex;
		gap: 0.4rem;
	}
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.3rem 0.45rem;
	}
	.chip {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}
	.chip.on {
		border-color: var(--danger);
		color: var(--danger);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		border-bottom: 1px solid var(--border);
	}
	li.error {
		background: color-mix(in srgb, var(--danger) 7%, transparent);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.4rem 0.3rem;
		cursor: pointer;
		text-align: left;
	}
	.ts {
		color: var(--fg-dim);
		flex-shrink: 0;
	}
	.type {
		color: var(--fg-dim);
		width: 6.5rem;
		flex-shrink: 0;
	}
	.name {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.task {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 0.3rem;
	}
	.dur {
		color: var(--fg-dim);
		flex-shrink: 0;
	}
	.status.ok {
		color: var(--fg-dim);
	}
	.status.error {
		color: var(--danger);
	}
	.status.running {
		color: var(--accent);
	}
	.detail {
		/* Pretty-printed JSON, indented with spaces. */
		font-family: var(--font-mono);
		background: var(--bg-pane);
		border-radius: 6px;
		font-size: var(--text-sm);
		padding: 0.6rem;
		margin: 0 0 0.5rem;
		overflow-x: auto;
	}
	.empty {
		color: var(--fg-dim);
		padding: 1rem 0;
	}

	@media (max-width: 720px) {
		.obs-page {
			padding: 0.75rem 0.85rem;
		}
		.row {
			flex-wrap: wrap;
			gap: 0.35rem 0.6rem;
			font-size: var(--text-base);
		}
		/* Event type is also conveyed by the name; drop the fixed column so
		   the name and status stay readable on a phone. */
		.type {
			width: auto;
			font-size: var(--text-xs);
		}
		.name {
			flex-basis: 100%;
			order: 3;
		}
	}
</style>
