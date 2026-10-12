import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('builds');

const { run } = await import('../src/core/db/client.ts');
const { seedDemo } = await import('../src/core/db/seed.ts');
const { latestBuild, buildByCycle, listBuilds, shippedBuilds, buildEvents, stepStates, resultLabel } = await import(
	'../src/core/builds/queries.ts'
);
const { duration, pad3 } = await import('../src/core/format.ts');

describe('empty database', () => {
	test('no builds means null and empty lists, not errors', () => {
		assert.equal(latestBuild(), null);
		assert.deepEqual(listBuilds(), []);
		assert.equal(buildByCycle(1), null);
	});
});

describe('demo builds', () => {
	test('latest is the build in progress', () => {
		seedDemo();
		const build = latestBuild();
		assert.equal(build.cycle, 37);
		assert.equal(build.status, 'building');
		assert.equal(build.isDemo, true);
		assert.ok(Array.isArray(build.files) && build.files.length > 0);
	});

	test('lists newest first; shipped only has live builds', () => {
		const cycles = listBuilds().map((b) => b.cycle);
		assert.deepEqual(cycles, [...cycles].sort((a, b) => b - a));
		assert.ok(shippedBuilds().every((b) => b.status === 'live'));
	});

	test('events come back in order', () => {
		const events = buildEvents(buildByCycle(35).id);
		assert.equal(events[0].tag, 'window');
		assert.equal(events.at(-1).tag, 'live');
	});

	test('a broken files column does not break the page', () => {
		run("UPDATE builds SET files = 'not json' WHERE cycle = 36");
		assert.deepEqual(buildByCycle(36).files, []);
	});
});

describe('step states', () => {
	const tags = (...list) => list;

	test('in progress: done up to the current step, which is active', () => {
		assert.deepEqual(stepStates('building', tags('window', 'winner', 'ai', 'checks', 'build')), [
			'done',
			'done',
			'done',
			'done',
			'active',
			'waiting',
		]);
	});

	test('live: everything done', () => {
		assert.deepEqual(stepStates('live', tags('window', 'live')), Array(6).fill('done'));
	});

	test('rolled back: the step it stopped at is failed', () => {
		assert.deepEqual(stepStates('rolled_back', tags('window', 'winner', 'ai', 'checks', 'build', 'rollback')), [
			'done',
			'done',
			'done',
			'done',
			'failed',
			'waiting',
		]);
	});

	test('no events yet: first step not started', () => {
		assert.deepEqual(stepStates('building', []), Array(6).fill('waiting'));
	});
});

describe('labels', () => {
	test('result labels include the note', () => {
		assert.equal(resultLabel({ status: 'live', note: null }), 'Live');
		assert.equal(resultLabel({ status: 'live', note: 'fixed on 2nd try' }), 'Live · fixed on 2nd try');
		assert.equal(resultLabel({ status: 'rolled_back', note: 'build failed' }), 'Rolled back · build failed');
	});

	test('a dry run is never labelled Live, and never counts as shipped', () => {
		assert.equal(resultLabel({ status: 'live', note: null, dryRun: true }), 'Dry run passed');
		assert.equal(resultLabel({ status: 'live', note: 'dry run', dryRun: true }), 'Dry run passed');
		assert.equal(resultLabel({ status: 'live', note: 'simulated', dryRun: true }), 'Simulated');
		assert.equal(resultLabel({ status: 'failed', note: 'build failed', dryRun: true }), 'Failed · build failed');
		run("UPDATE builds SET dry_run = 1 WHERE cycle = 36");
		assert.ok(!shippedBuilds().some((b) => b.cycle === 36));
		assert.equal(buildByCycle(36).dryRun, true);
	});

	test('formatting', () => {
		assert.equal(pad3(7), '007');
		assert.equal(duration(347_000), '5m 47s');
		assert.equal(duration(25 * 3600_000 + 10 * 60_000), '25h 10m');
	});
});
