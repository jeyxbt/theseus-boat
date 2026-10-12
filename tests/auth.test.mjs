import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('auth');

const { pkceChallenge, randomToken, safeReturnTo, cleanHandle } = await import('../src/core/auth/oauth.ts');
const { upsertUser, getUserById } = await import('../src/core/auth/users.ts');
const { displayName } = await import('../src/core/auth/session.ts');
const { findProvider, enabledProviders } = await import('../src/core/auth/providers/index.ts');
const { github } = await import('../src/core/auth/providers/github.ts');
const { google } = await import('../src/core/auth/providers/google.ts');
const { x } = await import('../src/core/auth/providers/x.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Replaces fetch with canned JSON responses, in order, and records the calls. */
function mockFetch(responses) {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		const next = responses.shift();
		if (!next) throw new Error(`unexpected fetch to ${url}`);
		return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
	};
	return calls;
}

const INPUT = { clientId: 'cid', clientSecret: 'secret', code: 'the-code', redirectUri: 'http://127.0.0.1:4321/cb', verifier: 'v' };

describe('PKCE and tokens', () => {
	test('S256 challenge is base64url(sha256(verifier)), checked with WebCrypto', async () => {
		const verifier = randomToken(48);
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		const expected = Buffer.from(digest).toString('base64url');
		assert.equal(pkceChallenge(verifier), expected);
		assert.match(pkceChallenge(verifier), /^[A-Za-z0-9_-]{43}$/);
	});

	test('random tokens are url-safe and unique', () => {
		const a = randomToken();
		assert.match(a, /^[A-Za-z0-9_-]{43}$/);
		assert.notEqual(a, randomToken());
	});
});

describe('safeReturnTo', () => {
	test('keeps paths on this site', () => {
		assert.equal(safeReturnTo('/ideas'), '/ideas');
		assert.equal(safeReturnTo('/ideas?sort=new'), '/ideas?sort=new');
	});

	test('refuses anything that could leave the site', () => {
		for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'evil.com', '', null, 42, '/ideas\nSet-Cookie:x', '/api/auth/logout']) {
			assert.equal(safeReturnTo(bad), '/', `should refuse ${JSON.stringify(bad)}`);
		}
	});
});

describe('handles', () => {
	test('strips control characters and caps at 64', () => {
		assert.equal(cleanHandle('ali\u0000ce', 'x'), 'alice');
		assert.equal(cleanHandle('a'.repeat(100), 'x').length, 64);
		assert.equal(cleanHandle('   ', 'fallback'), 'fallback');
	});

	test('Google shows the name, others an @handle', () => {
		assert.equal(displayName({ provider: 'google', handle: 'Alex' }), 'Alex');
		assert.equal(displayName({ provider: 'github', handle: 'alex' }), '@alex');
	});
});

describe('users', () => {
	test('first sign-in creates the account, later ones refresh it', () => {
		const first = upsertUser('github', { providerId: '1', handle: 'old', name: null, avatarUrl: null });
		const second = upsertUser('github', { providerId: '1', handle: 'new', name: 'New', avatarUrl: 'https://a/b.png' });
		assert.equal(first.id, second.id);
		assert.equal(getUserById(first.id).handle, 'new');
		assert.equal(getUserById(first.id).avatarUrl, 'https://a/b.png');
	});

	test('the same id on different providers is a different person', () => {
		const a = upsertUser('github', { providerId: '7', handle: 'a', name: null, avatarUrl: null });
		const b = upsertUser('x', { providerId: '7', handle: 'a', name: null, avatarUrl: null });
		const c = upsertUser('google', { providerId: '7', handle: 'a', name: null, avatarUrl: null });
		assert.equal(new Set([a.id, b.id, c.id]).size, 3);
	});
});

describe('provider registry', () => {
	test('finds only known providers', () => {
		assert.equal(findProvider('github')?.id, 'github');
		assert.equal(findProvider('facebook'), null);
		assert.equal(findProvider('__proto__'), null);
		assert.equal(findProvider(undefined), null);
	});

	test('enables a provider only when both keys are set', () => {
		const saved = { ...process.env };
		process.env.GITHUB_CLIENT_ID = 'id';
		process.env.GITHUB_CLIENT_SECRET = 'secret';
		process.env.GOOGLE_CLIENT_ID = 'id';
		process.env.GOOGLE_CLIENT_SECRET = '';
		process.env.X_CLIENT_ID = '';
		process.env.X_CLIENT_SECRET = '';
		assert.deepEqual(enabledProviders().map((p) => p.id), ['github']);
		process.env = saved;
	});
});

describe('authorize URLs carry state and PKCE', () => {
	for (const provider of [github, google, x]) {
		test(provider.label, () => {
			const url = provider.authorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:4321/cb', state: 'st', challenge: 'ch' });
			assert.equal(url.protocol, 'https:');
			assert.equal(url.searchParams.get('client_id'), 'cid');
			assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4321/cb');
			assert.equal(url.searchParams.get('state'), 'st');
			assert.equal(url.searchParams.get('code_challenge'), 'ch');
			assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
		});
	}
});

describe('code exchange', () => {
	test('GitHub', async () => {
		const calls = mockFetch([
			{ body: { access_token: 'tok' } },
			{ body: { id: 99, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/99' } },
		]);
		const profile = await github.exchange(INPUT);
		assert.deepEqual(profile, {
			providerId: '99',
			handle: 'octo',
			name: 'Octo Cat',
			avatarUrl: 'https://avatars.githubusercontent.com/u/99',
		});
		assert.equal(JSON.parse(calls[0].init.body).code_verifier, 'v');
		assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
	});

	test('GitHub error inside a 200 response is a failure', async () => {
		mockFetch([{ body: { error: 'bad_verification_code' } }]);
		await assert.rejects(github.exchange(INPUT), /bad_verification_code/);
	});

	test('Google', async () => {
		const calls = mockFetch([
			{ body: { access_token: 'tok' } },
			{ body: { sub: 'g-1', name: 'Ana Petrenko', given_name: 'Ana', picture: 'https://lh3.googleusercontent.com/p' } },
		]);
		const profile = await google.exchange(INPUT);
		assert.deepEqual(profile, {
			providerId: 'g-1',
			handle: 'Ana',
			name: 'Ana Petrenko',
			avatarUrl: 'https://lh3.googleusercontent.com/p',
		});
		const body = new URLSearchParams(String(calls[0].init.body));
		assert.equal(body.get('code_verifier'), 'v');
		assert.equal(body.get('grant_type'), 'authorization_code');
	});

	test('X sends client credentials as Basic auth', async () => {
		const calls = mockFetch([
			{ body: { access_token: 'tok' } },
			{ body: { data: { id: '123', username: 'jey', name: 'Jey', profile_image_url: 'https://pbs.twimg.com/p.jpg' } } },
		]);
		const profile = await x.exchange(INPUT);
		assert.deepEqual(profile, { providerId: '123', handle: 'jey', name: 'Jey', avatarUrl: 'https://pbs.twimg.com/p.jpg' });
		assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('cid:secret').toString('base64')}`);
		assert.match(calls[1].url, /\/2\/users\/me/);
	});

	test('a provider error status is a failure', async () => {
		mockFetch([{ status: 401, body: { error: 'unauthorized_client' } }]);
		await assert.rejects(x.exchange(INPUT), /401/);
	});
});
