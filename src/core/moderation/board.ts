import { recordSpend } from '../builds/writes';
import { markReviewed, pendingReviews, removeIdea } from '../ideas/queries';
import { moderationMode, reviewIdea, type AiCategory } from './index';

export type BoardReview = { rejected: AiCategory } | { verified: boolean };

function record(verdict: { model: string; costUsd: number }) {
	if (verdict.model !== 'off') recordSpend({ kind: 'moderation', model: verdict.model, costUsd: verdict.costUsd });
}

/**
 * The AI review of an idea on its way to the board. A rejection refuses it; no
 * answer in time lets it up on the regex checks alone, marked unverified, to be
 * reviewed again in the background.
 */
export async function reviewForBoard(text: string): Promise<BoardReview> {
	const verdict = await reviewIdea(text, 'submit');
	record(verdict);
	if (verdict.status === 'reject') return { rejected: verdict.category };
	if (verdict.status === 'unavailable') {
		console.warn(`[moderation] review unavailable, idea goes up unverified: ${verdict.error}`);
		return { verified: false };
	}
	return { verified: true };
}

let running = false;

/** Reviews ideas that went up unverified. Takes them down if the model rejects them. One batch at a time. */
export async function reviewPending(limit = 3) {
	if (running || moderationMode() === 'off') return { reviewed: 0, removed: 0 };
	running = true;
	let reviewed = 0;
	let removed = 0;
	try {
		for (const idea of pendingReviews(limit)) {
			const verdict = await reviewIdea(idea.body, 'submit');
			record(verdict);
			// Still unreachable: try again on the next round.
			if (verdict.status === 'unavailable') break;
			reviewed++;
			if (verdict.status === 'allow') markReviewed(idea.id, idea.body);
			else if (removeIdea(idea.id, idea.body, verdict.category)) removed++;
		}
	} finally {
		running = false;
	}
	return { reviewed, removed };
}
