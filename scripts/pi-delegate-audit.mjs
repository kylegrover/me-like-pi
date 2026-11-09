#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditDelegation } from './lib/delegation-audit.mjs';

const args = process.argv.slice(2);
const options = { sessionsDir: join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'sessions'),
  since: Date.now() - 7 * 86400_000, until: Date.now(), details: false };
try {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      console.log('Usage: node scripts/pi-delegate-audit.mjs [--sessions <directory>] [--since <ISO date>] [--until <ISO date>] [--details]\nDefaults: local Pi sessions, last 7 days. Metadata-only JSON; --details adds private session locators and per-worker telemetry. No model calls.');
      process.exit(0);
    }
    if (arg === '--details') { options.details = true; continue; }
    if (!['--sessions', '--since', '--until'].includes(arg) || !args[i + 1]) throw new Error(`Unknown/incomplete option: ${arg}`);
    const value = args[++i];
    if (arg === '--sessions') options.sessionsDir = value;
    else options[arg.slice(2)] = Date.parse(value);
  }
  console.log(JSON.stringify(await auditDelegation(options), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
