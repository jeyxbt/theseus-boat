/**
 * Keeps the cycle going without anyone at the keyboard: every CYCLE_POLL_MS
 * (30 s) it closes a window that is due and builds the winner, one at a time.
 * Run it next to the site:
 *
 *   pnpm dev            # the site
 *   pnpm cycle:daemon   # this
 *
 * Ctrl+C once waits for a build in progress to finish; twice stops at once (the
 * next start closes the unfinished build as interrupted).
 */
import { closeDb } from '../src/core/db/client';
import { configProblems, pipelineConfig } from './pipeline/config';
import { runCycle, type CycleOutcome } from './pipeline/iterate';

const config = pipelineConfig();
const problems = configProblems(config);
if (problems.length > 0) {
	for (const problem of problems) console.error(`Configuration problem: ${problem}`);
	process.exit(2);
}
const pollMs = Math.max(5_000, Number(process.env.CYCLE_POLL_MS) || 30_000);
const MAX_BACKOFF_MS = 10 * 60 * 1000;

let stopping = false;
let building = false;

const stamp = () => new Date().toLocaleTimeString('en-GB');
const say = (line: string) => console.log(`${stamp()}  ${line}`);

function stop() {
	if (stopping || !building) {
		say('Stopped.');
		closeDb();
		process.exit(0);
	}
	stopping = true;
	say('Stopping after the build in progress. Press Ctrl+C again to stop now.');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describe(outcome: CycleOutcome) {
	switch (outcome.status) {
		case 'live':
			return `build ${outcome.buildId} ${config.deployMode === 'preview' ? 'passed the dry run' : 'is live'} (${outcome.commitSha})`;
		case 'skipped':
			return `winner skipped: ${outcome.reason}`;
		case 'failed':
			return `build ${outcome.buildId} failed: ${outcome.reason.split('\n')[0]}`;
		case 'rolled_back':
			return `build ${outcome.buildId} rolled back: ${outcome.reason}`;
		default:
			return outcome.status;
	}
}

say(`Cycle daemon: ${config.deployMode} mode, checking every ${pollMs / 1000} s. Runner ${config.runnerDir}.`);
say(`The agent runs on ${config.agentRuntime === 'sdk' ? `the Anthropic API (${config.model})` : `Claude Code (${config.model})`}.`);
if (config.deployMode !== 'preview') {
	say(`Changes go into ${config.sourceDir} and are checked on ${config.liveUrl}${config.deployMode === 'production' ? ' after a rebuild and restart' : ''}.`);
	if (config.pushAfterShip) say(`Every shipped change is pushed to ${config.pushRemote}.`);
}

let failures = 0;
while (!stopping) {
	let outcome: CycleOutcome | null = null;
	building = true;
	try {
		outcome = await runCycle(config, { print: (line) => line !== 'Nothing to build.' && say(line) });
		failures = 0;
	} catch (error) {
		failures++;
		say(`The run stopped with an error: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		building = false;
	}
	if (stopping) break;

	if (outcome && outcome.status !== 'idle' && outcome.status !== 'busy') {
		say(describe(outcome));
		// There may be another winner waiting: look again straight away.
		continue;
	}
	// Errors back off, so a broken setup doesn't retry every few seconds.
	await sleep(failures > 0 ? Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS) : pollMs);
}

say('Stopped.');
closeDb();
process.exit(0);
