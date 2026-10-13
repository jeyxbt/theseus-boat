export const PROVIDERS = ['github', 'google', 'x', 'dev'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const IDEA_MIN = 16;
export const IDEA_MAX = 280;

export const IDEA_STATUSES = ['open', 'withdrawn', 'removed', 'won', 'lost', 'skipped'] as const;

export const SKIP_REASONS = [
	'no_ideas',
	'not_enough_votes',
	'paused',
	'budget',
	'final_gate',
	'moderation_unavailable',
	'already_built',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** DDL shared by fresh databases and by the migration that rebuilds old tables. */
export function ideasTable(name = 'ideas') {
	return `CREATE TABLE IF NOT EXISTS ${name} (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		window_id INTEGER NOT NULL REFERENCES windows(id),
		body TEXT NOT NULL CHECK (length(body) BETWEEN ${IDEA_MIN} AND ${IDEA_MAX}),
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${list(IDEA_STATUSES)})),
		edits INTEGER NOT NULL DEFAULT 0 CHECK (edits >= 0),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1)),
		removed_reason TEXT
	)`;
}

export function votesTable(name = 'votes') {
	return `CREATE TABLE IF NOT EXISTS ${name} (
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
		window_id INTEGER NOT NULL REFERENCES windows(id),
		created_at TEXT NOT NULL,
		PRIMARY KEY (user_id, idea_id)
	) WITHOUT ROWID`;
}

export const BUILD_STATUSES = ['building', 'repairing', 'live', 'rolled_back', 'failed'] as const;

export function buildsTable(name = 'builds') {
	return `CREATE TABLE IF NOT EXISTS ${name} (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		window_id INTEGER UNIQUE REFERENCES windows(id),
		idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
		cycle INTEGER NOT NULL UNIQUE,
		idea_text TEXT NOT NULL,
		author_handle TEXT NOT NULL,
		votes INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL CHECK (status IN (${list(BUILD_STATUSES)})),
		note TEXT,
		error TEXT,
		previous_sha TEXT,
		commit_sha TEXT,
		repairs INTEGER NOT NULL DEFAULT 0 CHECK (repairs >= 0),
		lines_added INTEGER NOT NULL DEFAULT 0,
		lines_removed INTEGER NOT NULL DEFAULT 0,
		files TEXT NOT NULL DEFAULT '[]',
		cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
		started_at TEXT NOT NULL,
		heartbeat_at TEXT,
		finished_at TEXT,
		dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))
	)`;
}

export const AI_SPEND_KINDS = ['implement', 'repair', 'moderation', 'final_gate'] as const;

export const AI_SPEND_TABLE = `CREATE TABLE IF NOT EXISTS ai_spend (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL,
	window_id INTEGER REFERENCES windows(id),
	kind TEXT NOT NULL CHECK (kind IN (${list(AI_SPEND_KINDS)})),
	model TEXT NOT NULL,
	cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
	input_tokens INTEGER,
	output_tokens INTEGER,
	num_turns INTEGER,
	duration_ms INTEGER,
	created_at TEXT NOT NULL
)`;

export function windowsTable(name = 'windows') {
	return `CREATE TABLE IF NOT EXISTS ${name} (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		number INTEGER NOT NULL UNIQUE,
		opened_at TEXT NOT NULL,
		closes_at TEXT NOT NULL,
		closed_at TEXT,
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
		winner_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
		winner_votes INTEGER,
		ideas_count INTEGER NOT NULL DEFAULT 0,
		votes_count INTEGER NOT NULL DEFAULT 0,
		skip_reason TEXT CHECK (skip_reason IN (${list(SKIP_REASONS)}))
	)`;
}

/** Shared data for features the AI builds. Collections are declared in src/collections/*.json. */
export const STORE_ITEM_MAX_BYTES = 2048;

export const STORE_TABLES = [
	`CREATE TABLE IF NOT EXISTS store_items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		collection TEXT NOT NULL,
		key TEXT,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		data TEXT NOT NULL CHECK (length(data) <= ${STORE_ITEM_MAX_BYTES}),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	// Every accepted write, for the per-hour and per-day limits. Kept for a day.
	`CREATE TABLE IF NOT EXISTS store_writes (
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		collection TEXT NOT NULL,
		at TEXT NOT NULL
	)`,
];

export const TABLES = [
	`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		provider TEXT NOT NULL CHECK (provider IN ('github', 'google', 'x', 'dev')),
		provider_id TEXT NOT NULL,
		handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 64),
		name TEXT,
		avatar_url TEXT,
		created_at TEXT NOT NULL,
		UNIQUE (provider, provider_id)
	)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	) WITHOUT ROWID`,
	windowsTable(),
	ideasTable(),
	votesTable(),
	`CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) WITHOUT ROWID`,
	buildsTable(),
	AI_SPEND_TABLE,
	`CREATE TABLE IF NOT EXISTS build_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
		ts TEXT NOT NULL,
		tag TEXT NOT NULL,
		message TEXT NOT NULL
	)`,
	...STORE_TABLES,
];

export const INDEXES = [
	'CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at)',
	// One open idea per person: the database enforces it, not only the code.
	"CREATE UNIQUE INDEX IF NOT EXISTS ideas_one_open_per_user ON ideas(user_id) WHERE status = 'open'",
	'CREATE INDEX IF NOT EXISTS ideas_status_created ON ideas(status, created_at)',
	'CREATE INDEX IF NOT EXISTS ideas_window_status ON ideas(window_id, status)',
	'CREATE INDEX IF NOT EXISTS ideas_unverified ON ideas(verified, status) WHERE verified = 0',
	'CREATE INDEX IF NOT EXISTS votes_idea ON votes(idea_id)',
	'CREATE INDEX IF NOT EXISTS votes_user_window ON votes(user_id, window_id)',
	// Exactly one open voting window at a time.
	"CREATE UNIQUE INDEX IF NOT EXISTS windows_one_open ON windows(status) WHERE status = 'open'",
	'CREATE INDEX IF NOT EXISTS windows_closes_at ON windows(closes_at)',
	'CREATE INDEX IF NOT EXISTS build_events_build ON build_events(build_id, id)',
	'CREATE INDEX IF NOT EXISTS ai_spend_created ON ai_spend(created_at)',
	// One record per key: a canvas cell, or one per person in a one-per-user collection.
	'CREATE UNIQUE INDEX IF NOT EXISTS store_items_key ON store_items(collection, key) WHERE key IS NOT NULL',
	'CREATE INDEX IF NOT EXISTS store_items_collection ON store_items(collection, id)',
	'CREATE INDEX IF NOT EXISTS store_items_user ON store_items(user_id)',
	'CREATE INDEX IF NOT EXISTS store_writes_user_at ON store_writes(user_id, at)',
	'CREATE INDEX IF NOT EXISTS store_writes_at ON store_writes(at)',
];

export type User = {
	id: number;
	provider: Provider;
	providerId: string;
	handle: string;
	name: string | null;
	avatarUrl: string | null;
	createdAt: string;
};

export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export type Idea = {
	id: number;
	userId: number;
	windowId: number;
	body: string;
	status: IdeaStatus;
	edits: number;
	createdAt: string;
	updatedAt: string;
	/** 0 while the AI review is still pending: the idea is up on regex checks only. */
	verified: number;
	removedReason: string | null;
};

export type Window = {
	id: number;
	/** Public cycle number shown on the site. */
	number: number;
	openedAt: string;
	closesAt: string;
	closedAt: string | null;
	status: 'open' | 'closed';
	winnerIdeaId: number | null;
	winnerVotes: number | null;
	ideasCount: number;
	votesCount: number;
	skipReason: SkipReason | null;
};

export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** A build is still running in these states. */
export const ACTIVE_BUILD_STATUSES: readonly BuildStatus[] = ['building', 'repairing'];

export type Build = {
	id: number;
	windowId: number | null;
	ideaId: number | null;
	cycle: number;
	ideaText: string;
	authorHandle: string;
	votes: number;
	status: BuildStatus;
	note: string | null;
	error: string | null;
	previousSha: string | null;
	commitSha: string | null;
	repairs: number;
	linesAdded: number;
	linesRemoved: number;
	files: string[];
	costUsd: number;
	startedAt: string;
	heartbeatAt: string | null;
	finishedAt: string | null;
	/** Built and tested but never applied to the site. */
	dryRun: boolean;
};

export type BuildEvent = {
	id: number;
	buildId: number;
	ts: string;
	tag: string;
	message: string;
};
