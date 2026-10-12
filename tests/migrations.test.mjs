import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

const url = useTempDatabase('old-schema');
const path = url.replace(/^file:/, '');

// The schema as the first version of the site created it, before voting windows.
const old = new DatabaseSync(path);
old.exec(`
	CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL CHECK (provider IN ('github','google','x','dev')),
		provider_id TEXT NOT NULL, handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 64), name TEXT, avatar_url TEXT,
		created_at TEXT NOT NULL, UNIQUE (provider, provider_id));
	CREATE TABLE sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID;
	CREATE TABLE ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		body TEXT NOT NULL CHECK (length(body) BETWEEN 16 AND 280),
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'withdrawn', 'removed')),
		edits INTEGER NOT NULL DEFAULT 0 CHECK (edits >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
	CREATE TABLE votes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
		PRIMARY KEY (user_id, idea_id)) WITHOUT ROWID;
	CREATE TABLE builds (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle INTEGER NOT NULL UNIQUE, idea_text TEXT NOT NULL,
		author_handle TEXT NOT NULL, votes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('building','live','rolled_back')),
		note TEXT, commit_sha TEXT, lines_added INTEGER NOT NULL DEFAULT 0, lines_removed INTEGER NOT NULL DEFAULT 0,
		files TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
	CREATE TABLE build_events (id INTEGER PRIMARY KEY AUTOINCREMENT, build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
		ts TEXT NOT NULL, tag TEXT NOT NULL, message TEXT NOT NULL);
	CREATE UNIQUE INDEX ideas_one_open_per_user ON ideas(user_id) WHERE status = 'open';
	INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', 'a', 'alice', '2026-10-01T00:00:00Z');
	INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', 'b', 'bob', '2026-10-01T00:00:00Z');
	INSERT INTO ideas (user_id, body, status, created_at, updated_at) VALUES (1, 'An open idea from the old schema', 'open', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
	INSERT INTO ideas (user_id, body, status, created_at, updated_at) VALUES (2, 'A withdrawn idea from the old schema', 'withdrawn', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
	INSERT INTO votes (user_id, idea_id, created_at) VALUES (2, 1, '2026-10-01T00:00:00Z');
	INSERT INTO builds (cycle, idea_text, author_handle, status, started_at, is_demo) VALUES (37, 'demo', 'demo', 'live', '2026-10-01T00:00:00Z', 1);
`);
old.close();

const { getDb, get, all, closeDb } = await import('../src/core/db/client.ts');

describe('migrating a database from before voting windows', () => {
	test('keeps every idea, vote and status, and puts them in a first window', () => {
		const db = getDb();
		assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);

		const window = get("SELECT id, number, status FROM windows WHERE status = 'open'");
		assert.equal(window.number, 38, 'numbering continues after the existing build cycle');

		const ideas = all('SELECT id, window_id AS windowId, status FROM ideas ORDER BY id');
		assert.deepEqual(
			ideas.map((i) => ({ ...i })),
			[
				{ id: 1, windowId: window.id, status: 'open' },
				{ id: 2, windowId: window.id, status: 'withdrawn' },
			],
		);
		assert.deepEqual({ ...get('SELECT user_id, idea_id, window_id FROM votes') }, { user_id: 2, idea_id: 1, window_id: window.id });
	});

	test('old builds keep their data and gain the new columns', () => {
		const build = get('SELECT cycle, status, is_demo, window_id, repairs, cost_usd, dry_run FROM builds');
		assert.deepEqual({ ...build }, { cycle: 37, status: 'live', is_demo: 1, window_id: null, repairs: 0, cost_usd: 0, dry_run: 0 });
		assert.match(get("SELECT sql FROM sqlite_master WHERE name = 'builds'").sql, /'repairing'/);
		assert.ok(get("SELECT name FROM sqlite_master WHERE name = 'ai_spend'"));
		assert.ok(get("SELECT name FROM sqlite_master WHERE name = 'store_items'"));
		assert.match(get("SELECT sql FROM sqlite_master WHERE name = 'windows'").sql, /'already_built'/);
	});

	test('the new constraints and indexes are in place', () => {
		const sql = get("SELECT sql FROM sqlite_master WHERE name = 'ideas'").sql;
		assert.match(sql, /'won'/);
		assert.match(sql, /window_id INTEGER NOT NULL/);
		const indexes = all("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
		for (const name of ['ideas_one_open_per_user', 'ideas_window_status', 'votes_user_window', 'windows_one_open']) {
			assert.ok(indexes.includes(name), `missing index ${name}`);
		}
		assert.deepEqual(getDb().prepare('PRAGMA foreign_key_check').all(), []);
		assert.equal(getDb().prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
	});

	test('opening it again does nothing more', () => {
		closeDb();
		const db = getDb();
		assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
		assert.equal(get('SELECT count(*) AS n FROM windows').n, 1);
		assert.equal(get('SELECT count(*) AS n FROM ideas').n, 2);
	});
});
