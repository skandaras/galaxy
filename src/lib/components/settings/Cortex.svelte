<script lang="ts">
	/**
	 * Your say over your own lattice. The cadence is the platform's (Admin →
	 * Cortex); whether the pass touches your concepts at all is yours.
	 */
	let enabled = $state(true);
	let lastRun = $state(0);
	let saved = $state(false);

	async function load() {
		const data = await (await fetch('/api/cortex/groom')).json();
		enabled = data.enabled ?? true;
		lastRun = data.lastRun ?? 0;
	}
	$effect(() => {
		void load();
	});

	async function save() {
		await fetch('/api/cortex/groom', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled })
		});
		saved = true;
		setTimeout(() => (saved = false), 1500);
		await load();
	}
</script>

<section>
	<h3>Cortex</h3>
	<p class="hint">
		The groomer reads your concepts and suggests changes — merges, missing connections, areas —
		which wait in your Cortex tab until you accept them. It applies nothing on its own beyond
		tidying whitespace, and anything it does apply can be undone from the history there.
	</p>
	<label class="check">
		<input type="checkbox" bind:checked={enabled} onchange={save} />
		let it look over my lattice
	</label>
	<p class="hint">
		Last run {lastRun ? new Date(lastRun).toLocaleString() : 'never'}.
		{#if !enabled}Turned off, the scheduled pass skips you; you can still run it by hand.{/if}
		{#if saved}<span class="ok">Saved ✓</span>{/if}
	</p>
</section>

<style>
	h3 {
		margin: 1.2rem 0 0.3rem;
		font-size: var(--text-sm);
		color: var(--label);
	}
	.hint {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		line-height: 1.5;
		max-width: 60ch;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: var(--text-sm);
		margin: 0.4rem 0;
	}
	.ok {
		color: var(--accent);
	}
</style>
