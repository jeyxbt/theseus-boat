import { cleanHandle, fetchJson, OAuthError } from '../oauth';
import type { OAuthProvider } from './types';

export const google: OAuthProvider = {
	id: 'google',
	label: 'Google',

	authorizeUrl({ clientId, redirectUri, state, challenge }) {
		const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
		url.searchParams.set('client_id', clientId);
		url.searchParams.set('redirect_uri', redirectUri);
		url.searchParams.set('response_type', 'code');
		// No email scope: we don't store it.
		url.searchParams.set('scope', 'openid profile');
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('prompt', 'select_account');
		return url;
	},

	async exchange({ clientId, clientSecret, code, redirectUri, verifier }) {
		const token = await fetchJson<{ access_token?: string }>(
			'https://oauth2.googleapis.com/token',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					client_id: clientId,
					client_secret: clientSecret,
					redirect_uri: redirectUri,
					code_verifier: verifier,
				}),
			},
			'Google token exchange',
		);
		if (!token.access_token) throw new OAuthError('Google returned no token');

		const profile = await fetchJson<{ sub: string; name?: string; given_name?: string; picture?: string }>(
			'https://openidconnect.googleapis.com/v1/userinfo',
			{ headers: { Authorization: `Bearer ${token.access_token}` } },
			'Google profile',
		);

		const name = profile.name ? cleanHandle(profile.name, '') : '';
		return {
			providerId: profile.sub,
			// Google has no usernames: the display name stands in for one.
			handle: cleanHandle(profile.given_name || profile.name, 'google user'),
			name: name || null,
			avatarUrl: profile.picture ?? null,
		};
	},
};
