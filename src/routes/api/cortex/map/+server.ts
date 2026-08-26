import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { mapProjection, refreshLayout } from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);

	// Make sure there *are* coordinates before drawing any. The background sweep
	// has almost always done this already, but its first tick is five minutes
	// out, so without this a brand-new lattice — which is every lattice, once —
	// has no positions at all for the first five minutes of its life and the map
	// falls back to a meaningless ring.
	//
	// This is not the per-request layout the design warns about: the signature
	// check answers "has the graph changed" without laying anything out, so the
	// usual cost here is one comparison. Only the person whose write changed the
	// graph pays for the recompute, and only once.
	refreshLayout();

	// A visualisation is the easiest place in the world to render the whole
	// table by accident, so this goes through the same scoped projection the
	// privacy tests cover rather than reading the tables directly.
	return json(mapProjection(user.id));
};
