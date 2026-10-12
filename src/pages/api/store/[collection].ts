import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../core/auth/session';
import { clientIp, intIn, json } from '../../../core/http/api';
import { allow } from '../../../core/http/rate-limit';
import { addItem, listItems } from '../../../core/store/queries';
import { getCollection } from '../../../core/store/registry';
import { failure, guardStoreWrite, NO_COLLECTION } from '../../../core/store/routes';

export const prerender = false;

/** Records, newest first: ?limit=1..1000 (100), ?before=<id> for the next page. Public. */
export const GET: APIRoute = async (context) => {
	const collection = getCollection(context.params.collection);
	if (!collection) return NO_COLLECTION();
	if (!allow(`store-read:${clientIp(context.request)}`, 240, 60_000)) {
		return json({ error: 'slow', message: 'Too many requests. Wait a moment.' }, 429);
	}
	const url = context.url;
	const user = await getSessionUser(context);
	const list = listItems(collection, {
		limit: intIn(url.searchParams.get('limit'), 1, 1000) ?? 100,
		before: intIn(url.searchParams.get('before'), 1, Number.MAX_SAFE_INTEGER),
		viewerId: user?.id ?? null,
	});
	return json({ ...list, signedIn: Boolean(user) });
};

/** Add a record (append), or save the visitor's own record (one-per-user). */
export const POST: APIRoute = async (context) => {
	const guard = await guardStoreWrite(context);
	if ('response' in guard) return guard.response;
	const result = addItem(guard.user.id, guard.collection, guard.body?.data);
	return result.ok ? json({ item: result.item }, 201) : failure(result);
};
