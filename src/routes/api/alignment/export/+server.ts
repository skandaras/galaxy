import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import {
	deleteAllAlignmentData,
	listAssessments,
	listConstitutionVersions,
	listEntries,
	listPrinciples,
	listRevisions,
	listSyntheses,
	listTensions
} from '$lib/server/alignment';
import { RUBRIC_VERSION } from '$lib/server/alignment-rubric';

/**
 * Everything, in one file. A journal you cannot get out of the tool is a
 * journal held hostage by it, and the revision history is exported alongside
 * because how a belief changed is as much the record as the belief.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireAlignment(locals);
	const principles = listPrinciples(user.id);
	const entries = listEntries(user.id, 10_000);
	const assessments = listAssessments(user.id, 10_000);
	const data = {
		exportedAt: new Date().toISOString(),
		rubricVersion: RUBRIC_VERSION,
		principles: principles.map((p) => ({ ...p, revisions: listRevisions(p.id, user.id) })),
		tensions: listTensions(user.id),
		constitutionVersions: listConstitutionVersions(user.id),
		entries,
		assessments,
		syntheses: listSyntheses(user.id, 10_000)
	};

	if (url.searchParams.get('format') !== 'markdown') {
		return json(data, {
			headers: { 'content-disposition': 'attachment; filename="alignment.json"' }
		});
	}

	const byId = new Map(principles.map((p) => [p.id, p]));
	const name = (id: string) => byId.get(id)?.title ?? id;
	const out: string[] = ['# Alignment', '', '## Constitution', ''];

	for (const p of principles) {
		out.push(`### ${p.title}${p.status === 'retired' ? ' (retired)' : ''}`);
		out.push(`*${p.kind} · weight ${p.weight}/5 · conviction ${p.conviction}/5*`, '');
		if (p.statement) out.push(p.statement, '');
		if (p.body) out.push(p.body, '');
		if (p.exemplar) out.push(`**Keeping it:** ${p.exemplar}`, '');
		if (p.counterExemplar) out.push(`**Breaking it:** ${p.counterExemplar}`, '');
		if (p.origin) out.push(`**Origin:** ${p.origin}`, '');
		const revisions = listRevisions(p.id, user.id);
		if (revisions.length > 1) {
			out.push('**History**', '');
			for (const r of revisions) {
				const changed = (r.changedFields ?? []).join(', ');
				out.push(
					`- ${new Date(r.createdAt).toISOString().slice(0, 10)} — ${changed}${r.note ? `: ${r.note}` : ''}`
				);
			}
			out.push('');
		}
	}

	const tensions = listTensions(user.id);
	if (tensions.length) {
		out.push('## Declared tensions', '');
		for (const t of tensions) {
			out.push(`- ${name(t.aId)} vs ${name(t.bId)}${t.note ? ` — ${t.note}` : ''}`);
		}
		out.push('');
	}

	out.push('## Journal', '');
	const readings = new Map<string, typeof assessments>();
	for (const a of assessments) {
		readings.set(a.entryId, [...(readings.get(a.entryId) ?? []), a]);
	}
	for (const e of entries) {
		out.push(`### ${new Date(e.createdAt).toISOString().slice(0, 10)}${e.title ? ` — ${e.title}` : ''}`);
		if (e.tags) out.push(`*${e.tags}*`);
		out.push('', e.body, '');
		for (const a of readings.get(e.id) ?? []) {
			if (a.care) continue;
			out.push(`> **${a.band}** — ${a.standing}`, '>');
			if (a.summary) out.push(`> ${a.summary.replace(/\n/g, '\n> ')}`, '>');
			for (const s of a.scores ?? []) {
				out.push(`> - ${s.dimensionId}: ${s.score}/5 — "${s.evidence}"`);
			}
			if (a.nextStep) out.push(`>`, `> **Next:** ${a.nextStep}`);
			if (a.question) out.push(`>`, `> **Question:** ${a.question}`);
			out.push('');
		}
	}

	const syntheses = listSyntheses(user.id, 10_000);
	if (syntheses.length) {
		out.push('## Letters', '');
		for (const s of syntheses) {
			out.push(`### ${new Date(s.createdAt).toISOString().slice(0, 10)}`, '', s.body, '');
		}
	}

	return new Response(out.join('\n'), {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': 'attachment; filename="alignment.md"'
		}
	});
};

/** Erase everything. Irreversible, and the UI says so before it calls this. */
export const DELETE: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	return json({ deleted: deleteAllAlignmentData(user.id) });
};
