/**
 * Runs the benchmark questions through the agent and records latency and token usage.
 *
 *   npm run bench -- [--mode jev|standard|jev-bon|both] [--limit N] [--ids 1,5,9]
 *                    [--concurrency N] [--resume bench/results/<file>.jsonl] [--config path]
 *                    [--label jev="Sol + Jev",standard=Sol | --label "Luna + Jev"]
 *
 * `--config` points to an alternate config.yaml (e.g. to run jev-bon with a different
 * executor model). It must be set before `../src/config.js` is imported, so this file only
 * imports it dynamically, after parsing argv.
 *
 * `--label` sets a `label` field on each recorded row, used by bench:grade to group and name
 * series (it takes precedence over the mode/model key). Two forms:
 *   - `mode=Label,mode2=Label2`: a different label per mode in this run.
 *   - a single value with no `=`: applies to every mode in this run.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { AgentMode } from '../src/pipeline.js';
import type { RunRecord } from './lib.js';

// Parsed here, inline, without importing lib.js: that module imports src/config.js at the top
// level, so importing it before CONFIG_FILE is set would lock in the default config.yaml.
function parseArgsForConfig(argv: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[token.slice(2)] = true;
    } else {
      parsed[token.slice(2)] = next;
      i++;
    }
  }
  return parsed;
}

const preArgs = parseArgsForConfig(process.argv.slice(2));
if (typeof preArgs.config === 'string') process.env.CONFIG_FILE = preArgs.config;

// Imported dynamically, after CONFIG_FILE is set, because src/config.js (and lib.js, which
// imports it) reads the config file at import time.
const { config } = await import('../src/config.js');
const { closePools } = await import('../src/db.js');
const { runAgent } = await import('../src/pipeline.js');
const { loadQuestions, parseArgs, readJsonl, RESULTS_DIR } = await import('./lib.js');

const args = parseArgs(process.argv.slice(2));

// The AI SDK already retries 3 times quickly; these attempts wait longer, which is what
// gateway outages and per-minute token rate limits need.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20_000;
const TRANSIENT_ERROR =
  /GatewayInternalServerError|Service temporarily unavailable|Rate ?limit|ECONNRESET|ETIMEDOUT/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const modeArg = String(args.mode ?? 'both');
const modes: AgentMode[] = modeArg === 'both' ? ['jev', 'standard'] : [modeArg as AgentMode];
const concurrency = Number(args.concurrency ?? 3);

/** Parses `--label`: either `mode=Label,mode2=Label2` or a single value for every mode. */
function parseLabels(raw: string | true | undefined): Map<AgentMode, string> {
  const labels = new Map<AgentMode, string>();
  if (typeof raw !== 'string') return labels;
  if (raw.includes('=')) {
    for (const pair of raw.split(',')) {
      const [mode, ...rest] = pair.split('=');
      const label = rest.join('=').trim();
      if (mode && label) labels.set(mode.trim() as AgentMode, label);
    }
  } else {
    for (const mode of modes) labels.set(mode, raw);
  }
  return labels;
}
const labels = parseLabels(args.label);

let questions = await loadQuestions();
if (typeof args.ids === 'string') {
  const ids = new Set(args.ids.split(',').map(Number));
  questions = questions.filter((question) => ids.has(question.id));
}
if (typeof args.limit === 'string') questions = questions.slice(0, Number(args.limit));

await mkdir(RESULTS_DIR, { recursive: true });
// Fail fast: a bare --resume or a wrong path would otherwise start a new, paid full run.
if (args.resume !== undefined && (typeof args.resume !== 'string' || !existsSync(args.resume))) {
  console.error(`--resume needs an existing results file, got: ${String(args.resume)}`);
  process.exit(1);
}
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
      const label = labels.get(mode);
      return {
        ...run,
        id: question.id,
        mode,
        status: 'ok',
        attempts: attempt,
        startedAt,
        ...(label ? { label } : {}),
      };
    } catch (error) {
      lastError = (error as Error).message;
      if (!TRANSIENT_ERROR.test(lastError) || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  const label = labels.get(mode);
  return {
    id: question.id,
    mode,
    status: 'failed',
    error: lastError,
    attempts: MAX_ATTEMPTS,
    startedAt,
    ...(label ? { label } : {}),
  };
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
