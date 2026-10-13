import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

process.env.WINDOW_MINUTES = '60';
const DB_URL = useTempDatabase('windows');

const { get, run, nowIso } = await import('../src/core/db/client.ts');
const { tickWindows, currentWindow, closeWindowNow, getOpenWindow, lastClosedWindow, listClosedWindows } =
	await import('../src/core/cycle/windows.ts');
const { submitIdea, editIdea, withdrawIdea, getMyOpenIdea } = await import('../src/core/ideas/queries.ts');
const { toggleVote, myVotes } = await import('../src/core/votes/queries.ts');
const { setSetting } = await import('../src/core/settings.ts');

const HOUR = 60 * 60 * 1000;

let counter = 0;
function makeUser() {
	counter++;
	return get(
		"INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', ?, ?, ?) RETURNING id",
		`w${counter}`,
		`person${counter}`,
		nowIso(),
	).id;
}

let ideaCounter = 0;
/** Distinct made-up words, so no idea looks like a duplicate of another. */
function text() {
	ideaCounter++;
	const tag = (n) => `qx${(ideaCounter * 7919 + n).toString(36)}`;
	return `Build ${tag(1)} ${tag(2)} ${tag(3)} for visitors`;
}

/** Opens a fresh window that starts at `start`, closing whatever was open. */
function freshWindow(start) {
	run("UPDATE ideas SET status = 'removed' WHERE status = 'open'");
	const open = getOpenWindow();
	if (open) run("UPDATE windows SET closes_at = ? WHERE id = ?", new Date(start).toISOString(), open.id);
	return tickWindows(start).current;
}

function ideaWithVotes(votes, at) {
	const idea = submitIdea(makeUser(), text(), at).idea;
	for (let i = 0; i < votes; i++) assert.equal(toggleVote(makeUser(), idea.id, at).ok, true);
	return idea;
}

describe('opening', () => {
	test('the first tick opens window 1 for a full window length', () => {
		const now = Date.parse('2026-10-09T00:00:00Z');
		const { current, opened } = tickWindows(now);
		assert.equal(opened.id, current.id);
		assert.equal(current.number, 1);
		assert.equal(current.openedAt, '2026-10-09T00:00:00.000Z');
		assert.equal(Date.parse(current.closesAt) - Date.parse(current.openedAt), HOUR);
	});

	test('ticking again before the close changes nothing', () => {
		const before = getOpenWindow();
		const { closed, opened, current } = tickWindows(Date.parse(before.closesAt) - 1);
		assert.equal(closed, null);
		assert.equal(opened, null);
		assert.equal(current.id, before.id);
	});

	test('there is never more than one open window', () => {
		assert.throws(() =>
			run(
				"INSERT INTO windows (number, opened_at, closes_at, status) VALUES (999, ?, ?, 'open')",
				nowIso(),
				nowIso(),
			),
		);
	});
});

describe('closing', () => {
	test('the most-voted idea wins; the rest lose; the next window opens at the close', () => {
		const start = Date.parse('2026-10-10T00:00:00Z');
		const window = freshWindow(start);
		const a = ideaWithVotes(5, start + 1000);
		const b = ideaWithVotes(3, start + 2000);
		const c = ideaWithVotes(0, start + 3000);

		const closeAt = Date.parse(window.closesAt);
		const { closed, opened } = tickWindows(closeAt + 5000);

		assert.equal(closed.id, window.id);
		assert.equal(closed.status, 'closed');
		assert.equal(closed.winnerIdeaId, a.id);
		assert.equal(closed.winnerVotes, 5);
		assert.equal(closed.ideasCount, 3);
		assert.equal(closed.votesCount, 8);
		assert.equal(closed.skipReason, null);
		assert.equal(get('SELECT status FROM ideas WHERE id = ?', a.id).status, 'won');
		assert.equal(get('SELECT status FROM ideas WHERE id = ?', b.id).status, 'lost');
		assert.equal(get('SELECT status FROM ideas WHERE id = ?', c.id).status, 'lost');

		assert.equal(opened.number, window.number + 1);
		assert.equal(opened.openedAt, new Date(closeAt + 5000).toISOString());
		assert.equal(Date.parse(opened.closesAt) - Date.parse(opened.openedAt), HOUR);
	});

	test('a tie goes to the idea proposed first', () => {
		const start = Date.parse('2026-10-11T00:00:00Z');
		const window = freshWindow(start);
		const first = ideaWithVotes(4, start + 1000);
		ideaWithVotes(4, start + 2000);
		const { closed } = tickWindows(Date.parse(window.closesAt));
		assert.equal(closed.winnerIdeaId, first.id);
	});

	test(`fewer than 3 votes: no winner, every idea lost`, () => {
		const start = Date.parse('2026-10-12T00:00:00Z');
		const window = freshWindow(start);
		const idea = ideaWithVotes(2, start + 1000);
		const { closed } = tickWindows(Date.parse(window.closesAt));
		assert.equal(closed.winnerIdeaId, null);
		assert.equal(closed.skipReason, 'not_enough_votes');
		assert.equal(get('SELECT status FROM ideas WHERE id = ?', idea.id).status, 'lost');
	});

	test('no ideas at all: skipped as no_ideas', () => {
		const start = Date.parse('2026-10-13T00:00:00Z');
		const window = freshWindow(start);
		const { closed } = tickWindows(Date.parse(window.closesAt));
		assert.equal(closed.skipReason, 'no_ideas');
		assert.equal(closed.ideasCount, 0);
	});

	test('the threshold comes from settings', () => {
		const start = Date.parse('2026-10-14T00:00:00Z');
		setSetting('min_votes', 1);
		const window = freshWindow(start);
		const idea = ideaWithVotes(1, start + 1000);
		const { closed } = tickWindows(Date.parse(window.closesAt));
		setSetting('min_votes', 3);
		assert.equal(closed.winnerIdeaId, idea.id);
	});

	test('closing twice at the same moment closes once', () => {
		const start = Date.parse('2026-10-15T00:00:00Z');
		const window = freshWindow(start);
		const at = Date.parse(window.closesAt);
		const first = tickWindows(at);
		const second = tickWindows(at);
		assert.equal(first.closed.id, window.id);
		assert.equal(second.closed, null);
		assert.equal(second.current.id, first.opened.id);
	});

	test('lastClosedWindow carries the winning text and author', () => {
		const start = Date.parse('2026-10-16T00:00:00Z');
		const window = freshWindow(start);
		const idea = ideaWithVotes(3, start + 1000);
		tickWindows(Date.parse(window.closesAt));
		const last = lastClosedWindow();
		assert.equal(last.id, window.id);
		assert.equal(last.winnerText, idea.body);
		assert.ok(last.winnerHandle.startsWith('person'));
		assert.ok(listClosedWindows().length >= 5);
	});
});

describe('the moment voting ends', () => {
	test('after closes_at, votes, edits and withdrawals are refused even before the close runs', () => {
		const start = Date.parse('2026-10-17T00:00:00Z');
		const window = freshWindow(start);
		const author = makeUser();
		const idea = submitIdea(author, text(), start + 1000).idea;
		const late = Date.parse(window.closesAt) + 1;

		assert.equal(toggleVote(makeUser(), idea.id, late).error, 'window_closed');
		assert.equal(editIdea(author, idea.id, text(), late).error, 'window_closed');
		assert.equal(withdrawIdea(author, idea.id, late), 'window_closed');
	});

	test('a new idea after closes_at goes into the next window', () => {
		const start = Date.parse('2026-10-18T00:00:00Z');
		const window = freshWindow(start);
		const late = Date.parse(window.closesAt) + 1;
		const result = submitIdea(makeUser(), text(), late);
		assert.equal(result.ok, true);
		assert.notEqual(result.idea.windowId, window.id);
		assert.equal(result.idea.windowId, getOpenWindow().id);
	});

	test('after the close, votes come back and authors can propose again', () => {
		const start = Date.parse('2026-10-19T00:00:00Z');
		const window = freshWindow(start);
		const author = makeUser();
		const voter = makeUser();
		const idea = submitIdea(author, text(), start + 1000).idea;
		toggleVote(voter, idea.id, start + 2000);
		assert.equal(myVotes(voter).length, 1);

		tickWindows(Date.parse(window.closesAt));
		assert.equal(myVotes(voter).length, 0);
		assert.equal(getMyOpenIdea(author), null);
		assert.equal(submitIdea(author, text(), Date.parse(window.closesAt) + 1000).ok, true);
		// History stays: the vote row is still there, it just no longer counts.
		assert.equal(get('SELECT count(*) AS n FROM votes WHERE idea_id = ?', idea.id).n, 1);
	});

	test('a stale close for a window that already rolled over closes nothing else', () => {
		const open = currentWindow();
		const late = Date.parse(open.closesAt) + 1000;
		// The window ran out on its own; the button still points at it.
		const { closed, current } = closeWindowNow(late, open.id);
		assert.equal(closed.id, open.id);
		const fresh = current;
		// Pressing it again for the old id must leave the fresh window alone.
		const again = closeWindowNow(late + 1000, open.id);
		assert.equal(again.closed, null);
		assert.equal(again.current.id, fresh.id);
		assert.equal(getOpenWindow().id, fresh.id);
	});

	test('a blank min_votes setting falls back to 3, not 0', async () => {
		const { minVotes } = await import('../src/core/settings.ts');
		setSetting('min_votes', '');
		assert.equal(minVotes(), 3);
		setSetting('min_votes', 3);
	});

	test('closeWindowNow ends the open window immediately', () => {
		const before = currentWindow();
		const { closed, current } = closeWindowNow(Date.parse(before.openedAt) + 1000);
		assert.equal(closed.id, before.id);
		assert.equal(current.number, before.number + 1);
	});
});

describe('numbering', () => {
	test('continues after the highest build cycle, so numbers never collide', () => {
		run(
			`INSERT INTO builds (cycle, idea_text, author_handle, status, started_at)
			 VALUES (500, 'a build recorded without a window', 'someone', 'live', ?)`,
			nowIso(),
		);
		const before = currentWindow();
		const { current } = closeWindowNow(Date.parse(before.openedAt) + 1000);
		assert.equal(current.number, 501);
	});
});

describe('two processes closing at once', () => {
	test('exactly one close and one new window', async () => {
		const window = currentWindow();
		const at = Date.parse(window.closesAt) + 1000;
		const script = `import { tickWindows } from './src/core/cycle/windows.ts'; const t = tickWindows(${at}); console.log(JSON.stringify({ closed: t.closed?.id ?? null, current: t.current.id }));`;

		const runOne = () =>
			new Promise((resolve, reject) => {
				const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
					cwd: new URL('..', import.meta.url),
					env: { ...process.env, DATABASE_URL: DB_URL },
				});
				let out = '';
				let err = '';
				child.stdout.on('data', (chunk) => (out += chunk));
				child.stderr.on('data', (chunk) => (err += chunk));
				child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err))));
			});

		const [a, b] = await Promise.all([runOne(), runOne()]);
		const closers = [a, b].filter((r) => r.closed === window.id);
		assert.equal(closers.length, 1, JSON.stringify([a, b]));
		assert.equal(a.current, b.current);
		assert.equal(get("SELECT count(*) AS n FROM windows WHERE status = 'open'").n, 1);
		assert.equal(get('SELECT status FROM windows WHERE id = ?', window.id).status, 'closed');
	});
});
