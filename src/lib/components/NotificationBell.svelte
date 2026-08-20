<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	interface Notification {
		id: string;
		kind: 'question' | 'card-assigned' | 'board-shared' | 'card-done' | 'turn-failed';
		title: string;
		body: string;
		link: string;
		urgent: boolean;
		createdAt: number;
		readAt: number | null;
	}

	const ICON: Record<Notification['kind'], string> = {
		question: '✋',
		'card-assigned': '◉',
		'board-shared': '⊞',
		'card-done': '✓',
		'turn-failed': '⚠'
	};

	let items = $state<Notification[]>([]);
	let unread = $state(0);
	let open = $state(false);
	let bellEl = $state<HTMLElement | null>(null);
	/**
	 * Where to pin the panel, in viewport coordinates.
	 *
	 * It has to be `fixed` rather than absolutely placed inside the nav: the
	 * pane is a scroll container (`overflow-y: auto`), which clips a child that
	 * sticks out sideways — so the panel was being sliced down the middle and
	 * the Mark-all-read button was off-screen entirely.
	 */
	let at = $state({ left: 0, bottom: 0, width: 0 });

	const PANEL_WIDTH = 360;
	const MARGIN = 8;

	function place() {
		const rect = bellEl?.getBoundingClientRect();
		if (!rect) return;
		const width = Math.min(PANEL_WIDTH, window.innerWidth - MARGIN * 2);
		at = {
			// Clamped to the viewport so a narrow window shifts it left rather
			// than pushing it off the edge.
			left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN)),
			bottom: Math.max(MARGIN, window.innerHeight - rect.top + 6),
			width
		};
	}

	function toggle() {
		open = !open;
		if (open) place();
	}

	onMount(() => {
		void load();
		const source = new EventSource('/api/notifications/stream');
		source.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.type === 'new') {
				items = [msg.notification, ...items].slice(0, 50);
				unread++;
			} else if (msg.type === 'read') {
				// Another tab (or the drawer answering a question) dealt with it.
				const ids = new Set<string>(msg.ids);
				items = items.map((n) => (ids.has(n.id) ? { ...n, readAt: Date.now() } : n));
				unread = Math.max(0, unread - msg.ids.length);
			}
		};
		return () => source.close();
	});

	async function load() {
		const res = await fetch('/api/notifications');
		if (!res.ok) return;
		const data = await res.json();
		items = data.notifications;
		unread = data.unread;
	}

	async function openItem(n: Notification) {
		open = false;
		if (!n.readAt) {
			// Optimistic: the row is going away from the badge either way, and the
			// stream will confirm.
			unread = Math.max(0, unread - 1);
			items = items.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x));
			void fetch(`/api/notifications/${n.id}`, { method: 'POST' });
		}
		if (n.link) await goto(n.link);
	}

	async function clearAll() {
		unread = 0;
		items = items.map((n) => ({ ...n, readAt: n.readAt ?? Date.now() }));
		await fetch('/api/notifications', { method: 'POST' });
	}

	// The tab title is the only signal that reaches a window in the background.
	$effect(() => {
		if (typeof document === 'undefined') return;
		const base = document.title.replace(/^\(\d+\)\s*/, '');
		document.title = unread > 0 ? `(${unread}) ${base}` : base;
	});

	const ago = (ts: number) => {
		// Coerced rather than trusted: the API sends epoch ms, but a stale tab
		// mid-deploy can still be holding the ISO strings that produced "NaNd".
		const at = typeof ts === 'number' ? ts : Date.parse(String(ts));
		if (!Number.isFinite(at)) return '';
		const mins = Math.round((Date.now() - at) / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.round(mins / 60);
		return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
	};
</script>

<svelte:window onresize={() => open && place()} />

<div class="bell-wrap" bind:this={bellEl}>
	<button
		class="bell"
		class:has-unread={unread > 0}
		aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
		onclick={toggle}
	>
		<span class="glyph">◔</span>
		<span class="label">Alerts</span>
		{#if unread > 0}<span class="count">{unread > 99 ? '99+' : unread}</span>{/if}
	</button>

	{#if open}
		<!-- Click-away and reposition-on-resize, so a fixed panel cannot be left
		     stranded away from the button it belongs to. -->
		<div
			class="scrim"
			role="presentation"
			onclick={() => (open = false)}
			onkeydown={(e) => e.key === 'Escape' && (open = false)}
		></div>
		<div class="panel" style={`left:${at.left}px; bottom:${at.bottom}px; width:${at.width}px`}>
			<header>
				<span>Notifications</span>
				<button class="clear" disabled={unread === 0} onclick={clearAll}>
					{unread === 0 ? 'All read' : 'Mark all as read'}
				</button>
			</header>
			<ul>
				{#each items as n (n.id)}
					<li class:unread={!n.readAt} class:urgent={n.urgent && !n.readAt}>
						<button onclick={() => openItem(n)}>
							<span class="icon">{ICON[n.kind] ?? '•'}</span>
							<span class="text">
								<span class="title">{n.title}</span>
								{#if n.body}<span class="body">{n.body}</span>{/if}
								<span class="when">{ago(n.createdAt)}</span>
							</span>
						</button>
					</li>
				{:else}
					<li class="empty">Nothing needs you.</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.bell-wrap {
		position: relative;
	}
	.bell {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.35rem 0.4rem;
		cursor: pointer;
		text-align: left;
	}
	.bell:hover {
		color: var(--fg);
	}
	.bell.has-unread {
		color: var(--accent);
	}
	.glyph {
		font-size: var(--text-lg);
	}
	.label {
		flex: 1;
	}
	.count {
		background: var(--accent);
		color: var(--bg);
		border-radius: 999px;
		font-size: var(--text-xs);
		padding: 0.05rem 0.35rem;
		min-width: 1rem;
		text-align: center;
	}
	/* Catches the click that dismisses the panel. Transparent, but it has to be
	   under the panel and over everything else. */
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
	}
	/* Fixed, not absolute: the nav pane scrolls, and a scroll container clips
	   any child that overflows it sideways. Coordinates come from the button's
	   own rect (see place()), so it stays anchored without being contained. */
	.panel {
		position: fixed;
		max-height: min(28rem, 70vh);
		overflow-y: auto;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.4);
		z-index: 61;
	}
	/* The list scrolls under it, so the action stays reachable at fifty alerts. */
	header {
		position: sticky;
		top: 0;
		background: var(--bg-pane);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
		font-size: var(--text-xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.clear {
		flex-shrink: 0;
		background: none;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-xs);
		padding: 0.2rem 0.45rem;
		cursor: pointer;
		text-transform: none;
		letter-spacing: normal;
	}
	.clear:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
	}
	.clear:disabled {
		opacity: 0.45;
		cursor: default;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		border-bottom: 1px solid var(--border);
	}
	li button {
		display: flex;
		gap: 0.45rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		text-align: left;
		padding: 0.5rem 0.6rem;
		cursor: pointer;
	}
	li.unread button {
		color: var(--fg);
	}
	li.unread {
		border-left: 2px solid var(--border);
	}
	li.urgent {
		border-left-color: var(--accent);
	}
	.icon {
		flex-shrink: 0;
		font-size: var(--text-md);
	}
	.text {
		min-width: 0;
		flex: 1;
	}
	.title {
		display: block;
		font-size: var(--text-base);
		line-height: 1.35;
	}
	.body {
		display: block;
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin-top: 0.15rem;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.when {
		display: block;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-top: 0.2rem;
	}
	.empty {
		padding: 0.7rem 0.6rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}

	@media (max-width: 720px) {
		.panel {
			position: fixed;
			left: 0.5rem;
			right: 0.5rem;
			width: auto;
			bottom: 4rem;
		}
	}
</style>
