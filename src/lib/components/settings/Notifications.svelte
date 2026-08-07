<script lang="ts">
	interface Device {
		id: string;
		userAgent: string;
		createdAt: number;
		lastUsedAt: number | null;
	}

	let publicKey = $state<string | null>(null);
	let devices = $state<Device[]>([]);
	let permission = $state<NotificationPermission | 'unsupported'>('default');
	let busy = $state(false);
	let notice = $state<string | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		void load();
	});

	async function load() {
		permission = supported() ? Notification.permission : 'unsupported';
		const res = await fetch('/api/push/subscriptions');
		if (!res.ok) return;
		const data = await res.json();
		publicKey = data.publicKey;
		devices = data.devices;
	}

	const supported = () =>
		typeof window !== 'undefined' &&
		'Notification' in window &&
		'serviceWorker' in navigator &&
		'PushManager' in window;

	/**
	 * The browser hands back the VAPID public key as base64url; PushManager wants
	 * raw bytes.
	 */
	function toBytes(base64url: string): ArrayBuffer {
		const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
			.replace(/-/g, '+')
			.replace(/_/g, '/');
		const raw = atob(padded);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		return bytes.buffer;
	}

	async function enable() {
		error = null;
		notice = null;
		if (!publicKey) {
			error = 'Push is not set up on this instance yet — an admin generates the keys first.';
			return;
		}
		busy = true;
		try {
			// Must be inside a user gesture, which is why this is a button and not
			// something that happens on load.
			permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				error =
					permission === 'denied'
						? 'Notifications are blocked for this site — you will have to allow them in browser settings.'
						: 'Permission was dismissed.';
				return;
			}
			const reg = await navigator.serviceWorker.ready;
			const sub =
				(await reg.pushManager.getSubscription()) ??
				(await reg.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: toBytes(publicKey)
				}));
			const res = await fetch('/api/push/subscriptions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(sub.toJSON())
			});
			if (!res.ok) {
				error = (await res.json().catch(() => ({}))).message ?? 'Could not register this device';
				return;
			}
			notice = 'This device will now be notified.';
			await load();
		} catch (err) {
			error = `Could not enable notifications: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			busy = false;
		}
	}

	async function remove(device: Device) {
		await fetch(`/api/push/subscriptions/${device.id}`, { method: 'DELETE' });
		// If it was this browser, drop the local registration too, otherwise the
		// button would say "enabled" with nothing on the server.
		if (supported()) {
			const reg = await navigator.serviceWorker.ready;
			const sub = await reg.pushManager.getSubscription();
			await sub?.unsubscribe().catch(() => {});
		}
		notice = 'Device removed.';
		await load();
	}

	const describe = (ua: string) => {
		if (!ua) return 'Unknown device';
		if (/iPhone|iPad/i.test(ua)) return 'iPhone or iPad';
		if (/Android/i.test(ua)) return 'Android';
		if (/Macintosh/i.test(ua)) return 'Mac';
		if (/Windows/i.test(ua)) return 'Windows';
		if (/Linux/i.test(ua)) return 'Linux';
		return ua.slice(0, 40);
	};
	const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : 'never');
</script>

<section>
	{#if notice}<p class="notice">{notice}</p>{/if}
	{#if error}<p class="error">{error}</p>{/if}

	<article class="card">
		<h3>Push notifications</h3>
		<p class="hint">
			Galaxy only pushes things that hold work up — today that means an agent stopping to ask you a
			question, which gives up after ten minutes if nobody answers. Cards, boards and failed runs
			show in the bell but will not buzz your phone.
		</p>

		{#if permission === 'unsupported'}
			<p class="hint">
				This browser cannot do push notifications. On iPhone you need to add Galaxy to your home
				screen first (Share → Add to Home Screen) and open it from there.
			</p>
		{:else if !publicKey}
			<p class="hint">
				Not set up on this instance yet. An admin needs to generate the keys in
				<strong>Admin → Settings → Push</strong>.
			</p>
		{:else}
			<button class="btn primary" disabled={busy} onclick={enable}>
				{busy ? 'Asking…' : 'Enable on this device'}
			</button>
			{#if permission === 'denied'}
				<p class="hint">
					This site is currently blocked from sending notifications. Allow them in your browser's
					site settings, then try again.
				</p>
			{/if}
		{/if}
	</article>

	<article class="card">
		<h3>Devices</h3>
		<p class="hint">
			Each browser you enable is registered separately — your phone and your laptop are two entries.
		</p>
		{#each devices as d (d.id)}
			<div class="row">
				<span class="device">
					{describe(d.userAgent)}
					<span class="meta">added {when(d.createdAt)} · last used {when(d.lastUsedAt)}</span>
				</span>
				<button class="btn danger" onclick={() => remove(d)}>Remove</button>
			</div>
		{:else}
			<p class="hint">No devices registered.</p>
		{/each}
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
		color: var(--accent);
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.4rem 0 0.6rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.device {
		flex: 1;
		font-size: 0.78rem;
	}
	.meta {
		display: block;
		color: var(--fg-dim);
		font-size: 0.64rem;
		margin-top: 0.1rem;
	}
	.notice {
		color: var(--accent);
		font-size: 0.75rem;
	}
	.error {
		color: var(--danger);
		font-size: 0.75rem;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
</style>
