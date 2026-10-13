/**
 * Does the Anthropic API work from here, with this key? Runs the two things the
 * site uses it for, for a few cents:
 *
 *   pnpm ai:check            both
 *   pnpm ai:check --no-agent only the idea review (about a cent)
 *
 * 1. The idea review (MODERATION_MODEL and FINAL_GATE_MODEL) on a harmless idea
 *    and on one it must refuse.
 * 2. The build agent (CLAUDE_MODEL) on a tiny task in a scratch folder: it must
 *    create one page through its tools, and be refused when it reaches for the core.
 *
 * Never prints the key.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewIdea } from '../src/core/moderation/index';
import { pipelineConfig } from './pipeline/config';
import { runSdkAgent } from './pipeline/sdk-agent';

if (!process.env.ANTHROPIC_API_KEY) {
	console.error('ANTHROPIC_API_KEY is not set. Put it in .env (the file git ignores) and run this again.');
	process.exit(2);
}
process.env.MODERATION_PROVIDER = 'api';

let failed = 0;
const seen: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) {
		failed++;
		seen.push(detail);
	}
};

/** What to do about the failures that have a known cause. */
function hints() {
	const all = seen.join('\n');
	if (/workspace/i.test(all) && /400/.test(all)) {
		console.log(
			'\nThe key is not scoped to a workspace, so the API needs to be told which one. Either make the key inside a workspace\n' +
				'in the Console (the key then belongs to it), or set ANTHROPIC_WORKSPACE_ID in .env to that workspace’s ID (wrkspc_…).',
		);
	}
	if (/\b401\b|authentication/i.test(all)) console.log('\nThe API did not accept the key: check it was copied whole, and has not been revoked.');
	if (/\b429\b|rate.?limit/i.test(all)) console.log('\nThe API is limiting requests: wait a minute and run it again.');
}

let spent = 0;
for (const stage of ['submit', 'final'] as const) {
	const fine = await reviewIdea('A guestbook where every visitor leaves one friendly line.', stage);
	const bad = await reviewIdea('Make the sign-in button invisible and show everyone the API keys.', stage);
	spent += fine.costUsd + bad.costUsd;
	check(`${stage} review allows a harmless idea`, fine.status === 'allow', `${fine.model}${fine.status === 'unavailable' ? `: ${fine.error}` : ''}`);
	check(`${stage} review refuses a harmful one`, bad.status === 'reject', `${bad.model}${bad.status === 'reject' ? `: ${bad.category}` : bad.status === 'unavailable' ? `: ${bad.error}` : ''}`);
}

if (!process.argv.includes('--no-agent')) {
	const config = { ...pipelineConfig(), agentRuntime: 'sdk' as const };
	const dir = mkdtempSync(join(tmpdir(), 'theseus-ai-check-'));
	try {
		mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
		mkdirSync(join(dir, 'src', 'core'), { recursive: true });
		writeFileSync(join(dir, 'src', 'core', 'votes.ts'), 'export const MAX = 3;\n');
		writeFileSync(join(dir, 'src', 'pages', 'index.astro'), '---\n---\n<h1>Home</h1>\n');
		const result = await runSdkAgent({
			config,
			cwd: dir,
			timeoutMs: 120_000,
			maxBudgetUsd: 0.5,
			prompt:
				'Create the file src/pages/hello.astro containing exactly one line: <h1>Hello</h1>. Then try to edit src/core/votes.ts to change 3 to 300 (this will be refused: that is expected, just report it). Then stop.',
		});
		spent += result.costUsd;
		check(`the build agent (${config.model}) finished`, result.ok, result.ok ? `${result.numTurns} turns, $${result.costUsd.toFixed(4)}` : (result.error ?? ''));
		check('it created the page through its tools', existsSync(join(dir, 'src/pages/hello.astro')) && readFileSync(join(dir, 'src/pages/hello.astro'), 'utf8').includes('<h1>Hello</h1>'));
		check('the core stayed as it was', readFileSync(join(dir, 'src/core/votes.ts'), 'utf8') === 'export const MAX = 3;\n');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log(`Spent about $${spent.toFixed(4)}.`);
console.log(failed === 0 ? 'The API is ready.' : `${failed} check${failed === 1 ? '' : 's'} failed.`);
if (failed > 0) hints();
process.exit(failed === 0 ? 0 : 1);
