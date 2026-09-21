import type { ForgeSnapshot, ForgeSprint, ForgeTask } from '$lib/server/forge';

/**
 * What an epic should do next.
 *
 * A **pure function over rows** — the same move `research.ts` makes with
 * `shouldStopAfterRound`, and for the same reason. This ordering is where Forge
 * is most likely to be wrong, and purity means it tests with no model, no
 * container and no clock.
 *
 * It is also why an epic is rows rather than a job. `closeAbandonedJobs()` errors
 * every running job at boot and live job state is a module-level Map, so a build
 * spanning two days and three deploys cannot be one process. There is no process
 * that "is" a running epic: there is a row whose state says what should happen
 * next, and a sweep that asks this function.
 */

export type ForgeStep =
	| { kind: 'gate-sprint'; sprintId: string }
	| { kind: 'gate-task'; taskId: string }
	| { kind: 'run-task'; taskId: string }
	| { kind: 'close-sprint'; sprintId: string }
	| { kind: 'plan-sprint'; sprintId: string }
	| { kind: 'close-epic' };

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** The sprint the epic is working in: the first that is not finished. */
function currentSprint(sprints: ForgeSprint[]): ForgeSprint | null {
	return [...sprints].sort(byPosition).find((s) => s.state !== 'done') ?? null;
}

const tasksIn = (tasks: ForgeTask[], sprintId: string) =>
	tasks.filter((t) => t.sprintId === sprintId).sort(byPosition);

export function nextStep(snap: ForgeSnapshot): ForgeStep | null {
	const { epic, sprints, tasks } = snap;
	// Only a running epic has a next step. Drafting and awaiting-approval are
	// waiting on a person; paused, blocked, done and abandoned have stopped on
	// purpose, and a driver that "helpfully" advanced any of them would be
	// undoing the decision that put it there.
	if (epic.state !== 'running') return null;

	const ordered = [...sprints].sort(byPosition);

	// Finish what is in flight before starting anything. A gate left mid-flight
	// by a restart is the first thing to pick back up, because the work it judges
	// is already done and everything after it is waiting on the verdict.
	const gatingSprint = ordered.find((s) => s.state === 'gating');
	if (gatingSprint) return { kind: 'gate-sprint', sprintId: gatingSprint.id };

	const gatingTask = tasks.find((t) => t.state === 'gating');
	if (gatingTask) return { kind: 'gate-task', taskId: gatingTask.id };

	const sprint = currentSprint(ordered);
	if (!sprint) return { kind: 'close-epic' };

	// An outlined sprint is planned just in time. Planning sprint 4's tasks
	// before sprint 1 has run is planning against a repository that does not
	// exist yet, and they would be rewritten by the time they were reached.
	if (sprint.state === 'outlined') return { kind: 'plan-sprint', sprintId: sprint.id };
	// Planning is in flight elsewhere; nothing else in this sprint can start.
	if (sprint.state === 'planning') return null;

	const mine = tasksIn(tasks, sprint.id);
	const planned = mine.find((t) => t.state === 'planned');
	if (planned) return { kind: 'run-task', taskId: planned.id };

	// A task already running is a step in flight — one job per task, and the
	// pace settings decide how many of those there may be, not this function.
	if (mine.some((t) => t.state === 'running')) return null;

	// Everything has either finished or parked. A blocked task does not stall
	// the epic — the driver moved past it to get here — but it does stop its
	// sprint closing, because a sprint with work nobody could finish has not met
	// its goal whatever the gate would say about the code that did land.
	if (mine.some((t) => t.state === 'blocked')) return null;

	return { kind: 'close-sprint', sprintId: sprint.id };
}

/**
 * What a step would do, in words.
 *
 * So a button can say what it is about to do rather than "run one step now" —
 * which told somebody staring at a build that had not moved for five minutes
 * precisely nothing, and looked pressable while a task was already running.
 */
export function describeStep(step: ForgeStep | null, snap: ForgeSnapshot): string {
	if (!step) return '';
	const sprint = (id: string) => snap.sprints.find((s) => s.id === id);
	const task = (id: string) => snap.tasks.find((t) => t.id === id);
	const named = (title: string | undefined, fallback: string) =>
		title ? `“${title}”` : fallback;

	switch (step.kind) {
		case 'plan-sprint':
			return `plan ${named(sprint(step.sprintId)?.title, 'the next sprint')}`;
		case 'run-task':
			return `start ${named(task(step.taskId)?.title, 'the next task')}`;
		case 'gate-task':
			return `check ${named(task(step.taskId)?.title, 'the task that just finished')}`;
		case 'gate-sprint':
		case 'close-sprint':
			return `close ${named(sprint(step.sprintId)?.title, 'the current sprint')}`;
		case 'close-epic':
			return 'run the final gate and open the pull request';
	}
}
