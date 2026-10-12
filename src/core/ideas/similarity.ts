/** Lowercase, accents stripped, punctuation turned into spaces. */
export function normalize(text: string) {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Filler words that would make any two ideas look alike. */
const STOPWORDS = new Set(
	'the and for that with where when this then than from into onto are was were our your you can will would should could let lets its also just some every here there what which who'.split(
		' ',
	),
);

/** Meaningful words: three letters or more, no filler. */
export function tokens(text: string) {
	return new Set(
		normalize(text)
			.split(' ')
			.filter((word) => word.length > 2 && !STOPWORDS.has(word)),
	);
}

export function jaccard(a: Set<string>, b: Set<string>) {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return shared / (a.size + b.size - shared);
}

/** At or above this, two ideas are the same idea worded differently. */
export const DUPLICATE_AT = 0.6;

export function findDuplicate(body: string, candidates: { id: number; body: string }[]) {
	const mine = tokens(body);
	let best: { id: number; score: number } | null = null;
	for (const candidate of candidates) {
		const score = jaccard(mine, tokens(candidate.body));
		if (score >= DUPLICATE_AT && (!best || score > best.score)) best = { id: candidate.id, score };
	}
	return best;
}
