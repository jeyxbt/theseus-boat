import type { APIContext } from 'astro';
import { getSessionUser, type SessionUser } from '../auth/session';
import { json, readJson, rejectWrite } from '../http/api';
import { allow } from '../http/rate-limit';
import type { Collection } from './collections';
import type { StoreFailure } from './queries';
import { getCollection } from './registry';

export const STATUS: Record<StoreFailure['error'], number> = {
	invalid: 400,
	refused: 422,
	slow: 429,
	daily_limit: 429,
	full: 409,
	not_found: 404,
	wrong_mode: 405,
};

export function failure(result: StoreFailure) {
	return json({ error: result.error, field: result.field, message: result.message }, STATUS[result.error]);
}

export const NO_COLLECTION = () => json({ error: 'not_found', message: 'There is no such collection.' }, 404);

/** A write needs: this site as the origin, JSON, a known collection, a signed-in visitor, and a sane pace. */
export async function guardStoreWrite(
	context: APIContext,
): Promise<{ response: Response } | { user: SessionUser; collection: Collection; body: Record<string, unknown> | null }> {
	const rejected = rejectWrite(context);
	if (rejected) return { response: rejected };
	const collection = getCollection(context.params.collection);
	if (!collection) return { response: NO_COLLECTION() };
	const user = await getSessionUser(context);
	if (!user) return { response: json({ error: 'signin', message: 'Sign in to add to this.' }, 401) };
	// The database limits are the real ones; this stops a burst before it reaches them.
	if (!allow(`store:u${user.id}`, 20, 60_000)) return { response: json({ error: 'slow', message: 'Slow down a little.' }, 429) };
	const body = context.request.method === 'DELETE' ? null : await readJson(context.request, 4096);
	if (context.request.method !== 'DELETE' && !body) {
		return { response: json({ error: 'invalid', message: 'Send JSON like {"data": {…}}.' }, 400) };
	}
	return { user, collection, body };
}
