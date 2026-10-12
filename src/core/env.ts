function read(name: string, fallback = '') {
	// process.env only. Reading import.meta.env[name] with a variable key makes
	// Vite copy every .env variable, secrets included, into dist/.
	const value = process.env[name];
	return value !== undefined && value !== '' ? value : fallback;
}

export function getSiteUrl() {
	return read('SITE_URL', 'http://127.0.0.1:4321').replace(/\/$/, '');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Origin shown to OAuth providers as the redirect base. SITE_URL wins: the
 * request origin comes from the Host header, which the caller controls. The
 * request origin is used only when both it and SITE_URL are local.
 */
export function publicOrigin(requestUrl: URL) {
	const site = getSiteUrl();

	let siteHost = '';
	try {
		siteHost = new URL(site).hostname;
	} catch {
		return site;
	}

	if (!LOCAL_HOSTS.has(siteHost)) return site;
	return LOCAL_HOSTS.has(requestUrl.hostname) ? requestUrl.origin : site;
}

/** SQLite on local disk. */
export function getDatabaseUrl() {
	const raw = read('DATABASE_URL', 'file:data/local.db');
	return raw.startsWith('file:') ? raw : `file:${raw}`;
}

/** Length of a voting window. 360 minutes in production; set it lower in .env to test a cycle. */
export function getWindowMs() {
	const minutes = Number(read('WINDOW_MINUTES', '360'));
	return Math.max(1, Number.isFinite(minutes) ? minutes : 360) * 60 * 1000;
}

export type ProviderId = 'github' | 'google' | 'x';

export function getProviderConfig(provider: ProviderId) {
	const prefix = provider.toUpperCase();
	const clientId = read(`${prefix}_CLIENT_ID`);
	const clientSecret = read(`${prefix}_CLIENT_SECRET`);
	return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

export function configuredProviders(): ProviderId[] {
	return (['github', 'google', 'x'] as const).filter((id) => getProviderConfig(id).configured);
}
