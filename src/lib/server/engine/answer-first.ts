import type { LoopTool } from './loop';

/**
 * The gate that makes a chat turn answer before it goes looking.
 *
 * The complaint this exists for: a plain question — "my CPU keeps spiking, can
 * you help" — spent its whole first leg planning lookups, and five seconds of
 * Googling beat it. Nothing was looping; the turn simply had no cheap path
 * through it. Every tool was on the table from the first token, the prompt
 * announced a twelve-turn budget before the model had read the question, and
 * the chat prompt prescribes a search method with no branch for a question that
 * needs no searching.
 *
 * **Why a tool rather than an instruction.** `turnBudgetNote` in loop.ts carries
 * the lesson in its own comment: two instructions that disagree are decided by
 * the loudest, not the most correct. "Answer first" written into a prompt sits
 * beside a note offering twelve turns and a method paragraph describing how to
 * research, and loses. A toolset with nothing else in it does not lose, because
 * there is no other move to make.
 *
 * So the opening leg is offered everything that does *not* go and look something
 * up, plus this. Answering or acting are available; going wide has to be asked
 * for. Calling it opens the rest from the next leg on and the run carries on
 * exactly as it always has — the loop needs no new exit condition, because a leg
 * that called a tool already continues, and `replyParts` already joins legs with
 * a blank line.
 *
 * The first cut of this offered the gate *alone*, and `scripts/smoke-e2e.sh`
 * rejected it: "draw me a spiral galaxy" could no longer reach `generate_image`
 * on the leg that wanted to. Rightly — the complaint was the agent researching
 * before answering, not the agent doing what it was asked, and making an image,
 * a PDF or a card write pay a full round-trip to announce an intention was a
 * worse turn than the one being fixed. Which tools count is declared per tool
 * (`LoopTool.lookup`), so the next one added is classified where it is written.
 *
 * That was not enough on its own. Removing the looking-up tools was meant to
 * leave answering as the only other move, and on a reasoning model it does not:
 * it thinks, calls this, and emits no `content` at all. Reasoning is routed to
 * the thinking note and must never become the saved reply, so `iterationText` is
 * empty, nothing is kept, and the first thing the person sees is still a search.
 * Confirmed from a live Observatory trace: the first model call was this tool,
 * with no prose before it.
 *
 * Hence the description below opening with the instruction rather than assuming
 * it, and the matching line in `turnBudgetNote` — which is the loudest place in
 * the prompt by this codebase's own measurement. Asking rather than enforcing is
 * deliberate: the enforcing versions (make the answer a required argument and
 * promote it into the reply, or refuse this call until prose exists) are both
 * still available if asking turns out not to win.
 */
export function goDeeperTool(): LoopTool {
	return {
		// Calling this does no work — it only hands back the rest of the toolset —
		// so the loop treats prose on that leg as the answer rather than a lead-in.
		opensToolset: true,
		def: {
			name: 'look_into_it',
			description:
				'Write your answer first, then call this. In the same turn, before this call, say ' +
				'what you already know.\n\n' +
				'Ask to go and look something up. Web search, reading a page, this person’s ' +
				'lattice, their Library and their boards, and what earlier runs on this ' +
				'conversation did are all behind this — say what you need and they become ' +
				'available.\n\n' +
				'Everything else you can do is already available: answering, drawing, writing a ' +
				'document, filing a card, asking them a question. This is only for going and ' +
				'finding out.\n\n' +
				'Call this when what you know was not enough, not to double-check something you are ' +
				'confident about. Most questions end without it, which is the normal outcome ' +
				'rather than a failure.',
			parameters: {
				type: 'object',
				properties: {
					reason: {
						type: 'string',
						description: 'What you need to find out, in a few words'
					}
				},
				required: ['reason']
			}
		},
		// Read back as the label for this step in the run timeline, so the trace
		// says what the turn went looking for rather than just that it did.
		describe: (a) => String(a.reason ?? 'going further'),
		execute: async () =>
			'Your full toolset is available from here. Carry on from what you have already ' +
			'said rather than repeating it — the person has read it.'
	};
}
