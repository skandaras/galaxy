<script lang="ts">
	/**
	 * Platform-level controls for the lattice.
	 *
	 * Per-user things live in Settings → Cortex: whether *your* lattice gets
	 * groomed is yours to decide, and how often the job runs at all is the
	 * platform's. Same split the memory job uses.
	 */
	let groom = $state({ enabled: false, intervalHours: 168, maxProposalsPerRun: 10 });
	let cortex = $state({ agentWrites: false, kinship: false, maxNodesPerUser: 2000 });
	let lastRun = $state(0);
	let busy = $state(false);
	let notice = $state<string | null>(null);

	async function load() {
		const [settings, status] = await Promise.all([
			(await fetch('/api/admin/settings')).json(),
			(await fetch('/api/cortex/groom')).json()
		]);
		groom = { ...settings.cortexGroom };
		cortex = { ...settings.cortex };
		lastRun = status.lastRun ?? 0;
	}
	$effect(() => {
		void load();
	});

	async function save(key: 'cortex' | 'cortexGroom', value: unknown) {
		await fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key, value })
		});
		notice = 'Saved';
		await load();
	}

	async function runNow() {
		busy = true;
		notice = null;
		const result = await (await fetch('/api/cortex/groom', { method: 'POST' })).json();
		busy = false;
		notice = result.ran
			? `Tidied ${result.tidied ?? 0}, proposed ${result.proposed ?? 0}` +
				(result.duplicates ? `, ${result.duplicates} already raised` : '')
			: `Tidied ${result.tidied ?? 0}. Did not look further: ${result.reason}`;
		await load();
	}

	const due = $derived(lastRun ? lastRun + groom.intervalHours * 3_600_000 : 0);
	const when = (t: number) => (t ? new Date(t).toLocaleString() : 'never');
</script>

<section>
	<h3>The groomer</h3>
	<p class="hint">
		A weekly pass over each person's lattice. It <strong>applies only tidying</strong> — whitespace
		in a name, and little else — and <strong>proposes everything that would change what a query
		returns</strong>: merges, weights, new connections, areas. Suggestions are reviewed by the
		person whose lattice it is, in their own Cortex tab, and anything it does apply is logged with
		a snapshot so it can be undone.
	</p>

	<div class="grid">
		<label class="check">
			<input type="checkbox" bind:checked={groom.enabled} /> run on a schedule
		</label>
		<label>
			every (hours)
			<input type="number" min="1" max="8760" bind:value={groom.intervalHours} />
		</label>
		<label>
			suggestions per run
			<input type="number" min="1" max="25" bind:value={groom.maxProposalsPerRun} />
		</label>
	</div>
	<p class="hint">
		Last run {when(lastRun)}{#if groom.enabled && lastRun}, next due {when(due)}{/if}. Needs a model
		set for the <code>cortex-groom</code> task; without one it still tidies, since that half needs
		no model at all.
	</p>
	<div class="row">
		<button class="btn primary" onclick={() => save('cortexGroom', groom)}>Save schedule</button>
		<button class="btn" disabled={busy} onclick={runNow}>
			{busy ? 'Looking…' : 'Run now on my lattice'}
		</button>
	</div>

	<h3>The lattice</h3>
	<div class="grid">
		<label class="check">
			<input type="checkbox" bind:checked={cortex.agentWrites} /> agents may write concepts
		</label>
		<label>
			concepts per person
			<input type="number" min="10" max="20000" bind:value={cortex.maxNodesPerUser} />
		</label>
	</div>
	<p class="hint">
		Agent writes ship off. An agent that can mint concepts outruns anyone merging the near
		duplicates it makes, so the lattice is worth shaping by hand — or through the groomer's review
		queue — until there is enough of it to be worth automating.
	</p>
	<div class="row">
		<button class="btn primary" onclick={() => save('cortex', cortex)}>Save lattice</button>
	</div>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
</section>

<style>
	h3 {
		margin: 1.2rem 0 0.3rem;
		font-size: var(--text-sm);
		color: var(--label);
	}
	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: 0.8rem;
		align-items: end;
		margin: 0.5rem 0;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.35rem;
	}
	input[type='number'] {
		width: 7rem;
		padding: 0.3rem 0.45rem;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--control-border);
	}
	.row {
		display: flex;
		gap: 0.5rem;
		margin: 0.5rem 0 0.2rem;
	}
	.hint {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		line-height: 1.5;
		max-width: 60ch;
	}
	.notice {
		font-size: var(--text-sm);
		color: var(--accent);
	}
	.btn {
		padding: 0.35rem 0.8rem;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--control-border);
		cursor: pointer;
	}
	.btn.primary {
		border-color: var(--accent);
		color: var(--heading);
	}
</style>
