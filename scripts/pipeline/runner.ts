import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb } from '../../src/core/db/client';
import type { PipelineConfig } from './config';
import { run } from './proc';

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
	return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
		cwd,
		env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/** Throws away everything the AI did in the runner, including ignored files it may have hidden in src/ or public/. */
export function discardChanges(runnerDir: string) {
	git(runnerDir, ['reset', '--hard', '--quiet', 'HEAD']);
	git(runnerDir, ['clean', '-fd', '--quiet']);
	git(runnerDir, ['clean', '-fdx', '--quiet', '--', 'src', 'public']);
}

const LOCK_HASH = '.iterate-lockhash';

/**
 * Brings the runner clone to the site's latest commit, with no leftovers, and
 * installs dependencies when the lockfile changed. Returns the commit it starts from.
 */
export async function prepareRunner(config: PipelineConfig, log: (message: string) => void) {
	const { runnerDir, sourceDir } = config;
	if (!existsSync(join(runnerDir, '.git'))) {
		// Windows refuses mkdir on a drive root (E:\) even when it exists.
		if (!existsSync(dirname(runnerDir))) mkdirSync(dirname(runnerDir), { recursive: true });
		execFileSync('git', ['clone', '--quiet', sourceDir, runnerDir], { stdio: ['ignore', 'pipe', 'pipe'] });
		log(`created the runner clone at ${runnerDir}`);
	}

	const branch = git(sourceDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
	git(runnerDir, ['fetch', '--quiet', 'origin']);
	git(runnerDir, ['checkout', '--quiet', '--force', '-B', branch, `origin/${branch}`]);
	discardChanges(runnerDir);

	if (config.installCommand) {
		const lockfile = join(runnerDir, 'pnpm-lock.yaml');
		const hash = existsSync(lockfile) ? createHash('sha256').update(readFileSync(lockfile)).digest('hex') : 'none';
		const stamp = join(runnerDir, LOCK_HASH);
		const installed = existsSync(join(runnerDir, 'node_modules')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash;
		if (!installed) {
			log('installing dependencies');
			const result = await run(config.installCommand, { cwd: runnerDir, timeoutMs: 10 * 60 * 1000 });
			if (result.code !== 0) throw new Error(`install failed:\n${result.output.slice(-2000)}`);
			writeFileSync(stamp, hash);
		}
	}

	return git(runnerDir, ['rev-parse', 'HEAD']).trim();
}

/** A copy of the live database for the preview server, so smoke tests never write to the real one. */
export function snapshotDatabase(target: string) {
	mkdirSync(dirname(target), { recursive: true });
	rmSync(target, { force: true });
	getDb().exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
}
