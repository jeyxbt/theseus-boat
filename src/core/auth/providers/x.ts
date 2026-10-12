import { cleanHandle, fetchJson, OAuthError } from '../oauth';
import type { OAuthProvider } from './types';

export const x: OAuthProvider = {
	id: 'x',
	label: 'X',

	authorizeUrl({ clientId, redirectUri, state, challenge }) {
		const url = new URL('https://x.com/i/oauth2/authorize');
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', clientId);
		url.searchParams.set('redirect_uri', redirectUri);
		// users.read needs tweet.read alongside it.
		url.searchParams.set('scope', 'users.read tweet.read');
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		return url;
	},

	async exchange({ clientId, clientSecret, code, redirectUri, verifier }) {
		// Confidential client: credentials go in Basic auth.
		const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
		const token = await fetchJson<{ access_token?: string }>(
			'https://api.x.com/2/oauth2/token',
			{
				method: 'POST',
				headers: {
					Authorization: `Basic ${basic}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					redirect_uri: redirectUri,
					code_verifier: verifier,
					client_id: clientId,
				}),
			},
			'X token exchange',
		);
		if (!token.access_token) throw new OAuthError('X returned no token');

		const profile = await fetchJson<{
			data?: { id: string; username: string; name?: string; profile_image_url?: string };
		}>(
			'https://api.x.com/2/users/me?user.fields=profile_image_url',
			{ headers: { Authorization: `Bearer ${token.access_token}` } },
			'X profile',
		);
		if (!profile.data) throw new OAuthError('X returned no profile');

		const { id, username, name, profile_image_url } = profile.data;
		return {
			providerId: id,
			handle: cleanHandle(username, `x-${id}`),
			name: name ? cleanHandle(name, '') || null : null,
			avatarUrl: profile_image_url ?? null,
		};
	},
};
