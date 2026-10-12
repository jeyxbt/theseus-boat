import { all, get, run, transaction } from '../db/client';
import type { SkipReason, Window } from '../db/schema';
import { getWindowMs } from '../env';
import { minVotes } from '../settings';

const COLUMNS = `id, number, opened_at AS openedAt, closes_at AS closesAt, closed_at AS closedAt, status,
	winner_idea_id AS winnerIdeaId, winner_votes AS winnerVotes, ideas_count AS ideasCount,
	votes_count AS votesCount, skip_reason AS skipReason`;

export type ClosedWindow = Window & {
	winnerText: string | null;
	winnerHandle: string | null;
	winnerProvider: string | null;
};

export function getOpenWindow() {
	return get<Window>(`SELECT ${COLUMNS} FROM windows WHERE status = 'open'`);
}

export function getWindow(id: number) {
	return get<Window>(`SELECT ${COLUMNS} FROM windows WHERE id = ?`, id);
}

const CLOSED = `SELECT w.id, w.number, w.opened_at AS openedAt, w.closes_at AS closesAt, w.closed_at AS closedAt,
		w.status, w.winner_idea_id AS winnerIdeaId, w.winner_votes AS winnerVotes, w.ideas_count AS ideasCount,
		w.votes_count AS votesCount, w.skip_reason AS skipReason,
		i.body AS winnerText, u.handle AS winnerHandle, u.provider AS winnerProvider
	FROM windows w
	LEFT JOIN ideas i ON i.id = w.winner_idea_id
	LEFT JOIN users u ON u.id = i.user_id
	WHERE w.status = 'closed'`;

export function lastClosedWindow() {
	return get<ClosedWindow>(`${CLOSED} ORDER BY w.number DESC LIMIT 1`);
}

export function listClosedWindows(limit = 500) {
	return all<ClosedWindow>(`${CLOSED} ORDER BY w.number DESC LIMIT ?`, limit);
}

/** The next public cycle number. Continues after builds that exist without a window (demo data). */
function nextNumber() {
	const row = get<{ n: number }>(
		`SELECT max(coalesce((SELECT max(number) FROM windows), 0), coalesce((SELECT max(cycle) FROM builds), 0)) AS n`,
	);
	return (row?.n ?? 0) + 1;
}

function openWindow(now: number) {
	const window = get<Window>(
		`INSERT INTO windows (number, opened_at, closes_at, status) VALUES (?, ?, ?, 'open') RETURNING ${COLUMNS}`,
		nextNumber(),
		new Date(now).toISOString(),
		new Date(now + getWindowMs()).toISOString(),
	);
	if (!window) throw new Error('Could not open a voting window');
	return window;
}

/**
 * Closes a window: the open idea with the most votes wins if it has at least
 * min_votes; ties go to the idea proposed first. Every other open idea in the
 * window is lost. Votes stay in the database as history.
 */
function closeWindow(window: Window, now: number) {
	const ranked = all<{ id: number; votes: number }>(
		`SELECT i.id, count(v.user_id) AS votes
		 FROM ideas i LEFT JOIN votes v ON v.idea_id = i.id
		 WHERE i.window_id = ? AND i.status = 'open'
		 GROUP BY i.id
		 ORDER BY votes DESC, i.created_at ASC, i.id ASC`,
		window.id,
	);

	const top = ranked[0];
	const winner = top && top.votes >= minVotes() ? top : null;
	const skipReason: SkipReason | null = ranked.length === 0 ? 'no_ideas' : winner ? null : 'not_enough_votes';
	const closedAt = new Date(now).toISOString();

	run(
		`UPDATE ideas SET status = CASE WHEN id = ? THEN 'won' ELSE 'lost' END, updated_at = ?
		 WHERE window_id = ? AND status = 'open'`,
		winner?.id ?? -1,
		closedAt,
		window.id,
	);
	run(
		`UPDATE windows SET status = 'closed', closed_at = ?, winner_idea_id = ?, winner_votes = ?,
			ideas_count = ?, votes_count = ?, skip_reason = ?
		 WHERE id = ?`,
		closedAt,
		winner?.id ?? null,
		winner?.votes ?? null,
		ranked.length,
		ranked.reduce((sum, row) => sum + row.votes, 0),
		skipReason,
		window.id,
	);
	return getWindow(window.id)!;
}

export type Tick = { current: Window; closed: Window | null; opened: Window | null };

/**
 * Brings the cycle up to date: closes the open window if its time is up and
 * opens the next one, which runs a full window length from the moment it opens.
 * Safe to call from any process at any time: the common case is one read, and
 * changes happen under a write lock with the state read again inside it.
 */
export function tickWindows(now = Date.now()): Tick {
	const open = getOpenWindow();
	if (open && Date.parse(open.closesAt) > now) return { current: open, closed: null, opened: null };

	return transaction(() => {
		let current = getOpenWindow();
		let closed: Window | null = null;
		if (current && Date.parse(current.closesAt) <= now) {
			closed = closeWindow(current, now);
			current = null;
		}
		let opened: Window | null = null;
		if (!current) {
			opened = openWindow(now);
			current = opened;
		}
		return { current, closed, opened };
	});
}

/** The open window, opening one first if none exists. */
export function currentWindow(now = Date.now()) {
	return tickWindows(now).current;
}

/**
 * Ends the open window right now. For the dev button and the cycle:close script.
 * With `expectedId`, only that window is closed: a stale button press after the
 * window already rolled over must not close the fresh, empty one too.
 */
export function closeWindowNow(now = Date.now(), expectedId?: number) {
	const before = tickWindows(now);
	// It had already run out: that tick was the close.
	if (before.closed) return before;
	const target = expectedId ?? before.current.id;
	const at = new Date(now).toISOString();
	run("UPDATE windows SET closes_at = ? WHERE id = ? AND status = 'open' AND closes_at > ?", at, target, at);
	return tickWindows(now);
}

/**
 * The window had a winner, but it won't be built: paused, over budget, or
 * refused by a final check. The reason shows publicly in the changelog.
 */
export function skipWinner(windowId: number, reason: Exclude<SkipReason, 'no_ideas' | 'not_enough_votes'>) {
	transaction(() => {
		const window = get<{ winnerIdeaId: number | null }>(
			"SELECT winner_idea_id AS winnerIdeaId FROM windows WHERE id = ? AND status = 'closed'",
			windowId,
		);
		if (!window?.winnerIdeaId) return;
		run('UPDATE windows SET skip_reason = ? WHERE id = ?', reason, windowId);
		run("UPDATE ideas SET status = 'skipped', updated_at = ? WHERE id = ?", new Date().toISOString(), window.winnerIdeaId);
	});
}

/** True when voting in this window is over, even if nobody has ticked the cycle yet. */
export function isPastClose(window: Pick<Window, 'closesAt' | 'status'>, now = Date.now()) {
	return window.status !== 'open' || Date.parse(window.closesAt) <= now;
}
