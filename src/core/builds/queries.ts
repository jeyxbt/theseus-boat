import { all, get } from '../db/client';
import { ACTIVE_BUILD_STATUSES, type Build, type BuildEvent, type BuildStatus } from '../db/schema';

type BuildRow = Omit<Build, 'files' | 'isDemo' | 'dryRun'> & { files: string; isDemo: number; dryRun: number };

const COLUMNS = `id, window_id AS windowId, idea_id AS ideaId, cycle, idea_text AS ideaText,
	author_handle AS authorHandle, votes, status, note, error, previous_sha AS previousSha,
	commit_sha AS commitSha, repairs, lines_added AS linesAdded, lines_removed AS linesRemoved, files,
	cost_usd AS costUsd, started_at AS startedAt, heartbeat_at AS heartbeatAt, finished_at AS finishedAt,
	is_demo AS isDemo, dry_run AS dryRun`;

function toBuild(row: BuildRow): Build {
	let files: string[] = [];
	try {
		const parsed = JSON.parse(row.files);
		if (Array.isArray(parsed)) files = parsed.filter((file): file is string => typeof file === 'string');
	} catch {
		// A broken files column shouldn't take the page down.
	}
	return { ...row, files, isDemo: row.isDemo === 1, dryRun: row.dryRun === 1 };
}

const one = (row: BuildRow | null) => (row ? toBuild(row) : null);

export function latestBuild() {
	return one(get<BuildRow>(`SELECT ${COLUMNS} FROM builds ORDER BY cycle DESC LIMIT 1`));
}

export function buildById(id: number) {
	return one(get<BuildRow>(`SELECT ${COLUMNS} FROM builds WHERE id = ?`, id));
}

export function buildByCycle(cycle: number) {
	return one(get<BuildRow>(`SELECT ${COLUMNS} FROM builds WHERE cycle = ?`, cycle));
}

export function buildForWindow(windowId: number) {
	return one(get<BuildRow>(`SELECT ${COLUMNS} FROM builds WHERE window_id = ?`, windowId));
}

export function listBuilds(limit = 50) {
	return all<BuildRow>(`SELECT ${COLUMNS} FROM builds ORDER BY cycle DESC LIMIT ?`, limit).map(toBuild);
}

/** Builds that are on the site. A dry run passed its tests but was never applied. */
export function shippedBuilds(limit = 12) {
	return all<BuildRow>(
		`SELECT ${COLUMNS} FROM builds WHERE status = 'live' AND dry_run = 0 ORDER BY cycle DESC LIMIT ?`,
		limit,
	).map(toBuild);
}

/** Real ideas already on the site, for spotting a winner that asks for the same thing again. Demo builds don't count. */
export function builtIdeas() {
	return all<{ cycle: number; ideaText: string }>(
		"SELECT cycle, idea_text AS ideaText FROM builds WHERE status = 'live' AND dry_run = 0 AND is_demo = 0 ORDER BY cycle DESC",
	);
}

export function buildEvents(buildId: number) {
	return all<BuildEvent>(
		'SELECT id, build_id AS buildId, ts, tag, message FROM build_events WHERE build_id = ? ORDER BY id',
		buildId,
	);
}

/** Log lines after a given id, for the live stream. */
export function eventsSince(buildId: number, afterId: number, limit = 200) {
	return all<BuildEvent>(
		`SELECT id, build_id AS buildId, ts, tag, message FROM build_events
		 WHERE build_id = ? AND id > ? ORDER BY id LIMIT ?`,
		buildId,
		afterId,
		limit,
	);
}

export function isActive(status: BuildStatus) {
	return ACTIVE_BUILD_STATUSES.includes(status);
}

/** A running build that hasn't reported in this long is presumed dead. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** True for a real build stuck "in progress": its process died without saying so. */
export function isStale(build: Pick<Build, 'status' | 'heartbeatAt' | 'startedAt' | 'isDemo'>, now = Date.now()) {
	if (build.isDemo || !isActive(build.status)) return false;
	return now - Date.parse(build.heartbeatAt ?? build.startedAt) > STALE_AFTER_MS;
}

export { STEPS, stepStates, type StepState } from './steps';

const RESULT_LABELS: Record<BuildStatus | 'queued' | 'skipped', string> = {
	building: 'Building now',
	repairing: 'Repairing',
	live: 'Live',
	rolled_back: 'Rolled back',
	failed: 'Failed',
	queued: 'Queued for AI',
	skipped: 'Skipped',
};

/** A build that finished without touching the site: a dry run, or one played by build:simulate. */
export function dryRunLabel(note: string | null) {
	return note === 'simulated' ? 'Simulated' : 'Dry run passed';
}

export function resultLabel(entry: { status: BuildStatus | 'queued' | 'skipped'; note: string | null; dryRun?: boolean }) {
	// A dry run that passed is not on the site: never call it "Live".
	if (entry.dryRun && entry.status === 'live') return dryRunLabel(entry.note);
	const base = RESULT_LABELS[entry.status] ?? entry.status;
	return entry.note && !(entry.dryRun && entry.note === 'dry run') ? `${base} · ${entry.note}` : base;
}
