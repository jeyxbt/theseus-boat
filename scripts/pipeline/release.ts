/**
 * Putting a change that passed every check in the runner onto the real site,
 * and taking it back if the site breaks.
 *
 * local:      the change is fast-forwarded into the site's repository, where a
 *             dev server reloads it by itself; the live site is then checked.
 * production: the site is a production build under a process manager: the change
 *             is applied, built, the site restarted, and the restarted site is
 *             checked with every check the preview had, in a real browser too.
 *
 * Either way a broken site is undone with a revert commit, so the history shows
 * both the change and its undoing.
 */
import { checkEssentials } from './browser';
import type { PipelineConfig } from './config';
import { checkRoutes, collectionsFor, sandboxEnv, siteRoutes, waitForHealth, type Failure } from './deploy';
import { lastLines, run } from './proc';
import { git } from './runner';

export type LiveState = 'dev' | 'production' | 'down';

/**
 * What answers at the live address. The dev server reloads changed files by
 * itself; a production build keeps serving the old code until it is rebuilt,
 * so checking it would prove nothing. The dev server sends no security policy.
 */
export async function liveState(base: string): Promise<LiveState> {
	try {
		const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
		if (!health.ok) return 'down';
		const home = await fetch(`${base}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
		await home.arrayBuffer();
		return home.headers.get('content-security-policy') ? 'production' : 'dev';
	} catch {
		return 'down';
	}
}

/** Checks the live dev server, retrying for a while: it needs a moment to reload. */
export async function checkLive(config: PipelineConfig, files: string[]): Promise<Failure | null> {
	const routes = siteRoutes(files);
	const collections = collectionsFor(files, config.sourceDir);
	const until = Date.now() + config.liveSettleMs;
	for (;;) {
		const failure = await checkRoutes(config.liveUrl, routes, { collections, requireCsp: false });
		if (!failure || Date.now() >= until) return failure;
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
}

/**
 * Builds the site where it lives, restarts it, and checks it as a visitor would
 * see it. Returns null when it works, or what failed. The build runs without our
 * secrets, as in the preview: it only compiles, it has no business with them.
 */
export async function publishProduction(config: PipelineConfig, files: string[], log: (tag: string, message: string) => void): Promise<Failure | null> {
	if (!config.restartCommand) return { reason: 'there is no RESTART_COMMAND to restart the site with', details: '' };

	log('deploy', 'building the site…');
	const built = await run(config.buildCommand, { cwd: config.sourceDir, timeoutMs: config.buildTimeoutMs, env: sandboxEnv({}) });
	if (built.timedOut || built.code !== 0) {
		return { reason: built.timedOut ? 'the production build timed out' : 'the production build failed', details: lastLines(built.output) };
	}

	log('deploy', 'restarting the site…');
	const restarted = await run(config.restartCommand, { cwd: config.sourceDir, timeoutMs: config.restartTimeoutMs, env: process.env });
	if (restarted.timedOut || restarted.code !== 0) {
		return { reason: restarted.timedOut ? 'restarting the site timed out' : 'restarting the site failed', details: lastLines(restarted.output) };
	}
	if (!(await waitForHealth(config.liveUrl, config.restartTimeoutMs, () => true))) {
		return { reason: 'the site did not come back after the restart', details: `nothing answered at ${config.liveUrl}/api/health` };
	}

	const routes = siteRoutes(files);
	const failure = await checkRoutes(config.liveUrl, routes, { collections: collectionsFor(files, config.sourceDir), requireCsp: true });
	if (failure) return failure;
	if (config.browserCheck === 'required') return checkEssentials(config.liveUrl, routes);
	return null;
}

/** Fast-forward only: uncommitted work in the site's folder is never overwritten. */
export function applyToSite(config: PipelineConfig) {
	const branch = git(config.runnerDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
	git(config.sourceDir, ['pull', '--ff-only', '--quiet', config.runnerDir, branch]);
}

/** Undoes a shipped commit with a new commit by the bot. Returns the new commit. */
export function revertOnSite(config: PipelineConfig, sha: string, cycle: number, reason: string, env: NodeJS.ProcessEnv) {
	try {
		git(config.sourceDir, ['revert', '--no-commit', sha], env);
	} catch (error) {
		// Someone's edits are in the way: leave their folder exactly as it was.
		try {
			git(config.sourceDir, ['revert', '--abort']);
		} catch {
			// Nothing was started.
		}
		throw error;
	}
	const message = [
		`revert: cycle ${String(cycle).padStart(3, '0')} broke the live site`,
		'',
		reason.replaceAll(/[\u0000-\u001F\u007F]+/g, ' ').slice(0, 200),
		`This reverts commit ${sha}.`,
		'',
	].join('\n');
	git(config.sourceDir, ['commit', '--quiet', '-m', message], env);
	return git(config.sourceDir, ['rev-parse', '--short=7', 'HEAD']).trim();
}

/**
 * Sends the site's branch to the remote, so the public history follows what is
 * live. Returns why it failed, or null. A push that fails never undoes a
 * change that works: the next successful push carries everything up.
 */
export function pushSite(config: PipelineConfig): string | null {
	try {
		const branch = git(config.sourceDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
		git(config.sourceDir, ['push', '--quiet', config.pushRemote, `${branch}:${branch}`]);
		return null;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		// A remote URL may carry a token; never copy it into the public log.
		return text.replaceAll(/https?:\/\/[^\s@]*@/g, 'https://***@').split('\n')[0].slice(0, 200);
	}
}
