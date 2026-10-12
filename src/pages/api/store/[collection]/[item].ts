import type { APIRoute } from 'astro';
import { intIn, json } from '../../../../core/http/api';
import { putItem, removeItem } from '../../../../core/store/queries';
import { failure, guardStoreWrite } from '../../../../core/store/routes';

export const prerender = false;

/** Save the record in one slot of an upsert-by-key collection: /api/store/canvas/12:7. */
export const PUT: APIRoute = async (context) => {
	const guard = await guardStoreWrite(context);
	if ('response' in guard) return guard.response;
	const result = putItem(guard.user.id, guard.collection, context.params.item, guard.body?.data);
	return result.ok ? json({ item: result.item }) : failure(result);
};

/** Remove a record you wrote: /api/store/guestbook/42. */
export const DELETE: APIRoute = async (context) => {
	const guard = await guardStoreWrite(context);
	if ('response' in guard) return guard.response;
	const id = intIn(context.params.item, 1, Number.MAX_SAFE_INTEGER);
	if (!id) return json({ error: 'not_found', message: 'There is no such record.' }, 404);
	const result = removeItem(guard.user.id, guard.collection, id);
	return result.ok ? json({ ok: true }) : failure(result);
};
