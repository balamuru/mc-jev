/**
 * Summarize Jev decision logs: outcomes, latency, confidence and cost.
 *
 *   npm run analyze:decisions                       all files in logs/
 *   npm run analyze:decisions -- logs/decisions-2026-09-24.jsonl
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatSummary, parseJsonl, summarize } from '../src/telemetry/analyze.js';

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync('logs')
      .filter((f) => /^decisions-.*\.jsonl$/.test(f))
      .map((f) => join('logs', f));
if (!files.length) {
  console.log('No decision logs found. Run a bot with Jev first (see docs/setup.md).');
  process.exit(0);
}

const all = files.map((f) => parseJsonl(readFileSync(f, 'utf8')));
const entries = all.flatMap((a) => a.entries);
const bad = all.reduce((n, a) => n + a.bad, 0);
console.log(`files: ${files.join(', ')}`);
console.log(formatSummary(summarize(entries)));
if (bad) console.log(`(${bad} unreadable lines skipped)`);
