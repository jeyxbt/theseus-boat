import type { DatabaseSync } from 'node:sqlite';
import { getWindowMs } from '../env';
import { buildsTable, ideasTable, votesTable, windowsTable } from './schema';

type Migration = (db: DatabaseSync, now: number) => void;

/**
 * Ordered schema changes for databases created by older code. PRAGMA
 * user_version counts how many have run. A fresh database is created with the
 * latest schema and skips them all. Never edit or reorder one that has shipped.
 */
export const MIGRATIONS: Migration[] = [
	// 1. Voting windows: every idea and vote belongs to a window; ideas can be won, lost or skipped.
	(db, now) => {
		const maxCycle = (db.prepare('SELECT max(cycle) AS n FROM builds').get() as { n: number | null }).n ?? 0;
		const maxWindow = (db.prepare('SELECT max(number) AS n FROM windows').get() as { n: number | null }).n ?? 0;
		const opened = new Date(now).toISOString();
		const closes = new Date(now + getWindowMs()).toISOString();
		const { id: windowId } = db
			.prepare(
				`INSERT INTO windows (number, opened_at, closes_at, status) VALUES (?, ?, ?, 'open') RETURNING id`,
			)
			.get(Math.max(maxCycle, maxWindow) + 1, opened, closes) as { id: number };

		// SQLite can't change a CHECK or add a NOT NULL column in place: rebuild both tables.
		db.exec(ideasTable('ideas_v2'));
		db.prepare(
			`INSERT INTO ideas_v2 (id, user_id, window_id, body, status, edits, created_at, updated_at)
			 SELECT id, user_id, ?, body, status, edits, created_at, updated_at FROM ideas`,
		).run(windowId);
		db.exec('DROP TABLE ideas');
		db.exec('ALTER TABLE ideas_v2 RENAME TO ideas');

		db.exec(votesTable('votes_v2'));
		db.prepare(
			`INSERT INTO votes_v2 (user_id, idea_id, window_id, created_at)
			 SELECT user_id, idea_id, ?, created_at FROM votes`,
		).run(windowId);
		db.exec('DROP TABLE votes');
		db.exec('ALTER TABLE votes_v2 RENAME TO votes');
	},

	// 2. Real builds: linked to a window and its idea, with repair, error, cost and heartbeat columns.
	(db) => {
		db.exec(buildsTable('builds_v2'));
		db.exec(
			`INSERT INTO builds_v2 (id, cycle, idea_text, author_handle, votes, status, note, commit_sha,
				lines_added, lines_removed, files, started_at, finished_at, is_demo)
			 SELECT id, cycle, idea_text, author_handle, votes, status, note, commit_sha,
				lines_added, lines_removed, files, started_at, finished_at, is_demo FROM builds`,
		);
		db.exec('DROP TABLE builds');
		db.exec('ALTER TABLE builds_v2 RENAME TO builds');
	},

	// 3. AI moderation: whether an idea has passed the model's review, and why one was taken down.
	(db) => {
		// Migration 1 rebuilds ideas from today's definition, which already has these columns.
		const columns = new Set((db.prepare('PRAGMA table_info(ideas)').all() as { name: string }[]).map((c) => c.name));
		// Ideas from before this existed passed the regex filter; they are not sent back for review.
		if (!columns.has('verified')) {
			db.exec('ALTER TABLE ideas ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1))');
		}
		if (!columns.has('removed_reason')) db.exec('ALTER TABLE ideas ADD COLUMN removed_reason TEXT');
	},

	// 4. Dry runs are told apart from shipped builds, and a winner can be skipped as already built.
	(db) => {
		// Migration 2 rebuilds builds from today's definition, which already has the column.
		const columns = new Set((db.prepare('PRAGMA table_info(builds)').all() as { name: string }[]).map((c) => c.name));
		if (!columns.has('dry_run')) {
			db.exec('ALTER TABLE builds ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))');
		}
		db.exec("UPDATE builds SET dry_run = 1 WHERE note = 'dry run'");

		// A new skip reason means a new CHECK, which needs a rebuilt table.
		db.exec(windowsTable('windows_v2'));
		db.exec(
			`INSERT INTO windows_v2 (id, number, opened_at, closes_at, closed_at, status, winner_idea_id, winner_votes,
				ideas_count, votes_count, skip_reason)
			 SELECT id, number, opened_at, closes_at, closed_at, status, winner_idea_id, winner_votes,
				ideas_count, votes_count, skip_reason FROM windows`,
		);
		db.exec('DROP TABLE windows');
		db.exec('ALTER TABLE windows_v2 RENAME TO windows');
	},

	// 5. Simulated builds (pnpm build:simulate) never touched the site either.
	(db) => {
		db.exec("UPDATE builds SET dry_run = 1 WHERE note IN ('simulated', 'simulated failure')");
	},
];

/** Runs pending migrations, one transaction each, with foreign keys checked at the end. */
export function migrate(db: DatabaseSync, fresh: boolean, now = Date.now()) {
	if (fresh) {
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
		return;
	}

	const version = () => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
	while (version() < MIGRATIONS.length) {
		// Table rebuilds must not fire ON DELETE CASCADE, so keys are off while they run.
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN IMMEDIATE');
		try {
			// Read again under the write lock: another process may have just migrated.
			const current = version();
			if (current >= MIGRATIONS.length) {
				db.exec('COMMIT');
				break;
			}
			MIGRATIONS[current](db, now);
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
