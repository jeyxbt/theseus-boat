import Anthropic from '@anthropic-ai/sdk';
import { costUsd as priceOf } from '../ai/pricing';
import { workspaceParam } from '../ai/workspace';
import type { ModerationProvider } from './types';

/** Moderation through the Messages API, with an API key (ANTHROPIC_API_KEY). */

let client: Anthropic | null = null;

function getClient() {
	// One retry: a moderation call sits in front of a visitor waiting for their idea.
	client ??= new Anthropic({ maxRetries: 1 });
	return client;
}

/** For tests: replace the SDK client with a stand-in. */
export function setApiClientForTests(stand: unknown) {
	client = stand as Anthropic;
}

export const apiProvider: ModerationProvider = async (call) => {
	const response = await getClient().messages.create(
		{
			model: call.model,
			// Thinking tokens count against this too; the verdict itself is a few dozen.
			max_tokens: 8192,
			system: call.system,
			messages: [{ role: 'user', content: call.user }],
			output_config: {
				effort: call.effort,
				format: { type: 'json_schema', schema: call.schema },
			},
			...workspaceParam(),
		},
		{ timeout: call.timeoutMs },
	);

	const input = response.usage?.input_tokens ?? 0;
	const output = response.usage?.output_tokens ?? 0;
	const costUsd = priceOf(call.model, response.usage);

	// A decline is an answer too: the model would not even look at this idea.
	if (response.stop_reason === 'refusal') {
		const detail = response.stop_details?.category ?? 'refusal';
		return { kind: 'refused', detail: String(detail), costUsd };
	}
	if (response.stop_reason === 'max_tokens') throw new Error('the answer was cut off');

	const text = response.content.find((block) => block.type === 'text');
	if (!text || text.type !== 'text') throw new Error('no text in the answer');
	return { kind: 'json', value: JSON.parse(text.text), costUsd, inputTokens: input, outputTokens: output };
};
