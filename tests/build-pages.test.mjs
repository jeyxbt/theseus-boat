import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageLinks, routesFor } from '../src/core/builds/pages.ts';
import { buildPrompt } from '../scripts/pipeline/prompt.ts';

test('routesFor maps page files to routes and skips dynamic ones', () => {
	assert.deepEqual(routesFor(['src/pages/index.astro', 'src/pages/welcome.astro', 'src/pages/games/snake.astro', 'src/pages/games/index.astro', 'src/pages/[slug].astro', 'src/components/Hero.astro']), [
		'/',
		'/welcome',
		'/games/snake',
		'/games',
	]);
});

test('pageLinks lists the new pages of a live build, never the home page', () => {
	const files = ['src/pages/index.astro', 'src/pages/welcome.astro', 'src/components/Wave.astro'];
	assert.deepEqual(pageLinks({ status: 'live', files }), ['/welcome']);
	assert.deepEqual(pageLinks({ status: 'rolled_back', files }), []);
	assert.deepEqual(pageLinks({ status: 'failed', files }), []);
	assert.deepEqual(pageLinks({ status: 'live', files: ['src/pages/index.astro'] }), []);
});

test('the build prompt invites new pages and big features', () => {
	const winner = { windowId: 1, number: 7, ideaId: 1, ideaText: 'Create a Welcome page', authorHandle: 'a', votes: 1 };
	const prompt = buildPrompt(winner, { pages: ['src/pages/index.astro'], built: [] });
	assert.match(prompt, /You are not limited to them/);
	assert.match(prompt, /src\/pages\/<name>\.astro is served at \/<name>/);
	assert.match(prompt, /give it its own new page/);
	assert.doesNotMatch(prompt, /Keep the change small/);
});
