import type { APIRoute } from 'astro';
import { pkceChallenge, randomToken, safeReturnTo } from '../../../core/auth/oauth';
import { findProvider } from '../../../core/auth/providers';
import { getProviderConfig, publicOrigin } from '../../../core/env';
import { clientIp } from '../../../core/http/api';
import { allow } from '../../../core/http/rate-limit';

export const prerender = false;

export const GET: APIRoute = async (context) => {
	const provider = findProvider(context.params.provider);
	if (!provider || !getProviderConfig(provider.id).configured) {
		return context.redirect('/signin?error=unavailable');
	}

	if (!allow(`auth:${clientIp(context.request)}`, 10, 60_000)) {
		return context.redirect('/signin?error=slow');
	}

	const state = randomToken();
	const verifier = randomToken(48);
	context.session?.set('oauth', {
		provider: provider.id,
		state,
		verifier,
		returnTo: safeReturnTo(context.url.searchParams.get('returnTo')),
		startedAt: Date.now(),
	});

	const { clientId } = getProviderConfig(provider.id);
	const url = provider.authorizeUrl({
		clientId,
		redirectUri: `${publicOrigin(context.url)}/api/auth/${provider.id}/callback`,
		state,
		challenge: pkceChallenge(verifier),
	});
	return context.redirect(url.toString());
};
