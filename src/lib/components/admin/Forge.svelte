<script lang="ts">
	/**
	 * The two dials, and the switch that turns the driver on at all.
	 *
	 * Forge ships off. The defaults below are meant to make a first build slow
	 * and watchable: somebody who wants it faster can say so, and somebody who
	 * does not should never discover the setting through their bill.
	 */
	let forge = $state({
		enabled: false,
		stepsPerTick: 1,
		concurrentEpics: 1,
		concurrentTasks: 1,
		maxStepsPerTask: 50,
		maxAttempts: 3,
		maxUsdPerEpic: 0,
		maxUsdPerDay: 0,
		autoApproveCharter: false
	});
	let notice = $state<string | null>(null);
	let busy = $state(false);

	async function load() {
		const settings = await (await fetch('/api/admin/settings')).json();
		forge = { ...forge, ...settings.forge };
	}
	$effect(() => {
		void load();
	});

	async function save() {
		busy = true;
		await fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key: 'forge', value: forge })
		});
		busy = false;
		notice = 'Saved';
		// Read back rather than trusted: the API clamps on the way in, and a form
		// still showing 40 after the server stored 20 is a form that lies.
		await load();
	}

	const perHour = $derived(forge.stepsPerTick * 12);
</script>

<section>
	<h3>The driver</h3>
	<p class="hint">
		A build is a row and each unit of work is a short job, because the server restarts and anything
		trying to be a two-day process dies with it. The scheduler asks each running build what it
		should do next and starts that one thing — so a restart mid-build loses at most one step, and
		these numbers bound how much is in flight at once rather than how long anything may take.
	</p>

	<label class="check">
		<input type="checkbox" bind:checked={forge.enabled} /> let builds run on their own
	</label>
	<p class="hint">
		Off, nothing advances unless somebody presses <em>Run one step now</em> on the build itself.
	</p>

	<div class="grid">
		<label>
			steps per tick
			<input type="number" min="0" max="20" bind:value={forge.stepsPerTick} />
		</label>
		<label>
			builds working at once
			<input type="number" min="1" max="10" bind:value={forge.concurrentEpics} />
		</label>
		<label>
			tasks at once, per build
			<input type="number" min="1" max="10" bind:value={forge.concurrentTasks} />
		</label>
		<label>
			model steps per task attempt
			<input type="number" min="5" max="200" bind:value={forge.maxStepsPerTask} />
		</label>
		<label>
			attempts before it parks
			<input type="number" min="1" max="10" bind:value={forge.maxAttempts} />
		</label>
	</div>
	<p class="hint">
		The tick is five minutes, so {forge.stepsPerTick} step{forge.stepsPerTick === 1 ? '' : 's'} a tick
		is at most <strong>{perHour} an hour</strong> whatever the models do.
		{#if forge.stepsPerTick === 0}
			At 0 everything is paused — and because this is a stored setting rather than a flag in a
			process, that pause survives a restart.
		{/if}
	</p>

	<h3>What it may spend</h3>
	<p class="hint">
		Money and wall clock are independent, which is why there are two dials rather than one "speed".
		Both ceilings are read <strong>between steps and never inside one</strong>: a step is the unit
		that produces something usable, so stopping between them leaves a coherent tree rather than a
		half-written file. Spend is summed from the usage log — a build's coding turns and its planning
		runs both — never counted on the build's own row, so it is a number you can audit.
	</p>
	<div class="grid">
		<label>
			per build ($, 0 for none)
			<input type="number" min="0" max="10000" step="0.5" bind:value={forge.maxUsdPerEpic} />
		</label>
		<label>
			per rolling day, all builds ($, 0 for none)
			<input type="number" min="0" max="10000" step="0.5" bind:value={forge.maxUsdPerDay} />
		</label>
	</div>
	<p class="hint">
		A build that reaches its own ceiling pauses and rings the owner's bell; raising the ceiling on
		the build itself is what starts it again. The platform-wide cap in Settings outranks both of
		these.
	</p>

	<h3>Approval</h3>
	<label class="check">
		<input type="checkbox" bind:checked={forge.autoApproveCharter} /> start building without asking
	</label>
	<p class="hint">
		The charter is the one moment a person is asked for anything, and it is where the commands a
		build is judged by get frozen. Turn this on and a brief goes to a pull request unattended —
		with the checks the charter proposed for itself, which no longer had a person read them.
	</p>

	<div class="row">
		<button class="primary" onclick={save} disabled={busy}>Save</button>
		{#if notice}<span class="hint">{notice}</span>{/if}
	</div>
</section>

<style>
	h3 {
		font-size: var(--text-md);
		margin: 1.4rem 0 0.4rem;
	}
	h3:first-child {
		margin-top: 0;
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
		margin: 0.3rem 0 0.6rem;
		max-width: 60ch;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 0.7rem;
		max-width: 60rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
	}
	input {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font: inherit;
		font-size: var(--text-sm);
		padding: 0.4rem 0.5rem;
		min-height: var(--tap);
		box-sizing: border-box;
	}
	input[type='checkbox'] {
		min-height: 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-top: 1.2rem;
	}
	button {
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		padding: 0.35rem 0.8rem;
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
		min-height: var(--tap);
	}
	button.primary {
		border-color: var(--accent);
		color: var(--accent);
	}
	button:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
