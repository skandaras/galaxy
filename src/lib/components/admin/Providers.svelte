<script lang="ts">
	interface Provider {
		id: string;
		kind: string;
		name: string;
		baseUrl: string;
		hasKey: boolean;
		enabled: boolean;
	}

	let providers = $state<Provider[]>([]);
	let form = $state({ kind: 'openrouter', name: '', baseUrl: '', apiKey: '' });
	let keyEditId = $state<string | null>(null);
	let keyDraft = $state('');
	let busy = $state<string | null>(null);
	let notice = $state<string | null>(null);

	let { onchanged }: { onchanged?: () => void } = $props();

	async function load() {
		providers = await (await fetch('/api/admin/providers')).json();
	}
	$effect(() => {
		void load();
	});

	async function add() {
		busy = 'add';
		const res = await fetch('/api/admin/providers', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				kind: form.kind,
				name: form.name || undefined,
				baseUrl: form.baseUrl || undefined,
				apiKey: form.apiKey || undefined
			})
		});
		busy = null;
		if (!res.ok) {
			notice = (await res.json().catch(() => ({})))?.message ?? 'Failed to add provider';
			return;
		}
		form = { kind: 'openrouter', name: '', baseUrl: '', apiKey: '' };
		notice = null;
		await load();
	}

	async function sync(p: Provider) {
		busy = p.id;
		const res = await fetch(`/api/admin/providers/${p.id}/sync`, { method: 'POST' });
		const data = await res.json().catch(() => ({}));
		notice = res.ok
			? `Synced ${data.synced} models from ${p.name} — enable the ones you want in the Models tab`
			: `Sync failed: ${data.message ?? res.statusText}`;
		busy = null;
		onchanged?.();
	}

	async function patch(p: Provider, body: Record<string, unknown>) {
		await fetch(`/api/admin/providers/${p.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		keyEditId = null;
		keyDraft = '';
		await load();
	}

	async function remove(p: Provider) {
		if (!confirm(`Delete provider "${p.name}" and its models?`)) return;
		await fetch(`/api/admin/providers/${p.id}`, { method: 'DELETE' });
		await load();
		onchanged?.();
	}
</script>

<section>
	{#if notice}<p class="notice">{notice}</p>{/if}

	<table>
		<thead>
			<tr><th>Name</th><th>Kind</th><th>Base URL</th><th>Key</th><th></th></tr>
		</thead>
		<tbody>
			{#each providers as p (p.id)}
				<tr class:disabled={!p.enabled}>
					<td>{p.name}</td>
					<td>{p.kind}</td>
					<td class="url">{p.baseUrl}</td>
					<td>
						{#if keyEditId === p.id}
							<input type="password" bind:value={keyDraft} placeholder="paste API key" />
							<button class="btn" onclick={() => patch(p, { apiKey: keyDraft })}>Save</button>
						{:else}
							{p.hasKey ? '●●●' : '—'}
							<button class="link" onclick={() => ((keyEditId = p.id), (keyDraft = ''))}>
								set
							</button>
						{/if}
					</td>
					<td class="actions">
						<button class="btn" disabled={busy === p.id} onclick={() => sync(p)}>
							{busy === p.id ? 'Syncing…' : 'Sync models'}
						</button>
						<button class="btn" onclick={() => patch(p, { enabled: !p.enabled })}>
							{p.enabled ? 'Disable' : 'Enable'}
						</button>
						<button class="btn danger" onclick={() => remove(p)}>Delete</button>
					</td>
				</tr>
			{:else}
				<tr><td colspan="5" class="empty">No providers yet — add one below.</td></tr>
			{/each}
		</tbody>
	</table>

	<h3>Add provider</h3>
	<div class="form">
		<label>
			kind
			<select bind:value={form.kind}>
				<option value="openrouter">OpenRouter</option>
				<option value="openai-compatible">OpenAI-compatible endpoint</option>
			</select>
		</label>
		<label>
			name <span class="opt">optional</span>
			<input bind:value={form.name} />
		</label>
		<label>
			base URL
			<input
				placeholder={form.kind === 'openrouter' ? 'default: openrouter.ai' : 'http://host:8000/v1'}
				bind:value={form.baseUrl}
			/>
		</label>
		<label>
			API key <span class="opt">optional</span>
			<input type="password" bind:value={form.apiKey} />
		</label>
		<button class="btn primary" disabled={busy === 'add'} onclick={add}>Add</button>
	</div>
</section>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--fg-dim);
		font-weight: normal;
	}
	tr.disabled td {
		opacity: 0.45;
	}
	.url {
		font-size: 0.7rem;
		color: var(--fg-dim);
		word-break: break-all;
	}
	.actions {
		white-space: nowrap;
	}
	.empty {
		color: var(--fg-dim);
	}
	.notice {
		color: var(--accent);
		font-size: 0.78rem;
	}
	h3 {
		font-size: 0.8rem;
		color: var(--heading);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		margin-top: 1.5rem;
	}
	.form {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.form label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.68rem;
		color: var(--label);
	}
	.opt {
		color: var(--fg-dim);
		font-size: 0.62rem;
	}
	input,
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.6rem;
		font-family: inherit;
		font-size: 0.72rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.danger {
		color: var(--danger);
	}
	.btn:disabled {
		opacity: 0.5;
	}
	.link {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.7rem;
		font-family: inherit;
	}
</style>
