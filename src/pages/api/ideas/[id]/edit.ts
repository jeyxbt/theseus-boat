import type { APIRoute } from 'astro';
import { intIn } from '../../../../core/http/api';
import { formText } from '../../../../core/http/forms';
import { editIdea, prepareEdit } from '../../../../core/ideas/queries';
import { guardIdeaWrite, respond } from '../../../../core/ideas/routes';
import { reviewForBoard } from '../../../../core/moderation/board';

export const prerender = false;

export const POST: APIRoute = async (context) => {
	const guard = await guardIdeaWrite(context);
	if ('response' in guard) return guard.response;

	const id = intIn(context.params.id, 1, 2 ** 31);
	if (!id) return context.redirect('/ideas?error=not_found#propose');

	const body = await formText(context.request, 'body');
	const prepared = prepareEdit(guard.user.id, id, body);
	if (!prepared.ok) return respond(context, prepared, 'edited', body);

	const review = await reviewForBoard(prepared.text);
	if ('rejected' in review) return respond(context, { ok: false, error: review.rejected }, 'edited', body);
	return respond(context, editIdea(guard.user.id, id, body, Date.now(), review.verified), 'edited', body);
};
