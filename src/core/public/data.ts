/**
 * The read-only data layer for pages the AI may edit. Everything here only
 * reads, and none of it exposes SQL, the database handle, sessions or secrets:
 * guards let AI code import this module and nothing else from the core except
 * components and format helpers.
 */
import { displayName as nameOf } from '../auth/session';
import { buildEvents as eventsOf, latestBuild as latest, shippedBuilds as shipped } from '../builds/queries';
import { HOUSE_RULES, HOW_IT_WORKS } from '../content';
import { getOpenWindow, lastClosedWindow } from '../cycle/windows';
import type { Provider } from '../db/schema';
import { boardStats as stats, listOpenIdeas } from '../ideas/queries';
import { listItems } from '../store/queries';
import { getCollection } from '../store/registry';

export { HOUSE_RULES, HOW_IT_WORKS };

/** The voting window that is open now. The server opens one before any page renders. */
export function openWindow() {
	return getOpenWindow();
}

/** The most recently closed window, with its winner if it had one. */
export function lastResult() {
	return lastClosedWindow();
}

/** Open ideas, most votes first (or newest first). */
export function ideas(sort: 'top' | 'new' = 'top') {
	return listOpenIdeas(sort);
}

/** Ideas, votes and people in the open window. */
export function boardStats() {
	return stats();
}

export function shippedBuilds(limit = 12) {
	return shipped(Math.min(Math.max(1, limit), 50));
}

export function latestBuild() {
	return latest();
}

export function buildLog(buildId: number) {
	return eventsOf(buildId);
}

/** "@handle", or the plain name for Google accounts. */
export function displayName(person: { provider: Provider; handle: string }) {
	return nameOf(person);
}

/**
 * Records of a shared-data collection (src/collections/<name>.json), newest
 * first, for rendering on the server. The same shape the browser helper's
 * list() returns, without `mine`. An unknown collection gives an empty list.
 */
export function storeItems(name: string, limit = 100) {
	const collection = getCollection(name);
	if (!collection) return { items: [], total: 0, counts: {}, next: null };
	return listItems(collection, { limit: Math.min(Math.max(1, limit), 1000) });
}
