import { parseCollection, STORE_LIMITS, type Collection } from './collections';

let override: Map<string, Collection> | null = null;
let loaded: Map<string, Collection> | null = null;

/** Valid declarations, in file-name order, up to the global limit. A broken one is left out, not fatal. */
export function loadCollections(files: Record<string, unknown>) {
	const found = new Map<string, Collection>();
	for (const path of Object.keys(files).sort()) {
		const fileName = path.split('/').pop()!.replace(/\.json$/, '');
		const parsed = parseCollection(fileName, files[path]);
		if (!parsed.ok) {
			console.warn(`[store] ignoring ${path}: ${parsed.problems.join('; ')}`);
			continue;
		}
		if (found.size >= STORE_LIMITS.collections) {
			console.warn(`[store] ignoring ${path}: over ${STORE_LIMITS.collections} collections`);
			continue;
		}
		found.set(parsed.collection.name, parsed.collection);
	}
	return found;
}

/**
 * Every collection declared in src/collections/. The files are bundled at build
 * time, so the running site always uses the declarations it was built with.
 */
export function collections(): Map<string, Collection> {
	if (override) return override;
	loaded ??= loadCollections(import.meta.glob('../../collections/*.json', { eager: true, import: 'default' }));
	return loaded;
}

export function getCollection(name: unknown) {
	return typeof name === 'string' ? (collections().get(name) ?? null) : null;
}

/** Tests only: use these declarations instead of the files. */
export function setCollectionsForTests(list: Collection[] | null) {
	override = list ? new Map(list.map((collection) => [collection.name, collection])) : null;
}
