import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { getDatabaseUrl } from '../env';
import { startMaintenance } from './maintenance';
import { migrate } from './migrations';
import { INDEXES, TABLES } from './schema';

/** Defaults for runtime settings; existing values are never overwritten. */
const SETTING_DEFAULTS: Record<string, string> = {
	min_votes: '3',
	paused: '0',
	monthly_cap_usd: '75',
};

type Value = null | number | string | bigint | Uint8Array;

let db: DatabaseSync | null = null;

/** node:sqlite only accepts these parameter types. */
function toValue(value: unknown): Value {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (value instanceof Date) return value.toISOString();
	return value as Value;
}

export function databasePath() {
	return getDatabaseUrl().replace(/^file:/, '');
}

function open() {
	const path = databasePath();
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

	const sqlite = new DatabaseSync(path);

	// WAL lets reads run during a write; the timeout avoids SQLITE_BUSY.
	sqlite.exec('PRAGMA journal_mode = WAL');
	sqlite.exec('PRAGMA busy_timeout = 5000');
	sqlite.exec('PRAGMA synchronous = NORMAL');
	sqlite.exec('PRAGMA foreign_keys = ON');
	sqlite.exec('PRAGMA journal_size_limit = 4194304');
	sqlite.exec('PRAGMA temp_store = MEMORY');
	enableIncrementalVacuum(sqlite);

	const fresh = !sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
	for (const statement of TABLES) sqlite.exec(statement);
	migrate(sqlite, fresh);
	for (const statement of INDEXES) sqlite.exec(statement);

	const insertSetting = sqlite.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
	for (const [key, value] of Object.entries(SETTING_DEFAULTS)) insertSetting.run(key, value, new Date().toISOString());

	sqlite.exec('PRAGMA optimize = 0x10002');
	startMaintenance(sqlite);
	return sqlite;
}

/** Without incremental auto_vacuum the file never shrinks. Switching needs one VACUUM. */
function enableIncrementalVacuum(sqlite: DatabaseSync) {
	const { auto_vacuum: mode } = sqlite.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
	if (mode === 2) return;
	sqlite.exec('PRAGMA auto_vacuum = INCREMENTAL');
	sqlite.exec('VACUUM');
}

export function getDb() {
	db ??= open();
	return db;
}

export function closeDb() {
	db?.close();
	db = null;
	statements.clear();
}

/** Queries are fixed strings: prepare each once and reuse it. */
const statements = new Map<string, StatementSync>();

function prepared(sql: string) {
	let statement = statements.get(sql);
	if (!statement) {
		statement = getDb().prepare(sql);
		statements.set(sql, statement);
	}
	return statement;
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
	return prepared(sql).all(...params.map(toValue)) as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | null {
	return (prepared(sql).get(...params.map(toValue)) as T | undefined) ?? null;
}

export function run(sql: string, ...params: unknown[]) {
	return prepared(sql).run(...params.map(toValue));
}

/** Several writes as one: all of them land or none do. */
export function transaction<T>(work: () => T): T {
	const db = getDb();
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = work();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function nowIso() {
	return new Date().toISOString();
}
