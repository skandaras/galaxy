<script lang="ts">
	import { BACKDROP_COLS, BACKDROP_ROWS, generateGalaxy } from '$lib/galaxy-art';

	let { animate = true }: { animate?: boolean } = $props();

	/** One full revolution. Deliberately slow — this is ambient, not a feature. */
	const REVOLUTION_MS = 240_000;
	/** Redraw cadence. The art is character-quantised, so ~5fps is plenty. */
	const FRAME_MS = 200;

	let art = $state(generateGalaxy(BACKDROP_COLS, BACKDROP_ROWS));

	$effect(() => {
		if (!animate) return;
		if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

		// A phone renders the same 110x34 grid as a desktop, at a size where most
		// of it is off the side of the screen anyway, and pays for it out of a
		// battery. Half the cadence is still ambient; nobody watches the backdrop
		// closely enough to count frames.
		const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
		const frameMs = coarse ? FRAME_MS * 2 : FRAME_MS;

		let raf = 0;
		let last = -Infinity;
		// rAF (not setInterval) so the browser suspends this on a hidden tab.
		const tick = (t: number) => {
			raf = requestAnimationFrame(tick);
			if (t - last < frameMs) return;
			last = t;
			const rotation = ((t % REVOLUTION_MS) / REVOLUTION_MS) * Math.PI * 2;
			art = generateGalaxy(BACKDROP_COLS, BACKDROP_ROWS, { rotation });
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="backdrop" aria-hidden="true">
	<pre>{art}</pre>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-backdrop);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		pointer-events: none;
		user-select: none;
	}
	pre {
		margin: 0;
		/* Deliberately not --font-mono. The art is made of characters and needs
		   every glyph the same width; --font-galaxy is fixed in themeCss and no
		   setting writes to it, so no font choice can distort the spiral. */
		font-family: var(--font-galaxy);
		/* Falls back to the accent, which is what this was pinned to before the
		   backdrop had a colour of its own — so a theme saved without one is
		   unchanged. */
		color: var(--galaxy, var(--accent));
		opacity: 0.16;
		font-size: clamp(8px, 1.1vw, 14px);
		line-height: 1.25;
		white-space: pre;
	}
</style>
