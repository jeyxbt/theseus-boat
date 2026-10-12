import { closeDb, databasePath } from '../src/core/db/client';
import { seedDemo } from '../src/core/db/seed';

const result = seedDemo();
closeDb();

console.log(`Seeded ${databasePath()}`);
console.log(
	`  ${result.users} demo people · ${result.ideas} ideas · ${result.votes} votes · ${result.builds} demo builds`,
);
