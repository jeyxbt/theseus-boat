import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('db');

const { getDb, get, all, run, nowIso } = await import('../src/core/db/client.ts');
const { default: sqliteSessions } = await import('../src/core/db/session-driver.ts');
const { sweep } = await import('../src/core/db/maintenance.ts');
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

