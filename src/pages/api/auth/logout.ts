import type { APIRoute } from 'astro';
import { sameOrigin } from '../../../core/http/same-origin';

export const prerender = false;

export const POST: APIRoute = async ({ request, session, redirect }) => {
	// Without this, any site could sign people out with a hidden form.
	if (!sameOrigin(request)) return redirect('/?error=origin');

	await session?.destroy();
	return redirect('/');
};
