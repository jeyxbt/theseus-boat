import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('votes');

const { get, nowIso } = await import('../src/core/db/client.ts');
const { submitIdea, withdrawIdea } = await import('../src/core/ideas/queries.ts');
const { toggleVote, myVotes, voteCounts, MAX_VOTES } = await import('../src/core/votes/queries.ts');

let counter = 0;
function makeUser() {
	counter++;
	return get(
		"INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', ?, ?, ?) RETURNING id",
		`v${counter}`,
		`voter${counter}`,
		nowIso(),
	).id;
}

let ideaCounter = 0;
/** Each idea gets its own made-up words, so none of them look like duplicates. */
function uniqueText() {
	ideaCounter++;
	const tag = (n) => `zq${(ideaCounter * 7919 + n).toString(36)}`;
	return `Build ${tag(1)} ${tag(2)} ${tag(3)} for visitors`;
}
function makeIdea() {
	const result = submitIdea(makeUser(), uniqueText());
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.idea.id;
}

describe('toggling', () => {
	test('a vote counts, a second click takes it back', () => {
		const voter = makeUser();
		const idea = makeIdea();
		assert.deepEqual(toggleVote(voter, idea), { ok: true, voted: true, votes: 1, used: 1 });
		assert.deepEqual(toggleVote(voter, idea), { ok: true, voted: false, votes: 0, used: 0 });
	});

	test(`at most ${MAX_VOTES} votes at once`, () => {
		const voter = makeUser();
		const ideas = Array.from({ length: MAX_VOTES + 1 }, makeIdea);
		for (const idea of ideas.slice(0, MAX_VOTES)) assert.equal(toggleVote(voter, idea).ok, true);
		assert.deepEqual(toggleVote(voter, ideas[MAX_VOTES]), { ok: false, error: 'no_votes_left', used: MAX_VOTES });
	});

	test('taking a vote back frees it for another idea', () => {
		const voter = makeUser();
		const ideas = Array.from({ length: MAX_VOTES + 1 }, makeIdea);
		for (const idea of ideas.slice(0, MAX_VOTES)) toggleVote(voter, idea);
		toggleVote(voter, ideas[0]);
		assert.equal(toggleVote(voter, ideas[MAX_VOTES]).ok, true);
		assert.deepEqual(myVotes(voter).sort(), [ideas[1], ideas[2], ideas[3]].sort());
	});

	test("you can't vote for your own idea", () => {
		const author = makeUser();
		const { idea } = submitIdea(author, 'A tiny weather station drawn in ascii art');
		assert.equal(toggleVote(author, idea.id).error, 'own_idea');
	});

	test('missing or closed ideas cannot be voted on', () => {
		const voter = makeUser();
		assert.equal(toggleVote(voter, 999999).error, 'not_found');

		const author = makeUser();
		const { idea } = submitIdea(author, 'A paper boat race that runs every afternoon');
		withdrawIdea(author, idea.id);
		assert.equal(toggleVote(voter, idea.id).error, 'not_found');
	});
});

describe('withdrawn ideas give votes back', () => {
	test('a voter who used all votes gets one back when an idea is withdrawn', () => {
		const voter = makeUser();
		const authors = [makeUser(), makeUser(), makeUser()];
		const ideas = authors.map((author) => submitIdea(author, uniqueText()).idea.id);
		for (const idea of ideas) toggleVote(voter, idea);
		assert.equal(myVotes(voter).length, 3);

		withdrawIdea(authors[0], ideas[0]);
		assert.equal(myVotes(voter).length, 2);
		assert.equal(toggleVote(voter, makeIdea()).ok, true);
	});
});

describe('counts', () => {
	test('voteCounts lists every open idea, zero included', () => {
		const idea = makeIdea();
		const voter = makeUser();
		toggleVote(voter, idea);
		const counts = new Map(voteCounts().map((row) => [row.id, row.votes]));
		assert.equal(counts.get(idea), 1);
		const lonely = makeIdea();
		assert.equal(new Map(voteCounts().map((row) => [row.id, row.votes])).get(lonely), 0);
	});

	test('many voters on one idea add up', () => {
		const idea = makeIdea();
		for (let i = 0; i < 7; i++) toggleVote(makeUser(), idea);
		assert.equal(get('SELECT count(*) AS n FROM votes WHERE idea_id = ?', idea).n, 7);
	});
});
