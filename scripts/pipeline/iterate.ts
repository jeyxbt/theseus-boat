/**
 * One run of the build pipeline: close a due window, take the oldest winner
 * waiting for a build, have the AI implement it in the runner clone, check the
 * diff, build and smoke-test it, give the AI up to two tries to repair a broken
 * build, and commit the result. Every step lands in the public build log.
 *
 * In preview mode (the dry run) nothing reaches the live site: the commit stays
 * in the runner. In local mode it is applied to the site's own repository and
 * the running dev server is checked. In production mode it is applied, built,
 * the site restarted and checked in a browser. A change that breaks the live
 * site is reverted. With GIT_PUSH=1 every shipped change and revert is pushed.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { builtIdeas, shippedBuilds } from '../../src/core/builds/queries';
import {
	appendEvent,
	countRepair,
	createBuild,
	failInterruptedBuilds,
	finishBuild,
	heartbeat,
	nextWinnerToBuild,
	recordSpend,
	spentThisMonth,
} from '../../src/core/builds/writes';
import { skipWinner, tickWindows } from '../../src/core/cycle/windows';
import { findDuplicate } from '../../src/core/ideas/similarity';
import { reviewIdea } from '../../src/core/moderation/index';
import { getNumberSetting, getSetting } from '../../src/core/settings';
import { runAgent, type AgentResult } from './agent';
import type { PipelineConfig } from './config';
import { buildAndSmoke, type Failure } from './deploy';
import { reviewWorkingTree, secretValuesFrom } from './guards';
import { acquireLock } from './lock';
import { buildPrompt, commitMessage, repairPrompt, type Winner } from './prompt';
import { applyToSite, checkLive, liveState, publishProduction, pushSite, revertOnSite } from './release';
import { discardChanges, git, prepareRunner, snapshotDatabase } from './runner';

type SkipReason = 'paused' | 'already_built' | 'budget' | 'final_gate' | 'moderation_unavailable';

export type CycleOutcome =
	| { status: 'busy' }
	| { status: 'idle' }
	| { status: 'skipped'; windowId: number; reason: SkipReason }
	| { status: 'failed'; buildId: number; reason: string }
	| { status: 'rolled_back'; buildId: number; reason: string }
	| { status: 'live'; buildId: number; commitSha: string; repairs: number };

const CORE_PAGES = new Set(['ideas', 'build', 'changelog', 'rules', 'privacy', 'signin', '404', '500']);

/** Pages the AI may work on, for the prompt. */
function aiPages(runnerDir: string) {
	const pagesDir = join(runnerDir, 'src', 'pages');
	if (!existsSync(pagesDir)) return [];
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const rel = relative(join(runnerDir), full).replaceAll('\\', '/');
			if (entry.isDirectory()) {
				if (!rel.startsWith('src/pages/api') && !CORE_PAGES.has(entry.name)) walk(full);
			} else if (entry.name.endsWith('.astro') && !CORE_PAGES.has(entry.name.replace(/\.astro$/, ''))) {
				found.push(rel);
			}
		}
	};
	walk(pagesDir);
	return found.sort();
}

/** Next to the runner, not inside it: the runner may not exist yet, and a clone needs an empty folder. */
function lockPath(config: PipelineConfig) {
	return `${config.runnerDir}.lock`;
}

export async function runCycle(config: PipelineConfig, options: { now?: () => number; print?: (line: string) => void } = {}): Promise<CycleOutcome> {
	const print = options.print ?? ((line: string) => console.log(line));
	const lock = acquireLock(lockPath(config), config.heartbeatMs);
	if (!lock) {
		print('Another run holds the lock.');
		return { status: 'busy' };
	}

	try {
		// Holding the lock means no other run is building: anything still "building" that has gone quiet died with its process.
		const interrupted = failInterruptedBuilds(Math.max(3 * config.heartbeatMs, 2 * 60 * 1000));
		if (interrupted > 0) print(`Closed ${interrupted} build(s) left unfinished by a stopped run.`);

		tickWindows(options.now?.() ?? Date.now());
		const next = nextWinnerToBuild();
		if (!next) {
			print('Nothing to build.');
			return { status: 'idle' };
		}
		const winner: Winner = { ...next };

		if (getSetting('paused') === '1') {
			skipWinner(winner.windowId, 'paused');
			print(`Cycle ${winner.number} skipped: paused.`);
			return { status: 'skipped', windowId: winner.windowId, reason: 'paused' };
		}
		// Two windows can pick the same idea while the first is still being built.
		const built = findDuplicate(
			winner.ideaText,
			builtIdeas().map((build) => ({ id: build.cycle, body: build.ideaText })),
		);
		if (built) {
			skipWinner(winner.windowId, 'already_built');
			print(`Cycle ${winner.number} skipped: already built in cycle ${built.id}.`);
			return { status: 'skipped', windowId: winner.windowId, reason: 'already_built' };
		}
		const cap = getNumberSetting('monthly_cap_usd', 75);
		const left = cap - spentThisMonth();
		if (left < config.perRunBudgetUsd) {
			skipWinner(winner.windowId, 'budget');
			print(`Cycle ${winner.number} skipped: $${left.toFixed(2)} left of the $${cap} monthly cap.`);
			return { status: 'skipped', windowId: winner.windowId, reason: 'budget' };
		}

		// The last check before code gets written: fail-closed, no answer means no build.
		const gate = await reviewIdea(winner.ideaText, 'final');
		if (gate.model !== 'off') {
			recordSpend({ kind: 'final_gate', model: gate.model, costUsd: gate.costUsd, windowId: winner.windowId });
		}
		if (gate.status !== 'allow') {
			const reason = gate.status === 'reject' ? 'final_gate' : 'moderation_unavailable';
			skipWinner(winner.windowId, reason);
			print(`Cycle ${winner.number} skipped: ${gate.status === 'reject' ? `refused by the final check (${gate.category})` : `final check unavailable (${gate.error})`}.`);
			return { status: 'skipped', windowId: winner.windowId, reason };
		}

		return await build(config, winner, Math.min(config.perRunBudgetUsd, left), lock.beat, print);
	} finally {
		lock.release();
	}
}

async function build(
	config: PipelineConfig,
	winner: Winner,
	budgetUsd: number,
	beatLock: () => void,
	print: (line: string) => void,
): Promise<CycleOutcome> {
	const previousSha = await prepareRunner(config, (message) => print(message));
	const buildId = createBuild({ ...winner, cycle: winner.number, previousSha });
	if (!buildId) throw new Error(`cycle ${winner.number} already has a build`);

	const log = (tag: string, message: string) => {
		appendEvent(buildId, tag, message);
		print(`[${tag}] ${message}`);
	};
	// Proof of life for the lock and for /build while long steps run quietly.
	const timer = setInterval(() => {
		heartbeat(buildId);
		beatLock();
	}, config.heartbeatMs);

	try {
		log('window', `cycle ${String(winner.number).padStart(3, '0')} closed · winner had ${winner.votes} votes`);
		log('winner', `“${winner.ideaText}”`);
		snapshotDatabase(join(config.runnerDir, 'data', 'preview.db'));

		const site = { pages: aiPages(config.runnerDir), built: shippedBuilds(30).map((b) => b.ideaText) };
		let spent = 0;
		const agent = async (prompt: string, timeoutMs: number, kind: 'implement' | 'repair') => {
			const result: AgentResult = await runAgent({
				config,
				cwd: config.runnerDir,
				prompt,
				timeoutMs,
				maxBudgetUsd: Math.max(0.01, budgetUsd - spent),
				onEvent: (message) => log('ai', message),
			});
			spent += result.costUsd;
			recordSpend({
				kind,
				model: config.model,
				costUsd: result.costUsd,
				buildId,
				windowId: winner.windowId,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				numTurns: result.numTurns,
				durationMs: result.durationMs,
			});
			return result;
		};

		const fail = (reason: string, note: string, error?: string): CycleOutcome => {
			discardChanges(config.runnerDir);
			log('failed', reason);
			finishBuild(buildId, { status: 'failed', note, error: error ?? reason });
			return { status: 'failed', buildId, reason };
		};

		log('ai', 'reading the site, planning the change');
		const first = await agent(buildPrompt(winner, site), config.implementTimeoutMs, 'implement');
		if (!first.ok) return fail(`the AI did not finish: ${first.error}`, 'AI did not finish', first.output.slice(-2000));

		const secrets = secretValuesFrom(process.env);
		const check = () => {
			const review = reviewWorkingTree(config.runnerDir, secrets);
			if (review.ok && review.files.length === 0) return { ok: false, problems: ['no changes were made'], review };
			return { ok: review.ok, problems: review.problems, review };
		};

		let checked = check();
		if (!checked.ok) {
			for (const problem of checked.problems.slice(0, 5)) log('guard', `✗ ${problem}`);
			return fail('refused by the safety checks', 'refused by safety checks', checked.problems.join('\n'));
		}
		log('checks', `allowed paths ✓  no outside requests ✓  no secrets ✓  ${checked.review.added + checked.review.removed} lines ✓`);

		let repairs = 0;
		let failure: Failure | null = await buildAndSmoke(config, config.runnerDir, checked.review.files, log);
		while (failure && repairs < config.maxRepairs) {
			repairs++;
			countRepair(buildId);
			log('repair', `attempt ${repairs} · ${failure.reason}`);
			const fix = await agent(repairPrompt(winner, site, failure), config.repairTimeoutMs, 'repair');
			if (!fix.ok) {
				failure = { reason: `the repair did not finish: ${fix.error}`, details: fix.output.slice(-2000) };
				break;
			}
			checked = check();
			if (!checked.ok) {
				for (const problem of checked.problems.slice(0, 5)) log('guard', `✗ ${problem}`);
				return fail('the repair was refused by the safety checks', 'refused by safety checks', checked.problems.join('\n'));
			}
			failure = await buildAndSmoke(config, config.runnerDir, checked.review.files, log);
		}
		if (failure) return fail(failure.reason, 'build failed', failure.details);

		const review = checked.review;
		const roots = ['src', 'public'].filter((dir) => existsSync(join(config.runnerDir, dir)));
		git(config.runnerDir, ['add', '-A', '--', ...roots]);
		const env = {
			...process.env,
			GIT_AUTHOR_NAME: config.botName,
			GIT_AUTHOR_EMAIL: config.botEmail,
			GIT_COMMITTER_NAME: config.botName,
			GIT_COMMITTER_EMAIL: config.botEmail,
		};
		git(config.runnerDir, ['commit', '--quiet', '-m', commitMessage(winner, repairs)], env);
		const sha = git(config.runnerDir, ['rev-parse', '--short=7', 'HEAD']).trim();

		const dryRun = config.deployMode === 'preview';
		const changed = { commitSha: sha, linesAdded: review.added, linesRemoved: review.removed, files: review.files };
		log('git', `committed ${sha}${dryRun ? ' (dry run: not deployed, not pushed)' : ''}`);
		if (!dryRun) {
			try {
				applyToSite(config);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log('failed', 'could not apply the change to the site (local changes in the way?)');
				finishBuild(buildId, { status: 'failed', note: 'not applied', error: message, ...changed });
				return { status: 'failed', buildId, reason: message };
			}
			log('deploy', 'applied to the site');

			if (config.deployMode === 'production') {
				// A production build serves the old code until it is rebuilt and restarted: do both, then look.
				const broken = await publishProduction(config, review.files, log);
				if (broken) return rollBack(config, buildId, winner, sha, broken, changed, env, log);
				log('smoke', 'the live site works ✓ (restarted, checked in a browser)');
			} else {
				const state = await liveState(config.liveUrl);
				if (state === 'down') {
					log('deploy', `nothing answers at ${config.liveUrl}: the change shows when the site starts`);
				} else if (state === 'production') {
					log('deploy', `${config.liveUrl} runs a production build: rebuild and restart it to show the change`);
				} else {
					const broken = await checkLive(config, review.files);
					if (broken) return rollBack(config, buildId, winner, sha, broken, changed, env, log);
					log('smoke', 'the live site works ✓');
				}
			}
			pushIfAsked(config, sha, log);
		}
		log('live', `cycle ${String(winner.number).padStart(3, '0')} ${dryRun ? 'passed the dry run' : 'shipped'}`);
		finishBuild(buildId, {
			status: 'live',
			note: repairs > 0 ? `fixed on try ${repairs + 1}` : null,
			dryRun,
			...changed,
		});
		return { status: 'live', buildId, commitSha: sha, repairs };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			discardChanges(config.runnerDir);
		} catch {
			// The runner may be unusable; the next run re-creates its state.
		}
		appendEvent(buildId, 'failed', 'the pipeline stopped with an internal error');
		finishBuild(buildId, { status: 'failed', note: 'internal error', error: message });
		return { status: 'failed', buildId, reason: message };
	} finally {
		clearInterval(timer);
	}
}

/** The change broke the running site: undo it with a revert commit and check the site again. */
async function rollBack(
	config: PipelineConfig,
	buildId: number,
	winner: Winner,
	sha: string,
	broken: Failure,
	changed: { commitSha: string; linesAdded: number; linesRemoved: number; files: string[] },
	env: NodeJS.ProcessEnv,
	log: (tag: string, message: string) => void,
): Promise<CycleOutcome> {
	log('rollback', `${broken.reason} on the live site · rolling back`);
	try {
		const revert = revertOnSite(config, sha, winner.number, broken.reason, env);
		log('rollback', `reverted in ${revert}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log('failed', 'could not roll back by itself: the site needs a person');
		finishBuild(buildId, { status: 'failed', note: 'rollback failed', error: `${broken.reason}\n${message}`, ...changed });
		return { status: 'failed', buildId, reason: `rollback failed: ${message}` };
	}
	// The old code has to be built and running again, not just back in the files.
	const after = config.deployMode === 'production' ? await publishProduction(config, [], log) : await checkLive(config, []);
	log('rollback', after ? `the site still fails after the rollback: ${after.reason}` : 'the site works again ✓');
	if (after && config.deployMode === 'production') {
		// A site that is down after its own rollback needs a person: say so, don't call it rolled back.
		log('failed', 'the site is not working: it needs a person');
		finishBuild(buildId, { status: 'failed', note: 'site down after rollback', error: `${broken.reason}\n${after.reason}\n${after.details}`, ...changed });
		return { status: 'failed', buildId, reason: `the site is down after the rollback: ${after.reason}` };
	}
	pushIfAsked(config, changed.commitSha, log);
	finishBuild(buildId, {
		status: 'rolled_back',
		note: 'broke the live site',
		error: `${broken.reason}\n${broken.details}`,
		...changed,
	});
	return { status: 'rolled_back', buildId, reason: broken.reason };
}

/** Sends the site's history to the remote when that is switched on. The log says whether it worked. */
function pushIfAsked(config: PipelineConfig, sha: string, log: (tag: string, message: string) => void) {
	if (!config.pushAfterShip) return;
	const failed = pushSite(config);
	log('git', failed ? `could not push to ${config.pushRemote}: ${failed}` : `pushed to ${config.pushRemote} (${sha})`);
}
