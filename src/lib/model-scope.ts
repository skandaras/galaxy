/**
 * The tasks a coding-only provider's models may run.
 *
 * A provider can be kept to coding so a model added for the repository agent
 * does not also appear in chat, or get picked by a fallback that reaches for
 * "the first enabled model". `subagent` is here because its one caller is the
 * explore tool, which only exists inside a coding session.
 *
 * Shared with the browser so Admin → Tasks offers the same models the server
 * will accept, rather than a dropdown that saves a choice the task then refuses.
 */
export const CODING_ONLY_TASKS: readonly string[] = ['coding', 'subagent'];

/** Whether a model from a provider with this flag may run `task`. Unknown task means no. */
export function scopeAllows(codingOnly: boolean, task: string | undefined): boolean {
	return !codingOnly || (task !== undefined && CODING_ONLY_TASKS.includes(task));
}
