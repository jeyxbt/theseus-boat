import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('builds');

const { run, get, nowIso } = await import('../src/core/db/client.ts');
const { latestBuild, buildByCycle, listBuilds, shippedBuilds, buildEvents, stepStates, resultLabel } = await import(
	'../src/core/builds/queries.ts'
);
const { duration, pad3 } = await import('../src/core/format.ts');

/** A build row with its log, recorded straight into the table. */
function addBuild({ cycle, status = 'live', note = null, dryRun = 0, files = '[]', events = [] }) {
	const { id } = get(
		`INSERT INTO builds (cycle, idea_text, author_handle, status, note, dry_run, files, started_at)
		 VALUES (?, ?, 'someone', ?, ?, ?, ?, ?) RETURNING id`,
		cycle,
		`Idea number ${cycle}`,
		status,
		note,
		dryRun,
		files,
		nowIso(),
	);
	events.forEach((tag, index) => run('INSERT INTO build_events (build_id, ts, tag, message) VALUES (?, ?, ?, ?)', id, nowIso(), tag, `step ${index}`));
	return id;
}

describe('empty database', () => {
	test('no builds means null and empty lists, not errors', () => {
		assert.equal(latestBuild(), null);
		assert.deepEqual(listBuilds(), []);
		assert.equal(buildByCycle(1), null);
		assert.deepEqual(shippedBuilds(), []);
	});
});

describe('reading builds', () => {
	test('latest is the highest cycle, and the list is newest first', () => {
		addBuild({ cycle: 1, events: ['window', 'winner', 'live'] });
		addBuild({ cycle: 3, status: 'building', events: ['window'] });
		addBuild({ cycle: 2, status: 'rolled_back', note: 'build failed' });
		assert.equal(latestBuild().cycle, 3);
		assert.deepEqual(listBuilds().map((b) => b.cycle), [3, 2, 1]);
	});

	test('shipped only has live builds that were really applied', () => {
		addBuild({ cycle: 4, dryRun: 1, note: 'dry run' });
		addBuild({ cycle: 5 });
		assert.deepEqual(shippedBuilds().map((b) => b.cycle), [5, 1]);
	});

	test('events come back in order', () => {
		const events = buildEvents(buildByCycle(1).id);
		assert.deepEqual(events.map((e) => e.tag), ['window', 'winner', 'live']);
	});

	test('files come back as a list, and a broken files column does not break the page', () => {
		addBuild({ cycle: 6, files: '["src/pages/garden.astro"]' });
		assert.deepEqual(buildByCycle(6).files, ['src/pages/garden.astro']);
		run("UPDATE builds SET files = 'not json' WHERE cycle = 6");
		assert.deepEqual(buildByCycle(6).files, []);
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
		assert.equal(resultLabel({ status: 'failed', note: 'build failed', dryRun: true }), 'Failed · build failed');
		assert.equal(buildByCycle(4).dryRun, true);
		assert.ok(!shippedBuilds().some((b) => b.cycle === 4));
	});

	test('formatting', () => {
		assert.equal(pad3(7), '007');
		assert.equal(duration(347_000), '5m 47s');
		assert.equal(duration(25 * 3600_000 + 10 * 60_000), '25h 10m');
	});
});
