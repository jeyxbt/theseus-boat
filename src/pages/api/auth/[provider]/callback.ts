import type { APIRoute } from 'astro';
import { OAuthError } from '../../../../core/auth/oauth';
import { findProvider } from '../../../../core/auth/providers';
import { toSessionUser } from '../../../../core/auth/session';
import { upsertUser } from '../../../../core/auth/users';
import { getProviderConfig, publicOrigin } from '../../../../core/env';

export const prerender = false;

/** A sign-in that takes longer than this is treated as abandoned. */
const MAX_AGE_MS = 10 * 60 * 1000;

export const GET: APIRoute = async ({ params, url, session, redirect }) => {
	const provider = findProvider(params.provider);
	const pending = await session?.get('oauth');
	// One use only, whatever happens next.
	session?.delete('oauth');

	if (!provider || !session) return redirect('/signin?error=auth');

	// The person pressed "cancel" on the provider's page.
	if (url.searchParams.get('error')) return redirect('/signin?error=denied');

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (
		!code ||
		!state ||
		!pending ||
		pending.provider !== provider.id ||
		pending.state !== state ||
		Date.now() - pending.startedAt > MAX_AGE_MS
	) {
		return redirect('/signin?error=auth');
	}

	try {
		const { clientId, clientSecret } = getProviderConfig(provider.id);
		const profile = await provider.exchange({
			clientId,
			clientSecret,
			code,
			redirectUri: `${publicOrigin(url)}/api/auth/${provider.id}/callback`,
			verifier: pending.verifier,
		});
		const user = upsertUser(provider.id, profile);

		// New session id after sign-in, so a planted id can't be reused.
		await session.regenerate();
		session.set('user', toSessionUser(user));
		return redirect(pending.returnTo);
	} catch (error) {
		const reason = error instanceof OAuthError ? error.message : String(error);
		console.error(`[auth] ${provider.label} sign-in failed: ${reason}`);
		return redirect(`/signin?error=auth&provider=${provider.id}`);
	}
};
