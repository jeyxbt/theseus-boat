#!/usr/bin/env node
/**
 * A stand-in for Claude Code in tests. Reads the prompt on stdin, writes a
 * scripted change into the current folder, and prints stream-json lines like
 * the real CLI. The scenario is the first --scenario=… argument.
 *
 *   ok            writes a working page
 *   forbidden     edits a core file
 *   broken-fixed  writes a page that fails the build; the repair fixes it
 *   crash-fixed   writes a page that answers 500; the repair fixes it
 *   broken        writes a page that always fails the build
 *   nothing       changes nothing
 *   slow          takes 1.5 s, then writes a working page
 *   hang          never finishes (for timeouts)
 *   live-crash    a page that passes the preview but answers 500 on the live site
 *   store         declares a shared-data collection and a page that uses it
 *   bad-store     declares a collection the core would reject
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = (process.argv.find((arg) => arg.startsWith('--scenario=')) ?? '--scenario=ok').split('=')[1];

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const repairing = prompt.includes('does NOT work');

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const write = (path, text) => {
	mkdirSync(join(process.cwd(), path, '..'), { recursive: true });
	writeFileSync(join(process.cwd(), path), text);
	emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(process.cwd(), path) } }] } });
};
const page = (body) => `---\nconst title = 'Garden';\n---\n<main data-site-shell><h1>THESEUS</h1><p>${body}</p></main>\n`;
const NOTE = 'Done.\n<<<SUMMARY\nThere is a new garden page at /garden where flowers grow as you watch.\nSUMMARY>>>';
const done = (cost) => emit({ type: 'result', subtype: 'success', is_error: false, result: NOTE, total_cost_usd: cost, num_turns: 3, duration_ms: 1200, usage: { input_tokens: 1000, output_tokens: 200 } });

emit({ type: 'system', subtype: 'init' });

switch (scenario) {
	case 'ok':
		write('src/pages/garden.astro', page('A little garden'));
		done(0.12);
		break;
	case 'forbidden':
		write('src/core/votes.ts', 'export const MAX = 300;\n');
		done(0.05);
		break;
	case 'broken-fixed':
		write('src/pages/garden.astro', page(repairing ? 'Fixed garden' : 'BROKEN garden'));
		done(0.1);
		break;
	case 'crash-fixed':
		write('src/pages/garden.astro', page(repairing ? 'Fixed garden' : 'CRASH garden'));
		done(0.1);
		break;
	case 'broken':
		write('src/pages/garden.astro', page('BROKEN again'));
		done(0.1);
		break;
	case 'nothing':
		done(0.01);
		break;
	case 'slow':
		await new Promise((resolve) => setTimeout(resolve, 1500));
		write('src/pages/garden.astro', page('A slow garden'));
		done(0.2);
		break;
	case 'live-crash':
		write('src/pages/garden.astro', page('LIVECRASH garden'));
		done(0.1);
		break;
	case 'store':
		write('src/collections/notes.json', JSON.stringify({ name: 'notes', mode: 'append', fields: { text: { type: 'text', max: 80 } } }));
		write('src/pages/garden.astro', page('Notes garden'));
		done(0.1);
		break;
	case 'bad-store':
		write('src/collections/notes.json', JSON.stringify({ name: 'other', mode: 'everything', fields: {} }));
		done(0.1);
		break;
	case 'hang':
		// Tests check this pid is gone after the timeout.
		writeFileSync(join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'pw-fake-claude-hang.pid'), String(process.pid));
		await new Promise(() => setInterval(() => {}, 1000));
		break;
}
