import { closeWindowNow, lastClosedWindow } from '../src/core/cycle/windows';
import { closeDb } from '../src/core/db/client';

const tick = closeWindowNow();
const closed = lastClosedWindow();
closeDb();

if (closed) {
	const outcome = closed.winnerText
		? `winner: "${closed.winnerText}" by ${closed.winnerHandle} with ${closed.winnerVotes} votes`
		: `no winner (${closed.skipReason})`;
	console.log(`Closed cycle ${closed.number}: ${outcome}`);
}
console.log(`Opened cycle ${tick.current.number}, closes ${tick.current.closesAt}`);
