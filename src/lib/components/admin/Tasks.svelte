<script lang="ts">
	import { ADMIN_PATHS, taskLabel } from '$lib/admin-sections';

	interface Props {
		/** The tasks this admin section edits; see $lib/admin-sections. */
		only: readonly string[];
		/** The explanation of overrides and where style lives, once, in General tasks. */
		intro?: boolean;
	}
	let { only, intro = false }: Props = $props();
	import { ask } from '$lib/confirm.svelte';
	interface TaskConfig {
		task: string;
		/** What the task will run on: the override where there is one, else the default. */
		systemPrompt: string;
		/** What this release ships, so the box can be put back without a reload. */
		defaultPrompt: string;
		/** Whether the text above is the owner's or the shipped one. */
		overridden: boolean;
		primaryModelId: string | null;
		backupModelId: string | null;
		options?: Record<string, unknown> | null;
		/** Only the worker tiers have one: what the orchestrator reads to pick a tier. */
		description?: string;
		defaultDescription?: string;
	}
	/** Tasks whose model, when unset, becomes the first enabled one for every tier alike. */
	const FALLBACK_HINT = new Set(['coding-orchestrator', 'coding-tier1', 'coding-tier2']);
	interface ModelOption {
		id: string;
		displayName: string;
		providerName: string;
		imageOnly?: boolean;
	}
	/** A model that only draws can serve `visual` and nothing that wants text back. */
	const offered = (task: string) => models.filter((m) => task === 'visual' || !m.imageOnly);
	interface PromptVersion {
		id: string;
		systemPrompt: string;
		author: string;
		createdAt: number;
	}

	let configs = $state<TaskConfig[]>([]);
	let models = $state<ModelOption[]>([]);
	let historyTask = $state<string | null>(null);
	let versions = $state<PromptVersion[]>([]);
	let savedTask = $state<string | null>(null);
	let failedTask = $state<string | null>(null);

	async function load() {
		const [cfgRes, modelRes] = await Promise.all([
			fetch('/api/admin/task-configs'),
			fetch('/api/models?images=1')
		]);
		configs = await cfgRes.json();
		models = (await modelRes.json()).models;
	}
	$effect(() => {
		void load();
	});

	async function save(cfg: TaskConfig) {
		const res = await fetch('/api/admin/task-configs', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			// options is replaced whole on the server, so the description goes in
			// beside whatever other keys the row already carries.
			body: JSON.stringify(
				cfg.defaultDescription === undefined
					? cfg
					: { ...cfg, options: { ...cfg.options, description: cfg.description } }
			)
		}).catch(() => null);
		// Without this a refused prompt still showed "Saved ✓" and the edited badge.
		if (!res?.ok) {
			failedTask = cfg.task;
			return;
		}
		failedTask = null;
		// The route clears the override when the text matches the default, so the
		// badge has to be recomputed here rather than left as it was.
		cfg.overridden = cfg.systemPrompt !== cfg.defaultPrompt;
		if (cfg.defaultDescription !== undefined) {
			cfg.options = { ...cfg.options, description: cfg.description };
		}
		savedTask = cfg.task;
		setTimeout(() => (savedTask = null), 1500);
	}

	/**
	 * Hand the box back the shipped prompt and save it.
	 *
	 * Saving the default is what *clears* the override, so this needs no endpoint
	 * of its own. A task with no override tracks the code, which is the point:
	 * reset once and every future reword arrives without being asked for.
	 */
	async function resetToDefault(cfg: TaskConfig) {
		if (
			!(await ask({
				title: `Reset the ${cfg.task} prompt to the shipped wording?`,
				body: 'Your version stays in its history and can be restored.',
				confirm: 'Reset prompt'
			}))
		)
			return;
		cfg.systemPrompt = cfg.defaultPrompt;
		await save(cfg);
	}

	async function resetDescription(cfg: TaskConfig) {
		if (
			!(await ask({
				title: `Reset the ${taskLabel(cfg.task)} description to the shipped wording?`,
				body: 'The text you wrote is replaced and is not kept in a history.',
				confirm: 'Reset description'
			}))
		)
			return;
		cfg.description = cfg.defaultDescription;
		await save(cfg);
	}

	async function showHistory(task: string) {
		if (historyTask === task) {
			historyTask = null;
			return;
		}
		versions = await (await fetch(`/api/admin/task-configs/versions?task=${task}`)).json();
		historyTask = task;
	}

	async function restore(cfg: TaskConfig, v: PromptVersion) {
		cfg.systemPrompt = v.systemPrompt;
		await save(cfg);
		historyTask = null;
	}
</script>

<section>
	{#if intro}
	<p class="preamble">
		A box left at the shipped wording keeps tracking it, so a prompt improved in a later release
		arrives on its own. Save anything else and the task is marked <em>edited</em>: it is yours from
		then on and nothing will touch it, until you reset it.
	</p>
	<p class="preamble">
		These prompts say what each agent does. How the ones that write prose sound is set once, for
		all of them, under {ADMIN_PATHS.language}, and is added after the prompt on every turn.
	</p>
	{/if}
	{#each configs.filter((c) => only.includes(c.task)) as cfg (cfg.task)}
		<article class="card">
			<header>
				<h3>
					{taskLabel(cfg.task)}
					{#if cfg.overridden}<span class="badge">edited</span>{/if}
				</h3>
				<div class="model-row">
					<label>
						primary
						<select bind:value={cfg.primaryModelId}>
							<option value={null}>first enabled model</option>
							{#each offered(cfg.task) as m (m.id)}
								<option value={m.id}>{m.displayName} · {m.providerName}</option>
							{/each}
						</select>
					</label>
					<label>
						backup
						<select bind:value={cfg.backupModelId}>
							<option value={null}>none</option>
							{#each offered(cfg.task) as m (m.id)}
								<option value={m.id}>{m.displayName} · {m.providerName}</option>
							{/each}
						</select>
					</label>
				</div>
			</header>
			{#if FALLBACK_HINT.has(cfg.task)}
				<p class="hint">
					A model left unset falls back to the first enabled model, which removes the cost difference
					between the tiers.
				</p>
			{/if}
			<textarea rows="4" bind:value={cfg.systemPrompt} aria-label={`${taskLabel(cfg.task)} prompt`}
			></textarea>
			{#if cfg.defaultDescription !== undefined}
				<label class="desc">
					Send it
					<textarea rows="3" bind:value={cfg.description}></textarea>
					<span class="hint">
						The orchestrator reads this text when it chooses a tier for a task. Say what suits this
						worker and what does not.
					</span>
				</label>
				{#if cfg.description !== cfg.defaultDescription}
					<button class="btn" onclick={() => resetDescription(cfg)}>Reset description to default</button>
				{/if}
			{/if}
			<footer>
				<button class="btn primary" onclick={() => save(cfg)}>
					{savedTask === cfg.task ? 'Saved ✓' : 'Save'}
				</button>
				<button class="btn" onclick={() => showHistory(cfg.task)}>
					{historyTask === cfg.task ? 'Hide history' : 'History'}
				</button>
				{#if cfg.systemPrompt !== cfg.defaultPrompt}
					<button class="btn" onclick={() => resetToDefault(cfg)}>Reset to default</button>
				{/if}
				{#if failedTask === cfg.task}
					<span class="save-error" role="alert">Not saved. Try again.</span>
				{/if}
			</footer>
			{#if historyTask === cfg.task}
				<ul class="history">
					{#each versions as v (v.id)}
						<li>
							<span class="meta"
								>{new Date(v.createdAt).toLocaleString()} · {v.author}</span
							>
							<span class="preview">{v.systemPrompt.slice(0, 110)}…</span>
							<button class="btn" onclick={() => restore(cfg, v)}>Restore</button>
						</li>
					{:else}
						<li class="meta">No saved versions yet — versions record from the first edit.</li>
					{/each}
				</ul>
			{/if}
		</article>
	{/each}
</section>

<style>
	.card {
		margin-bottom: 0.9rem;
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: var(--text-lg);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.model-row {
		display: flex;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	label {
		font-size: var(--text-sm);
		color: var(--label);
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	select {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.25rem 0.4rem;
		max-width: 14rem;
	}
	.desc {
		flex-direction: column;
		align-items: stretch;
		gap: 0;
		margin-top: 0.4rem;
	}
	.preamble {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin: 0 0 0.9rem;
	}
	/* Sits on the heading line beside the task name, which is set larger than
	   the badge, so it is centred on that line rather than its baseline. */
	.badge {
		vertical-align: middle;
		margin-left: 0.4rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.5rem 0.65rem;
		margin: 0.5rem 0;
		resize: vertical;
	}
	.history {
		list-style: none;
		margin: 0.6rem 0 0;
		padding: 0;
		border-top: 1px solid var(--border);
	}
	.history li {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--border);
		font-size: var(--text-base);
	}
	.meta {
		color: var(--fg-dim);
		white-space: nowrap;
	}
	.save-error {
		align-self: center;
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.preview {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--fg-dim);
	}
</style>
