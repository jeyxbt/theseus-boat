import type { APIContext } from 'astro';
import { getSessionUser, type SessionUser } from '../auth/session';
import { allow } from '../http/rate-limit';
import { sameOrigin } from '../http/same-origin';
import type { IdeaResult } from './queries';

const HOUR = 60 * 60 * 1000;
/** Submits and edits per person per hour, refused ones included. */
export const IDEA_WRITES_PER_HOUR = 5;

type Guarded = { user: SessionUser } | { response: Response };

/** Same-origin, signed in, under the rate limit. */
export async function guardIdeaWrite(context: APIContext, { limited = true } = {}): Promise<Guarded> {
	if (!sameOrigin(context.request)) return { response: context.redirect('/ideas?error=origin#propose') };
	const user = await getSessionUser(context);
	if (!user) return { response: context.redirect('/signin?returnTo=%2Fideas') };
	if (limited && !allow(`ideas:u${user.id}`, IDEA_WRITES_PER_HOUR, HOUR)) {
		return { response: context.redirect('/ideas?error=slow#propose') };
	}
	return { user };
}

/** Redirect back to the board with the outcome. A refused text is kept for the form. */
export function respond(context: APIContext, result: IdeaResult, okCode: string, draft: string | null) {
	if (result.ok) return context.redirect(`/ideas?ok=${okCode}#propose`);
	if (draft && result.error !== 'unchanged') context.session?.set('draft', draft.slice(0, 600));
	const similar = result.similarId ? `&similar=${result.similarId}` : '';
	const built = result.builtCycle ? `&built=${result.builtCycle}` : '';
	return context.redirect(`/ideas?error=${result.error}${similar}${built}#propose`);
}
