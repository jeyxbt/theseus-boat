import type { APIRoute } from 'astro';
import { getSessionUser } from '../../core/auth/session';
import { fail, intIn, json, readJson, rejectWrite } from '../../core/http/api';
import { allow } from '../../core/http/rate-limit';
import { currentWindow } from '../../core/cycle/windows';
import { MAX_VOTES, myVotes, toggleVote, voteCounts } from '../../core/votes/queries';

export const prerender = false;

/** Live counts for the board, which ideas the current person voted for, and the open window. */
export const GET: APIRoute = async (context) => {
	const user = await getSessionUser(context);
	const window = currentWindow();
	const mine = user ? myVotes(user.id) : [];
	return json({
		ideas: voteCounts(),
		mine,
		used: mine.length,
		max: MAX_VOTES,
		window: { id: window.id, number: window.number, closesAt: window.closesAt },
	});
};

const STATUS = { not_found: 404, own_idea: 403, no_votes_left: 409, window_closed: 409 } as const;

export const POST: APIRoute = async (context) => {
	const rejected = rejectWrite(context);
	if (rejected) return rejected;

	const user = await getSessionUser(context);
	if (!user) return fail(401, 'signin');
	if (!allow(`votes:u${user.id}`, 30, 60_000)) return fail(429, 'slow');

	const body = await readJson<{ ideaId?: unknown }>(context.request);
	const ideaId = intIn(body?.ideaId, 1, 2 ** 31);
	if (!ideaId) return fail(400, 'idea');

	const result = toggleVote(user.id, ideaId);
	if (!result.ok) return json({ error: result.error, used: result.used }, STATUS[result.error]);
	return json(result);
};
