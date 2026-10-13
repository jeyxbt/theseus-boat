import { displayName } from '../auth/session';
import { listBuilds } from '../builds/queries';
import type { BuildStatus, Provider, SkipReason } from '../db/schema';
import { listClosedWindows } from './windows';

export type CycleStatus = BuildStatus | 'queued' | 'skipped';

/** One row of the changelog: a build, or a closed window that has no build (yet). */
export type CycleEntry = {
	cycle: number;
	ideaText: string;
	authorLabel: string | null;
	votes: number;
	status: CycleStatus;
	note: string | null;
	commitSha: string | null;
	linesAdded: number;
	linesRemoved: number;
	startedAt: string;
	dryRun: boolean;
	hasBuild: boolean;
};

export const SKIP_LABELS: Record<SkipReason, string> = {
	no_ideas: 'no ideas',
	not_enough_votes: 'not enough votes',
	paused: 'paused',
	budget: 'budget limit reached',
	final_gate: 'refused by the final check',
	moderation_unavailable: 'moderation unavailable',
	already_built: 'already built',
};

/** Builds and closed windows, newest cycle first. A window with a build shows as its build. */
export function listCycles(limit = 500): CycleEntry[] {
	const builds = listBuilds(limit);
	const built = new Set(builds.map((build) => build.cycle));

	const entries: CycleEntry[] = builds.map((build) => ({
		cycle: build.cycle,
		ideaText: build.ideaText,
		authorLabel: `@${build.authorHandle}`,
		votes: build.votes,
		status: build.status,
		note: build.note,
		commitSha: build.commitSha,
		linesAdded: build.linesAdded,
		linesRemoved: build.linesRemoved,
		startedAt: build.startedAt,
		dryRun: build.dryRun,
		hasBuild: true,
	}));

	for (const window of listClosedWindows(limit)) {
		if (built.has(window.number)) continue;
		// A winner that was skipped (paused, budget, final check) still shows its idea, marked skipped.
		const won = Boolean(window.winnerText) && !window.skipReason;
		entries.push({
			cycle: window.number,
			ideaText: window.winnerText ?? 'No winner this cycle',
			authorLabel:
				window.winnerHandle && window.winnerProvider
					? displayName({ provider: window.winnerProvider as Provider, handle: window.winnerHandle })
					: null,
			votes: won ? (window.winnerVotes ?? 0) : window.votesCount,
			status: won ? 'queued' : 'skipped',
			note: won ? null : window.skipReason ? SKIP_LABELS[window.skipReason] : null,
			commitSha: null,
			linesAdded: 0,
			linesRemoved: 0,
			startedAt: window.closedAt ?? window.closesAt,
			dryRun: false,
			hasBuild: false,
		});
	}

	return entries.sort((a, b) => b.cycle - a.cycle).slice(0, limit);
}
