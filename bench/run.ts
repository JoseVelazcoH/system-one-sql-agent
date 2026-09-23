/**
 * Runs the benchmark questions through the agent and records latency and token usage.
 *
 *   npm run bench -- [--mode jev|standard|both] [--limit N] [--ids 1,5,9]
 *                    [--concurrency N] [--resume bench/results/<file>.jsonl]
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { closePools } from '../src/db.js';
import { runAgent, type AgentMode } from '../src/pipeline.js';
import { loadQuestions, parseArgs, readJsonl, RESULTS_DIR, type RunRecord } from './lib.js';

// The AI SDK already retries 3 times quickly; these attempts wait longer, which is what
// gateway outages and per-minute token rate limits need.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20_000;
const TRANSIENT_ERROR =
  /GatewayInternalServerError|Service temporarily unavailable|Rate limit|ECONNRESET|ETIMEDOUT/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const args = parseArgs(process.argv.slice(2));
const modeArg = String(args.mode ?? 'both');
const modes: AgentMode[] = modeArg === 'both' ? ['jev', 'standard'] : [modeArg as AgentMode];
const concurrency = Number(args.concurrency ?? 3);

let questions = await loadQuestions();
if (typeof args.ids === 'string') {
  const ids = new Set(args.ids.split(',').map(Number));
  questions = questions.filter((question) => ids.has(question.id));
}
if (typeof args.limit === 'string') questions = questions.slice(0, Number(args.limit));

await mkdir(RESULTS_DIR, { recursive: true });
const output =
  typeof args.resume === 'string'
    ? pathToFileURL(args.resume)
    : new URL(`${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, RESULTS_DIR);

const done = new Set(
  (await readJsonl<RunRecord>(output))
    .filter((record) => record.status === 'ok')
    .map((record) => `${record.id}:${record.mode}`),
);

// Alternate the mode order per question so neither mode always runs first.
const tasks = questions
  .flatMap((question, index) =>
    (index % 2 === 0 ? modes : [...modes].reverse()).map((mode) => ({ question, mode })),
  )
  .filter(({ question, mode }) => !done.has(`${question.id}:${mode}`));

console.log(
  `Model ${config.model.modelId} | ${tasks.length} runs | concurrency ${concurrency} | ${output.pathname}`,
);

async function runTask({ question, mode }: (typeof tasks)[number]): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const run = await runAgent(mode, question.question);
      return { ...run, id: question.id, mode, status: 'ok', attempts: attempt, startedAt };
    } catch (error) {
      lastError = (error as Error).message;
      if (!TRANSIENT_ERROR.test(lastError) || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  return { id: question.id, mode, status: 'failed', error: lastError, attempts: MAX_ATTEMPTS, startedAt };
}

let finished = 0;
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const task = tasks[next++];
    const record = await runTask(task);
    await appendFile(output, JSON.stringify(record) + '\n');
    finished++;
    const summary =
      record.status === 'ok'
        ? `${((record.durationMs ?? 0) / 1000).toFixed(1)}s in=${record.inputTokens} out=${record.outputTokens}`
        : `FAILED ${record.error?.slice(0, 80)}`;
    console.log(`[${finished}/${tasks.length}] #${task.question.id} ${task.mode.padEnd(8)} ${summary}`);
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
} finally {
  await closePools();
}
console.log(`Done. Grade with: npm run bench:grade -- --results ${output.pathname}`);
