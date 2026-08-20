<script lang="ts">
	interface UserRow {
		id: string;
		username: string;
		email: string | null;
		displayName: string | null;
		isAdmin: boolean;
		canCode: boolean;
		createdAt: number;
		lastSeenAt: number;
	}

	let rows = $state<UserRow[]>([]);
	let notice = $state<string | null>(null);

	async function load() {
		rows = await (await fetch('/api/admin/users')).json();
	}
	$effect(() => {
		void load();
	});

	async function setCanCode(user: UserRow, canCode: boolean) {
		await fetch('/api/admin/users', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: user.id, canCode })
		});
		notice = `${canCode ? 'Granted' : 'Removed'} coding access for ${user.username}`;
		await load();
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
</script>

<section>
	{#if notice}<p class="notice">{notice}</p>{/if}

	<article class="card">
		<h3>Accounts</h3>
		<p class="hint">
			Users appear here the first time they sign in through Authelia — there is no invite step in
			Galaxy. <strong>Admin</strong> comes from Authelia group membership and is re-read on every
			request, so it can only be changed there; it is shown here for reference.
		</p>
		<table>
			<thead>
				<tr><th>User</th><th>Admin</th><th>Coding</th><th>First seen</th><th>Last seen</th></tr>
			</thead>
			<tbody>
				{#each rows as u (u.id)}
					<tr>
						<td>
							{u.username}
							{#if u.email}<span class="meta">{u.email}</span>{/if}
						</td>
						<td>{u.isAdmin ? 'yes' : 'no'}</td>
						<td>
							<label class="toggle">
								<input
									type="checkbox"
									checked={u.canCode}
									onchange={(e) => setCanCode(u, e.currentTarget.checked)}
								/>
								{u.canCode ? 'allowed' : 'blocked'}
							</label>
						</td>
						<td class="when num">{when(u.createdAt)}</td>
						<td class="when num">{when(u.lastSeenAt)}</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="hint">No users yet.</td></tr>
				{/each}
			</tbody>
		</table>
		<p class="hint">
			<strong>Coding</strong> lets a user clone and push through the coding agent, which uses the
			single GitHub token in Settings — so it grants write access to every repository that token
			can reach. Off by default for new accounts.
		</p>
	</article>
</section>

<style>
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.5rem 0;
	}
	.notice {
		color: var(--accent);
		font-size: 0.75rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	th {
		color: var(--fg-dim);
		font-weight: normal;
	}
	/* Block, so the email sits on its own line under the username. Only ever on
	   the span inside a cell — putting it on a <td> is what broke this table. */
	.meta {
		color: var(--fg-dim);
		font-size: 0.68rem;
		display: block;
	}
	/* The timestamp columns are dimmed the same way, but they are cells: a
	   display:block <td> stops being a table cell, drops out of the column grid
	   and no longer lines up under its <th>. Colour and size only. */
	.when {
		color: var(--fg-dim);
		font-size: 0.68rem;
		white-space: nowrap;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.72rem;
		cursor: pointer;
	}
</style>
