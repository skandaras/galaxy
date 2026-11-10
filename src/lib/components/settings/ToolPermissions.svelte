<script lang="ts">
	import { ask } from '$lib/confirm.svelte';
	import { grantedOn } from '$lib/permission-prompt';

	interface Grant {
		key: string;
		label: string;
		server?: string;
		at: number;
	}

	let grants = $state<Grant[]>([]);
	let loaded = $state(false);
	let notice = $state<string | null>(null);
	let noticeFailed = $state(false);
	let revoking = $state<string | null>(null);

	$effect(() => {
		void load();
	});

	function say(text: string, failed = false) {
		notice = text;
		noticeFailed = failed;
	}

	async function load() {
		const res = await fetch('/api/settings/tool-grants').catch(() => null);
		if (!res?.ok) {
			say('Could not load your tool permissions. Reload to try again.', true);
			return;
		}
		grants = (await res.json()).grants;
		loaded = true;
	}

	async function revoke(grant: Grant) {
		if (
			!(await ask({
				title: `Revoke "${grant.label}"?`,
				body: 'The agent will ask again the next time it wants to use this tool.',
				confirm: 'Revoke',
				danger: true
			}))
		)
			return;
		revoking = grant.key;
		const res = await fetch(`/api/settings/tool-grants?key=${encodeURIComponent(grant.key)}`, {
			method: 'DELETE'
		}).catch(() => null);
		revoking = null;
		if (!res?.ok) {
			say(`Could not revoke "${grant.label}". Try again.`, true);
			return;
		}
		// The list is reloaded rather than filtered locally, so what shows is what
		// the server holds.
		say(`Revoked "${grant.label}".`);
		await load();
	}
</script>

<section>
	{#if notice}
		<p class="notice" class:error={noticeFailed} role={noticeFailed ? 'alert' : 'status'}>
			{notice}
		</p>
	{/if}

	<article class="card">
		<h3>Tool permissions</h3>
		<p class="hint">
			Tools you chose to always allow run without asking. "Allow for this session" grants are not
			listed here: they end with the chat.
		</p>
		{#each grants as g (g.key)}
			<div class="row">
				<span class="grant">
					{g.label}
					<span class="meta">
						{#if g.server}{g.server} · {/if}allowed {grantedOn(g.at)}
					</span>
				</span>
				<button class="btn danger" disabled={revoking === g.key} onclick={() => revoke(g)}
					>Revoke</button
				>
			</div>
		{:else}
			{#if loaded}<p class="hint">No tools are always allowed. The agent asks each time.</p>{/if}
		{/each}
	</article>
</section>

<style>
	.card {
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.hint {
		margin: 0.4rem 0 0.6rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.grant {
		flex: 1;
		min-width: 0;
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	.meta {
		display: block;
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin-top: 0.1rem;
	}
</style>
