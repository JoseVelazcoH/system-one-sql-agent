/**
 * Re-runs every gold SQL and compares the result with expectedValues.
 *
 *   npm run bench:refresh            report mismatches only
 *   npm run bench:refresh -- --write overwrite expectedValues with fresh results
 */
import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { closePools, readOnlyQuery } from '../src/db.js';
import { loadAnswers, normalizeValue, parseArgs } from './lib.js';

const args = parseArgs(process.argv.slice(2));
const answers = await loadAnswers();

// Gold SQL can be slower than what the agent is allowed; this is not a latency test.
const GOLD_TIMEOUT = '120s';
// expectedValues may be rounded for readability (60.76 vs 60.7642...).
const ROUNDING_TOLERANCE = 0.01;

const sameValue = (expected: number | string, fresh: number | string) =>
  typeof expected === 'number' && typeof fresh === 'number'
    ? Math.abs(expected - fresh) <= Math.max(ROUNDING_TOLERANCE, Math.abs(fresh) * 1e-6)
    : String(expected) === String(fresh);

/** Every expected value must appear in the fresh result; extra rows (e.g. "No especificado") are fine. */
const covers = (fresh: (number | string)[], expected: (number | string)[]) =>
  expected.every((value) => fresh.some((candidate) => sameValue(value, candidate)));

let failures = 0;
try {
  for (const answer of answers) {
    if (!answer.answerable || !answer.goldSql || !answer.database) continue;
    try {
      const { rows } = await readOnlyQuery(answer.database, answer.goldSql, {
        maxRows: Infinity,
        timeout: GOLD_TIMEOUT,
        rowMode: 'array',
      });
      const fresh = (rows as unknown[][]).flat().map(normalizeValue);
      if (covers(fresh, answer.expectedValues)) continue;
      failures++;
      console.log(`#${answer.id} changed:\n  expected ${JSON.stringify(answer.expectedValues)}\n  got      ${JSON.stringify(fresh)}`);
      if (args.write) answer.expectedValues = fresh;
    } catch (error) {
      failures++;
      console.log(`#${answer.id} error: ${(error as Error).message}`);
    }
  }
} finally {
  await closePools();
}

if (args.write && failures > 0) {
  await writeFile(config.benchmark.answersPath, JSON.stringify(answers, null, 2) + '\n');
  console.log('answers.json updated. Review expectedAnswer texts for the changed ids.');
}
console.log(failures === 0 ? 'All gold SQL results match.' : `${failures} answers need attention.`);
process.exitCode = failures > 0 && !args.write ? 1 : 0;
