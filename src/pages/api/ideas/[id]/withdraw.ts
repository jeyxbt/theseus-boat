import type { APIRoute } from 'astro';
import { intIn } from '../../../../core/http/api';
import { withdrawIdea } from '../../../../core/ideas/queries';
import { guardIdeaWrite } from '../../../../core/ideas/routes';

export const prerender = false;

export const POST: APIRoute = async (context) => {
	// Withdrawing is never rate limited: people must always be able to take an idea down.
	const guard = await guardIdeaWrite(context, { limited: false });
	if ('response' in guard) return guard.response;

	const id = intIn(context.params.id, 1, 2 ** 31);
	const result = id ? withdrawIdea(guard.user.id, id) : 'not_found';
	if (result !== 'ok') return context.redirect(`/ideas?error=${result}#propose`);
	return context.redirect('/ideas?ok=withdrawn#propose');
};
