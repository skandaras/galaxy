<script lang="ts">
	interface TaskConfig {
		task: string;
		systemPrompt: string;
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
		savedTask = cfg.task;
		setTimeout(() => (savedTask = null), 1500);
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
	{#each configs as cfg (cfg.task)}
		<article class="card">
			<header>
				<h3>{cfg.task}</h3>
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
		font-size: 0.85rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.model-row {
		display: flex;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	label {
		font-size: 0.7rem;
		color: var(--fg-dim);
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
		font-size: 0.72rem;
		padding: 0.25rem 0.4rem;
		max-width: 14rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.8rem;
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
		font-size: 0.72rem;
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
		font-size: 0.72rem;
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
