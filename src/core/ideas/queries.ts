import { builtIdeas } from '../builds/queries';
import { currentWindow } from '../cycle/windows';
import { all, get, nowIso, run, transaction } from '../db/client';
import { IDEA_MAX, IDEA_MIN, type Idea, type Provider } from '../db/schema';
import { cleanText } from '../http/api';
import { moderate, type RejectReason } from './moderation';
import { findDuplicate } from './similarity';

export const MAX_EDITS = 3;

export type IdeaError =
	| RejectReason
	| 'length'
	| 'duplicate'
	| 'has_idea'
	| 'not_found'
	| 'no_edits'
	| 'unchanged'
	| 'window_closed'
	| 'already_built'
	// Only the AI review can tell these.
	| 'harmful'
	| 'off_topic';

type Refusal = { ok: false; error: IdeaError; similarId?: number; builtCycle?: number };

export type IdeaResult = { ok: true; idea: Idea } | Refusal;

export type IdeaRow = {
	id: number;
	body: string;
	createdAt: string;
	authorId: number;
	authorHandle: string;
	authorProvider: Provider;
	votes: number;
};

const IDEA_COLUMNS = `id, user_id AS userId, window_id AS windowId, body, status, edits,
	created_at AS createdAt, updated_at AS updatedAt, verified, removed_reason AS removedReason`;

/** The author's open idea, with its window's closing time, if the window is still running. */
function myOpenIdeaWithWindow(userId: number, ideaId: number) {
	return get<Idea & { closesAt: string }>(
		`SELECT i.id, i.user_id AS userId, i.window_id AS windowId, i.body, i.status, i.edits,
			i.created_at AS createdAt, i.updated_at AS updatedAt, i.verified, i.removed_reason AS removedReason,
			w.closes_at AS closesAt
		 FROM ideas i JOIN windows w ON w.id = i.window_id
		 WHERE i.id = ? AND i.user_id = ? AND i.status = 'open'`,
		ideaId,
		userId,
	);
}

const LIST = `SELECT i.id, i.body, i.created_at AS createdAt, i.user_id AS authorId,
		u.handle AS authorHandle, u.provider AS authorProvider, count(v.user_id) AS votes
	FROM ideas i
	JOIN users u ON u.id = i.user_id
	LEFT JOIN votes v ON v.idea_id = i.id
	WHERE i.status = 'open'
	GROUP BY i.id`;

/** Open ideas. "top": most votes, ties go to the earlier idea. "new": newest first. */
export function listOpenIdeas(sort: 'top' | 'new' = 'top') {
	return sort === 'new'
		? all<IdeaRow>(`${LIST} ORDER BY i.created_at DESC, i.id DESC`)
		: all<IdeaRow>(`${LIST} ORDER BY votes DESC, i.created_at ASC, i.id ASC`);
}

/** Live numbers for the home page: open ideas, votes on them, and how many people took part. */
export function boardStats() {
	return (
		get<{ ideas: number; votes: number; people: number }>(
			`SELECT
				(SELECT count(*) FROM ideas WHERE status = 'open') AS ideas,
				(SELECT count(*) FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE i.status = 'open') AS votes,
				(SELECT count(*) FROM (
					SELECT user_id FROM ideas WHERE status = 'open'
					UNION
					SELECT v.user_id FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE i.status = 'open'
				)) AS people`,
		) ?? { ideas: 0, votes: 0, people: 0 }
	);
}

export function getMyOpenIdea(userId: number) {
	return get<Idea>(`SELECT ${IDEA_COLUMNS} FROM ideas WHERE user_id = ? AND status = 'open'`, userId);
}

/** Cleans and checks a text. Returns the clean text or why it was refused. */
function check(raw: unknown, excludeIdeaId?: number): { ok: true; text: string } | Refusal {
	const text = cleanText(raw, IDEA_MAX, { min: IDEA_MIN });
	if (!text) return { ok: false, error: 'length' };

	const verdict = moderate(text);
	if (!verdict.ok) return { ok: false, error: verdict.reason };

	const others = all<{ id: number; body: string }>(
		"SELECT id, body FROM ideas WHERE status = 'open' AND id != ?",
		excludeIdeaId ?? 0,
	);
	const duplicate = findDuplicate(text, others);
	if (duplicate) return { ok: false, error: 'duplicate', similarId: duplicate.id };

	const built = findDuplicate(
		text,
		builtIdeas().map((build) => ({ id: build.cycle, body: build.ideaText })),
	);
	if (built) return { ok: false, error: 'already_built', builtCycle: built.id };

	return { ok: true, text };
}

export type Prepared = { ok: true; text: string } | Refusal;

/** Every check a new idea must pass before the AI review: one open idea per person, length, regex rules, duplicates. */
export function prepareSubmit(userId: number, raw: unknown, nowMs = Date.now()): Prepared {
	currentWindow(nowMs);
	if (getMyOpenIdea(userId)) return { ok: false, error: 'has_idea' };
	return check(raw);
}

/** Ideas go into the window that is open right now. `verified` is false when the AI review couldn't run yet. */
export function submitIdea(userId: number, raw: unknown, nowMs = Date.now(), verified = true): IdeaResult {
	const prepared = prepareSubmit(userId, raw, nowMs);
	if (!prepared.ok) return prepared;
	const window = currentWindow(nowMs);

	const now = new Date(nowMs).toISOString();
	try {
		const idea = get<Idea>(
			`INSERT INTO ideas (user_id, window_id, body, status, edits, created_at, updated_at, verified)
			 SELECT ?, id, ?, 'open', 0, ?, ?, ? FROM windows WHERE id = ? AND status = 'open' AND closes_at > ?
			 RETURNING ${IDEA_COLUMNS}`,
			userId,
			prepared.text,
			now,
			now,
			verified ? 1 : 0,
			window.id,
			now,
		);
		return idea ? { ok: true, idea } : { ok: false, error: 'window_closed' };
	} catch (error) {
		// Two submits at once: the unique index lets only one through.
		if (String(error).includes('UNIQUE')) return { ok: false, error: 'has_idea' };
		throw error;
	}
}

/**
 * Edits spend one of MAX_EDITS. The text is checked first, so a refused or
 * unchanged edit costs nothing. The count and the change happen in one UPDATE,
 * so two edits at once can't both take the last slot.
 *
 * A saved edit clears the idea's votes: people voted for the old text, and an
 * author must not be able to collect votes and then swap in something else.
 */
/** Every check an edit must pass before the AI review. A refused or unchanged edit costs nothing. */
export function prepareEdit(userId: number, ideaId: number, raw: unknown, nowMs = Date.now()): Prepared {
	const current = myOpenIdeaWithWindow(userId, ideaId);
	if (!current) return { ok: false, error: 'not_found' };
	if (Date.parse(current.closesAt) <= nowMs) return { ok: false, error: 'window_closed' };
	if (current.edits >= MAX_EDITS) return { ok: false, error: 'no_edits' };

	const checked = check(raw, ideaId);
	if (!checked.ok) return checked;
	if (checked.text === current.body) return { ok: false, error: 'unchanged' };
	return checked;
}

export function editIdea(userId: number, ideaId: number, raw: unknown, nowMs = Date.now(), verified = true): IdeaResult {
	const prepared = prepareEdit(userId, ideaId, raw, nowMs);
	if (!prepared.ok) return prepared;

	return transaction((): IdeaResult => {
		const idea = get<Idea>(
			`UPDATE ideas SET body = ?, edits = edits + 1, updated_at = ?, verified = ?
			 WHERE id = ? AND user_id = ? AND status = 'open' AND edits < ?
			 RETURNING ${IDEA_COLUMNS}`,
			prepared.text,
			new Date(nowMs).toISOString(),
			verified ? 1 : 0,
			ideaId,
			userId,
			MAX_EDITS,
		);
		if (!idea) return { ok: false, error: 'no_edits' };
		run('DELETE FROM votes WHERE idea_id = ?', ideaId);
		return { ok: true, idea };
	});
}

/**
 * Takes the idea off the board and gives its votes back to the people who cast
 * them. Not once the window's time is up: that would let an author change the
 * result in the last second.
 */
export function withdrawIdea(userId: number, ideaId: number, nowMs = Date.now()): 'ok' | 'not_found' | 'window_closed' {
	const current = myOpenIdeaWithWindow(userId, ideaId);
	if (!current) return 'not_found';
	if (Date.parse(current.closesAt) <= nowMs) return 'window_closed';

	return transaction(() => {
		const changed = run(
			"UPDATE ideas SET status = 'withdrawn', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'",
			nowIso(),
			ideaId,
			userId,
		).changes;
		if (Number(changed) === 0) return 'not_found';
		run('DELETE FROM votes WHERE idea_id = ?', ideaId);
		return 'ok';
	});
}

// ---- Background AI review ----

/** Open ideas that went up on regex checks only, oldest first. */
export function pendingReviews(limit = 3) {
	return all<{ id: number; body: string }>(
		"SELECT id, body FROM ideas WHERE verified = 0 AND status = 'open' ORDER BY created_at, id LIMIT ?",
		limit,
	);
}

/** The review passed. Only if the text is still the one that was reviewed: an edit since then gets its own review. */
export function markReviewed(ideaId: number, body: string) {
	run("UPDATE ideas SET verified = 1 WHERE id = ? AND body = ? AND status = 'open'", ideaId, body);
}

/** The review failed: off the board, votes back to the people who cast them, reason kept for the author. */
export function removeIdea(ideaId: number, body: string, reason: string) {
	return transaction(() => {
		const changed = Number(
			run(
				"UPDATE ideas SET status = 'removed', removed_reason = ?, verified = 1, updated_at = ? WHERE id = ? AND body = ? AND status = 'open'",
				reason,
				nowIso(),
				ideaId,
				body,
			).changes,
		);
		if (changed > 0) run('DELETE FROM votes WHERE idea_id = ?', ideaId);
		return changed > 0;
	});
}

/** The author's idea taken down in this window, if any, so the board can tell them why. */
export function myRemovedIdea(userId: number, windowId: number) {
	return get<{ id: number; body: string; reason: string }>(
		`SELECT id, body, removed_reason AS reason FROM ideas
		 WHERE user_id = ? AND window_id = ? AND status = 'removed' AND removed_reason IS NOT NULL
		 ORDER BY updated_at DESC, id DESC LIMIT 1`,
		userId,
		windowId,
	);
}
