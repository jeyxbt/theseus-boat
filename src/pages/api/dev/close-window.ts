import type { APIRoute } from 'astro';
import { devLoginEnabled } from '../../../core/auth/session';
import { closeWindowNow } from '../../../core/cycle/windows';
import { intIn } from '../../../core/http/api';
import { formText } from '../../../core/http/forms';
import { sameOrigin } from '../../../core/http/same-origin';

export const prerender = false;

/** Ends the voting window shown on the page. Exists only under `astro dev`, to try a full cycle quickly. */
export const POST: APIRoute = async ({ request, redirect }) => {
	if (!devLoginEnabled()) return new Response('Not found', { status: 404 });
	if (!sameOrigin(request)) return redirect('/ideas?error=origin');
	const windowId = intIn(await formText(request, 'windowId'), 1, 2 ** 31);
	if (!windowId) return redirect('/ideas');
	closeWindowNow(Date.now(), windowId);
	return redirect('/ideas?ok=closed');
};
