/**
 * What a site on a real domain needs to be right before it starts. A copy on a
 * laptop (SITE_URL on 127.0.0.1) needs none of this, so none of it applies there.
 *
 * Pure: it reads the environment it is given, so `pnpm preflight`, the server and
 * the tests all ask the same question.
 */
import { isAbsolute } from 'node:path';
import { LOCAL_HOSTS } from './env';

export type Readiness = {
	/** Lives on a real domain: the rules below apply. */
	isPublic: boolean;
	/** Things that must be fixed before this can run in public. */
	problems: string[];
	/** Worth a look, but they don't stop anything. */
	warnings: string[];
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const PROVIDERS = ['GITHUB', 'GOOGLE', 'X'] as const;

function hostOf(url: string | undefined) {
	try {
		return new URL(url ?? 'http://127.0.0.1:4321').hostname;
	} catch {
		return null;
	}
}

export function readiness(env: NodeJS.ProcessEnv = process.env): Readiness {
	const host = hostOf(env.SITE_URL);
	if (host !== null && LOCAL_HOSTS.has(host)) return { isPublic: false, problems: [], warnings: [] };

	const problems: string[] = [];
	const warnings: string[] = [];

	if (host === null) {
		problems.push('SITE_URL is not a valid address');
	} else if (!(env.SITE_URL ?? '').startsWith('https://')) {
		problems.push('SITE_URL must start with https:// on a real domain: sign-in and cookies need it');
	}

	// Visitors' addresses come from the proxy's X-Real-IP header. On a public port anyone could forge it.
	if (env.HOST && !LOOPBACK.has(env.HOST)) {
		problems.push(`HOST is ${env.HOST}: the app must listen on 127.0.0.1 behind the proxy, or anyone can forge a visitor's address and slip past the rate limits`);
	}

	if (!env.DATABASE_URL) {
		problems.push('DATABASE_URL is not set: give it an absolute path outside the code folder, like file:/var/lib/theseus/theseus.db');
	} else if (!isAbsolute(env.DATABASE_URL.replace(/^file:/, ''))) {
		problems.push('DATABASE_URL must be an absolute path: a relative one moves when the app starts from another folder');
	}

	if (!PROVIDERS.some((name) => env[`${name}_CLIENT_ID`] && env[`${name}_CLIENT_SECRET`])) {
		problems.push('no sign-in provider is configured: set the id and secret for at least one of GITHUB, GOOGLE or X');
	}

	// A server has no signed-in Claude Code, and an unreviewed idea is never acceptable in public.
	if (env.MODERATION_PROVIDER !== 'api') {
		problems.push('MODERATION_PROVIDER must be api on a real domain (off would skip the AI review; cli needs a signed-in Claude Code)');
	}
	if (!env.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is not set: the AI review and the build agent need it');

	const minutes = Number(env.WINDOW_MINUTES);
	if (env.WINDOW_MINUTES && Number.isFinite(minutes) && minutes < 60) {
		warnings.push(`WINDOW_MINUTES=${env.WINDOW_MINUTES}: windows this short are for testing; remove it for the default 360`);
	}
	if (env.MODERATION_TIMEOUT_MS && Number(env.MODERATION_TIMEOUT_MS) > 60_000) {
		warnings.push('MODERATION_TIMEOUT_MS is over a minute: visitors wait that long for their idea to go up');
	}
	if (env.DEPLOY_MODE !== 'production') {
		warnings.push(`DEPLOY_MODE is ${env.DEPLOY_MODE || 'preview'}: winners are not shipped to this site. Use production for the real thing`);
	}

	return { isPublic: true, problems, warnings };
}
