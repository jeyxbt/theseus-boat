import { SITE_SLUG } from '../../site';
import { cleanHandle, fetchJson, OAuthError } from '../oauth';
import type { OAuthProvider } from './types';

export const github: OAuthProvider = {
	id: 'github',
	label: 'GitHub',

	authorizeUrl({ clientId, redirectUri, state, challenge }) {
		const url = new URL('https://github.com/login/oauth/authorize');
		url.searchParams.set('client_id', clientId);
		url.searchParams.set('redirect_uri', redirectUri);
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('allow_signup', 'true');
		return url;
	},

	async exchange({ clientId, clientSecret, code, redirectUri, verifier }) {
		const token = await fetchJson<{ access_token?: string; error?: string }>(
			'https://github.com/login/oauth/access_token',
			{
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					client_id: clientId,
					client_secret: clientSecret,
					code,
					redirect_uri: redirectUri,
					code_verifier: verifier,
				}),
			},
			'GitHub token exchange',
		);
		// GitHub answers 200 with an error field when the code is bad.
		if (!token.access_token) throw new OAuthError(`GitHub returned no token: ${token.error ?? 'unknown'}`);

		const profile = await fetchJson<{ id: number; login: string; name: string | null; avatar_url: string | null }>(
			'https://api.github.com/user',
			{
				headers: {
					Authorization: `Bearer ${token.access_token}`,
					Accept: 'application/vnd.github+json',
					'User-Agent': SITE_SLUG,
				},
			},
			'GitHub profile',
		);

		return {
			providerId: String(profile.id),
			handle: cleanHandle(profile.login, `github-${profile.id}`),
			name: profile.name ? cleanHandle(profile.name, '') || null : null,
			avatarUrl: profile.avatar_url,
		};
	},
};
