/**
 * Plays a fake build for the next queued winner, writing to the database the
 * same way the real pipeline will, so /build can be watched live before the AI
 * is connected. Nothing in the site's code changes. `--fail` ends in a rollback.
 *
 *   pnpm build:simulate [--fail]
 */
import { appendEvent, countRepair, createBuild, finishBuild, nextWinnerToBuild } from '../src/core/builds/writes';
import { closeDb, run } from '../src/core/db/client';

const fail = process.argv.includes('--fail');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const winner = nextWinnerToBuild();
if (!winner) {
	console.error('No winner is waiting to be built. Close a window that has a winner first (pnpm cycle:close).');
	process.exit(1);
}

const buildId = createBuild({ ...winner, cycle: winner.number, previousSha: null });
if (!buildId) {
	console.error(`Cycle ${winner.number} already has a build.`);
	process.exit(1);
}
run("UPDATE builds SET note = 'simulated' WHERE id = ?", buildId);
console.log(`Simulating cycle ${winner.number}: "${winner.ideaText}" — watch http://127.0.0.1:4321/build`);

const files = ['src/components/Simulated.astro', 'src/pages/index.astro'];
const steps: [tag: string, message: string, waitMs: number][] = [
	['window', `closed · winner had ${winner.votes} votes`, 1500],
	['winner', `“${winner.ideaText}”`, 2000],
	['ai', 'reading the site, planning the change (simulated)', 3000],
	['ai', `wrote ${files[0]} (+96)`, 2500],
	['ai', `edited ${files[1]} (+4 −1)`, 2000],
	['checks', 'allowed paths ✓  no outside requests ✓  no secrets ✓', 1500],
	['checks', 'size 101 lines ✓', 1500],
	['build', 'compiling…', 3000],
];

for (const [tag, message, wait] of steps) {
	appendEvent(buildId, tag, message);
	await sleep(wait);
}

if (fail) {
	appendEvent(buildId, 'build', 'failed · simulated type error');
	countRepair(buildId);
	await sleep(1500);
	appendEvent(buildId, 'repair', 'attempt 1 · failed (simulated)');
	await sleep(2000);
	appendEvent(buildId, 'rollback', 'site restored to the last working version');
	finishBuild(buildId, { status: 'rolled_back', note: 'simulated failure', dryRun: true });
	console.log('Simulated build rolled back.');
} else {
	const sha = Math.random().toString(16).slice(2, 9);
	appendEvent(buildId, 'build', 'restarted · health check 200 ✓');
	await sleep(1500);
	appendEvent(buildId, 'smoke', '/, /ideas, /changelog respond ✓');
	await sleep(1500);
	appendEvent(buildId, 'git', `committed ${sha} (simulated, not pushed)`);
	await sleep(1000);
	appendEvent(buildId, 'live', `cycle ${String(winner.number).padStart(3, '0')} shipped`);
	// Never applied to the site: flagged like a dry run, so it never counts as built.
	finishBuild(buildId, { status: 'live', note: 'simulated', commitSha: sha, linesAdded: 100, linesRemoved: 1, files, dryRun: true });
	console.log(`Simulated build is live (${sha}).`);
}

closeDb();
