import type { APIRoute } from 'astro';
import { safeReturnTo } from '../../../core/auth/oauth';
import { devLoginEnabled, toSessionUser } from '../../../core/auth/session';
import { upsertUser } from '../../../core/auth/users';
import { sameOrigin } from '../../../core/http/same-origin';

export const prerender = false;

const HANDLE_RE = /^[a-z0-9_.-]{2,24}$/;

/** Sign in as any handle, without a provider. Exists only under `astro dev`. */
export const POST: APIRoute = async ({ request, session, redirect }) => {
	if (!devLoginEnabled()) return new Response('Not found', { status: 404 });
	if (!sameOrigin(request) || !session) return redirect('/signin?error=origin');

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return redirect('/signin?error=handle');
	}

	const handle = String(form.get('handle') ?? '')
		.trim()
		.replace(/^@/, '')
		.toLowerCase();
	if (!HANDLE_RE.test(handle)) return redirect('/signin?error=handle');

	const user = upsertUser('dev', { providerId: `local:${handle}`, handle, name: null, avatarUrl: null });
	await session.regenerate();
	session.set('user', toSessionUser(user));
	return redirect(safeReturnTo(form.get('returnTo')));
};
