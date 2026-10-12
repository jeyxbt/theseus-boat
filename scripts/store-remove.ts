/**
 * Removes one record from a shared-data collection, whoever wrote it.
 *
 *   pnpm store:remove <collection> <id>
 */
import { closeDb } from '../src/core/db/client';
import { removeAnyItem } from '../src/core/store/queries';

const [collection, rawId] = process.argv.slice(2);
const id = Number(rawId);
if (!collection || !Number.isInteger(id) || id < 1) {
	console.error('Usage: pnpm store:remove <collection> <id>');
	process.exit(2);
}
const removed = removeAnyItem(collection, id);
console.log(removed ? `Removed record ${id} from ${collection}.` : `No record ${id} in ${collection}.`);
closeDb();
process.exit(removed ? 0 : 1);
