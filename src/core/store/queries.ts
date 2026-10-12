import { displayName } from '../auth/session';
import { all, get, run, transaction } from '../db/client';
import type { Provider } from '../db/schema';
import { KEY_PATTERN, STORE_LIMITS, validateRecord, type Collection } from './collections';

export type StoreItem = {
	id: number;
	/** The slot in an upsert-by-key collection; null otherwise. */
	key: string | null;
	data: Record<string, unknown>;
	/** "@handle", or the plain name for Google accounts. */
	author: string;
	mine: boolean;
	createdAt: string;
	updatedAt: string;
};

export type StoreList = {
	items: StoreItem[];
	total: number;
	/** For enum and bool fields: how many records hold each value. Polls and tallies need nothing else. */
	counts: Record<string, Record<string, number>>;
	/** Pass as `before` to get the next, older page; null when there is none. */
	next: number | null;
};

export type StoreError = 'invalid' | 'refused' | 'slow' | 'daily_limit' | 'full' | 'not_found' | 'wrong_mode';
export type StoreFailure = { ok: false; error: StoreError; field?: string; message: string };
export type StoreWrite = { ok: true; item: StoreItem } | StoreFailure;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Row = {
	id: number;
	key: string | null;
	data: string;
	userId: number;
	handle: string;
	provider: Provider;
	createdAt: string;
	updatedAt: string;
};

const SELECT = `SELECT s.id, s.key, s.data, s.user_id AS userId, u.handle, u.provider,
	s.created_at AS createdAt, s.updated_at AS updatedAt
	FROM store_items s JOIN users u ON u.id = s.user_id`;

function toItem(row: Row, viewerId: number | null): StoreItem {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(row.data);
	} catch {
		// A broken record shows as empty rather than taking the page down.
	}
	return {
		id: row.id,
		// One-per-user records are keyed by user internally; that key means nothing to a page.
		key: row.key?.startsWith('u:') ? null : row.key,
		data,
		author: displayName({ provider: row.provider, handle: row.handle }),
		mine: viewerId !== null && row.userId === viewerId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Newest first. Reading is public. */
export function listItems(
	collection: Collection,
	{ limit = 100, before = null, viewerId = null }: { limit?: number; before?: number | null; viewerId?: number | null } = {},
): StoreList {
	const size = Math.min(Math.max(1, Math.floor(limit)), STORE_LIMITS.listMax);
	const rows = all<Row>(
		`${SELECT} WHERE s.collection = ? AND s.id < ? ORDER BY s.id DESC LIMIT ?`,
		collection.name,
		before ?? Number.MAX_SAFE_INTEGER,
		size + 1,
	);
	const more = rows.length > size;
	const items = rows.slice(0, size).map((row) => toItem(row, viewerId));

	const counts: StoreList['counts'] = {};
	for (const [field, spec] of Object.entries(collection.fields)) {
		if (spec.type !== 'enum' && spec.type !== 'bool') continue;
		const tally: Record<string, number> = {};
		for (const { value, n } of all<{ value: unknown; n: number }>(
			`SELECT json_extract(data, ?) AS value, count(*) AS n FROM store_items
			 WHERE collection = ? AND json_extract(data, ?) IS NOT NULL GROUP BY value`,
			`$.${field}`,
			collection.name,
			`$.${field}`,
		)) {
			// JSON true/false come back from SQLite as 1/0.
			tally[spec.type === 'bool' ? String(value === 1) : String(value)] = n;
		}
		counts[field] = tally;
	}

	return {
		items,
		total: get<{ n: number }>('SELECT count(*) AS n FROM store_items WHERE collection = ?', collection.name)?.n ?? 0,
		counts,
		next: more ? items[items.length - 1].id : null,
	};
}

function itemById(id: number, viewerId: number) {
	const row = get<Row>(`${SELECT} WHERE s.id = ?`, id);
	return row ? toItem(row, viewerId) : null;
}

/** Per-hour (all collections) and per-day (this collection) limits, then the write itself, then a note of it. */
function limitedWrite(userId: number, collection: Collection, nowMs: number, write: () => number | StoreFailure): StoreWrite {
	return transaction((): StoreWrite => {
		const now = new Date(nowMs).toISOString();
		run('DELETE FROM store_writes WHERE at < ?', new Date(nowMs - DAY - HOUR).toISOString());

		const hour = get<{ n: number }>(
			'SELECT count(*) AS n FROM store_writes WHERE user_id = ? AND at > ?',
			userId,
			new Date(nowMs - HOUR).toISOString(),
		)!.n;
		if (hour >= STORE_LIMITS.writesPerHour) {
			return { ok: false, error: 'slow', message: 'You’ve saved a lot in the last hour. Try again a bit later.' };
		}
		const day = get<{ n: number }>(
			'SELECT count(*) AS n FROM store_writes WHERE user_id = ? AND collection = ? AND at > ?',
			userId,
			collection.name,
			new Date(nowMs - DAY).toISOString(),
		)!.n;
		if (day >= collection.perUserPerDay) {
			return { ok: false, error: 'daily_limit', message: `That’s ${collection.perUserPerDay} for today here. Come back tomorrow.` };
		}

		const id = write();
		if (typeof id !== 'number') return id;
		run('INSERT INTO store_writes (user_id, collection, at) VALUES (?, ?, ?)', userId, collection.name, now);
		return { ok: true, item: itemById(id, userId)! };
	});
}

function count(collection: Collection) {
	return get<{ n: number }>('SELECT count(*) AS n FROM store_items WHERE collection = ?', collection.name)!.n;
}

const FULL: StoreFailure = { ok: false, error: 'full', message: 'This feature has no room for new entries.' };

/** Upsert one keyed record. Whoever writes a slot last owns it. */
function upsert(userId: number, collection: Collection, key: string, data: Record<string, unknown>, now: string): number | StoreFailure {
	const exists = get('SELECT 1 FROM store_items WHERE collection = ? AND key = ?', collection.name, key);
	if (!exists && count(collection) >= STORE_LIMITS.itemsPerCollection) return FULL;
	return get<{ id: number }>(
		`INSERT INTO store_items (collection, key, user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (collection, key) WHERE key IS NOT NULL
		 DO UPDATE SET user_id = excluded.user_id, data = excluded.data, updated_at = excluded.updated_at
		 RETURNING id`,
		collection.name,
		key,
		userId,
		JSON.stringify(data),
		now,
		now,
	)!.id;
}

/** append: a new record (the oldest go past the limit). one-per-user: the visitor's own record, replaced. */
export function addItem(userId: number, collection: Collection, raw: unknown, nowMs = Date.now()): StoreWrite {
	if (collection.mode === 'upsert-by-key') {
		return { ok: false, error: 'wrong_mode', message: 'This collection saves by key: use put(key, data).' };
	}
	const checked = validateRecord(collection, raw);
	if (!checked.ok) return checked;
	const now = new Date(nowMs).toISOString();

	return limitedWrite(userId, collection, nowMs, () => {
		if (collection.mode === 'one-per-user') return upsert(userId, collection, `u:${userId}`, checked.data, now);
		const { id } = get<{ id: number }>(
			`INSERT INTO store_items (collection, key, user_id, data, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)
			 RETURNING id`,
			collection.name,
			userId,
			JSON.stringify(checked.data),
			now,
			now,
		)!;
		const over = count(collection) - STORE_LIMITS.itemsPerCollection;
		if (over > 0) {
			run(
				'DELETE FROM store_items WHERE id IN (SELECT id FROM store_items WHERE collection = ? ORDER BY id LIMIT ?)',
				collection.name,
				over,
			);
		}
		return id;
	});
}

/** upsert-by-key: write the record in one slot, like a canvas cell. */
export function putItem(userId: number, collection: Collection, key: unknown, raw: unknown, nowMs = Date.now()): StoreWrite {
	if (collection.mode !== 'upsert-by-key') {
		return { ok: false, error: 'wrong_mode', message: 'This collection doesn’t save by key: use add(data).' };
	}
	if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.startsWith('u:')) {
		return { ok: false, error: 'invalid', message: 'A key is 1 to 64 letters, digits, :, _ or -.' };
	}
	const checked = validateRecord(collection, raw);
	if (!checked.ok) return checked;
	const now = new Date(nowMs).toISOString();
	return limitedWrite(userId, collection, nowMs, () => upsert(userId, collection, key, checked.data, now));
}

/** People can remove what they wrote (in a keyed slot: if they wrote it last). */
export function removeItem(userId: number, collection: Collection, id: number): { ok: true } | StoreFailure {
	const removed = run('DELETE FROM store_items WHERE id = ? AND collection = ? AND user_id = ?', id, collection.name, userId).changes;
	return removed > 0 ? { ok: true } : { ok: false, error: 'not_found', message: 'That isn’t yours, or it’s already gone.' };
}

/** The person running the site can remove anything. */
export function removeAnyItem(collectionName: string, id: number) {
	return run('DELETE FROM store_items WHERE id = ? AND collection = ?', id, collectionName).changes > 0;
}
