<script lang="ts">
	/**
	 * The lattice as a star chart.
	 *
	 * One canvas, no dependency. A 3D library would be by far the heaviest thing
	 * in this project and Galaxy is a progressive web app people install on
	 * phones, so the flat chart comes first and earns the weight of the other one
	 * before anything gets loaded for it.
	 *
	 * Nothing animates. Positions are computed by the background sweep, so there
	 * is no simulation to run here and no idle loop to burn a battery on — the
	 * canvas redraws when someone pans, zooms, selects or resizes, and otherwise
	 * sits still. That also makes `prefers-reduced-motion` a non-question rather
	 * than a special case.
	 *
	 * This canvas is aria-hidden. The list beside it on the page is the real
	 * interface for anyone not looking at pixels, and it is the same list a
	 * sighted person clicks — not a hidden parallel that quietly rots.
	 */
	interface MapNode {
		id: string;
		name: string;
		x: number | null;
		y: number | null;
		z: number | null;
		isConvergence: boolean;
		degree: number;
		circuits?: string[] | null;
	}
	interface MapEdge {
		source: string;
		target: string;
		weight: number;
	}

	let {
		nodes = [],
		edges = [],
		selectedId = null,
		onselect,
		areaNames
	}: {
		nodes?: MapNode[];
		edges?: MapEdge[];
		selectedId?: string | null;
		onselect?: (id: string | null) => void;
		/** Area id → display name, so the chart can label a cluster. */
		areaNames?: Map<string, string>;
	} = $props();

	let canvas = $state<HTMLCanvasElement>();
	let wrap = $state<HTMLDivElement>();
	let scale = $state(1);
	let originX = $state(0);
	let originY = $state(0);
	let ready = $state(false);
	let dragging = false;
	let moved = false;
	let lastX = 0;
	let lastY = 0;

	/**
	 * A node the sweep has not placed yet — created in the last few minutes —
	 * still has to be somewhere, or it is invisible until the next tick and looks
	 * like a write that failed. A deterministic ring keeps it stable between
	 * redraws until it gets a real position.
	 */
	function placed(node: MapNode, i: number, total: number) {
		if (node.x !== null && node.y !== null) return { x: node.x, y: node.y, z: node.z ?? 0 };
		const angle = (i / Math.max(total, 1)) * Math.PI * 2;
		return { x: Math.cos(angle) * 200, y: Math.sin(angle) * 200, z: 0 };
	}

	const points = $derived(
		new Map(nodes.map((n, i) => [n.id, placed(n, i, nodes.length)]))
	);

	/** Fit everything into view, once there is something to fit. */
	function fit() {
		if (!wrap || !nodes.length) return;
		const pts = [...points.values()];
		const minX = Math.min(...pts.map((p) => p.x));
		const maxX = Math.max(...pts.map((p) => p.x));
		const minY = Math.min(...pts.map((p) => p.y));
		const maxY = Math.max(...pts.map((p) => p.y));
		const w = wrap.clientWidth || 600;
		const h = wrap.clientHeight || 400;
		const pad = 60;
		// Bounds of what *this* viewer can see. The layout is computed over the
		// whole graph, so someone seeing part of it would otherwise be looking at
		// a corner of a chart mostly made of nodes they have no access to.
		const spanX = Math.max(maxX - minX, 1);
		const spanY = Math.max(maxY - minY, 1);
		scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY, 2);
		originX = w / 2 - ((minX + maxX) / 2) * scale;
		originY = h / 2 - ((minY + maxY) / 2) * scale;
		ready = true;
		draw();
	}

	function css(name: string, fallback: string): string {
		if (!wrap) return fallback;
		return getComputedStyle(wrap).getPropertyValue(name).trim() || fallback;
	}

	/**
	 * A hue per area, spread evenly around the wheel and keyed by the area's
	 * position in the sorted set so a colour does not change when an unrelated
	 * one is added. Areas are what the agents' context index is grouped by, so
	 * seeing them here is seeing what the agent sees.
	 *
	 * Deliberately not the theme accent: this is categorical data and one accent
	 * cannot carry it. Lightness and saturation are fixed to stay legible on both
	 * a near-black and a cream page.
	 */
	const areaHues = $derived.by(() => {
		const seen = [...new Set(nodes.flatMap((n) => n.circuits ?? []))].sort();
		return new Map(seen.map((id, i) => [id, Math.round((i * 360) / Math.max(seen.length, 1))]));
	});

	function areaColour(node: MapNode): string | null {
		const first = node.circuits?.[0];
		if (!first) return null;
		const hue = areaHues.get(first);
		return hue === undefined ? null : `hsl(${hue} 52% 62%)`;
	}

	function radius(node: MapNode): number {
		// Degree, not activation: the map's job is to show the shape of the mesh,
		// and how connected a concept is *is* that shape.
		return 3 + Math.min(Math.sqrt(node.degree) * 2.2, 9);
	}

	function draw() {
		if (!canvas || !wrap) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const w = wrap.clientWidth;
		const h = wrap.clientHeight;
		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr;
			canvas.height = h * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		// Not --border. That colour is a deliberate whisper — docs/ACCESSIBILITY.md
		// puts it near 1.2:1 against the page, which is right for separating cards
		// and wrong for a line that carries meaning. An edge *is* the information
		// here, so it gets a colour the themes are actually held to.
		const dim = css('--fg-dim', '#888');
		const accent = css('--accent', '#7aa2f7');
		const fg = css('--fg', '#ddd');

		const at = (id: string) => {
			const p = points.get(id);
			return p ? { x: p.x * scale + originX, y: p.y * scale + originY } : null;
		};

		ctx.lineCap = 'round';
		for (const e of edges) {
			const a = at(e.source);
			const b = at(e.target);
			if (!a || !b) continue;
			const touches = selectedId === e.source || selectedId === e.target;
			ctx.strokeStyle = touches ? accent : dim;
			// Weight is visible as opacity as well as width, so a strong
			// association reads as strong at a glance rather than on inspection.
			ctx.globalAlpha = touches ? 0.95 : 0.3 + e.weight * 0.45;
			ctx.lineWidth = Math.max(0.5, e.weight * 2 * Math.min(scale, 1.5));
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;

		for (const node of nodes) {
			const p = at(node.id);
			if (!p) continue;
			const r = radius(node) * Math.min(Math.max(scale, 0.6), 1.6);
			const selected = node.id === selectedId;

			// Depth, hinted rather than drawn. z records how much this node's
			// placement was compromised by flattening, so a node the flat map had
			// to squeeze sits slightly back — the same information the 3D view will
			// show properly, without pretending this one is 3D.
			const depth = points.get(node.id)?.z ?? 0;
			ctx.globalAlpha = selected ? 1 : Math.max(0.45, 1 - Math.abs(depth) / 400);

			ctx.fillStyle = selected ? accent : node.isConvergence ? accent : (areaColour(node) ?? dim);
			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
			ctx.fill();

			if (node.isConvergence) {
				// A bridge gets a ring rather than a different colour, so it still
				// reads as one in a theme where the accent is the only strong hue.
				ctx.strokeStyle = accent;
				ctx.lineWidth = 1.2;
				ctx.beginPath();
				ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
				ctx.stroke();
			}
			if (selected) {
				ctx.strokeStyle = accent;
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
				ctx.stroke();
			}

			// Labels only once there is room for them, and always for the selection.
			if (scale > 0.55 || selected) {
				ctx.globalAlpha = selected ? 1 : 0.8;
				ctx.fillStyle = selected ? fg : dim;
				ctx.font = `${selected ? 600 : 400} 11px var(--font-ui, system-ui)`;
				ctx.textAlign = 'center';
				ctx.fillText(node.name, p.x, p.y - r - 6);
			}
			ctx.globalAlpha = 1;
		}

		// Zoomed far enough out that node labels are gone, the areas are what is
		// left to navigate by — drawn at the centre of mass of each one's nodes.
		if (scale <= 0.55 && areaHues.size) {
			const centres = new Map<string, { x: number; y: number; n: number }>();
			for (const node of nodes) {
				const id = node.circuits?.[0];
				const p = at(node.id);
				if (!id || !p) continue;
				const acc = centres.get(id) ?? { x: 0, y: 0, n: 0 };
				centres.set(id, { x: acc.x + p.x, y: acc.y + p.y, n: acc.n + 1 });
			}
			ctx.textAlign = 'center';
			ctx.font = '600 13px var(--font-ui, system-ui)';
			for (const [id, c] of centres) {
				if (c.n < 2) continue;
				ctx.fillStyle = `hsl(${areaHues.get(id)} 52% 62%)`;
				ctx.globalAlpha = 0.85;
				ctx.fillText(areaNames?.get(id) ?? id, c.x / c.n, c.y / c.n);
			}
			ctx.globalAlpha = 1;
		}
	}

	function nodeAt(clientX: number, clientY: number): string | null {
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const sx = clientX - rect.left;
		const sy = clientY - rect.top;
		let best: { id: string; d: number } | null = null;
		for (const node of nodes) {
			const p = points.get(node.id);
			if (!p) continue;
			const d = Math.hypot(p.x * scale + originX - sx, p.y * scale + originY - sy);
			const hit = radius(node) * Math.min(Math.max(scale, 0.6), 1.6) + 8;
			if (d <= hit && (!best || d < best.d)) best = { id: node.id, d };
		}
		return best?.id ?? null;
	}

	function onpointerdown(e: PointerEvent) {
		dragging = true;
		moved = false;
		lastX = e.clientX;
		lastY = e.clientY;
		canvas?.setPointerCapture(e.pointerId);
	}

	function onpointermove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
		originX += dx;
		originY += dy;
		lastX = e.clientX;
		lastY = e.clientY;
		draw();
	}

	function onpointerup(e: PointerEvent) {
		dragging = false;
		canvas?.releasePointerCapture(e.pointerId);
		// A drag that ends on a node is a pan, not a click on it.
		if (!moved) onselect?.(nodeAt(e.clientX, e.clientY));
	}

	function onwheel(e: WheelEvent) {
		e.preventDefault();
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const factor = Math.exp(-e.deltaY * 0.0015);
		const next = Math.min(Math.max(scale * factor, 0.1), 6);
		// Zoom toward the pointer rather than the centre, so the thing being
		// looked at is the thing that stays put.
		originX = sx - ((sx - originX) / scale) * next;
		originY = sy - ((sy - originY) / scale) * next;
		scale = next;
		draw();
	}

	$effect(() => {
		// Re-fit whenever the lattice itself changes, and redraw on selection.
		void nodes.length;
		void edges.length;
		if (!ready) fit();
		else draw();
	});

	$effect(() => {
		void selectedId;
		void scale;
		draw();
	});

	$effect(() => {
		if (!wrap) return;
		const observer = new ResizeObserver(() => (ready ? draw() : fit()));
		observer.observe(wrap);
		return () => observer.disconnect();
	});
</script>

<div class="map" bind:this={wrap}>
	<canvas
		bind:this={canvas}
		aria-hidden="true"
		{onpointerdown}
		{onpointermove}
		{onpointerup}
		{onwheel}
	></canvas>
	{#if nodes.length}
		<div class="hint">drag to pan · scroll to zoom · click a node</div>
		<button class="fit" onclick={fit}>Fit</button>
	{/if}
</div>

<style>
	.map {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 240px;
		overflow: hidden;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
	.hint {
		position: absolute;
		left: 0.75rem;
		bottom: 0.6rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
		pointer-events: none;
	}
	.fit {
		position: absolute;
		right: 0.75rem;
		top: 0.6rem;
		font-size: var(--text-sm);
		padding: 0.25rem 0.6rem;
		color: var(--fg);
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
	}
</style>
