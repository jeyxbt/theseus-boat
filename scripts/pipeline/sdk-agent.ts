/**
 * The build agent on the Messages API, with an API key: the way to run it on a
 * server, where there is no signed-in Claude Code. It is a plain tool loop. The
 * model gets five tools (see sandbox.ts) and nothing else: no shell, no web.
 *
 * Every turn is paid for from the token counts the API reports, including
 * cache reads and writes, and the run stops the moment the budget, the turn
 * limit or the clock runs out.
 */
import Anthropic from '@anthropic-ai/sdk';
import { costUsd } from '../../src/core/ai/pricing';
import { workspaceParam } from '../../src/core/ai/workspace';
import type { AgentResult } from './agent';
import type { PipelineConfig } from './config';
import { createSandbox, type Sandbox, type ToolResult } from './sandbox';

let client: Anthropic | null = null;

/** For tests: replace the SDK client with a stand-in. Pass null to undo. */
export function setSdkClientForTests(stand: unknown) {
	client = stand as Anthropic | null;
}

function getClient() {
	// The SDK retries rate limits and overloads on its own; the run's clock still applies.
	client ??= new Anthropic({ maxRetries: 4 });
	return client;
}

const SYSTEM = `You are the build agent for a website that its visitors shape: they propose ideas, vote, and the winning idea is built by you.
You work inside a git working tree and have exactly these tools: read_file, list_files, search, edit_file and write_file. You cannot run commands, install anything, use git or reach the network, so do not try; the script that called you builds, tests and commits your work.
Look before you change anything: list the files, read what you build on, and reuse what is already there. A new feature usually gets a new page of its own; when you change an existing file, edit it rather than rewrite it. When the change is done, reply with one short sentence saying what you built, or why you changed nothing.`;

/** The tool definitions. Fixed text and order, so the cached prefix is the same every turn. */
export const TOOLS = [
	{
		name: 'read_file',
		description:
			'Read a text file in the working tree. Returns numbered lines. Long files are cut off: read on with offset. Secrets, databases, .git and build output can’t be read.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the working tree, like src/pages/index.astro' },
				offset: { type: 'integer', description: 'First line to show, starting at 1' },
				limit: { type: 'integer', description: 'How many lines to show' },
			},
			required: ['path'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_files',
		description: 'List files under a folder, optionally only those matching a glob like *.astro or src/**/*.ts.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Folder to list; the whole working tree if left out' },
				pattern: { type: 'string', description: 'Glob to filter by' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'search',
		description: 'Search file contents with a regular expression. Returns file:line: text for each match.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'JavaScript regular expression' },
				path: { type: 'string', description: 'File or folder to search; the whole working tree if left out' },
				glob: { type: 'string', description: 'Only search files matching this glob, like *.astro' },
				ignore_case: { type: 'boolean' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
	},
	{
		name: 'edit_file',
		description:
			'Replace text in an existing file. old_string must match exactly once, spaces and tabs included, unless replace_all is true. Read the file first.',
		eager_input_streaming: true,
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				old_string: { type: 'string', description: 'The exact text to replace' },
				new_string: { type: 'string', description: 'The text to put there' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence' },
			},
			required: ['path', 'old_string', 'new_string'],
			additionalProperties: false,
		},
	},
	{
		name: 'write_file',
		description: 'Create a file, or replace one completely. Folders are created as needed. For a small change to an existing file, use edit_file.',
		eager_input_streaming: true,
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string', description: 'The whole file' },
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
	},
] satisfies Anthropic.Tool[];

/** Runs one tool call against the sandbox. A tool never throws: a problem is a result the model can read and recover from. */
export function runTool(sandbox: Sandbox, name: string, input: unknown): ToolResult & { touched?: { path: string; kind: 'wrote' | 'edited' } } {
	const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
	try {
		switch (name) {
			case 'read_file':
				return sandbox.readFile(args);
			case 'list_files':
				return sandbox.listFiles(args);
			case 'search':
				return sandbox.search(args);
			case 'edit_file': {
				const result = sandbox.editFile(args);
				return result.ok ? { ...result, touched: { path: String(args.path).replaceAll('\\', '/'), kind: 'edited' } } : result;
			}
			case 'write_file': {
				const result = sandbox.writeFile(args);
				return result.ok ? { ...result, touched: { path: String(args.path).replaceAll('\\', '/'), kind: 'wrote' } } : result;
			}
			default:
				return { ok: false, text: `there is no tool called ${name}` };
		}
	} catch (error) {
		return { ok: false, text: `the tool failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export async function runSdkAgent(input: {
	config: PipelineConfig;
	cwd: string;
	prompt: string;
	timeoutMs: number;
	maxBudgetUsd: number;
	onEvent?: (message: string) => void;
}): Promise<AgentResult> {
	const { config, cwd } = input;
	const started = Date.now();
	const touched = new Set<string>();
	const abort = new AbortController();
	const clock = setTimeout(() => abort.abort(), input.timeoutMs);

	let spent = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let turns = 0;
	let lastText = '';

	const finish = (error: string | null): AgentResult => ({
		ok: error === null,
		timedOut: abort.signal.aborted,
		costUsd: spent,
		inputTokens,
		outputTokens,
		numTurns: turns,
		durationMs: Date.now() - started,
		error,
		touched: [...touched],
		output: lastText,
	});

	try {
		if (!client && !process.env.ANTHROPIC_API_KEY) return finish('ANTHROPIC_API_KEY is not set');
		const api = getClient();
		const sandbox = createSandbox(cwd);
		const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input.prompt }];

		for (;;) {
			if (turns >= config.agentMaxTurns) return finish(`stopped after ${config.agentMaxTurns} turns`);
			if (spent >= input.maxBudgetUsd) return finish(`the budget of $${input.maxBudgetUsd.toFixed(2)} ran out`);
			turns++;

			const stream = api.messages.stream(
				{
					model: config.model,
					max_tokens: config.agentMaxOutputTokens,
					system: SYSTEM,
					tools: TOOLS,
					messages,
					output_config: { effort: config.agentEffort },
					// One marker on the whole request: tools, instructions and the conversation so far are
					// read from the cache on every turn after the first, at a tenth of the price.
					cache_control: { type: 'ephemeral' },
					...workspaceParam(),
				},
				{ signal: abort.signal },
			);
			const message = await stream.finalMessage();

			const usage = message.usage;
			spent += costUsd(config.model, usage);
			inputTokens += (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
			outputTokens += usage?.output_tokens ?? 0;
			const text = message.content
				.filter((block): block is Anthropic.TextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('\n')
				.trim();
			if (text) lastText = text;

			// A refusal can cut a tool call off mid-input: never run anything from that turn.
			if (message.stop_reason === 'refusal') return finish('the model declined to do this');
			if (message.stop_reason === 'max_tokens') return finish('the model ran out of room in one reply: the change is too big');
			if (message.stop_reason === 'end_turn') return finish(null);
			if (message.stop_reason !== 'tool_use') return finish(`the model stopped for an unexpected reason: ${message.stop_reason}`);

			const calls = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
			if (calls.length === 0) return finish('the model asked for a tool but sent none');

			// The whole reply goes back unchanged, thinking blocks included.
			messages.push({ role: 'assistant', content: message.content });
			const results: Anthropic.ToolResultBlockParam[] = [];
			for (const call of calls) {
				const result = runTool(sandbox, call.name, call.input);
				if (result.touched && !touched.has(result.touched.path)) input.onEvent?.(`${result.touched.kind} ${result.touched.path}`);
				if (result.touched) touched.add(result.touched.path);
				results.push({ type: 'tool_result', tool_use_id: call.id, content: result.text, ...(result.ok ? {} : { is_error: true }) });
			}
			messages.push({ role: 'user', content: results });
		}
	} catch (error) {
		if (abort.signal.aborted) return finish('timed out');
		if (error instanceof Anthropic.APIError) {
			// The SDK's own message describes the problem; it never contains the key.
			return finish(`the API answered ${error.status ?? 'with an error'}: ${error.message}`.slice(0, 400));
		}
		return finish(`the agent stopped: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(clock);
	}
}
