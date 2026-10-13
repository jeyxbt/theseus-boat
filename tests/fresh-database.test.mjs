import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('fresh');

const { all, get, getDb } = await import('../src/core/db/client.ts');
const { MIGRATIONS, migrate } = await import('../src/core/db/migrations.ts');
const { currentWindow } = await import('../src/core/cycle/windows.ts');

describe('a fresh database', () => {
	test('starts with nothing in it: no people, ideas, votes, builds, spend or shared data', () => {
		getDb();
		for (const table of ['users', 'sessions', 'ideas', 'votes', 'builds', 'build_events', 'ai_spend', 'store_items', 'store_writes']) {
			assert.equal(get(`SELECT count(*) AS n FROM ${table}`).n, 0, table);
		}
	});

	test('opens the first voting window on demand, numbered 1', () => {
		assert.equal(get('SELECT count(*) AS n FROM windows').n, 0);
		const window = currentWindow();
		assert.equal(window.number, 1);
		assert.equal(window.status, 'open');
	});

	test('carries only the default settings', () => {
		const settings = Object.fromEntries(all('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
		assert.deepEqual(settings, { min_votes: '3', paused: '0', monthly_cap_usd: '75' });
	});

	test('is at the latest schema version, so no migration runs on it', () => {
		assert.equal(getDb().prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
	});

	test('has no trace of sample data in its schema', () => {
		const sql = all("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").map((row) => row.sql).join('\n');
		assert.doesNotMatch(sql, /demo/i);
	});
});

describe('the migration runner', () => {
	const open = () => {
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE t (a INTEGER)');
		return db;
	};
	const version = (db) => db.prepare('PRAGMA user_version').get().user_version;

	test('a fresh database is stamped with the latest version without running anything', () => {
		const db = open();
		let ran = 0;
		migrate(db, true, Date.now(), [() => ran++, () => ran++]);
		assert.equal(ran, 0);
		assert.equal(version(db), 2);
	});

	test('an older database runs only what it is missing, in order, once', () => {
		const db = open();
		db.exec('PRAGMA user_version = 1');
		const order = [];
		const steps = [
			() => order.push('one'),
			(d) => (order.push('two'), d.exec('INSERT INTO t VALUES (2)')),
			(d) => (order.push('three'), d.exec('INSERT INTO t VALUES (3)')),
		];
		migrate(db, false, Date.now(), steps);
		migrate(db, false, Date.now(), steps);
		assert.deepEqual(order, ['two', 'three']);
		assert.equal(version(db), 3);
		assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY a').all().map((row) => row.a), [2, 3]);
	});

	test('a failing migration is rolled back whole and leaves the version where it was', () => {
		const db = open();
		const steps = [
			(d) => d.exec('INSERT INTO t VALUES (1)'),
			(d) => {
				d.exec('INSERT INTO t VALUES (2)');
				throw new Error('boom');
			},
		];
		assert.throws(() => migrate(db, false, Date.now(), steps), /boom/);
		assert.equal(version(db), 1);
		assert.deepEqual(db.prepare('SELECT a FROM t').all().map((row) => row.a), [1]);
		assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'keys are switched back on');
	});
});
