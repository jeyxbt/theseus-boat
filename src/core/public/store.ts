/**
 * Shared data from the browser, for features built on this site. Declare the
 * collection in src/collections/<name>.json first. Reading is public; adding
 * needs a signed-in visitor. Every call resolves (never throws): check `ok`, and
 * show `message` to the visitor when it is false.
 *
 *   import { collection } from '../core/public/store';
 *   const book = collection<{ message: string }>('guestbook');
 *   const stop = book.watch((list) => render(list.items));
 *   const result = await book.add({ message: 'Hello' });
 */

export type StoreItem<T> = {
	id: number;
	/** The slot in an upsert-by-key collection; null otherwise. */
	key: string | null;
	data: T;
	/** Who wrote it: "@handle", or a name. */
	author: string;
	/** Written by the visitor looking at the page. */
	mine: boolean;
	createdAt: string;
	updatedAt: string;
};

export type StoreList<T> = {
	ok: boolean;
	/** Newest first. */
	items: StoreItem<T>[];
	total: number;
	/** For enum and bool fields: field → value → how many records have it. */
	counts: Record<string, Record<string, number>>;
	/** Whether the visitor can write. If not, link to /signin?returnTo=<this page>. */
	signedIn: boolean;
	/** Pass as `before` for the next, older page; null when there is none. */
	next: number | null;
	/** Set when the list couldn't be loaded. */
	message?: string;
};

export type StoreFailure = { ok: false; error: string; message: string; field?: string };
export type StoreResult<T> = { ok: true; item: StoreItem<T> } | StoreFailure;

const OFFLINE = 'Couldn’t reach the site. Check your connection and try again.';

async function call(method: string, path: string, body?: unknown) {
	try {
		const response = await fetch(path, {
			method,
			credentials: 'same-origin',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload = await response.json().catch(() => ({}));
		return { status: response.status, payload: payload as Record<string, unknown> };
	} catch {
		return { status: 0, payload: { error: 'network', message: OFFLINE } };
	}
}

function failed(status: number, payload: Record<string, unknown>): StoreFailure {
	return {
		ok: false,
		error: typeof payload.error === 'string' ? payload.error : `http_${status}`,
		message: typeof payload.message === 'string' ? payload.message : 'Something went wrong. Try again.',
		field: typeof payload.field === 'string' ? payload.field : undefined,
	};
}

export function collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
	const base = `/api/store/${encodeURIComponent(name)}`;

	async function list(options: { limit?: number; before?: number | null } = {}): Promise<StoreList<T>> {
		const query = new URLSearchParams();
		if (options.limit) query.set('limit', String(options.limit));
		if (options.before) query.set('before', String(options.before));
		const search = query.toString();
		const { status, payload } = await call('GET', search ? `${base}?${search}` : base);
		if (status !== 200) {
			return { ok: false, items: [], total: 0, counts: {}, signedIn: false, next: null, message: failed(status, payload).message };
		}
		return { ok: true, ...(payload as Omit<StoreList<T>, 'ok'>) };
	}

	async function write(method: string, path: string, data?: T): Promise<StoreResult<T>> {
		const { status, payload } = await call(method, path, data === undefined ? undefined : { data });
		if (status === 200 || status === 201) return { ok: true, item: payload.item as StoreItem<T> };
		return failed(status, payload);
	}

	return {
		list,
		/** append: add a record. one-per-user: save the visitor's own record, replacing the last one. */
		add: (data: T) => write('POST', base, data),
		/** upsert-by-key: save the record in one slot, like a canvas cell "12:7". */
		put: (key: string, data: T) => write('PUT', `${base}/${encodeURIComponent(key)}`, data),
		/** Remove a record the visitor wrote. */
		async remove(id: number): Promise<{ ok: true } | StoreFailure> {
			const { status, payload } = await call('DELETE', `${base}/${id}`);
			return status === 200 ? { ok: true } : failed(status, payload);
		},
		/**
		 * Calls `onChange` now and then every few seconds while the tab is visible,
		 * so everyone sees new records without reloading. Returns a function that stops it.
		 */
		watch(onChange: (list: StoreList<T>) => void, options: { everyMs?: number; limit?: number } = {}) {
			const every = Math.max(2000, options.everyMs ?? 5000);
			let stopped = false;
			const refresh = async () => {
				if (stopped || document.visibilityState === 'hidden') return;
				const result = await list({ limit: options.limit });
				if (!stopped) onChange(result);
			};
			refresh();
			const timer = setInterval(refresh, every);
			const onVisible = () => document.visibilityState === 'visible' && refresh();
			document.addEventListener('visibilitychange', onVisible);
			return () => {
				stopped = true;
				clearInterval(timer);
				document.removeEventListener('visibilitychange', onVisible);
			};
		},
	};
}
