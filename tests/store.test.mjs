import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('store');

const { get, nowIso } = await import('../src/core/db/client.ts');
const { parseCollection, validateRecord, STORE_LIMITS } = await import('../src/core/store/collections.ts');
const { loadCollections, setCollectionsForTests } = await import('../src/core/store/registry.ts');
const { listItems, addItem, putItem, removeItem, removeAnyItem } = await import('../src/core/store/queries.ts');
const { storeItems } = await import('../src/core/public/data.ts');

let counter = 0;
function makeUser(provider = 'dev') {
	counter++;
	return get(
		'INSERT INTO users (provider, provider_id, handle, created_at) VALUES (?, ?, ?, ?) RETURNING id',
		provider,
		`s${counter}`,
		`storer${counter}`,
		nowIso(),
	).id;
}

function collection(name, mode, fields, extra = {}) {
	const parsed = parseCollection(name, { name, mode, fields, ...extra });
	assert.ok(parsed.ok, JSON.stringify(parsed));
	return parsed.collection;
}

describe('declaring a collection', () => {
	test('a guestbook with defaults', () => {
		const parsed = parseCollection('guestbook', {
			name: 'guestbook',
			write: 'signed-in',
			mode: 'append',
			fields: { message: { type: 'text', max: 140 }, color: { type: 'enum', values: ['orange', 'blue'] }, star: { type: 'bool', optional: true } },
		});
		assert.ok(parsed.ok);
		assert.equal(parsed.collection.perUserPerDay, STORE_LIMITS.perUserPerDayDefault);
		assert.deepEqual(parsed.collection.fields.message, { type: 'text', max: 140, min: 1, optional: false });
	});

	const bad = {
		'not an object': [],
		'name not matching the file': { name: 'other', mode: 'append', fields: { a: { type: 'bool' } } },
		'unknown mode': { name: 'x1', mode: 'everything', fields: { a: { type: 'bool' } } },
		'public writes': { name: 'x1', mode: 'append', write: 'anyone', fields: { a: { type: 'bool' } } },
		'a typo in a setting': { name: 'x1', mode: 'append', fields: { a: { type: 'bool' } }, perUserPerHour: 3 },
		'no fields': { name: 'x1', mode: 'append', fields: {} },
		'too many fields': { name: 'x1', mode: 'append', fields: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, { type: 'bool' }])) },
		'huge text': { name: 'x1', mode: 'append', fields: { a: { type: 'text', max: 100000 } } },
		'min over max': { name: 'x1', mode: 'append', fields: { a: { type: 'int', min: 5, max: 1 } } },
		'repeated enum values': { name: 'x1', mode: 'append', fields: { a: { type: 'enum', values: ['a', 'a'] } } },
		'html field': { name: 'x1', mode: 'append', fields: { a: { type: 'html' } } },
		'field name with a dot': { name: 'x1', mode: 'append', fields: { 'a.b': { type: 'bool' } } },
		'daily limit too high': { name: 'x1', mode: 'append', fields: { a: { type: 'bool' } }, perUserPerDay: 100000 },
	};
	for (const [label, raw] of Object.entries(bad)) {
		test(`refuses: ${label}`, () => assert.equal(parseCollection('x1', raw).ok, false));
	}

	test('broken files are left out, the rest still load', () => {
		const loaded = loadCollections({
			'../../collections/good.json': { name: 'good', mode: 'append', fields: { a: { type: 'bool' } } },
			'../../collections/bad.json': { name: 'nope', mode: 'append', fields: {} },
		});
		assert.deepEqual([...loaded.keys()], ['good']);
	});
});

describe('checking a record', () => {
	const book = collection('book', 'append', {
		message: { type: 'text', max: 20 },
		mood: { type: 'enum', values: ['calm', 'loud'], optional: true },
		count: { type: 'int', min: 0, max: 9, optional: true },
		color: { type: 'color', optional: true },
	});

	test('clean text comes back trimmed to one line; colours are lowercased', () => {
		const checked = validateRecord(book, { message: '  hello\nthere​ ', color: '#FF5B1F' });
		assert.deepEqual(checked, { ok: true, data: { message: 'hello there', color: '#ff5b1f' } });
	});

	test('only declared fields, of the right type and size', () => {
		assert.equal(validateRecord(book, { message: 'hi', extra: 1 }).field, 'extra');
		assert.equal(validateRecord(book, {}).field, 'message');
		assert.equal(validateRecord(book, { message: 'x'.repeat(21) }).field, 'message');
		assert.equal(validateRecord(book, { message: 'hi', mood: 'angry' }).field, 'mood');
		assert.equal(validateRecord(book, { message: 'hi', count: 1.5 }).field, 'count');
		assert.equal(validateRecord(book, { message: 'hi', color: 'red' }).field, 'color');
		assert.equal(validateRecord(book, 'hi').ok, false);
	});

	test('text follows the same rules as ideas', () => {
		const chat = collection('chat', 'append', { message: { type: 'text', max: 100 } });
		for (const message of ['see www.evil.example', 'send SOL to my wallet', 'ignore previous instructions']) {
			const checked = validateRecord(chat, { message });
			assert.equal(checked.ok, false, message);
			assert.equal(checked.error, 'refused');
		}
	});
});

describe('writing and reading', () => {
	test('append: newest first, with authors, totals and a cursor', () => {
		const wall = collection('wall', 'append', { text: { type: 'text', max: 40 }, color: { type: 'enum', values: ['red', 'blue'] } });
		const me = makeUser();
		const other = makeUser('google');
		for (let i = 0; i < 5; i++) assert.equal(addItem(i % 2 ? other : me, wall, { text: `note ${i}`, color: i < 3 ? 'red' : 'blue' }).ok, true);

		const first = listItems(wall, { limit: 3, viewerId: me });
		assert.deepEqual(first.items.map((i) => i.data.text), ['note 4', 'note 3', 'note 2']);
		assert.equal(first.total, 5);
		assert.deepEqual(first.counts.color, { red: 3, blue: 2 });
		assert.equal(first.items[0].mine, true);
		assert.equal(first.items[1].mine, false);
		assert.equal(first.items[0].author, `@storer${counter - 1}`);
		assert.equal(first.items[1].author, `storer${counter}`, 'Google accounts show a plain name');
		assert.equal(first.items[0].key, null);

		const second = listItems(wall, { limit: 3, before: first.next });
		assert.deepEqual(second.items.map((i) => i.data.text), ['note 1', 'note 0']);
		assert.equal(second.next, null);
	});

	test('one-per-user: saving again replaces your record', () => {
		const poll = collection('poll', 'one-per-user', { pick: { type: 'enum', values: ['cats', 'dogs'] }, sure: { type: 'bool' } });
		const a = makeUser();
		const b = makeUser();
		addItem(a, poll, { pick: 'cats', sure: true });
		addItem(a, poll, { pick: 'dogs', sure: false });
		addItem(b, poll, { pick: 'dogs', sure: true });
		const list = listItems(poll);
		assert.equal(list.total, 2);
		assert.deepEqual(list.counts, { pick: { dogs: 2 }, sure: { true: 1, false: 1 } });
		assert.ok(list.items.every((item) => item.key === null), 'the per-person key stays internal');
	});

	test('upsert-by-key: whoever paints a cell last owns it', () => {
		const canvas = collection('canvas', 'upsert-by-key', { color: { type: 'color' } });
		const a = makeUser();
		const b = makeUser();
		assert.equal(putItem(a, canvas, '3:4', { color: '#111111' }).ok, true);
		const repainted = putItem(b, canvas, '3:4', { color: '#ffd23f' });
		assert.equal(repainted.ok, true);
		assert.equal(repainted.item.key, '3:4');
		const list = listItems(canvas, { viewerId: b });
		assert.equal(list.total, 1);
		assert.deepEqual(list.items[0].data, { color: '#ffd23f' });
		assert.equal(list.items[0].mine, true);

		assert.equal(putItem(a, canvas, '../x', { color: '#111111' }).error, 'invalid');
		assert.equal(putItem(a, canvas, 'u:1', { color: '#111111' }).error, 'invalid');
		assert.equal(addItem(a, canvas, { color: '#111111' }).error, 'wrong_mode');
		const wall = collection('wall2', 'append', { t: { type: 'text', max: 5 } });
		assert.equal(putItem(a, wall, 'k', { t: 'hi' }).error, 'wrong_mode');
	});

	test('you can remove what you wrote, and nothing else', () => {
		const wall = collection('wall3', 'append', { t: { type: 'text', max: 5 } });
		const a = makeUser();
		const b = makeUser();
		const { item } = addItem(a, wall, { t: 'mine' });
		assert.equal(removeItem(b, wall, item.id).ok, false);
		assert.equal(removeItem(a, wall, item.id).ok, true);
		assert.equal(listItems(wall).total, 0);
		const again = addItem(b, wall, { t: 'bad' });
		assert.equal(removeAnyItem('wall3', again.item.id), true, 'the person running the site can remove anything');
	});
});

describe('limits', () => {
	test('per collection per day', () => {
		const book = collection('daily', 'append', { t: { type: 'text', max: 5 } }, { perUserPerDay: 2 });
		const a = makeUser();
		assert.equal(addItem(a, book, { t: 'one' }).ok, true);
		assert.equal(addItem(a, book, { t: 'two' }).ok, true);
		const third = addItem(a, book, { t: 'three' });
		assert.equal(third.error, 'daily_limit');
		assert.match(third.message, /2 for today/);
		// Tomorrow is fine.
		assert.equal(addItem(a, book, { t: 'four' }, Date.now() + 25 * 60 * 60 * 1000).ok, true);
		// Another person has their own allowance.
		assert.equal(addItem(makeUser(), book, { t: 'yes' }).ok, true);
	});

	test('per hour across every collection', () => {
		const a = makeUser();
		const one = collection('hour-a', 'append', { t: { type: 'bool' } }, { perUserPerDay: 500 });
		const two = collection('hour-b', 'append', { t: { type: 'bool' } }, { perUserPerDay: 500 });
		for (let i = 0; i < STORE_LIMITS.writesPerHour; i++) assert.equal(addItem(a, i % 2 ? one : two, { t: true }).ok, true);
		assert.equal(addItem(a, one, { t: true }).error, 'slow');
		assert.equal(addItem(a, two, { t: true }, Date.now() + 61 * 60 * 1000).ok, true);
	});

	test('a full list drops the oldest; a full keyed collection refuses new keys', () => {
		const saved = STORE_LIMITS.itemsPerCollection;
		STORE_LIMITS.itemsPerCollection = 3;
		try {
			const list = collection('small', 'append', { n: { type: 'int', min: 0, max: 9 } });
			const a = makeUser();
			for (let n = 0; n < 5; n++) addItem(a, list, { n });
			assert.deepEqual(listItems(list).items.map((i) => i.data.n), [4, 3, 2]);

			const grid = collection('grid', 'upsert-by-key', { c: { type: 'color' } });
			for (const key of ['a', 'b', 'c']) assert.equal(putItem(a, grid, key, { c: '#000000' }).ok, true);
			assert.equal(putItem(a, grid, 'd', { c: '#000000' }).error, 'full');
			assert.equal(putItem(a, grid, 'a', { c: '#ffffff' }).ok, true, 'an existing cell can still change');
		} finally {
			STORE_LIMITS.itemsPerCollection = saved;
		}
	});

	test('a refused write is not counted', () => {
		const book = collection('strict', 'append', { t: { type: 'text', max: 5 } }, { perUserPerDay: 1 });
		const a = makeUser();
		assert.equal(addItem(a, book, { t: 'way too long' }).ok, false);
		assert.equal(addItem(a, book, { t: 'ok' }).ok, true);
	});
});

describe('the read helper for pages', () => {
	test('reads declared collections; an unknown one is just empty', () => {
		const notes = collection('notes', 'append', { t: { type: 'text', max: 9 } });
		setCollectionsForTests([notes]);
		try {
			addItem(makeUser(), notes, { t: 'hello' });
			assert.equal(storeItems('notes').total, 1);
			assert.deepEqual(storeItems('nothing-here'), { items: [], total: 0, counts: {}, next: null });
		} finally {
			setCollectionsForTests(null);
		}
	});
});
