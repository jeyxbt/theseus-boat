/**
 * A consistent copy of the live database, while the site keeps running.
 *
 *   pnpm db:backup
 *
 * Copies into BACKUP_DIR (default: a backups/ folder next to the database) as
 * theseus-YYYYMMDD-HHMMSS.db, checks the copy opens and passes SQLite's own
 * integrity check, keeps the BACKUP_KEEP (default 14) newest and deletes the
 * rest, then pings BACKUP_PING_URL if one is set (a Healthchecks.io-style
 * monitor that alerts when the backups stop). Run it from cron.
 *
 * To restore: stop the site, copy a backup over the database file, start it.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { closeDb, databasePath, getDb } from '../src/core/db/client';
import { SITE_SLUG } from '../src/core/site';

export const BACKUP_NAME = new RegExp(`^${SITE_SLUG}-\\d{8}-\\d{6}\\.db$`);

const two = (n: number) => String(n).padStart(2, '0');
export function backupName(now = new Date()) {
	const d = now;
	return `${SITE_SLUG}-${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}.db`;
}

/** Copies, verifies, prunes. Returns the new file and how many old ones were removed. */
export function backUp(db: DatabaseSync, dir: string, keep: number, now = new Date()) {
	mkdirSync(dir, { recursive: true });
	const target = join(dir, backupName(now));
	if (existsSync(target)) throw new Error(`${target} already exists: wait a second and try again`);
	db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

	const copy = new DatabaseSync(target, { readOnly: true });
	try {
		const result = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
		if (result.integrity_check !== 'ok') throw new Error(`the copy failed SQLite's integrity check: ${result.integrity_check}`);
		const users = copy.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
		if (typeof users.n !== 'number') throw new Error('the copy has no users table');
	} catch (error) {
		copy.close();
		rmSync(target, { force: true });
		throw error;
	}
	copy.close();

	const old = readdirSync(dir)
		.filter((name) => BACKUP_NAME.test(name))
		.sort()
		.reverse()
		.slice(Math.max(1, keep));
	for (const name of old) rmSync(join(dir, name), { force: true });
	return { file: target, bytes: statSync(target).size, removed: old.length };
}

// Only when run as a command, not when a test imports it.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? '')) {
	const dir = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : join(dirname(resolve(databasePath())), 'backups');
	const keep = Number(process.env.BACKUP_KEEP) || 14;
	try {
		const { file, bytes, removed } = backUp(getDb(), dir, keep);
		console.log(`Backed up to ${file} (${Math.round(bytes / 1024)} KB)${removed ? `; removed ${removed} old` : ''}.`);
		closeDb();
		if (process.env.BACKUP_PING_URL) {
			const response = await fetch(process.env.BACKUP_PING_URL, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
			if (!response?.ok) console.warn('The backup is done, but the monitoring ping did not go through.');
		}
	} catch (error) {
		console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
