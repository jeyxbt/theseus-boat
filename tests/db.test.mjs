import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('db');

const { getDb, get, all, run, nowIso } = await import('../src/core/db/client.ts');
const { default: sqliteSessions } = await import('../src/core/db/session-driver.ts');
const { sweep } = await import('../src/core/db/maintenance.ts');
const { seedDemo } = await import('../src/core/db/seed.ts');
const { currentWindow } = await import('../src/core/cycle/windows.ts');

const castVote = (userId, ideaId) =>
	run(
		'INSERT INTO votes (user_id, idea_id, window_id, created_at) SELECT ?, id, window_id, ? FROM ideas WHERE id = ?',
		userId,
		nowIso(),
		ideaId,
	);

let counter = 0;
function makeUser(provider = 'dev') {
	counter++;
	return get(
		`INSERT INTO users (provider, provider_id, handle, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
		provider,
		`t${counter}`,
		`user${counter}`,
		nowIso(),
	).id;
}

function makeIdea(userId, body = 'A perfectly reasonable idea for the site', status = 'open') {
	return get(
		`INSERT INTO ideas (user_id, window_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
		userId,
		currentWindow().id,
		body,
		status,
		nowIso(),
		nowIso(),
	).id;
}

describe('database setup', () => {
	test('uses WAL and enforces foreign keys', () => {
		const db = getDb();
		assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
		assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
	});

	test('creates every table', () => {
		const names = all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
		for (const table of ['users', 'sessions', 'ideas', 'votes', 'builds', 'build_events']) {
			assert.ok(names.includes(table), `missing table ${table}`);
		}
	});
});

describe('constraints', () => {
	test('rejects unknown sign-in providers', () => {
		assert.throws(() =>
			run(
				"INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('facebook', '1', 'x', ?)",
				nowIso(),
			),
		);
	});

	test('one account per provider id', () => {
		run("INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('github', '42', 'a', ?)", nowIso());
		assert.throws(() =>
			run("INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('github', '42', 'b', ?)", nowIso()),
		);
	});

	test('idea length must be 16 to 280 characters', () => {
		const user = makeUser();
		assert.throws(() => makeIdea(user, 'x'.repeat(15)));
		assert.throws(() => makeIdea(user, 'x'.repeat(281)));
		assert.ok(makeIdea(user, 'x'.repeat(16)));
	});

	test('only one open idea per person, but withdrawn ones do not count', () => {
		const user = makeUser();
		const first = makeIdea(user);
		assert.throws(() => makeIdea(user), /UNIQUE/);

		run("UPDATE ideas SET status = 'withdrawn' WHERE id = ?", first);
		assert.ok(makeIdea(user));
	});

	test('a person votes for an idea at most once', () => {
		const author = makeUser();
		const voter = makeUser();
		const idea = makeIdea(author);
		castVote(voter, idea);
		assert.throws(() => castVote(voter, idea));
	});

	test('deleting an idea deletes its votes', () => {
		const author = makeUser();
		const voter = makeUser();
		const idea = makeIdea(author);
		castVote(voter, idea);
		run('DELETE FROM ideas WHERE id = ?', idea);
		assert.equal(get('SELECT count(*) AS n FROM votes WHERE idea_id = ?', idea).n, 0);
	});
});

describe('sessions', () => {
	test('stores, reads and removes a session', () => {
		const driver = sqliteSessions();
		driver.setItem('abc', '{"user":1}');
		assert.equal(driver.hasItem('abc'), true);
		assert.equal(driver.getItem('abc'), '{"user":1}');
		driver.removeItem('abc');
		assert.equal(driver.getItem('abc'), null);
	});

	test('expired sessions are invisible and get swept', () => {
		run('INSERT INTO sessions (id, value, expires_at) VALUES (?, ?, ?)', 'old', '{}', Date.now() - 1000);
		const driver = sqliteSessions();
		assert.equal(driver.getItem('old'), null);
		assert.equal(sweep(getDb()) >= 1, true);
		assert.equal(get('SELECT count(*) AS n FROM sessions WHERE id = ?', 'old').n, 0);
	});
});

describe('demo seed', () => {
	test('fills ideas, votes and builds', () => {
		const result = seedDemo();
		assert.equal(result.ideas, 6);
		assert.equal(result.builds, 6);
		assert.ok(result.votes > 0);
		assert.equal(get("SELECT count(*) AS n FROM builds WHERE status = 'building'").n, 1);
		assert.ok(get('SELECT count(*) AS n FROM build_events').n > 0);
	});

	test('respects the voting rules: at most 3 votes each, never for your own idea', () => {
		const maxPerUser = get('SELECT max(n) AS m FROM (SELECT count(*) AS n FROM votes GROUP BY user_id)').m;
		assert.ok(maxPerUser <= 3);
		const selfVotes = get('SELECT count(*) AS n FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE i.user_id = v.user_id').n;
		assert.equal(selfVotes, 0);
	});

	test('running it again replaces demo rows instead of duplicating them', () => {
		const before = get('SELECT count(*) AS n FROM ideas').n;
		seedDemo();
		assert.equal(get('SELECT count(*) AS n FROM ideas').n, before);
		assert.equal(get('SELECT count(*) AS n FROM builds').n, 6);
	});

	test('re-seeding after a window closes keeps that window’s winner', async () => {
		const { closeWindowNow, lastClosedWindow } = await import('../src/core/cycle/windows.ts');
		seedDemo();
		closeWindowNow();
		const winner = lastClosedWindow();
		assert.ok(winner.winnerText, 'the demo board has a winner');

		seedDemo();
		const after = lastClosedWindow();
		assert.equal(after.id, winner.id);
		assert.equal(after.winnerText, winner.winnerText);
		assert.equal(get("SELECT status FROM ideas WHERE id = ?", winner.winnerIdeaId).status, 'won');
		assert.equal(get("SELECT count(*) AS n FROM ideas WHERE status = 'open'").n >= 6, true);
	});

	test('leaves real people alone', () => {
		const real = get(
			"INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('github', '777', 'real', ?) RETURNING id",
			nowIso(),
		).id;
		makeIdea(real, 'An idea from a real person, not a demo');
		seedDemo();
		assert.equal(get('SELECT count(*) AS n FROM ideas WHERE user_id = ?', real).n, 1);
	});
});
