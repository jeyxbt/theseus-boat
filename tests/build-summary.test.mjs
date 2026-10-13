import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('summary');

const { getDb } = await import('../src/core/db/client.ts');
const { MIGRATIONS, migrate } = await import('../src/core/db/migrations.ts');
const { whereToSee } = await import('../src/core/builds/pages.ts');
const { summaryFrom } = await import('../scripts/pipeline/summary.ts');
const { buildPrompt, repairPrompt, SUMMARY_MARKERS } = await import('../scripts/pipeline/prompt.ts');

const wrap = (text) => `I built it.\n${SUMMARY_MARKERS.open}\n${text}\n${SUMMARY_MARKERS.close}`;
const NOTE = 'There is a new Welcome page at /welcome. It greets you by the time of day and waves at you.';

describe('the visitors note from the agent', () => {
	test('is the text between the markers, on one line', () => {
		assert.equal(summaryFrom(wrap(`  There is a new Welcome page at /welcome.\n\nIt greets you by the time of day and waves at you.  `)), NOTE);
	});

	test('takes the last note when the agent wrote more than one', () => {
		assert.equal(summaryFrom(`${wrap('An older note that is long enough to count.')}\n${wrap(NOTE)}`), NOTE);
	});

	test('is missing without both markers, or when too short', () => {
		assert.equal(summaryFrom(NOTE), null);
		assert.equal(summaryFrom(`${SUMMARY_MARKERS.open}\n${NOTE}`), null);
		assert.equal(summaryFrom(wrap('Done.')), null);
		assert.equal(summaryFrom(''), null);
	});

	test('drops links to other sites and markup, keeps addresses on this site', () => {
		const note = summaryFrom(wrap('Open /games to play. More at https://evil.example/x and www.evil.example, <b>bold</b> `code`.'));
		assert.equal(note, 'Open /games to play. More at and bbold/b code.');
		assert.doesNotMatch(note, /evil|https?:/);
	});

	test('is refused whole when it carries a secret', () => {
		assert.equal(summaryFrom(wrap(`A new page. The key is sk-ant-${'a'.repeat(30)} by the way.`)), null);
		assert.equal(summaryFrom(wrap('A new page, and the value is super-secret-value-123 here.'), ['super-secret-value-123']), null);
		assert.equal(summaryFrom(wrap('A new page that prints the API key for everyone to read.')), null);
	});

	test('is cut to a bounded length', () => {
		const note = summaryFrom(wrap('A long note. '.repeat(100)));
		assert.ok(note.length <= 600);
		assert.ok(note.endsWith('…'));
	});
});

describe('where to see a change', () => {
	const files = ['src/pages/index.astro', 'src/pages/welcome.astro', 'src/components/Wave.astro'];

	test('lists its own pages first, then the home page', () => {
		assert.deepEqual(whereToSee({ status: 'live', files }), [
			{ href: '/welcome', label: 'Open /welcome' },
			{ href: '/', label: 'See it on the home page' },
		]);
	});

	test('is empty for a change that is not on the site', () => {
		assert.deepEqual(whereToSee({ status: 'rolled_back', files }), []);
		assert.deepEqual(whereToSee({ status: 'building', files }), []);
		assert.deepEqual(whereToSee({ status: 'live', dryRun: true, files }), []);
	});
});

describe('the build prompt', () => {
	const winner = { windowId: 1, number: 7, ideaId: 1, ideaText: 'Create a Welcome page', authorHandle: 'a', votes: 1 };
	const site = { pages: ['src/pages/index.astro'], built: [] };

	test('asks for exactly what the visitors asked, and for the note', () => {
		const prompt = buildPrompt(winner, site);
		assert.match(prompt, /as close to their words as the rules allow/);
		assert.match(prompt, /A "welcome page" is a new page, not a banner/);
		assert.ok(prompt.includes(SUMMARY_MARKERS.open) && prompt.includes(SUMMARY_MARKERS.close));
	});

	test('asks a repair for the note on the whole change', () => {
		const prompt = repairPrompt(winner, site, { reason: 'the build failed', details: 'x' });
		assert.ok(prompt.includes(SUMMARY_MARKERS.open));
		assert.match(prompt, /all of it, not only the fix/);
	});
});

describe('the summary column', () => {
	test('exists on a fresh database', () => {
		const columns = getDb().prepare('PRAGMA table_info(builds)').all().map((column) => column.name);
		assert.ok(columns.includes('summary'));
	});

	test('is added to a database made before it', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE builds (id INTEGER PRIMARY KEY, files TEXT)');
		migrate(db, false);
		assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
		assert.ok(db.prepare('PRAGMA table_info(builds)').all().some((column) => column.name === 'summary'));
	});
});
