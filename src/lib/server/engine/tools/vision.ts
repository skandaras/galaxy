import type { LoopTool } from '../loop';
import type { ProviderMessage, ToolDef } from '$lib/server/providers/types';
import { attachmentDataUrl, listAttachments, type AttachmentSummary } from '$lib/server/chats';
import { getBudgetStatus } from '../budget';
import { getTaskConfig } from '../engine';
import { listEnabledModels, reasoningFor, resolveModel } from '$lib/server/providers/registry';
import { logUsage } from '../usage';

/** Long enough for a dense screenshot, short of a model that will not stop. */
const VISION_TIMEOUT_MS = 90_000;

/**
 * Paired with MAX_ANSWER_CHARS below — roughly four characters to the token, so
 * the model is not cut off mid-sentence by a budget the answer cap would have
 * trimmed anyway.
 */
const VISION_MAX_TOKENS = 2_048;

/** Longest answer handed back. Past this it is not answering the question. */
const MAX_ANSWER_CHARS = 8_000;

/**
 * Reading an image on behalf of an agent that cannot see one.
 *
 * The mirror of `generate_image` next door, and worth stating why it is a
 * separate tool rather than a capability: most good text models are not
 * vision models, and until this existed choosing one meant every screenshot
 * attached to the conversation was replaced by a note saying it had been
 * ignored. The picture was uploaded, stored and shown in the thread; only the
 * agent was blind to it.
 *
 * So the image goes to a model that can see it, with the question the agent
 * actually wants answered, and what comes back is text like any other tool
 * result. The cost of that call is the whole reason it is on demand: a caption
 * generated for every upload is spend on the majority of images nobody asks
 * about, and a caption written before the question is known answers the wrong
 * one anyway.
 */
export const viewImageToolDef: ToolDef = {
	name: 'view_image',
	description:
		'Ask a vision model what is in an image attached to this conversation, and get its answer ' +
		'back as text. You cannot see images yourself, so this is how you read a screenshot, a photo, ' +
		'a chart or a scanned page. Ask for what you actually need ("what does the error say?", ' +
		'"transcribe the table", "what is wrong with this layout?") rather than for a description: ' +
		'a specific question gets a specific answer, and you can call it again for more. One image ' +
		'per call; several calls in one turn run together.',
	parameters: {
		type: 'object',
		properties: {
			question: {
				type: 'string',
				description:
					'What you need to know about the image, in plain language. The model answering ' +
					'has no other context, so ask a question that stands on its own.'
			},
			id: {
				type: 'string',
				description:
					'Attachment id of the image, from list_attachments or from the note naming it. ' +
					'May be omitted when the conversation holds only one image.'
			}
		},
		required: ['question']
	}
};

export function visionTools(chatId: string, userId: string): LoopTool[] {
	return [
		{
			def: viewImageToolDef,
			// Owns no shared state and each call is a separate request, so several
			// images can be read in the time one used to take.
			parallelSafe: true,
			describe: (a) => String(a.question ?? '').slice(0, 80),
			execute: async (a, report) => {
				const question = String(a.question ?? '').trim();
				if (!question) throw new Error('question is required');
				if (getBudgetStatus().blocked) {
					throw new Error('The spend cap has been reached, so say so rather than guessing at the image.');
				}

				const image = pickImage(chatId, a.id);
				const url = attachmentDataUrl(chatId, image.id);
				if (!url) throw new Error(`Could not read ${image.name}.`);

				const choice = visionModel();
				const messages: ProviderMessage[] = [
					{ role: 'system', content: getTaskConfig('vision')?.systemPrompt ?? '' },
					{
						role: 'user',
						content: [
							{ type: 'text', text: `${question}\n\n(The image is attached as ${image.name}.)` },
							{ type: 'image_url', image_url: { url } }
						]
					}
				];

				let res;
				try {
					res = await choice.adapter.complete(
						{
							modelKey: choice.model.modelKey,
							messages,
							maxTokens: VISION_MAX_TOKENS,
							// Reads what it was given and answers one question about it —
							// the class of call where deliberation buys nothing and costs
							// the wall clock. Sent only where accepted; see reasoningFor.
							reasoning: reasoningFor(choice, 'low')
						},
						AbortSignal.timeout(VISION_TIMEOUT_MS)
					);
				} catch (err) {
					// Logged before rethrowing: a call that reached the provider and then
					// timed out has still been paid for, and spend the cap cannot see is
					// the one thing usage.ts exists to prevent.
					logUsage({ task: 'vision', choice, usage: null, status: 'error', userId });
					throw err;
				}
				logUsage({ task: 'vision', choice, usage: res.usage, status: 'ok', userId });
				report?.({ model: choice.model.modelKey, attachment: image.name });

				const answer = res.text.trim();
				if (!answer) {
					throw new Error(
						`${choice.model.displayName} returned nothing for ${image.name}. Try a narrower question, or point Admin → Tasks → vision at another model.`
					);
				}
				const body =
					answer.length > MAX_ANSWER_CHARS
						? `${answer.slice(0, MAX_ANSWER_CHARS)}\n…(cut off: ask about one part of the image at a time)`
						: answer;
				return `${choice.model.displayName} on ${image.name}:\n${body}`;
			}
		}
	];
}

/**
 * Which image the question is about.
 *
 * An id is optional because the overwhelmingly common case is one screenshot
 * in the message, and making the model call list_attachments first to learn a
 * uuid it was about to be handed anyway is a round trip for nothing. With
 * several images the ambiguity is real, so it says so and names them.
 */
function pickImage(chatId: string, rawId: unknown): AttachmentSummary {
	const images = listAttachments(chatId).filter((x) => x.kind === 'image');
	if (!images.length) throw new Error('No images are attached to this conversation.');

	const id = typeof rawId === 'string' ? rawId.trim() : '';
	if (!id) {
		if (images.length === 1) return images[0];
		throw new Error(
			`This conversation has ${images.length} images, so say which one with id: ${images.map((x) => `${x.name} (${x.id})`).join(', ')}`
		);
	}
	const match = images.find((x) => x.id === id);
	if (match) return match;

	const document = listAttachments(chatId).find((x) => x.id === id);
	if (document) throw new Error(`${document.name} is not an image. Read it with read_attachment.`);
	throw new Error(
		`No image with id ${id}. Attached: ${images.map((x) => `${x.name} (${x.id})`).join(', ')}`
	);
}

/**
 * The model that does the looking.
 *
 * Unlike `imageModel` next door, an unconfigured task falls back rather than
 * refusing. The reason the drawing half refuses is that a text model asked for
 * a picture returns prose — there is no such thing as a near miss. Here any
 * model the provider lists as taking image input genuinely answers the
 * question, so the fallback is a working default rather than a confident
 * nothing. listEnabledModels sorts by display name, so it is the same model
 * every time and not whatever the database happened to return first.
 */
function visionModel() {
	const configured = getTaskConfig('vision')?.primaryModelId;
	if (configured) {
		const choice = resolveModel(configured);
		if (choice && !choice.model.supportsVision) {
			throw new Error(
				`${choice.model.displayName} cannot read images. Point Admin → Tasks → vision at a model badged “V” in Admin → Models.`
			);
		}
		if (choice) return choice;
	}
	const fallback = listEnabledModels().find((m) => m.supportsVision);
	const choice = fallback ? resolveModel(fallback.id) : null;
	if (!choice) {
		throw new Error(
			'No model here can read images. Enable one badged “V” in Admin → Models, then point Admin → Tasks → vision at it.'
		);
	}
	return choice;
}
