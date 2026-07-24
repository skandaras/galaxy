/**
 * Procedural ASCII galaxy: a two-armed logarithmic spiral with a bright
 * elliptical core, dithered edges and a sprinkling of field stars. The PRNG
 * is seeded so the same galaxy renders on every load.
 */
export function generateGalaxy(cols: number, rows: number, seed = 21): string {
	let s = seed;
	const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const chars = [' ', '·', '·', '∙', '*', '°', 'o', '✦', '@'];
	const cx = cols / 2;
	const cy = rows / 2;
	const lines: string[] = [];
	for (let y = 0; y < rows; y++) {
		let line = '';
		for (let x = 0; x < cols; x++) {
			const dx = (x - cx) / (cols / 2);
			const dy = ((y - cy) / (rows / 2)) * 1.8; // monospace cells are ~2x taller
			const r = Math.sqrt(dx * dx + dy * dy);
			const theta = Math.atan2(dy, dx);
			const spiral = Math.cos(2 * theta - 5.4 * Math.log(r + 0.03));
			const core = Math.exp(-r * r * 26);
			const disc = Math.exp(-r * r * 7) * 0.1;
			const arms = Math.exp(-r * 1.9) * Math.pow(Math.max(0, spiral), 4) * 1.0;
			let v = core + disc + arms;
			v *= 0.8 + rand() * 0.4;
			if (r > 0.88) v *= Math.exp(-(r - 0.88) * 9);
			if (v < 0.03 && rand() > 0.993) v = 0.08 + rand() * 0.12;
			let idx: number;
			if (v < 0.05) idx = v > 0.018 && rand() < v * 11 ? 1 : 0;
			else idx = Math.min(chars.length - 1, 1 + Math.floor(v * (chars.length - 1)));
			line += chars[idx];
		}
		lines.push(line.trimEnd());
	}
	return lines.join('\n');
}

export const GALAXY_BACKDROP = generateGalaxy(110, 34);
export const GALAXY_SMALL = generateGalaxy(72, 20);
