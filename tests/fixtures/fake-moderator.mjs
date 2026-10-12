#!/usr/bin/env node
/**
 * Stands in for `claude -p --output-format json --json-schema …` in moderation
 * tests. The idea text on stdin picks the answer: REJECTME, HANGME, GARBAGE,
 * ERRORME; anything else is allowed. The reason echoes the flags it was given.
 */
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flags = ['--safe-mode', '--tools', '--json-schema', '--system-prompt', '--strict-mcp-config'].filter(flag).join(',');
const toolsValue = args[args.indexOf('--tools') + 1];

if (input.includes('HANGME')) await new Promise(() => setInterval(() => {}, 1000));
if (input.includes('GARBAGE')) {
	process.stdout.write('not json at all\n');
	process.exit(0);
}
const result = input.includes('REFUSEME')
	? { type: 'result', subtype: 'success', is_error: true, stop_reason: 'refusal', result: 'API Error: flagged by safety measures', total_cost_usd: 0.0027 }
	: input.includes('ERRORME')
	? { type: 'result', is_error: true, subtype: 'error_max_budget_usd' }
	: {
			type: 'result',
			is_error: false,
			total_cost_usd: 0.0021,
			usage: { input_tokens: 400, output_tokens: 30 },
			structured_output: input.includes('REJECTME')
				? { verdict: 'reject', category: 'off_topic', reason: `flags=${flags};tools=[${toolsValue}]` }
				: { verdict: 'allow', category: 'none', reason: `flags=${flags};tools=[${toolsValue}]` },
		};
process.stdout.write(`${JSON.stringify(result)}\n`);
