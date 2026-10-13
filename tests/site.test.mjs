import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitUrl, REPO_URL } from '../src/core/site.ts';

test('commitUrl links a real sha to the repository', () => {
	assert.equal(commitUrl('789e2b6'), `${REPO_URL}/commit/789e2b6`);
	assert.equal(commitUrl('5cb52eee7fcf98d28dc9be426bcacdee3d3653f8'), `${REPO_URL}/commit/5cb52eee7fcf98d28dc9be426bcacdee3d3653f8`);
});

test('commitUrl refuses anything that is not a sha', () => {
	for (const value of [null, undefined, '', 'abc', 'not-a-sha', '789e2b6/../x', 'javascript:alert(1)']) {
		assert.equal(commitUrl(value), null);
	}
});
