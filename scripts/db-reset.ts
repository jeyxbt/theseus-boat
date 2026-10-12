import { existsSync, rmSync } from 'node:fs';
import { databasePath } from '../src/core/db/client';

const path = databasePath();
let removed = 0;

for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
	if (existsSync(file)) {
		rmSync(file);
		removed++;
	}
}

console.log(removed ? `Deleted ${path}` : `Nothing to delete at ${path}`);
console.log('Stop the dev server first if it is running: it keeps the old file open.');
