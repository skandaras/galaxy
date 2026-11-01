<script lang="ts">
	let { src, alt = '' }: { src: string; alt?: string } = $props();
	let dialog = $state<HTMLDialogElement>();
	let status = $state('');

	async function imageBlob(): Promise<Blob> {
		const response = await fetch(src);
		if (!response.ok) throw new Error('Image could not be loaded');
		return response.blob();
	}
	async function save() {
		try {
			const blob = await imageBlob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png';
			link.download = /\.(png|jpe?g|webp|gif|svg)$/i.test(alt) ? alt : `image.${ext}`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			status = 'Saved';
		} catch {
			status = 'Could not save image';
		}
	}
	async function pngBlob() {
		const blob = await imageBlob();
		const url = URL.createObjectURL(blob);
		try {
			const image = new Image();
			image.src = url;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Canvas unavailable');
			context.drawImage(image, 0, 0);
			return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
				(value) => value ? resolve(value) : reject(new Error('Image conversion failed')), 'image/png'
			));
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	async function copy() {
		try {
			if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
				status = 'Image copying needs HTTPS and a supported browser';
				return;
			}
			// Start the clipboard write in the click handler; WebKit expires the
			// user gesture if fetching and decoding happen before this call.
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
			status = 'Copied';
		} catch {
			status = 'Could not copy image';
		}
	}
</script>

<span class="image-preview">
	<button class="image-open" aria-label={`Expand image${alt ? `: ${alt}` : ''}`} onclick={() => dialog?.showModal()}>
		<img {src} {alt} loading="lazy" />
	</button>
	<span class="image-actions">
		<button class="chip" onclick={save} aria-label="Save image" title="Save image">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 3h12l4 4v14H3V3h2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></svg>
			Save
		</button>
		<button class="chip" onclick={copy} aria-label="Copy image" title="Copy image">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg>
			Copy
		</button>
		<span role="status">{status}</span>
	</span>
	<dialog bind:this={dialog} aria-label={alt || 'Expanded image'} onclick={(event) => {
		if (event.target === dialog) dialog.close();
	}}>
		<span class="image-frame">
			<button class="chip close" aria-label="Close image" onclick={() => dialog?.close()}>✕</button>
			<img {src} {alt} />
		</span>
	</dialog>
</span>

<style>
	.image-preview { display: inline-flex; flex-direction: column; max-width: 100%; margin: 0.4rem 0; vertical-align: top; }
	.image-open { display: block; padding: 0; border: 0; background: transparent; cursor: zoom-in; max-width: 100%; }
	.image-open img { display: block; max-width: 100%; max-height: 600px; width: auto; height: auto; object-fit: contain; }
	.image-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.4rem; }
	.image-actions button { display: inline-flex; align-items: center; gap: 0.35rem; }
	dialog { padding: 2.5rem 1rem 1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-pane); color: var(--fg); max-width: 96vw; max-height: 96dvh; }
	dialog::backdrop { background: rgb(0 0 0 / 75%); }
	.image-frame { display: block; }
	.image-frame img { display: block; max-width: 90vw; max-height: 85dvh; width: auto; height: auto; object-fit: contain; }
	.close { position: absolute; top: 0.35rem; right: 0.35rem; }
</style>
