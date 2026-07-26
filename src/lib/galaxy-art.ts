/**
 * Procedural ASCII galaxy: a two-armed logarithmic spiral with a bright
 * elliptical core, dithered edges and a sprinkling of field stars.
 *
 * Noise is a deterministic per-cell hash rather than a sequential PRNG, so a
 * given cell always dithers the same way. That keeps successive frames stable
 * when `rotation` changes — only the spiral pattern moves, instead of the
 * whole field boiling like static.
 */

const CHARS = [' ', '·', '·', '∙', '*', '°', 'o', '✦', '@'];

/** Stable hash → [0,1) for a cell, independent of iteration order. */
function noise(x: number, y: number, salt: number): number {
	let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h = h ^ (h >>> 16);
	return (h >>> 0) / 4294967296;
}

export interface GalaxyOptions {
	seed?: number;
	/** Radians to rotate the spiral about its core. Field stars stay fixed. */
	rotation?: number;
}

export function generateGalaxy(cols: number, rows: number, opts: GalaxyOptions = {}): string {
	const { seed = 21, rotation = 0 } = opts;
	const cx = cols / 2;
	const cy = rows / 2;
	const lines: string[] = [];

	for (let y = 0; y < rows; y++) {
		let line = '';
		for (let x = 0; x < cols; x++) {
			const dx = (x - cx) / (cols / 2);
			const dy = ((y - cy) / (rows / 2)) * 1.8; // monospace cells are ~2x taller
			const r = Math.sqrt(dx * dx + dy * dy);
			const theta = Math.atan2(dy, dx) + rotation;

			const spiral = Math.cos(2 * theta - 5.4 * Math.log(r + 0.03));
			const core = Math.exp(-r * r * 26);
			const disc = Math.exp(-r * r * 7) * 0.1;
			const arms = Math.exp(-r * 1.9) * Math.pow(Math.max(0, spiral), 4);

			let v = core + disc + arms;
			v *= 0.8 + noise(x, y, seed) * 0.4;
			if (r > 0.88) v *= Math.exp(-(r - 0.88) * 9);

			// Field stars sit outside the galaxy and do not rotate with it.
			if (v < 0.03 && noise(x, y, seed + 7) > 0.993) {
				v = 0.08 + noise(x, y, seed + 13) * 0.12;
			}

			let idx: number;
			if (v < 0.05) idx = v > 0.018 && noise(x, y, seed + 29) < v * 11 ? 1 : 0;
			else idx = Math.min(CHARS.length - 1, 1 + Math.floor(v * (CHARS.length - 1)));
			line += CHARS[idx];
		}
		// Lines are NOT trimmed: a constant width keeps the centred block from
		// jittering horizontally as the pattern rotates.
		lines.push(line);
	}
	return lines.join('\n');
}

export const BACKDROP_COLS = 110;
export const BACKDROP_ROWS = 34;
