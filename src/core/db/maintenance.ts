import type { DatabaseSync } from 'node:sqlite';

export const SWEEP_MS = 60 * 1000;
export const COMPACT_MS = 10 * 60 * 1000;

/** Rows per DELETE, so each batch is a short transaction. */
const BATCH = 1000;

/** Deletes expired sessions. Returns how many rows went. */
export function sweep(db: DatabaseSync, now = Date.now()) {
	const statement = db.prepare(
		`DELETE FROM sessions WHERE id IN (
			SELECT id FROM sessions WHERE expires_at <= ? LIMIT ${BATCH}
		)`,
	);
	let total = 0;
	for (;;) {
		const changes = Number(statement.run(now).changes);
		total += changes;
		if (changes < BATCH) return total;
	}
}

/** Refreshes planner stats, returns free pages to disk and truncates the WAL. */
export function compact(db: DatabaseSync) {
	db.exec('PRAGMA optimize');
	db.exec('PRAGMA incremental_vacuum(1000)');
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

let started = false;

/** Starts the timers once per process. They don't keep the process alive. */
export function startMaintenance(db: DatabaseSync) {
	if (started) return;
	started = true;

	const guarded = (label: string, job: () => unknown) => () => {
		try {
			job();
		} catch (error) {
			// SQLITE_BUSY here is harmless: the next run picks it up.
			console.error(`[db] ${label} failed:`, error instanceof Error ? error.message : error);
		}
	};

	const doSweep = guarded('sweep', () => sweep(db));
	const doCompact = guarded('compact', () => compact(db));

	doSweep();
	setInterval(doSweep, SWEEP_MS).unref();
	setInterval(doCompact, COMPACT_MS).unref();
}
