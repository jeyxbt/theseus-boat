/**
 * Local mode: the change that passed every check in the runner is applied to
 * the site's own repository, where the dev server picks it up. Then the live
 * site is checked like the preview was; if it broke, the commit is reverted
 * with a new commit, so the history shows both.
 */
import { checkRoutes, collectionsFor, siteRoutes, type Failure } from './deploy';
import type { PipelineConfig } from './config';
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

/** Checks the live site, retrying for a while: the dev server needs a moment to reload. */
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
