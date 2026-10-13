/**
 * Is this setup ready to run in public? Checks the environment (the same rules
 * the server applies at start) and, for DEPLOY_MODE=production, the pipeline's.
 * Run it before starting or restarting the site, and from a deploy script:
 *
 *   pnpm preflight
 *
 * Exits 1 when something must be fixed, 0 when it is ready. Never prints a
 * secret, only which settings are missing or wrong.
 */
import { readiness } from '../src/core/production';
import { configProblems, pipelineConfig } from './pipeline/config';
import { findChrome } from './pipeline/browser';

const { isPublic, problems, warnings } = readiness();
const config = pipelineConfig();
const pipeline = config.deployMode === 'production' || isPublic ? configProblems(config) : [];
const browser = config.browserCheck === 'required' && !findChrome() ? ['no Chrome or Chromium found for the browser check: install one or set CHROME_PATH'] : [];

const all = [...problems, ...pipeline, ...browser];
console.log(isPublic ? 'This is a site on a real domain: the full checklist applies.' : 'This is a local setup (SITE_URL is on this machine): only the pipeline is checked.');
for (const warning of warnings) console.log(`  warning: ${warning}`);
for (const problem of all) console.log(`  PROBLEM: ${problem}`);
console.log(all.length === 0 ? 'Ready.' : `${all.length} problem${all.length === 1 ? '' : 's'} to fix.`);
process.exit(all.length === 0 ? 0 : 1);
