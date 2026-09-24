<script lang="ts">
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
	}
	interface ModelOption {
		id: string;
		displayName: string;
		providerName: string;
	}
	interface PromptVersion {
		id: string;
		systemPrompt: string;
		author: string;
		createdAt: number;
	}

	/**
	 * Model advice for the tasks where the choice of model is part of the
	 * method, not only a matter of cost.
	 */
	const TASK_NOTES: Record<string, string> = {
		'ivory-read': 'A small model is enough: it reads and quotes.',
		'ivory-plan': 'A large model: it decides what the project does next.',
		'ivory-synthesise': 'A mid-size model: it turns notes into claims.',
		'ivory-redteam':
			'Pick a model from a different family than ivory-synthesise’s. A claim reviewed by its own model family is refused.'
	};

	let configs = $state<TaskConfig[]>([]);
	let models = $state<ModelOption[]>([]);
	let historyTask = $state<string | null>(null);
	let versions = $state<PromptVersion[]>([]);
	let savedTask = $state<string | null>(null);

	async function load() {
		const [cfgRes, modelRes] = await Promise.all([
			fetch('/api/admin/task-configs'),
			fetch('/api/models')
		]);
		configs = await cfgRes.json();
		models = (await modelRes.json()).models;
	}
	$effect(() => {
		void load();
	});

	async function save(cfg: TaskConfig) {
		await fetch('/api/admin/task-configs', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(cfg)
		});
		// The route clears the override when the text matches the default, so the
		// badge has to be recomputed here rather than left as it was.
		cfg.overridden = cfg.systemPrompt !== cfg.defaultPrompt;
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
		cfg.systemPrompt = cfg.defaultPrompt;
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
	<p class="preamble">
		A box left at the shipped wording keeps tracking it, so a prompt improved in a later release
		arrives on its own. Save anything else and the task is marked <em>edited</em>: it is yours from
		then on and nothing will touch it, until you reset it.
	</p>
	<p class="preamble">
		The agents that write prose also carry a shared house style, which is not shown in these boxes
		and is not editable here — how they sound reaches chat, coding, deep research, the board, the
		sub-agent and the background reviewers, and how their replies are shaped reaches the ones that
		answer in prose rather than JSON. Read it, and add your own rules to it, under Settings &rarr;
		House style.
	</p>
	{#each configs as cfg (cfg.task)}
		<article class="card">
			<header>
				<h3>
					{cfg.task}
					{#if cfg.overridden}<span class="badge">edited</span>{/if}
				</h3>
				{#if TASK_NOTES[cfg.task]}<p class="task-note">{TASK_NOTES[cfg.task]}</p>{/if}
				<div class="model-row">
					<label>
						primary
						<select bind:value={cfg.primaryModelId}>
							<option value={null}>first enabled model</option>
							{#each models as m (m.id)}
								<option value={m.id}>{m.displayName} · {m.providerName}</option>
							{/each}
						</select>
					</label>
					<label>
						backup
						<select bind:value={cfg.backupModelId}>
							<option value={null}>none</option>
							{#each models as m (m.id)}
								<option value={m.id}>{m.displayName} · {m.providerName}</option>
							{/each}
						</select>
					</label>
				</div>
			</header>
			<textarea rows="4" bind:value={cfg.systemPrompt}></textarea>
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
	.task-note {
		margin: 0 0 0.4rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
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
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.25rem 0.4rem;
		max-width: 14rem;
	}
	.preamble {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin: 0 0 0.9rem;
	}
	/* Same shape as the scoped badge in Tools.svelte, for the same kind of fact:
	   this row is not on its default any more. */
	.badge {
		font-size: var(--text-xs);
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		text-transform: uppercase;
		vertical-align: middle;
		margin-left: 0.4rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.5rem 0.65rem;
		margin: 0.5rem 0;
		resize: vertical;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.32rem 0.65rem;
		font-family: inherit;
		font-size: var(--text-base);
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
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
	.preview {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--fg-dim);
	}
</style>
