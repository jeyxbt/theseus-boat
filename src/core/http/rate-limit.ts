/**
 * In-memory rate limiting. The site is a single process, so nothing needs to be
 * shared. Sliding window per key.
 */
const hits = new Map<string, number[]>();

/** Above this many keys, drop the ones with no recent hits. */
const PRUNE_AT = 5000;
const LONGEST_WINDOW_MS = 60 * 60 * 1000;

export function allow(key: string, limit: number, windowMs: number, now = Date.now()) {
	const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
	if (recent.length >= limit) {
		hits.set(key, recent);
		return false;
	}
	recent.push(now);
	hits.set(key, recent);

	if (hits.size > PRUNE_AT) {
		for (const [other, times] of hits) {
			if (times.every((at) => now - at >= LONGEST_WINDOW_MS)) hits.delete(other);
		}
	}
	return true;
}

/** Several limits at once: passes only if all pass, and only then counts. */
export function allowAll(rules: { key: string; limit: number; windowMs: number }[], now = Date.now()) {
	const blocked = rules.some(({ key, limit, windowMs }) => {
		const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
		return recent.length >= limit;
	});
	if (blocked) return false;
	for (const { key, limit, windowMs } of rules) allow(key, limit, windowMs, now);
	return true;
}

/** Tests only. */
export function resetRateLimits() {
	hits.clear();
}
