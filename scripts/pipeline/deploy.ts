import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkEssentials } from './browser';
import type { PipelineConfig } from './config';
import { freePort, killTree, lastLines, run, start } from './proc';

export type Failure = { reason: string; details: string };

/** Pages every build must keep working. */
const CORE_ROUTES = ['/', '/ideas', '/build', '/changelog', '/rules'];

/** The core pages plus every page a change touched. */
export function siteRoutes(changedFiles: string[]) {
	return [...new Set([...CORE_ROUTES, ...routesFor(changedFiles)])];
}

/** An attribute on the Shell's wrapper (not the site's name, which may change): a page without it has dropped the shell. */
export const SHELL_MARKER = 'data-site-shell';

/** Routes of the pages a change touched: src/pages/garden.astro → /garden. Dynamic routes are skipped. */
export function routesFor(files: string[]) {
	return files
		.filter((file) => /^src\/pages\/.+\.astro$/.test(file) && !file.includes('['))
		.map((file) => file.slice('src/pages'.length).replace(/\.astro$/, '').replace(/\/index$/, '') || '/');
}

/** Shared-data collections a change declared: src/collections/guestbook.json → guestbook. */
export function collectionsFor(files: string[], cwd: string) {
	return files
		.filter((file) => /^src\/collections\/[a-z][a-z0-9-]{1,31}\.json$/.test(file) && existsSync(join(cwd, file)))
		.map((file) => file.slice('src/collections/'.length, -'.json'.length));
}

/**
 * Every route answers 200 with the site's shell, and every declared collection
 * answers on the store API. On a production build the security policy must be
 * there too; the dev server leaves it out on purpose.
 */
export async function checkRoutes(
	base: string,
	routes: string[],
	{ collections = [], requireCsp = true, output = () => '' }: { collections?: string[]; requireCsp?: boolean; output?: () => string } = {},
): Promise<Failure | null> {
	for (const route of routes) {
		let response: Response;
		try {
			response = await fetch(`${base}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
		} catch (error) {
			return { reason: `${route} did not respond`, details: lastLines(`${String(error)}\n${output()}`) };
		}
		const body = await response.text();
		if (response.status !== 200) {
			return { reason: `${route} answered ${response.status}`, details: lastLines(`${body.slice(0, 2000)}\n${output()}`) };
		}
		if (!body.includes(SHELL_MARKER)) return { reason: `${route} lost the site's shell`, details: body.slice(0, 2000) };
		if (requireCsp && !response.headers.get('content-security-policy')) {
			return { reason: `${route} is missing the security policy`, details: '' };
		}
	}
	for (const name of collections) {
		const path = `/api/store/${name}`;
		try {
			const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
			const body = await response.text();
			if (response.status !== 200 || !Array.isArray(JSON.parse(body).items)) {
				return { reason: `${path} answered ${response.status}: is the collection declared right?`, details: lastLines(`${body.slice(0, 2000)}\n${output()}`) };
			}
		} catch (error) {
			return { reason: `${path} did not answer with a list`, details: lastLines(`${String(error)}\n${output()}`) };
		}
	}
	return null;
}

/** The environment for code the AI wrote: enough to run node, and none of our secrets. */
function sandboxEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const keep = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'TZ'];
	const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
	for (const name of keep) if (process.env[name]) env[name] = process.env[name];
	return { ...env, ...extra };
}

async function waitForHealth(base: string, timeoutMs: number, alive: () => boolean) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (!alive()) return false;
		try {
			const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return true;
		} catch {
			// Not listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return false;
}

/**
 * Builds the runner's tree and starts it on a spare port against a copy of the
 * database, then checks the core pages and every page the change touched.
 * Returns null when everything works, or what failed.
 */
export async function buildAndSmoke(
	config: PipelineConfig,
	cwd: string,
	changedFiles: string[],
	log: (tag: string, message: string) => void,
): Promise<Failure | null> {
	log('build', 'compiling…');
	const build = await run(config.buildCommand, { cwd, timeoutMs: config.buildTimeoutMs, env: sandboxEnv({}) });
	if (build.timedOut || build.code !== 0) {
		return { reason: build.timedOut ? 'the build timed out' : 'the build failed', details: lastLines(build.output) };
	}

	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const server = start(config.startCommand, {
		cwd,
		env: sandboxEnv({
			HOST: '127.0.0.1',
			PORT: String(port),
			SITE_URL: base,
			DATABASE_URL: `file:${join(cwd, 'data', 'preview.db')}`,
		}),
	});
	let exited = false;
	server.child.once('exit', () => (exited = true));

	try {
		if (!(await waitForHealth(base, config.healthTimeoutMs, () => !exited))) {
			return { reason: 'the built site did not start', details: lastLines(server.output()) };
		}
		log('build', 'started · health check 200 ✓');

		const routes = siteRoutes(changedFiles);
		const collections = collectionsFor(changedFiles, cwd);
		const failure = await checkRoutes(base, routes, { collections, output: server.output });
		if (failure) return failure;
		log('smoke', `${[...routes, ...collections.map((name) => `/api/store/${name}`)].join(', ')} respond ✓`);

		if (config.browserCheck === 'required') {
			const missing = await checkEssentials(base, routes);
			if (missing) return missing;
			log('smoke', `sign-in, navigation, countdown and the rest are all in place on phone and desktop ✓`);
		}
		return null;
	} finally {
		killTree(server.child.pid);
	}
}
