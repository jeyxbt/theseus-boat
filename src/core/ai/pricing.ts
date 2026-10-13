/**
 * What a call costs, from the token counts the API reports. One table for
 * every place the site spends money (moderation and the build agent), so the
 * monthly cap is counted the same way everywhere.
 *
 * Prices are US dollars per million tokens. Cache reads and writes are
 * multiples of the input price; a 5-minute cache write costs 1.25x.
 */
type Price = {
	input: number;
	output: number;
	/** Cache reads, as a multiple of the input price. */
	cacheRead: number;
	/** Above this many prompt tokens a different price applies. */
	long?: { over: number; input: number; output: number };
};

export const PRICES: Record<string, Price> = {
	'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.1, long: { over: 100_000, input: 0.5, output: 2.5 } },
	'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
	'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
	'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 },
};

const CACHE_WRITE = 1.25;

/** The dearest known model: an unknown model is counted at this price, so the cap errs on the safe side. */
const DEAREST = PRICES['claude-fable-5-1'];

export type Usage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
};

export function isPriced(model: string) {
	return model in PRICES;
}

/** The cost of one response, in dollars. Uncached input, cache writes, cache reads and output are each priced. */
export function costUsd(model: string, usage: Usage | null | undefined) {
	if (!usage) return 0;
	const price = PRICES[model] ?? DEAREST;
	const fresh = usage.input_tokens ?? 0;
	const written = usage.cache_creation_input_tokens ?? 0;
	const read = usage.cache_read_input_tokens ?? 0;
	const output = usage.output_tokens ?? 0;

	const long = price.long && fresh + written + read > price.long.over ? price.long : null;
	const input = long?.input ?? price.input;
	const out = long?.output ?? price.output;
	return (fresh * input + written * input * CACHE_WRITE + read * input * price.cacheRead + output * out) / 1_000_000;
}
