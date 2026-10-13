/**
 * Runs one pipeline cycle: builds the oldest winner waiting for a build.
 *
 *   pnpm cycle:run
 *
 * Configured from .env (DEPLOY_MODE, AGENT_RUNTIME, RUNNER_DIR, CLAUDE_MODEL,
 * PER_RUN_BUDGET_USD…). Defaults to a dry run.
 */
import { closeDb } from '../src/core/db/client';
import { configProblems, pipelineConfig } from './pipeline/config';
import { runCycle } from './pipeline/iterate';

const config = pipelineConfig();
const problems = configProblems(config);
if (problems.length > 0) {
	for (const problem of problems) console.error(`Configuration problem: ${problem}`);
	process.exit(2);
}
console.log(`Pipeline: ${config.deployMode} mode, runner ${config.runnerDir}, model ${config.model}`);
const outcome = await runCycle(config);
console.log(JSON.stringify(outcome));
closeDb();
process.exit(outcome.status === 'failed' || outcome.status === 'rolled_back' ? 1 : 0);
