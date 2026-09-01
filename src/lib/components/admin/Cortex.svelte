<script lang="ts">
	/**
	 * Platform-level controls for the lattice.
	 *
	 * Per-user things live in Settings → Cortex: whether *your* lattice gets
	 * groomed is yours to decide, and how often the job runs at all is the
	 * platform's. Same split the memory job uses.
	 */
	let groom = $state({
		enabled: false,
		intervalHours: 24,
		maxProposalsPerRun: 10,
		maxTokens: 16_384,
		timeoutSeconds: 300,
		shortlistSize: 20
	});
	let cortex = $state({
		agentWrites: true,
		kinship: false,
		maxNodesPerUser: 2000,
		learning: true,
		staleDays: 60
	});
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

	async function runNow(mode: 'harvest' | 'review') {
		busy = true;
		notice = null;
		const result = await (
			await fetch('/api/cortex/groom', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode })
			})
		).json();
		busy = false;
		const found = `tidied ${result.tidied ?? 0}, ${result.detected ?? 0} found by check`;
		notice = result.ran
			? `${found}, ${result.proposed ?? 0} suggested` +
				(result.duplicates ? `, ${result.duplicates} already raised` : '')
			: `${found}. Did not look further: ${result.reason}`;
		await load();
	}

	const due = $derived(lastRun ? lastRun + groom.intervalHours * 3_600_000 : 0);
	const when = (t: number) => (t ? new Date(t).toLocaleString() : 'never');
</script>

<section>
	<h3>The groomer</h3>
	<p class="hint">
		Two jobs, split by who asked for them. The <strong>scheduled pass adds</strong>: it reads what
		has been said since last time and suggests concepts worth keeping. A <strong>manual review
		consolidates</strong>: it reads the whole lattice looking for merges and structural problems,
		which is the expensive prompt and so only ever runs because someone asked.
	</p>
	<p class="hint">
		Both start with the free half — tidying, plus a check for concepts that connect to nothing,
		names that look like duplicates, and anything unfiled. Those are graph problems rather than
		language ones, so they cost no tokens and run whether or not a model is configured. Everything
		that would change what a query returns is <strong>proposed</strong>, never applied, and waits
		in the owner's own Cortex tab.
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
		<label>
			concepts read closely
			<input type="number" min="5" max="60" bind:value={groom.shortlistSize} />
		</label>
		<label>
			max tokens
			<input type="number" min="1024" max="200000" step="1024" bind:value={groom.maxTokens} />
		</label>
		<label>
			time limit (seconds)
			<input type="number" min="30" max="1800" step="30" bind:value={groom.timeoutSeconds} />
		</label>
	</div>
	<p class="hint">
		A review is two passes. The first reads every concept's shape — its name, its areas and what
		it connects to, never its description — and picks out the ones worth looking at properly;
		<strong>concepts read closely</strong> is how many it may pick. Only those get their
		descriptions sent, so the expensive half of a review stops growing with the lattice.
	</p>
	<p class="hint">
		A reasoning model spends part of its tokens thinking before it writes anything, and with too
		few it can spend all of them and answer nothing at all. A run that comes back empty on the
		token limit is asked again automatically with four times the room, so raising this is the
		second thing to try rather than the first. The time limit covers the whole run rather than
		one call, so a review's two passes share it.
	</p>
	<p class="hint">
		A run started by hand is a single request held open for as long as it takes, so if you raise
		the time limit past your reverse proxy's own read timeout, raise that too — otherwise the
		browser gives up while the run carries on.
	</p>
	<p class="hint">
		Last run {when(lastRun)}{#if groom.enabled && lastRun}, next due {when(due)}{/if}. Needs a model
		set for the <code>cortex-groom</code> task; without one it still tidies, since that half needs
		no model at all.
	</p>
	<div class="row">
		<button class="btn primary" onclick={() => save('cortexGroom', groom)}>Save schedule</button>
		<button class="btn" disabled={busy} onclick={() => runNow('harvest')}>
			{busy ? 'Working…' : 'Catch up on recent activity'}
		</button>
		<button class="btn" disabled={busy} onclick={() => runNow('review')}>
			{busy ? 'Working…' : 'Review the whole lattice'}
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

	<h3>Learning</h3>
	<p class="hint">
		Connections strengthen when a reply <em>uses</em> the concept at the other end, and fade when
		nothing does. Not when a query merely traverses them: a traversal follows the strongest
		connections, so rewarding it would teach the lattice to confirm the shape it already has.
	</p>
	<p class="hint">
		The strength somebody set by hand is never overwritten — what moves is a separate learned
		amount added to it, capped so nothing can strengthen without limit. Fading stops at a floor
		where a connection no longer reaches the activation threshold: it has stopped crowding
		results, but it is still on the map and still restorable. Removing one is a suggestion in the
		owner's Cortex tab, never something this does on its own.
	</p>
	<div class="grid">
		<label class="check">
			<input type="checkbox" bind:checked={cortex.learning} /> connections learn from use
		</label>
		<label>
			suggest removing after (days unused)
			<input type="number" min="7" max="3650" bind:value={cortex.staleDays} />
		</label>
	</div>
	<p class="hint" role="status">
		{#if cortex.learning}
			<strong>On.</strong> A faded connection that nothing has traversed in
			{cortex.staleDays} days is raised as a suggestion to disconnect.
		{:else}
			<strong>Off.</strong> No strength moves on its own in either direction. Anything already
			learned is kept and still counts — it is simply frozen where it is.
		{/if}
	</p>
	<p class="hint" role="status">
		{#if cortex.agentWrites}
			<strong>Agents can write.</strong> The <code>cortex_write</code> tool is offered on chat and
			coding turns, so a conversation can add a concept and connect it. It cannot file one under
			an area, mark it a bridge, merge or delete — those go through the review queue.
		{:else}
			<strong>Agents cannot write.</strong> <code>cortex_write</code> is withheld from every turn,
			so nothing reaches the lattice except what you add here or accept from a suggestion. It will
			still appear in Admin → Tools, which lists what exists rather than what is currently offered.
		{/if}
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
