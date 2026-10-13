import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('build-writes');

const { get, run, nowIso } = await import('../src/core/db/client.ts');
const { closeWindowNow } = await import('../src/core/cycle/windows.ts');
const { submitIdea } = await import('../src/core/ideas/queries.ts');
const { toggleVote } = await import('../src/core/votes/queries.ts');
const writes = await import('../src/core/builds/writes.ts');
const { buildById, buildEvents, eventsSince, isStale, STALE_AFTER_MS } = await import('../src/core/builds/queries.ts');
const { listCycles } = await import('../src/core/cycle/history.ts');

let counter = 0;
function makeUser() {
	counter++;
	return get(
		"INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', ?, ?, ?) RETURNING id",
		`b${counter}`,
		`builder${counter}`,
		nowIso(),
	).id;
}

/** A closed window whose winner is waiting for a build. */
function queuedWinner(words) {
	const idea = submitIdea(makeUser(), `Build ${words} for every visitor`).idea;
	for (let i = 0; i < 3; i++) toggleVote(makeUser(), idea.id);
	closeWindowNow();
	return idea;
}

describe('the build queue', () => {
	test('nothing to build at first', () => {
		assert.equal(writes.nextWinnerToBuild(), null);
	});

	test('a closed window with a winner is next in line, oldest first', () => {
		const first = queuedWinner('zqa zqb zqc');
		const second = queuedWinner('zqd zqe zqf');
		assert.equal(writes.nextWinnerToBuild().ideaId, first.id);

		const next = writes.nextWinnerToBuild();
		const id = writes.createBuild({ ...next, cycle: next.number, previousSha: 'abc1234' });
		assert.ok(id);
		assert.equal(writes.nextWinnerToBuild().ideaId, second.id);
	});

	test('one build per window', () => {
		const next = writes.nextWinnerToBuild();
		assert.ok(writes.createBuild({ ...next, cycle: next.number, previousSha: null }));
		assert.equal(writes.createBuild({ ...next, cycle: next.number, previousSha: null }), null);
	});

	test('a window without a winner is never queued', () => {
		closeWindowNow();
		assert.equal(writes.nextWinnerToBuild(), null);
	});
});

describe('the log', () => {
	test('lines are one line, capped, and count as a heartbeat', () => {
		const idea = queuedWinner('zqg zqh zqi');
		const next = writes.nextWinnerToBuild();
		const id = writes.createBuild({ ...next, cycle: next.number, previousSha: null });
		run("UPDATE builds SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", id);

		writes.appendEvent(id, 'ai', `line one\nline two\u0000 ${'x'.repeat(900)}`);
		const [event] = buildEvents(id);
		assert.equal(event.tag, 'ai');
		assert.ok(!event.message.includes('\n'));
		assert.ok(event.message.length <= 500);
		assert.ok(event.message.endsWith('…'));
		assert.notEqual(buildById(id).heartbeatAt, '2000-01-01T00:00:00.000Z');
		assert.equal(buildById(id).ideaId, idea.id);
	});

	test('eventsSince returns only newer lines, in order', () => {
		const next = (() => {
			queuedWinner('zqj zqk zql');
			return writes.nextWinnerToBuild();
		})();
		const id = writes.createBuild({ ...next, cycle: next.number, previousSha: null });
		for (const n of [1, 2, 3]) writes.appendEvent(id, 'build', `step ${n}`);
		const all = buildEvents(id);
		assert.deepEqual(
			eventsSince(id, all[0].id).map((e) => e.message),
			['step 2', 'step 3'],
		);
	});
});

describe('finishing', () => {
	test('a live build records its result and shows in the changelog', () => {
		queuedWinner('zqm zqn zqo');
		const next = writes.nextWinnerToBuild();
		const id = writes.createBuild({ ...next, cycle: next.number, previousSha: null });
		writes.countRepair(id);
		writes.finishBuild(id, { status: 'live', commitSha: 'deadbee', linesAdded: 10, linesRemoved: 2, files: ['src/pages/x.astro'] });

		const build = buildById(id);
		assert.equal(build.status, 'live');
		assert.equal(build.repairs, 1);
		assert.deepEqual(build.files, ['src/pages/x.astro']);
		assert.ok(build.finishedAt);

		const entry = listCycles().find((e) => e.cycle === next.number);
		assert.equal(entry.status, 'live');
		assert.equal(entry.hasBuild, true);
	});
});

describe('spend', () => {
	test('each call is recorded and added to the build; the month total adds up', () => {
		queuedWinner('zqp zqq zqr');
		const next = writes.nextWinnerToBuild();
		const id = writes.createBuild({ ...next, cycle: next.number, previousSha: null });
		const before = writes.spentThisMonth();
		writes.recordSpend({ kind: 'implement', model: 'claude-sonnet-5-5', costUsd: 0.42, buildId: id, windowId: next.windowId });
		writes.recordSpend({ kind: 'repair', model: 'claude-sonnet-5-5', costUsd: 0.08, buildId: id });
		writes.recordSpend({ kind: 'moderation', model: 'claude-haiku-5-5', costUsd: -5 });
		assert.ok(Math.abs(buildById(id).costUsd - 0.5) < 1e-9);
		assert.ok(Math.abs(writes.spentThisMonth() - before - 0.5) < 1e-9, 'negative cost is recorded as 0');
	});
});

describe('stale builds', () => {
	test('a running build that stopped reporting is stale; a recent or a finished one never is', () => {
		const now = Date.now();
		const old = new Date(now - STALE_AFTER_MS - 1000).toISOString();
		const fresh = new Date(now - 1000).toISOString();
		assert.equal(isStale({ status: 'building', heartbeatAt: old, startedAt: old }, now), true);
		assert.equal(isStale({ status: 'repairing', heartbeatAt: fresh, startedAt: old }, now), false);
		assert.equal(isStale({ status: 'live', heartbeatAt: old, startedAt: old }, now), false);
	});
});
