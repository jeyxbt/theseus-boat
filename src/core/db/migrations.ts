import type { DatabaseSync } from 'node:sqlite';

type Migration = (db: DatabaseSync, now: number) => void;

/**
 * Ordered schema changes for databases created by older code. PRAGMA
 * user_version counts how many have run. A fresh database is created with the
 * latest schema (see schema.ts) and skips them all, so the schema there is
 * version 0 until the first entry is added here.
 *
 * Once a database exists anywhere, never edit or reorder an entry: append.
 * SQLite can't change a CHECK or add a NOT NULL column in place, so a change
 * like that rebuilds the table: create `<name>_v2` from the new definition,
 * copy the rows, drop the old table, rename. migrate() turns foreign keys off
 * for the duration, so the drop doesn't cascade.
 */
export const MIGRATIONS: Migration[] = [];

/** Runs pending migrations, one transaction each, with foreign keys checked at the end. */
export function migrate(db: DatabaseSync, fresh: boolean, now = Date.now(), migrations: Migration[] = MIGRATIONS) {
	if (fresh) {
		db.exec(`PRAGMA user_version = ${migrations.length}`);
		return;
	}

	const version = () => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
	while (version() < migrations.length) {
		// Table rebuilds must not fire ON DELETE CASCADE, so keys are off while they run.
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN IMMEDIATE');
		try {
			// Read again under the write lock: another process may have just migrated.
			const current = version();
			if (current >= migrations.length) {
				db.exec('COMMIT');
				break;
			}
			migrations[current](db, now);
			const broken = db.prepare('PRAGMA foreign_key_check').all();
			if (broken.length > 0) throw new Error(`migration ${current + 1} left ${broken.length} broken references`);
			db.exec(`PRAGMA user_version = ${current + 1}`);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}
