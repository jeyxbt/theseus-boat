import { all, get, nowIso, run, transaction } from '../db/client';
import type { BuildStatus } from '../db/schema';
import { AI_SPEND_KINDS } from '../db/schema';

/** Log lines are shown to everyone: keep them short and on one line. */
const MAX_MESSAGE = 500;
const MAX_TAG = 16;

function oneLine(text: string, max: number) {
	const clean = text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The oldest closed window that has a winner and no build yet. */
export function nextWinnerToBuild() {
	return get<{ windowId: number; number: number; ideaId: number; ideaText: string; authorHandle: string; votes: number }>(
		`SELECT w.id AS windowId, w.number, i.id AS ideaId, i.body AS ideaText, u.handle AS authorHandle,
			w.winner_votes AS votes
		 FROM windows w
		 JOIN ideas i ON i.id = w.winner_idea_id
		 JOIN users u ON u.id = i.user_id
		 LEFT JOIN builds b ON b.window_id = w.id
		 WHERE w.status = 'closed' AND w.skip_reason IS NULL AND b.id IS NULL
		 ORDER BY w.number ASC
		 LIMIT 1`,
	);
}

export type NewBuild = {
	windowId: number;
	ideaId: number;
	cycle: number;
	ideaText: string;
	authorHandle: string;
	votes: number;
	previousSha: string | null;
};

/** Starts a build. One build per window: a second call for the same window returns null. */
export function createBuild(input: NewBuild) {
	const now = nowIso();
	try {
		return (
			get<{ id: number }>(
				`INSERT INTO builds (window_id, idea_id, cycle, idea_text, author_handle, votes, status,
					previous_sha, started_at, heartbeat_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?, ?) RETURNING id`,
				input.windowId,
				input.ideaId,
				input.cycle,
				input.ideaText,
				input.authorHandle,
				input.votes,
				input.previousSha,
				now,
				now,
			)?.id ?? null
		);
	} catch (error) {
		if (String(error).includes('UNIQUE')) return null;
		throw error;
	}
}

/** One line in the public build log. Also counts as a heartbeat. */
export function appendEvent(buildId: number, tag: string, message: string) {
	const now = nowIso();
	transaction(() => {
		run(
			'INSERT INTO build_events (build_id, ts, tag, message) VALUES (?, ?, ?, ?)',
			buildId,
			now,
			oneLine(tag, MAX_TAG) || 'info',
			oneLine(message, MAX_MESSAGE),
		);
		run('UPDATE builds SET heartbeat_at = ? WHERE id = ?', now, buildId);
	});
}

/** Proof of life while a long step runs with nothing to log. */
export function heartbeat(buildId: number) {
	run('UPDATE builds SET heartbeat_at = ? WHERE id = ?', nowIso(), buildId);
}

export function setBuildStatus(buildId: number, status: Extract<BuildStatus, 'building' | 'repairing'>) {
	run('UPDATE builds SET status = ?, heartbeat_at = ? WHERE id = ?', status, nowIso(), buildId);
}

export function countRepair(buildId: number) {
	run("UPDATE builds SET repairs = repairs + 1, status = 'repairing', heartbeat_at = ? WHERE id = ?", nowIso(), buildId);
}

export type BuildOutcome = {
	status: Extract<BuildStatus, 'live' | 'rolled_back' | 'failed'>;
	note?: string | null;
	error?: string | null;
	commitSha?: string | null;
	linesAdded?: number;
	linesRemoved?: number;
	files?: string[];
	/** Built and tested, never applied to the site. */
	dryRun?: boolean;
};

export function finishBuild(buildId: number, outcome: BuildOutcome) {
	const now = nowIso();
	run(
		`UPDATE builds SET status = ?, note = ?, error = ?, commit_sha = ?, lines_added = ?, lines_removed = ?,
			files = ?, dry_run = ?, finished_at = ?, heartbeat_at = ?
		 WHERE id = ?`,
		outcome.status,
		outcome.note ? oneLine(outcome.note, 80) : null,
		outcome.error ? oneLine(outcome.error, 2000) : null,
		outcome.commitSha ?? null,
		outcome.linesAdded ?? 0,
		outcome.linesRemoved ?? 0,
		JSON.stringify(outcome.files ?? []),
		outcome.dryRun ? 1 : 0,
		now,
		now,
		buildId,
	);
}

/**
 * Builds still marked as running after their process died. Called by a run that
 * holds the pipeline lock, so nothing else can be building: anything that has
 * gone quiet for `quietMs` is closed as failed.
 */
export function failInterruptedBuilds(quietMs: number, now = Date.now()) {
	const cutoff = new Date(now - quietMs).toISOString();
	const stuck = all<{ id: number }>(
		`SELECT id FROM builds WHERE status IN ('building', 'repairing') AND is_demo = 0
		 AND coalesce(heartbeat_at, started_at) < ?`,
		cutoff,
	);
	for (const { id } of stuck) {
		appendEvent(id, 'failed', 'the pipeline stopped before this build finished');
		finishBuild(id, { status: 'failed', note: 'interrupted', error: 'the pipeline process stopped mid-build' });
	}
	return stuck.length;
}

export type Spend = {
	kind: (typeof AI_SPEND_KINDS)[number];
	model: string;
	costUsd: number;
	buildId?: number | null;
	windowId?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	numTurns?: number | null;
	durationMs?: number | null;
};

/** Records what one AI call cost, and adds it to the build's total. */
export function recordSpend(spend: Spend) {
	const cost = Number.isFinite(spend.costUsd) && spend.costUsd > 0 ? spend.costUsd : 0;
	transaction(() => {
		run(
			`INSERT INTO ai_spend (build_id, window_id, kind, model, cost_usd, input_tokens, output_tokens, num_turns,
				duration_ms, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			spend.buildId ?? null,
			spend.windowId ?? null,
			spend.kind,
			spend.model,
			cost,
			spend.inputTokens ?? null,
			spend.outputTokens ?? null,
			spend.numTurns ?? null,
			spend.durationMs ?? null,
			nowIso(),
		);
		if (spend.buildId) run('UPDATE builds SET cost_usd = cost_usd + ? WHERE id = ?', cost, spend.buildId);
	});
}

/** AI spend since the first day of the current month, UTC. */
export function spentThisMonth(now = new Date()) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
	return get<{ total: number }>('SELECT coalesce(sum(cost_usd), 0) AS total FROM ai_spend WHERE created_at >= ?', start)
		?.total ?? 0;
}
