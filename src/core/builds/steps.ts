import type { BuildStatus } from '../db/schema';

/** The six steps shown on the live build page, in order. No database here: the browser uses it too. */
export const STEPS = [
	{ title: 'Window closed', note: 'Votes counted' },
	{ title: 'Winner picked', note: 'Most votes wins' },
	{ title: 'AI writing', note: 'Only the site’s own files' },
	{ title: 'Safety checks', note: 'Paths, secrets, size' },
	{ title: 'Build & test', note: 'Must start and respond' },
	{ title: 'Published', note: 'Commit on GitHub' },
] as const;

const STEP_OF_TAG: Record<string, number> = {
	window: 0,
	winner: 1,
	ai: 2,
	checks: 3,
	guard: 3,
	build: 4,
	repair: 4,
	smoke: 4,
	deploy: 4,
	rollback: 4,
	git: 5,
	live: 6,
};

export type StepState = 'done' | 'active' | 'failed' | 'waiting';

/** Where each step stands, read from the log. */
export function stepStates(status: BuildStatus, tags: string[]): StepState[] {
	const reached = Math.max(-1, ...tags.map((tag) => STEP_OF_TAG[tag] ?? -1));
	const failed = status === 'rolled_back' || status === 'failed';
	return STEPS.map((_, index) => {
		if (status === 'live') return 'done';
		if (index < reached) return 'done';
		if (index === reached) return failed ? 'failed' : 'active';
		return 'waiting';
	});
}
