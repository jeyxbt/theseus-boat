import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('deploy');

const { readiness } = await import('../src/core/production.ts');
const { backUp, backupName, BACKUP_NAME } = await import('../scripts/db-backup.ts');
const { adminCommand } = await import('../scripts/admin.ts');
const { all, get, getDb, nowIso, run } = await import('../src/core/db/client.ts');
const { currentWindow } = await import('../src/core/cycle/windows.ts');
const { getSetting } = await import('../src/core/settings.ts');
const { pipelineConfig, configProblems } = await import('../scripts/pipeline/config.ts');

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

/** A setup that is ready for a real domain. */
const ready = () => ({
	SITE_URL: 'https://example.com',
	HOST: '127.0.0.1',
	DATABASE_URL: process.platform === 'win32' ? 'file:C:/data/theseus.db' : 'file:/var/lib/theseus/theseus.db',
	GITHUB_CLIENT_ID: 'id',
	GITHUB_CLIENT_SECRET: 'secret',
	MODERATION_PROVIDER: 'api',
	ANTHROPIC_API_KEY: 'key',
	DEPLOY_MODE: 'production',
});

describe('is this setup ready for a real domain?', () => {
	test('a laptop setup is not held to the public rules', () => {
		assert.deepEqual(readiness({}), { isPublic: false, problems: [], warnings: [] });
		assert.equal(readiness({ SITE_URL: 'http://127.0.0.1:4321', MODERATION_PROVIDER: 'off' }).problems.length, 0);
		assert.equal(readiness({ SITE_URL: 'http://localhost:4321' }).isPublic, false);
	});

	test('a complete public setup has no problems and no warnings', () => {
		assert.deepEqual(readiness(ready()), { isPublic: true, problems: [], warnings: [] });
	});

	const broken = {
		'plain http': [{ SITE_URL: 'http://example.com' }, /must start with https/],
		'not an address': [{ SITE_URL: 'not a url' }, /not a valid address/],
		'listening on every interface': [{ HOST: '0.0.0.0' }, /forge a visitor's address/],
		'no database path': [{ DATABASE_URL: '' }, /DATABASE_URL is not set/],
		'a relative database path': [{ DATABASE_URL: 'file:data/local.db' }, /absolute path/],
		'no sign-in provider': [{ GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }, /no sign-in provider/],
		'half a provider': [{ GITHUB_CLIENT_SECRET: '' }, /no sign-in provider/],
		'the review switched off': [{ MODERATION_PROVIDER: 'off' }, /must be api/],
		'the review through a subscription': [{ MODERATION_PROVIDER: 'cli' }, /must be api/],
		'no API key': [{ ANTHROPIC_API_KEY: '' }, /ANTHROPIC_API_KEY is not set/],
	};
	for (const [name, [change, expected]] of Object.entries(broken)) {
		test(`refuses: ${name}`, () => {
			const result = readiness({ ...ready(), ...change });
			assert.match(result.problems.join('\n'), expected);
		});
	}

	test('warns, without refusing, about a test window and a site that does not ship', () => {
		const result = readiness({ ...ready(), WINDOW_MINUTES: '5', DEPLOY_MODE: 'preview' });
		assert.deepEqual(result.problems, []);
		assert.equal(result.warnings.length, 2);
	});

	test('never repeats a secret back', () => {
		const result = readiness({ ...ready(), ANTHROPIC_API_KEY: '', GITHUB_CLIENT_SECRET: 'super-secret-value', SITE_URL: 'http://example.com' });
		assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
	});

});

describe('backups', () => {
	const dir = () => mkdtempSync(join(tmpdir(), 'pw-backup-'));

	test('names sort by time, and only our own names count as backups', () => {
		assert.equal(backupName(new Date(Date.UTC(2026, 9, 12, 7, 5, 9))), 'theseus-20261012-070509.db');
		assert.ok(BACKUP_NAME.test('theseus-20261012-070509.db'));
		assert.ok(!BACKUP_NAME.test('theseus-20261012-070509.db-wal'));
		assert.ok(!BACKUP_NAME.test('notes.txt'));
	});

	test('a copy is consistent, readable and verified', () => {
		const db = getDb();
		const user = get("INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', 'b1', 'backer', ?) RETURNING id", nowIso()).id;
		assert.ok(user);
		const target = dir();
		const { file, bytes, removed } = backUp(db, target, 14, new Date(Date.UTC(2026, 9, 12, 7, 0, 0)));
		assert.ok(bytes > 0);
		assert.equal(removed, 0);
		const { DatabaseSync } = require_sqlite();
		const copy = new DatabaseSync(file, { readOnly: true });
		assert.equal(copy.prepare('SELECT handle FROM users').get().handle, 'backer');
		assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
		copy.close();
	});

	test('keeps the newest few and deletes the rest, never touching other files', () => {
		const target = dir();
		writeFileSync(join(target, 'notes.txt'), 'mine');
		const db = getDb();
		for (let hour = 0; hour < 5; hour++) backUp(db, target, 3, new Date(Date.UTC(2026, 9, 12, hour, 0, 0)));
		const left = readdirSync(target).sort();
		assert.deepEqual(left, ['notes.txt', 'theseus-20261012-020000.db', 'theseus-20261012-030000.db', 'theseus-20261012-040000.db']);
		// Asking to keep none still keeps one: the backup just made.
		backUp(db, target, 0, new Date(Date.UTC(2026, 9, 12, 5, 0, 0)));
		assert.deepEqual(readdirSync(target).filter((name) => name.endsWith('.db')), ['theseus-20261012-050000.db']);
	});

	test('never overwrites a backup', () => {
		const target = dir();
		const at = new Date(Date.UTC(2026, 9, 12, 7, 0, 0));
		backUp(getDb(), target, 14, at);
		assert.throws(() => backUp(getDb(), target, 14, at), /already exists/);
	});
});

function require_sqlite() {
	return createRequire(import.meta.url)('node:sqlite');
}

describe('the maintainer’s controls', () => {
	test('status shows where things stand', () => {
		currentWindow();
		const out = adminCommand(['status']);
		assert.match(out, /Building winners:\s+on/);
		assert.match(out, /Window:\s+cycle \d+/);
		assert.match(out, /AI spend:\s+\$0\.00 of the \$75 monthly cap/);
		assert.match(out, /Waiting to build:\s+nothing/);
	});

	test('pause and resume flip the setting the pipeline reads', () => {
		assert.match(adminCommand(['pause']), /Paused/);
		assert.equal(getSetting('paused'), '1');
		assert.match(adminCommand(['status']), /PAUSED/);
		assert.match(adminCommand(['resume']), /Resumed/);
		assert.equal(getSetting('paused'), '0');
	});

	test('cap and min-votes take numbers and refuse nonsense', () => {
		assert.match(adminCommand(['cap', '40']), /now \$40/);
		assert.equal(getSetting('monthly_cap_usd'), '40');
		assert.match(adminCommand(['min-votes', '5']), /needs 5 votes/);
		assert.equal(getSetting('min_votes'), '5');
		for (const bad of [['cap', 'lots'], ['cap', '-1'], ['cap'], ['min-votes', '0'], ['min-votes', '2.5'], ['remove-idea', 'x'], ['nonsense']]) {
			assert.throws(() => adminCommand(bad), /usage|commands/);
		}
		adminCommand(['cap', '75']);
		adminCommand(['min-votes', '3']);
	});

	test('remove-idea takes an idea off the board and gives its votes back', () => {
		const window = currentWindow();
		const mk = (handle) =>
			get("INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', ?, ?, ?) RETURNING id", `a-${handle}`, handle, nowIso()).id;
		const author = mk('author');
		const voter = mk('voter');
		const idea = get(
			"INSERT INTO ideas (user_id, window_id, body, status, created_at, updated_at) VALUES (?, ?, 'An idea that has to go away', 'open', ?, ?) RETURNING id",
			author,
			window.id,
			nowIso(),
			nowIso(),
		).id;
		run('INSERT INTO votes (user_id, idea_id, window_id, created_at) VALUES (?, ?, ?, ?)', voter, idea, window.id, nowIso());

		assert.match(adminCommand(['remove-idea', String(idea)]), /off the board/);
		assert.equal(get('SELECT status, removed_reason FROM ideas WHERE id = ?', idea).status, 'removed');
		assert.equal(get('SELECT count(*) AS n FROM votes WHERE idea_id = ?', idea).n, 0);
		assert.match(adminCommand(['remove-idea', String(idea)]), /No open idea/);
		assert.equal(all('SELECT id FROM ideas WHERE status = ?', 'open').length, 0);
	});
});
