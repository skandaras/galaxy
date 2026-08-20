<script lang="ts">
	interface Skill {
		id: string;
		name: string;
		category: string;
		description: string;
		triggers: string;
		version: number;
		author: 'user' | 'agent';
		enabled: boolean;
	}

	let skills = $state<Skill[]>([]);
	let template = $state('');
	let editing = $state<string | null>(null); // skill name, or '' for new
	let form = $state({ name: '', category: 'general', description: '', triggers: '', body: '' });
	let saved = $state(false);
	let errorMsg = $state<string | null>(null);

	async function load() {
		const data = await (await fetch('/api/skills')).json();
		skills = data.skills;
		template = data.template;
	}
	$effect(() => {
		void load();
	});

	const grouped = $derived(
		[...new Set(skills.map((s) => s.category))].map((cat) => ({
			category: cat,
			items: skills.filter((s) => s.category === cat)
		}))
	);

	function startNew() {
		editing = '';
		const parsed = template.match(/^---[\s\S]*?---\r?\n?([\s\S]*)$/);
		form = {
			name: '',
			category: 'general',
			description: '',
			triggers: '',
			body: parsed?.[1]?.trimStart() ?? ''
		};
		errorMsg = null;
	}

	async function edit(s: Skill) {
		const data = await (await fetch(`/api/skills/${s.name}`)).json();
		editing = s.name;
		form = {
			name: s.name,
			category: s.category,
			description: s.description,
			triggers: s.triggers,
			body: data.body
		};
		errorMsg = null;
	}

	async function save() {
		const isNew = editing === '';
		const res = await fetch(isNew ? '/api/skills' : `/api/skills/${editing}`, {
			method: isNew ? 'POST' : 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(form)
		});
		if (!res.ok) {
			errorMsg = (await res.json().catch(() => ({})))?.message ?? 'Save failed';
			return;
		}
		saved = true;
		setTimeout(() => (saved = false), 1500);
		editing = null;
		await load();
	}

	async function toggle(s: Skill) {
		await fetch(`/api/skills/${s.name}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: !s.enabled })
		});
		await load();
	}

	async function remove(s: Skill) {
		if (!confirm(`Delete skill "${s.name}"?`)) return;
		await fetch(`/api/skills/${s.name}`, { method: 'DELETE' });
		if (editing === s.name) editing = null;
		await load();
	}
</script>

<section>
	{#if editing === null}
		<button class="btn primary" onclick={startNew}>+ New skill</button>
		{#each grouped as group (group.category)}
			<h3>{group.category}</h3>
			<table>
				<tbody>
					{#each group.items as s (s.id)}
						<tr class:disabled={!s.enabled}>
							<td class="on"><input type="checkbox" checked={s.enabled} onchange={() => toggle(s)} /></td>
							<td>
								<div class="name">
									{s.name}
									<span class="v">v{s.version}</span>
									{#if s.author === 'agent'}<span class="agent-badge">agent</span>{/if}
								</div>
								<div class="desc">{s.description}</div>
								{#if s.triggers}<div class="trig">triggers: {s.triggers}</div>{/if}
							</td>
							<td class="actions">
								<button class="btn" onclick={() => edit(s)}>Edit</button>
								<button class="btn danger" onclick={() => remove(s)}>Delete</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="empty">No skills yet — create the first one. Skills are versioned in a git repo on the data volume.</p>
		{/each}
	{:else}
		<div class="form">
			{#if errorMsg}<p class="error">{errorMsg}</p>{/if}
			<div class="grid">
				<label>
					name
					<input bind:value={form.name} disabled={editing !== ''} placeholder="kebab-case-name" />
				</label>
				<label>
					category
					<input bind:value={form.category} placeholder="general" />
				</label>
				<label class="wide">
					description (shown in the agent's skill index)
					<input bind:value={form.description} placeholder="When and why to use this skill" />
				</label>
				<label class="wide">
					triggers (comma-separated keywords)
					<input bind:value={form.triggers} />
				</label>
			</div>
			<textarea rows="14" bind:value={form.body} placeholder="Skill instructions (markdown)"></textarea>
			<div class="row">
				<button class="btn primary" onclick={save}>{saved ? 'Saved ✓' : 'Save skill'}</button>
				<button class="btn" onclick={() => (editing = null)}>Cancel</button>
			</div>
		</div>
	{/if}
</section>

<style>
	h3 {
		font-size: var(--text-base);
		color: var(--heading);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		margin: 1.1rem 0 0.3rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-md);
	}
	td {
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	tr.disabled td {
		opacity: 0.45;
	}
	.on {
		width: 2rem;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.v {
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	.agent-badge {
		font-size: var(--text-xs);
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		text-transform: uppercase;
	}
	.desc {
		color: var(--fg-dim);
		font-size: var(--text-base);
	}
	.trig {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		font-style: italic;
	}
	.actions {
		white-space: nowrap;
		text-align: right;
	}
	.empty {
		color: var(--fg-dim);
		font-size: var(--text-md);
	}
	.error {
		color: var(--danger);
		font-size: var(--text-base);
	}
	.form {
		margin-top: 0.6rem;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.6rem;
		margin-bottom: 0.6rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--text-sm);
		color: var(--label);
	}
	label.wide {
		grid-column: span 2;
	}
	input,
	textarea {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.4rem 0.55rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
	}
	.row {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: var(--text-base);
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.danger {
		color: var(--danger);
		background: transparent;
		border: 1px solid var(--danger);
	}
	@media (max-width: 720px) {
		.grid {
			grid-template-columns: 1fr;
		}
		label.wide {
			grid-column: span 1;
		}
	}
</style>
