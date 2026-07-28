<script lang="ts">
	interface CatalogEntry {
		name: string;
		source: 'builtin' | 'mcp';
		group: string;
		tasks: string[];
		description: string;
		effectiveDescription: string;
		descriptionOverride: string | null;
		taskOverride: string[] | null;
		parameters: Record<string, unknown>;
		note?: string;
		serverId?: string;
		enabled: boolean;
	}
	interface Server {
		id: string;
		name: string;
		transport: 'http' | 'stdio';
		url: string | null;
		command: string | null;
		args: string[] | null;
		toolPrefix: string;
		tasks: string[] | null;
		enabled: boolean;
		status: 'unknown' | 'ok' | 'error';
		lastError: string | null;
		lastSyncAt: number | null;
		hasHeaders: boolean;
		toolCount: number;
	}

	let tools = $state<CatalogEntry[]>([]);
	let servers = $state<Server[]>([]);
	let expanded = $state<string | null>(null);
	let errorMsg = $state<string | null>(null);
	let syncing = $state<string | null>(null);
	let syncNote = $state<string | null>(null);

	const blankServer = () => ({
		id: '',
		name: '',
		transport: 'http' as 'http' | 'stdio',
		url: '',
		command: '',
		argsText: '',
		headersText: '',
		toolPrefix: '',
		enabled: true
	});
	let serverForm = $state<ReturnType<typeof blankServer> | null>(null);

	async function load() {
		const [toolsRes, serversRes] = await Promise.all([
			fetch('/api/admin/tools'),
			fetch('/api/admin/mcp-servers')
		]);
		// Scope chips come from each tool's own tasks, so the global task list in
		// the response is not needed here.
		tools = (await toolsRes.json()).tools;
		servers = await serversRes.json();
	}
	$effect(() => {
		void load();
	});

	const grouped = $derived(
		[...new Set(tools.map((t) => t.group))].map((group) => ({
			group,
			source: tools.find((t) => t.group === group)!.source,
			items: tools.filter((t) => t.group === group)
		}))
	);

	async function patch(tool: CatalogEntry, body: Record<string, unknown>) {
		errorMsg = null;
		const res = await fetch(`/api/admin/tools/${tool.name}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			errorMsg = (await res.json().catch(() => ({})))?.message ?? 'Update failed';
			return;
		}
		await load();
	}

	async function resetTool(tool: CatalogEntry) {
		await fetch(`/api/admin/tools/${tool.name}`, { method: 'DELETE' });
		await load();
	}

	/**
	 * Scoping can only narrow — a tool is never offered to a task it doesn't
	 * serve — so the chips are the tool's own tasks and unticking one removes it.
	 * Clearing the last would mean "nowhere", which is what the enable checkbox
	 * is for, so it's refused rather than silently reverting to unrestricted.
	 */
	function toggleTask(tool: CatalogEntry, task: string) {
		const current = tool.taskOverride ?? tool.tasks;
		const next = current.includes(task)
			? current.filter((t) => t !== task)
			: [...current, task];
		if (!next.length) {
			errorMsg = `Use the checkbox to turn ${tool.name} off — a tool needs at least one task.`;
			return;
		}
		void patch(tool, { tasks: next });
	}

	function editServer(s: Server) {
		serverForm = {
			id: s.id,
			name: s.name,
			transport: s.transport,
			url: s.url ?? '',
			command: s.command ?? '',
			argsText: (s.args ?? []).join(' '),
			headersText: '',
			toolPrefix: s.toolPrefix,
			enabled: s.enabled
		};
	}

	async function saveServer() {
		if (!serverForm) return;
		errorMsg = null;
		const headers = parseHeaders(serverForm.headersText);
		if (headers === 'invalid') {
			errorMsg = 'Headers must be one "Name: value" pair per line';
			return;
		}
		const body: Record<string, unknown> = {
			name: serverForm.name,
			transport: serverForm.transport,
			url: serverForm.url || null,
			command: serverForm.command || null,
			args: serverForm.argsText.trim() ? serverForm.argsText.trim().split(/\s+/) : null,
			toolPrefix: serverForm.toolPrefix,
			enabled: serverForm.enabled
		};
		// Leaving the headers box empty on an edit keeps the stored ones.
		if (headers !== null) body.headers = headers;

		const isNew = !serverForm.id;
		const res = await fetch(
			isNew ? '/api/admin/mcp-servers' : `/api/admin/mcp-servers/${serverForm.id}`,
			{
				method: isNew ? 'POST' : 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}
		);
		if (!res.ok) {
			errorMsg = (await res.json().catch(() => ({})))?.message ?? 'Save failed';
			return;
		}
		const saved = await res.json();
		serverForm = null;
		await load();
		// A new server has no tools until it's been talked to.
		if (isNew) await sync(saved.id);
	}

	/** null = leave unchanged, 'invalid' = parse error, {} = clear. */
	function parseHeaders(text: string): Record<string, string> | null | 'invalid' {
		const trimmed = text.trim();
		if (!trimmed) return null;
		const out: Record<string, string> = {};
		for (const line of trimmed.split('\n')) {
			const idx = line.indexOf(':');
			if (idx < 1) return 'invalid';
			out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
		return out;
	}

	async function sync(id: string) {
		syncing = id;
		syncNote = null;
		const res = await fetch(`/api/admin/mcp-servers/${id}/sync`, { method: 'POST' });
		const result = await res.json().catch(() => ({ ok: false, error: 'Request failed' }));
		syncing = null;
		syncNote = result.ok
			? `Discovered ${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}.`
			: `Sync failed: ${result.error}`;
		await load();
	}

	async function removeServer(s: Server) {
		if (!confirm(`Remove MCP server "${s.name}" and its tools?`)) return;
		await fetch(`/api/admin/mcp-servers/${s.id}`, { method: 'DELETE' });
		await load();
	}

	function paramList(parameters: Record<string, unknown>): string[] {
		const props = (parameters?.properties ?? {}) as Record<string, { type?: string }>;
		const required = new Set((parameters?.required as string[]) ?? []);
		return Object.entries(props).map(
			([key, spec]) => `${key}${required.has(key) ? '' : '?'}: ${spec?.type ?? 'any'}`
		);
	}
</script>

<section>
	{#if errorMsg}<p class="error">{errorMsg}</p>{/if}

	<h3>Tools</h3>
	<p class="hint">
		Everything the agents can call. Disabling a tool removes it from the model's toolset
		immediately; editing a description changes what the model is told the tool does.
	</p>

	{#each grouped as group (group.group)}
		<h4>
			{group.group}
			{#if group.source === 'mcp'}<span class="badge">mcp</span>{/if}
		</h4>
		<table>
			<tbody>
				{#each group.items as tool (tool.name)}
					<tr class:disabled={!tool.enabled}>
						<td class="on">
							<input
								type="checkbox"
								checked={tool.enabled}
								aria-label="Enable {tool.name}"
								onchange={() => patch(tool, { enabled: !tool.enabled })}
							/>
						</td>
						<td>
							<div class="name">
								<button class="linkish" onclick={() => (expanded = expanded === tool.name ? null : tool.name)}>
									{tool.name}
								</button>
								{#if tool.descriptionOverride}<span class="badge">edited</span>{/if}
								{#if tool.taskOverride}<span class="badge">scoped</span>{/if}
								{#if tool.note}<span class="note">{tool.note}</span>{/if}
							</div>
							<div class="desc">{tool.effectiveDescription}</div>

							{#if expanded === tool.name}
								<div class="detail">
									<label class="wide">
										description shown to the model
										<textarea
											rows="3"
											value={tool.effectiveDescription}
											onchange={(e) =>
												patch(tool, { descriptionOverride: e.currentTarget.value })}
										></textarea>
									</label>
									<div class="scope">
										<span class="scope-label">available in</span>
										{#each tool.tasks as task (task)}
											<button
												class="chip"
												class:on={(tool.taskOverride ?? tool.tasks).includes(task)}
												onclick={() => toggleTask(tool, task)}>{task}</button
											>
										{/each}
										{#if tool.tasks.length === 1}
											<span class="scope-label">— this tool only applies to {tool.tasks[0]}</span>
										{/if}
									</div>
									{#if paramList(tool.parameters).length}
										<div class="params">
											{#each paramList(tool.parameters) as p (p)}<code>{p}</code>{/each}
										</div>
									{:else}
										<div class="params dim">no parameters</div>
									{/if}
									{#if tool.descriptionOverride || tool.taskOverride || !tool.enabled}
										<button class="btn" onclick={() => resetTool(tool)}>Reset to defaults</button>
									{/if}
								</div>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/each}

	<h3>MCP servers</h3>
	<p class="hint">
		Connect an external MCP server and its tools join the list above. HTTP servers work anywhere;
		stdio servers need their command installed inside the Galaxy container. Credentials are
		static only — servers requiring an OAuth sign-in can't be connected. <code>docs/MCP.md</code>
		lists which known servers work.
	</p>
	{#if syncNote}<p class="hint note-line">{syncNote}</p>{/if}

	{#if servers.length}
		<table>
			<tbody>
				{#each servers as s (s.id)}
					<tr class:disabled={!s.enabled}>
						<td class="on">
							<span class="dot {s.status}" title={s.lastError ?? s.status}></span>
						</td>
						<td>
							<div class="name">
								{s.name}
								<span class="badge">{s.transport}</span>
								<span class="dim">{s.toolCount} tools</span>
							</div>
							<div class="desc">{s.transport === 'http' ? s.url : `${s.command} ${(s.args ?? []).join(' ')}`}</div>
							{#if s.lastError}<div class="err-line">{s.lastError}</div>{/if}
						</td>
						<td class="actions">
							<button class="btn" disabled={syncing === s.id} onclick={() => sync(s.id)}>
								{syncing === s.id ? 'Syncing…' : 'Sync'}
							</button>
							<button class="btn" onclick={() => editServer(s)}>Edit</button>
							<button class="btn danger" onclick={() => removeServer(s)}>Remove</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if serverForm}
		<div class="form">
			<div class="grid">
				<label>
					name
					<input bind:value={serverForm.name} placeholder="Linear" />
				</label>
				<label>
					transport
					<select bind:value={serverForm.transport}>
						<option value="http">http</option>
						<option value="stdio">stdio</option>
					</select>
				</label>
				{#if serverForm.transport === 'http'}
					<label class="wide">
						url
						<input bind:value={serverForm.url} placeholder="https://mcp.example.com/mcp" />
					</label>
					<label class="wide">
						headers (one "Name: value" per line{serverForm.id ? '; leave blank to keep stored' : ''})
						<textarea rows="2" bind:value={serverForm.headersText} placeholder="Authorization: Bearer …"
						></textarea>
					</label>
				{:else}
					<label>
						command
						<input bind:value={serverForm.command} placeholder="npx" />
					</label>
					<label>
						args
						<input bind:value={serverForm.argsText} placeholder="-y @modelcontextprotocol/server-git" />
					</label>
				{/if}
				<label>
					tool prefix
					<input bind:value={serverForm.toolPrefix} placeholder="linear" />
				</label>
				<label class="inline">
					<input type="checkbox" bind:checked={serverForm.enabled} /> enabled
				</label>
			</div>
			<div class="row">
				<button class="btn primary" onclick={saveServer}>Save server</button>
				<button class="btn" onclick={() => (serverForm = null)}>Cancel</button>
			</div>
		</div>
	{:else}
		<button class="btn primary" onclick={() => (serverForm = blankServer())}>+ Add MCP server</button>
	{/if}
</section>

<style>
	h3 {
		font-size: 0.75rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		margin: 1.4rem 0 0.3rem;
	}
	h4 {
		font-size: 0.7rem;
		color: var(--fg-dim);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		margin: 0.9rem 0 0.2rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.hint {
		color: var(--fg-dim);
		font-size: 0.72rem;
		margin: 0.2rem 0 0.6rem;
		max-width: 46rem;
	}
	.note-line {
		color: var(--fg);
	}
	.error {
		color: var(--danger);
		font-size: 0.75rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8rem;
	}
	td {
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	tr.disabled td {
		opacity: 0.45;
	}
	/* Must stay tag-qualified: the scope chips below carry .on for their
	   active state, and a bare .on clamped them to 2rem so the label spilled
	   out of the pill. */
	td.on {
		width: 2rem;
	}
	/* Cells are top-aligned because rows grow; nudge the checkbox onto the
	   baseline of the tool name rather than the top edge of the cell. */
	td.on input {
		margin: 0.2rem 0 0;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.linkish {
		background: none;
		border: none;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.8rem;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}
	.linkish:hover {
		color: var(--accent);
	}
	.badge {
		font-size: 0.58rem;
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 3px;
		padding: 0 0.25rem;
		text-transform: uppercase;
	}
	.note,
	.dim {
		color: var(--fg-dim);
		font-size: 0.65rem;
	}
	.desc {
		color: var(--fg-dim);
		font-size: 0.72rem;
	}
	.err-line {
		color: var(--danger);
		font-size: 0.68rem;
		margin-top: 0.2rem;
	}
	.detail {
		margin-top: 0.6rem;
		padding: 0.6rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.scope {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	/* .detail is a flex column, so a bare button would stretch edge to edge. */
	.detail .btn {
		align-self: flex-start;
	}
	.scope-label {
		color: var(--fg-dim);
		font-size: 0.68rem;
	}
	.chip {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: 0.68rem;
		padding: 0.15rem 0.55rem;
		cursor: pointer;
		/* Without these a hyphenated label like "deep-research" wraps mid-word
		   inside the pill, turning it into a circle that overlaps its neighbours. */
		white-space: nowrap;
		flex-shrink: 0;
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}
	.params {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		font-size: 0.68rem;
		color: var(--fg-dim);
	}
	.dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--fg-dim);
		margin-top: 0.35rem;
	}
	.dot.ok {
		background: #6fd08c;
	}
	.dot.error {
		background: var(--danger);
	}
	.actions {
		white-space: nowrap;
		text-align: right;
	}
	.form {
		margin-top: 0.8rem;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.6rem;
	}
	.wide {
		grid-column: 1 / -1;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	label.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	input,
	select,
	textarea {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
		border-radius: 4px;
	}
	label.inline input {
		width: auto;
	}
	.row {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.7rem;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 4px;
		padding: 0.3rem 0.6rem;
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
		cursor: default;
	}
</style>
