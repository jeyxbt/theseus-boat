import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SITE_SLUG } from '../../src/core/site';

/**
 * On Windows, `claude` on PATH is a .cmd shim that can't be started without a
 * shell; the npm package ships a real executable next to it.
 */
function defaultClaudeCommand(env: NodeJS.ProcessEnv) {
	if (env.CLAUDE_CMD) return env.CLAUDE_CMD;
	if (process.platform === 'win32' && env.APPDATA) {
		const exe = join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
		if (existsSync(exe)) return exe;
	}
	return 'claude';
}

/**
 * preview: build and smoke-test the change on a spare port, commit it in the
 * runner, never touch the live site (the dry run).
 * local: also fast-forward the site's own repository to the new commit, check
 * the running dev server, and revert the commit if the site broke.
 * production: like local, for a server that runs a production build: after the
 * fast-forward the site is built and restarted, checked, and if it broke the
 * commit is reverted and the site rebuilt and restarted.
 */
export type DeployMode = 'preview' | 'local' | 'production';

/** Splits "pm2 reload theseus-web" into arguments. Quotes group words; there is no shell, so nothing else is special. */
export function splitCommand(text: string | undefined): string[] | null {
	if (!text || !text.trim()) return null;
	const parts: string[] = [];
	for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) parts.push(match[1] ?? match[2] ?? match[3]);
	return parts.length > 0 ? parts : null;
}

export type PipelineConfig = {
	/** The site's repository. The pipeline never edits it directly. */
	sourceDir: string;
	/** A separate clone where the AI works, so a running dev server never sees half a change. */
	runnerDir: string;
	deployMode: DeployMode;
	/**
	 * What runs the build agent. 'cli' is Claude Code, headless (a signed-in
	 * subscription on a laptop). 'sdk' is the Messages API with ANTHROPIC_API_KEY
	 * and the tools in sandbox.ts: the way to run on a server.
	 */
	agentRuntime: 'cli' | 'sdk';
	/** Effort of the 'sdk' agent. Higher costs more and thinks longer. */
	agentEffort: 'low' | 'medium' | 'high';
	/** Most model turns one 'sdk' run may take. */
	agentMaxTurns: number;
	/** Largest single reply of the 'sdk' agent, in tokens. */
	agentMaxOutputTokens: number;
	/** Command that runs Claude Code; the pipeline appends its own flags. */
	claudeCommand: string[];
	/** 'oauth' runs with --safe-mode (a logged-in subscription); 'api-key' with --bare. */
	claudeAuth: 'oauth' | 'api-key';
	model: string;
	implementTimeoutMs: number;
	repairTimeoutMs: number;
	maxRepairs: number;
	perRunBudgetUsd: number;
	installCommand: string[] | null;
	buildCommand: string[];
	startCommand: string[];
	buildTimeoutMs: number;
	healthTimeoutMs: number;
	heartbeatMs: number;
	botName: string;
	botEmail: string;
	/**
	 * 'required' opens the built site in a real browser and checks the essential
	 * parts (sign-in, navigation, countdown…); a missing browser fails the build.
	 * 'off' skips it on purpose.
	 */
	browserCheck: 'required' | 'off';
	/** The running site, checked after a change is applied in local mode. */
	liveUrl: string;
	/** How long the live site gets to pick up a change before a failing page counts. */
	liveSettleMs: number;
	/** Production mode: restarts the site on the new build, like ["pm2", "reload", "theseus-web"]. */
	restartCommand: string[] | null;
	/** Production mode: how long the restarted site gets to answer. */
	restartTimeoutMs: number;
	/** Push each shipped change (and each revert) to the remote. A failed push never fails the build. */
	pushAfterShip: boolean;
	pushRemote: string;
};

/** Why this configuration can't run, as a list; empty when it can. */
export function configProblems(config: PipelineConfig, env: NodeJS.ProcessEnv = process.env) {
	const problems: string[] = [];
	if (config.deployMode === 'production' && !config.restartCommand) {
		problems.push('DEPLOY_MODE=production needs RESTART_COMMAND, like "pm2 reload theseus-web", so the site picks up each build');
	}
	if (config.deployMode === 'production' && config.browserCheck === 'off') {
		problems.push('DEPLOY_MODE=production needs the browser check: remove BROWSER_CHECK=off');
	}
	if (config.agentRuntime === 'sdk' && !env.ANTHROPIC_API_KEY) problems.push('AGENT_RUNTIME=sdk needs ANTHROPIC_API_KEY');
	if (config.agentRuntime === 'cli' && config.claudeAuth === 'api-key' && !env.ANTHROPIC_API_KEY) {
		problems.push('CLAUDE_AUTH=api-key needs ANTHROPIC_API_KEY');
	}
	return problems;
}

const num = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && value !== undefined && value !== '' ? parsed : fallback;
};

export function pipelineConfig(env: NodeJS.ProcessEnv = process.env): PipelineConfig {
	const sourceDir = resolve(env.PIPELINE_SOURCE_DIR ?? process.cwd());
	const node = process.execPath;
	// pnpm sets npm_execpath to its own script when it runs us; use it without a shell.
	const pnpm = env.npm_execpath && /pnpm/i.test(env.npm_execpath) ? [node, env.npm_execpath] : null;
	return {
		sourceDir,
		// Outside the site's folder: the AI is denied reading anything in there.
		runnerDir: resolve(env.RUNNER_DIR ?? join(dirname(dirname(sourceDir)), 'pw-runner')),
		deployMode: env.DEPLOY_MODE === 'local' || env.DEPLOY_MODE === 'production' ? env.DEPLOY_MODE : 'preview',
		agentRuntime: env.AGENT_RUNTIME === 'sdk' ? 'sdk' : 'cli',
		agentEffort: env.AGENT_EFFORT === 'low' || env.AGENT_EFFORT === 'high' ? env.AGENT_EFFORT : 'medium',
		agentMaxTurns: num(env.AGENT_MAX_TURNS, 60),
		agentMaxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS, 32_000),
		claudeCommand: [defaultClaudeCommand(env)],
		claudeAuth: env.CLAUDE_AUTH === 'api-key' ? 'api-key' : 'oauth',
		model: env.CLAUDE_MODEL ?? 'claude-sonnet-5-5',
		implementTimeoutMs: num(env.ITERATE_TIMEOUT_MS, 15 * 60 * 1000),
		repairTimeoutMs: num(env.ITERATE_REPAIR_TIMEOUT_MS, 6 * 60 * 1000),
		maxRepairs: num(env.ITERATE_MAX_REPAIRS, 2),
		perRunBudgetUsd: num(env.PER_RUN_BUDGET_USD, 3),
		installCommand: pnpm ? [...pnpm, 'install', '--frozen-lockfile'] : null,
		buildCommand: [node, 'node_modules/astro/bin/astro.mjs', 'build'],
		startCommand: [node, 'dist/server/entry.mjs'],
		buildTimeoutMs: num(env.BUILD_TIMEOUT_MS, 5 * 60 * 1000),
		healthTimeoutMs: num(env.HEALTH_TIMEOUT_MS, 30 * 1000),
		heartbeatMs: num(env.HEARTBEAT_MS, 30 * 1000),
		botName: env.BOT_NAME ?? `${SITE_SLUG}-bot`,
		botEmail: env.BOT_EMAIL ?? `bot@${SITE_SLUG}.invalid`,
		browserCheck: env.BROWSER_CHECK === 'off' ? 'off' : 'required',
		liveUrl: (env.LIVE_URL ?? env.SITE_URL ?? 'http://127.0.0.1:4321').replace(/\/+$/, ''),
		liveSettleMs: num(env.LIVE_SETTLE_MS, 20 * 1000),
		restartCommand: splitCommand(env.RESTART_COMMAND),
		restartTimeoutMs: num(env.RESTART_TIMEOUT_MS, 60 * 1000),
		pushAfterShip: env.GIT_PUSH === '1' || env.GIT_PUSH === 'true',
		pushRemote: env.GIT_REMOTE || 'origin',
	};
}
