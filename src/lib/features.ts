/**
 * Cortex, the knowledge lattice, is switched off.
 *
 * It was an experiment: concepts as nodes, weighted associations, retrieval by
 * spreading activation, Hebbian learning from replies (docs/CORTEX.md). On
 * balance a conventional knowledge graph or taxonomy would be as useful and
 * much easier to curate, and that is planned as separate work. Until then the
 * lattice was paying for a digest in every chat and coding prompt, and for two
 * tools every agent was offered, to give answers its own guidance said most
 * turns did not need.
 *
 * Kept rather than removed, on purpose: the module, its tables, its data and
 * its tests all stay, so this switch is the whole difference. Off means no
 * digest, no tools, no learning from replies, no research hints, no scheduled
 * sweeps, no page, no API and no place for it in Admin or Settings.
 *
 * Here rather than in `$lib/server/cortex` because the rail, Admin and
 * Settings read it in the browser.
 */
export function cortexEnabled(): boolean {
	return false;
}
