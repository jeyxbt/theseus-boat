import { all, get, nowIso, run, transaction } from '../db/client';

export const MAX_VOTES = 3;

export type VoteError = 'not_found' | 'own_idea' | 'no_votes_left' | 'window_closed';

export type ToggleResult =
	| { ok: true; voted: boolean; votes: number; used: number }
	| { ok: false; error: VoteError; used: number };

/** Votes count only while the idea is open. */
function usedVotes(userId: number) {
	return (
		get<{ n: number }>(
			`SELECT count(*) AS n FROM votes v JOIN ideas i ON i.id = v.idea_id
			 WHERE v.user_id = ? AND i.status = 'open'`,
			userId,
		)?.n ?? 0
	);
}

/** Ids of open ideas this person voted for. */
export function myVotes(userId: number) {
	return all<{ id: number }>(
		`SELECT v.idea_id AS id FROM votes v JOIN ideas i ON i.id = v.idea_id
		 WHERE v.user_id = ? AND i.status = 'open'
		 ORDER BY v.created_at, v.idea_id`,
		userId,
	).map((row) => row.id);
}

/** Vote counts for every open idea. */
export function voteCounts() {
	return all<{ id: number; votes: number }>(
		`SELECT i.id, count(v.user_id) AS votes FROM ideas i
		 LEFT JOIN votes v ON v.idea_id = i.id
		 WHERE i.status = 'open'
		 GROUP BY i.id`,
	);
}

/**
 * Casts or takes back a vote. Runs as one write transaction, so two clicks at
 * once can't both take the last free vote.
 */
export function toggleVote(userId: number, ideaId: number, nowMs = Date.now()): ToggleResult {
	return transaction(() => {
		const idea = get<{ userId: number; status: string; windowId: number; closesAt: string }>(
			`SELECT i.user_id AS userId, i.status, i.window_id AS windowId, w.closes_at AS closesAt
			 FROM ideas i JOIN windows w ON w.id = i.window_id WHERE i.id = ?`,
			ideaId,
		);
		if (!idea || idea.status !== 'open') return { ok: false, error: 'not_found', used: usedVotes(userId) };
		// The window's time is up even if nobody has closed it yet: no more changes.
		if (Date.parse(idea.closesAt) <= nowMs) return { ok: false, error: 'window_closed', used: usedVotes(userId) };
		if (idea.userId === userId) return { ok: false, error: 'own_idea', used: usedVotes(userId) };

		const removed = Number(run('DELETE FROM votes WHERE user_id = ? AND idea_id = ?', userId, ideaId).changes);
		if (removed === 0) {
			const used = usedVotes(userId);
			if (used >= MAX_VOTES) return { ok: false, error: 'no_votes_left', used };
			run(
				'INSERT INTO votes (user_id, idea_id, window_id, created_at) VALUES (?, ?, ?, ?)',
				userId,
				ideaId,
				idea.windowId,
				new Date(nowMs).toISOString(),
			);
		}

		const votes = get<{ n: number }>('SELECT count(*) AS n FROM votes WHERE idea_id = ?', ideaId)?.n ?? 0;
		return { ok: true, voted: removed === 0, votes, used: usedVotes(userId) };
	});
}
