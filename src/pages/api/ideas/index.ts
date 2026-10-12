import type { APIRoute } from 'astro';
import { formText } from '../../../core/http/forms';
import { prepareSubmit, submitIdea } from '../../../core/ideas/queries';
import { guardIdeaWrite, respond } from '../../../core/ideas/routes';
import { reviewForBoard } from '../../../core/moderation/board';

export const prerender = false;

export const POST: APIRoute = async (context) => {
	const guard = await guardIdeaWrite(context);
	if ('response' in guard) return guard.response;

	const body = await formText(context.request, 'body');
	// Cheap checks first, so a refused idea never costs a model call.
	const prepared = prepareSubmit(guard.user.id, body);
	if (!prepared.ok) return respond(context, prepared, 'submitted', body);

	const review = await reviewForBoard(prepared.text);
	if ('rejected' in review) return respond(context, { ok: false, error: review.rejected }, 'submitted', body);
	return respond(context, submitIdea(guard.user.id, body, Date.now(), review.verified), 'submitted', body);
};
