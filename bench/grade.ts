/**
 * Grades benchmark results against answers.json and writes a markdown report.
 *
 *   npm run bench:grade -- [--results bench/results/<file>.jsonl] [--concurrency N]
 *
 * Each answer gets two independent signals:
 *   - numeric: expected values found in the text (deterministic, rounding tolerant)
 *   - jev: a Jev boolean judgment against the expected and acceptable answers
 * When they disagree the answer is marked "review" instead of guessing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { experimental_evaluate as evaluate } from 'ai';
import { config } from '../src/config.js';
import type { AgentMode } from '../src/pipeline.js';
import { COLORS, groupedBarChart } from './charts.js';
import {
  latestResults,
  loadAnswers,
  loadQuestions,
  mean,
  normalizeText,
  parseArgs,
  percentile,
  readJsonl,
  type GoldAnswer,
  type Question,
  type RunRecord,
} from './lib.js';

type Verdict = 'correct' | 'incorrect' | 'review' | 'failed';
type NumericCheck = 'pass' | 'fail' | 'n/a';

type GradedRecord = RunRecord & {
  category: string;
  answerable: boolean;
  numeric: NumericCheck;
  jevProbability?: number;
  verdict: Verdict;
};

const JUDGE_THRESHOLD = 0.5;
const RELATIVE_TOLERANCE = 0.005;
const DECIMAL_TOLERANCE = 0.051;
const MAGNITUDE_WORDS: [RegExp, number][] = [
  [/^\s*mil\s+millones/i, 1e9],
  [/^\s*mill(?:o|ó)n(?:es)?/i, 1e6],
  [/^\s*mil\b/i, 1e3],
];

const args = parseArgs(process.argv.slice(2));
const resultsUrl =
  typeof args.results === 'string' ? pathToFileURL(args.results) : await latestResults();
const concurrency = Number(args.concurrency ?? 3);

/** Every plausible reading of each number in the text (1,234.5 vs 1.234,5, "3 mil"). */
function extractNumbers(text: string): number[] {
  const candidates: number[] = [];
  for (const match of text.matchAll(/-?\d(?:[\d.,]*\d)?/g)) {
    const token = match[0];
    const after = text.slice((match.index ?? 0) + token.length);
    const multiplier = MAGNITUDE_WORDS.find(([pattern]) => pattern.test(after))?.[1] ?? 1;
    const readings = [
      Number(token.replace(/,/g, '')),
      Number(token.replace(/\./g, '').replace(',', '.')),
    ];
    for (const reading of readings) {
      if (Number.isNaN(reading)) continue;
      candidates.push(reading, reading * multiplier);
    }
  }
  return candidates;
}

function numberMatches(expected: number, found: number[]) {
  const tolerance = Number.isInteger(expected)
    ? Math.abs(expected) * RELATIVE_TOLERANCE
    : Math.max(Math.abs(expected) * RELATIVE_TOLERANCE, DECIMAL_TOLERANCE);
  return found.some((value) => Math.abs(value - expected) <= tolerance);
}

function numericCheck(text: string, gold: GoldAnswer): NumericCheck {
  if (!gold.answerable || gold.expectedValues.length === 0) return 'n/a';
  const numbers = extractNumbers(text);
  const normalized = normalizeText(text);
  const allFound = gold.expectedValues.every((value) =>
    typeof value === 'number'
      ? numberMatches(value, numbers)
      : normalized.includes(normalizeText(value)),
  );
  return allFound ? 'pass' : 'fail';
}

async function jevJudge(question: Question, gold: GoldAnswer, answer: string) {
  const instructions = gold.answerable
    ? 'Is the agent answer correct? It is correct if it states the expected answer or one of the acceptable answers; small rounding differences are fine. It is incorrect if it gives different figures, claims the data is unavailable, or answers a different question.'
    : 'The requested information is not available in the databases. Is the agent answer correct? It is correct if it says the information is not available, asks for clarification, or offers related data while clearly stating the requested data is not available. It is incorrect if it presents figures as the answer to the question.';

  const { answers } = await evaluate({
    model: config.routerModel,
    state: {
      question: question.question,
      expectedAnswer: gold.expectedAnswer,
      acceptableAnswers: gold.acceptable,
      agentAnswer: answer,
    },
    questions: { correct: { type: 'boolean', instructions } },
  });
  return answers.correct.probability;
}

const JUDGE_ATTEMPTS = 3;
const JUDGE_RETRY_DELAY_MS = 15_000;

/** Jev judgment with patient retries; undefined when the gateway stays unavailable. */
async function jevJudgeWithRetry(question: Question, gold: GoldAnswer, answer: string) {
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
    try {
      return await jevJudge(question, gold, answer);
    } catch (error) {
      if (attempt === JUDGE_ATTEMPTS) {
        console.warn(`\nJudge unavailable for #${question.id}: ${(error as Error).message.slice(0, 100)}`);
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, JUDGE_RETRY_DELAY_MS * attempt));
    }
  }
}

function decide(gold: GoldAnswer, numeric: NumericCheck, jev: number | undefined): Verdict {
  // Without the judge a single signal is not enough to decide.
  if (jev === undefined) return 'review';
  const jevCorrect = jev >= JUDGE_THRESHOLD;
  if (numeric === 'n/a') return jevCorrect ? 'correct' : 'incorrect';
  if ((numeric === 'pass') === jevCorrect) return jevCorrect ? 'correct' : 'incorrect';
  return 'review';
}

const questions = new Map((await loadQuestions()).map((question) => [question.id, question]));
const gold = new Map((await loadAnswers()).map((answer) => [answer.id, answer]));
const records = await readJsonl<RunRecord>(resultsUrl);

// Keep the last record per (id, mode), so resumed runs replace earlier failures.
const latest = [...new Map(records.map((record) => [`${record.id}:${record.mode}`, record])).values()];

async function gradeRecord(record: RunRecord): Promise<GradedRecord> {
  const question = questions.get(record.id)!;
  const answer = gold.get(record.id);
  if (!answer) throw new Error(`answers.json has no entry for question ${record.id}`);
  const base = { ...record, category: question.category, answerable: answer.answerable };
  if (record.status !== 'ok' || record.text === undefined) {
    return { ...base, numeric: 'n/a', verdict: 'failed' };
  }
  const numeric = numericCheck(record.text, answer);
  const jevProbability = await jevJudgeWithRetry(question, answer, record.text);
  return { ...base, numeric, jevProbability, verdict: decide(answer, numeric, jevProbability) };
}

const graded: GradedRecord[] = [];
let next = 0;
async function worker() {
  while (next < latest.length) {
    const record = latest[next++];
    graded.push(await gradeRecord(record));
    process.stdout.write(`\rGraded ${graded.length}/${latest.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, latest.length) }, worker));
process.stdout.write('\n');
graded.sort((a, b) => a.id - b.id || a.mode.localeCompare(b.mode));

// ---------- report ----------

const pct = (part: number, total: number) => (total ? `${((part / total) * 100).toFixed(1)}%` : '-');
const seconds = (ms: number) => (Number.isNaN(ms) ? '-' : `${(ms / 1000).toFixed(2)} s`);
const integer = (value: number) => (Number.isNaN(value) ? '-' : Math.round(value).toLocaleString('en-US'));
const usd = (value: number | null) =>
  value === null || Number.isNaN(value) ? '-' : `$${value < 0.01 ? value.toFixed(5) : value.toFixed(3)}`;

type JevCall = NonNullable<RunRecord['jev']>['route'];
const jevCalls = (record: GradedRecord): JevCall[] => (record.jev ? [record.jev.route, record.jev.tables] : []);

/** Sum of per-run costs; null when any run lacks a reported cost (older runs or OpenAI direct). */
function totalCost(
  records: GradedRecord[],
  pick: (costs: NonNullable<RunRecord['costs']>) => number | null | undefined,
) {
  const values = records.map((record) => (record.costs ? pick(record.costs) : null));
  if (values.length === 0 || values.some((value) => value === null || value === undefined)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function modeSummary(mode: AgentMode) {
  const runs = graded.filter((record) => record.mode === mode);
  const ok = runs.filter((record) => record.verdict !== 'failed');
  const answerable = ok.filter((record) => record.answerable);
  const unanswerable = ok.filter((record) => !record.answerable);
  const durations = ok.map((record) => record.durationMs ?? 0);
  const queries = ok.flatMap((record) => record.queries ?? []);
  const calls = ok.flatMap(jevCalls);
  const providerMs = calls.map((call) => call.providerMs).filter((ms): ms is number => ms !== null);
  const total = totalCost(ok, (costs) => costs.totalUsd);
  const correct = ok.filter((record) => record.verdict === 'correct').length;
  return {
    mode,
    runs: runs.length,
    failed: runs.length - ok.length,
    accuracy: pct(answerable.filter((r) => r.verdict === 'correct').length, answerable.length),
    answerableCount: answerable.length,
    hallucination: pct(unanswerable.filter((r) => r.verdict === 'incorrect').length, unanswerable.length),
    unanswerableCount: unanswerable.length,
    review: ok.filter((record) => record.verdict === 'review').length,
    p50: seconds(percentile(durations, 50)),
    p95: seconds(percentile(durations, 95)),
    avg: seconds(mean(durations)),
    route: seconds(mean(ok.map((r) => r.timings?.routeMs ?? NaN).filter((v) => !Number.isNaN(v)))),
    tables: seconds(mean(ok.map((r) => r.timings?.tablesMs ?? NaN).filter((v) => !Number.isNaN(v)))),
    executor: seconds(mean(ok.map((r) => r.timings?.executorMs ?? 0))),
    inAvg: integer(mean(ok.map((r) => r.inputTokens ?? 0))),
    outAvg: integer(mean(ok.map((r) => r.outputTokens ?? 0))),
    inTotal: integer(ok.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0)),
    outTotal: integer(ok.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0)),
    sqlErrors: pct(queries.filter((q) => q.error).length, queries.length),
    runsWithSqlError: pct(ok.filter((r) => (r.queries ?? []).some((q) => q.error)).length, ok.length),
    jevProvider: calls.length ? seconds(mean(providerMs)) : '-',
    jevTokens: calls.length
      ? integer(mean(ok.map((r) => jevCalls(r).reduce((s, c) => s + c.inputTokens + c.outputTokens, 0))))
      : '-',
    executorCost: usd(totalCost(ok, (costs) => costs.executorUsd)),
    jevCost: calls.length ? usd(totalCost(ok, (costs) => costs.jevUsd)) : '-',
    totalCost: usd(total),
    costPerQuestion: usd(total === null ? null : total / ok.length),
    costPerCorrect: usd(total === null || correct === 0 ? null : total / correct),
  };
}

const modes = [...new Set(graded.map((record) => record.mode))];
const summaries = modes.map(modeSummary);
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const metricRows: [string, keyof ReturnType<typeof modeSummary>][] = [
  ['Runs', 'runs'],
  ['Failed runs (excluded)', 'failed'],
  ['Accuracy on answerable questions', 'accuracy'],
  ['Answerable graded', 'answerableCount'],
  ['Hallucination rate on unanswerable questions', 'hallucination'],
  ['Unanswerable graded', 'unanswerableCount'],
  ['Needs manual review', 'review'],
  ['Latency p50', 'p50'],
  ['Latency p95', 'p95'],
  ['Latency average', 'avg'],
  ['Avg database routing (Jev)', 'route'],
  ['Avg table routing + column preload (Jev)', 'tables'],
  ['Avg executor', 'executor'],
  ['Avg Jev time inside the provider, per call', 'jevProvider'],
  ['Avg input tokens (executor)', 'inAvg'],
  ['Avg output tokens (executor)', 'outAvg'],
  ['Total input tokens (executor)', 'inTotal'],
  ['Total output tokens (executor)', 'outTotal'],
  ['Avg Jev tokens per question', 'jevTokens'],
  ['Total cost (executor)', 'executorCost'],
  ['Total cost (Jev)', 'jevCost'],
  ['Total cost', 'totalCost'],
  ['Cost per question', 'costPerQuestion'],
  ['Cost per correct answer', 'costPerCorrect'],
  ['SQL queries with error', 'sqlErrors'],
  ['Runs with at least one SQL error', 'runsWithSqlError'],
];

const categories = [...new Set(graded.map((record) => record.category))];
const byQuestion = [...new Set(graded.map((record) => record.id))];
const cell = (record: GradedRecord | undefined) =>
  record
    ? record.verdict === 'failed'
      ? 'failed'
      : `${record.verdict} (${seconds(record.durationMs ?? NaN)}, ${integer((record.inputTokens ?? 0) + (record.outputTokens ?? 0))} tok)`
    : '-';

const report = [
  `# Benchmark report`,
  '',
  `- Results: \`${resultsUrl.pathname}\``,
  `- Executor model: \`${graded.find((r) => r.model)?.model ?? 'unknown'}\``,
  `- Judge: numeric check + \`${config.routerModel}\` (threshold ${JUDGE_THRESHOLD})`,
  '',
  '## Summary',
  '',
  row(['Metric', ...modes]),
  row(['---', ...modes.map(() => '---')]),
  ...metricRows.map(([label, key]) => row([label, ...summaries.map((summary) => summary[key])])),
  '',
  '## Accuracy by category',
  '',
  row(['Category', ...modes]),
  row(['---', ...modes.map(() => '---')]),
  ...categories.map((category) =>
    row([
      category,
      ...modes.map((mode) => {
        const runs = graded.filter(
          (r) => r.mode === mode && r.category === category && r.verdict !== 'failed',
        );
        return pct(runs.filter((r) => r.verdict === 'correct').length, runs.length);
      }),
    ]),
  ),
  '',
  '## Per question',
  '',
  row(['#', 'Category', 'Answerable', ...modes]),
  row(['---', '---', '---', ...modes.map(() => '---')]),
  ...byQuestion.map((id) => {
    const records = graded.filter((record) => record.id === id);
    return row([
      id,
      records[0].category,
      records[0].answerable ? 'yes' : 'no',
      ...modes.map((mode) => cell(records.find((record) => record.mode === mode))),
    ]);
  }),
  '',
  '## Needs manual review',
  '',
  ...graded
    .filter((record) => record.verdict === 'review')
    .map(
      (record) =>
        `- #${record.id} ${record.mode}: numeric=${record.numeric}, jev=${record.jevProbability?.toFixed(2)}. Expected: ${gold.get(record.id)?.expectedAnswer}`,
    ),
  '',
].join('\n');

// ---------- charts ----------

const MODE_STYLE: Record<AgentMode, { name: string; color: string }> = {
  jev: { name: 'With JEV', color: COLORS.jev },
  standard: { name: 'Standard', color: COLORS.standard },
};
const CATEGORY_LABELS: Record<string, string> = {
  count: 'Counts',
  lookup: 'Lookups',
  ranking: 'Rankings',
  comparison: 'Comparisons',
  aggregate: 'Aggregates',
  ambiguous: 'Ambiguous',
  out_of_scope: 'Out of scope',
};

const completed = (mode: AgentMode, filter: (record: GradedRecord) => boolean = () => true) =>
  graded.filter((record) => record.mode === mode && record.verdict !== 'failed' && filter(record));

/** Share of correct verdicts, or null when there is nothing to grade (drawn as N/A). */
function accuracyOf(records: GradedRecord[]) {
  return records.length ? (records.filter((r) => r.verdict === 'correct').length / records.length) * 100 : null;
}

const chartModes = modes.filter((mode): mode is AgentMode => mode in MODE_STYLE);
const seriesFor = (valueOf: (mode: AgentMode) => (number | null)[]) =>
  chartModes.map((mode) => ({ ...MODE_STYLE[mode], values: valueOf(mode) }));
const percentLabel = (value: number) => `${value.toFixed(1)}%`;
const secondsLabel = (value: number) => `${value.toFixed(1)} s`;
const tokensLabel = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(Math.round(value));
const nullable = (value: number) => (Number.isNaN(value) ? null : value);

const charts: Record<string, string> = {
  accuracy: groupedBarChart({
    title: 'Accuracy by question category',
    subtitle: 'Correct answers, including correctly refusing questions the data cannot answer',
    groups: ['All', ...categories.map((category) => CATEGORY_LABELS[category] ?? category)],
    series: seriesFor((mode) => [
      accuracyOf(completed(mode)),
      ...categories.map((category) => accuracyOf(completed(mode, (r) => r.category === category))),
    ]),
    format: percentLabel,
    tickFormat: (value) => `${value}%`,
    max: 100,
  }),
  latency: groupedBarChart({
    title: 'Response time',
    subtitle: 'Wall-clock seconds per question, failed runs excluded',
    groups: ['p50', 'Average', 'p95'],
    series: seriesFor((mode) => {
      const durations = completed(mode).map((r) => (r.durationMs ?? 0) / 1000);
      return [percentile(durations, 50), mean(durations), percentile(durations, 95)].map(nullable);
    }),
    format: secondsLabel,
    tickFormat: (value) => `${value} s`,
  }),
  tokens: groupedBarChart({
    title: 'Tokens per question (input + output)',
    subtitle: 'Average by question category',
    groups: ['All', ...categories.map((category) => CATEGORY_LABELS[category] ?? category)],
    series: seriesFor((mode) =>
      [undefined, ...categories].map((category) =>
        nullable(
          mean(
            completed(mode, (r) => category === undefined || r.category === category).map(
              (r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
            ),
          ),
        ),
      ),
    ),
    format: tokensLabel,
  }),
};

const base = resultsUrl.pathname.replace(/\.jsonl$/, '');
const chartsDir = `${base}-charts`;
await mkdir(chartsDir, { recursive: true });
await Promise.all(
  Object.entries(charts).map(([name, svg]) => writeFile(`${chartsDir}/${name}.svg`, svg)),
);
const chartSection = [
  '## Charts',
  '',
  ...Object.keys(charts).map((name) => `![${name}](${basename(chartsDir)}/${name}.svg)\n`),
].join('\n');

const CSV_COLUMNS: [string, (record: GradedRecord) => unknown][] = [
  ['id', (r) => r.id],
  ['category', (r) => r.category],
  ['answerable', (r) => r.answerable],
  ['mode', (r) => r.mode],
  ['model', (r) => r.model],
  ['verdict', (r) => r.verdict],
  ['duration_ms', (r) => r.durationMs?.toFixed(0)],
  ['route_ms', (r) => r.timings?.routeMs?.toFixed(0)],
  ['tables_ms', (r) => r.timings?.tablesMs?.toFixed(0)],
  ['executor_ms', (r) => r.timings?.executorMs?.toFixed(0)],
  ['jev_provider_ms', (r) => (r.jev ? jevCalls(r).reduce((s, c) => s + (c.providerMs ?? 0), 0) : undefined)],
  ['executor_input_tokens', (r) => r.inputTokens],
  ['executor_output_tokens', (r) => r.outputTokens],
  ['jev_input_tokens', (r) => (r.jev ? jevCalls(r).reduce((s, c) => s + c.inputTokens, 0) : undefined)],
  ['jev_output_tokens', (r) => (r.jev ? jevCalls(r).reduce((s, c) => s + c.outputTokens, 0) : undefined)],
  ['executor_cost_usd', (r) => r.costs?.executorUsd],
  ['jev_cost_usd', (r) => r.costs?.jevUsd],
  ['total_cost_usd', (r) => r.costs?.totalUsd],
  ['sql_queries', (r) => r.queries?.length],
  ['sql_errors', (r) => r.queries?.filter((q) => q.error).length],
  ['databases_used', (r) => r.databases?.length],
];
const csvValue = (value: unknown) => {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
await writeFile(
  `${base}.costs.csv`,
  [
    CSV_COLUMNS.map(([name]) => name).join(','),
    ...graded.map((record) => CSV_COLUMNS.map(([, value]) => csvValue(value(record))).join(',')),
  ].join('\n') + '\n',
);

await writeFile(`${base}.graded.jsonl`, graded.map((record) => JSON.stringify(record)).join('\n') + '\n');
await writeFile(`${base}.md`, report.replace('## Summary', `${chartSection}\n## Summary`));
await writeFile(
  `${base}.summary.json`,
  JSON.stringify(
    {
      model: graded.find((r) => r.model)?.model ?? null,
      metrics: metricRows.map(([label, key]) => ({
        label,
        values: Object.fromEntries(summaries.map((s) => [s.mode, s[key]])),
      })),
      charts: Object.keys(charts).map((name) => `${basename(chartsDir)}/${name}.svg`),
      questions: byQuestion.map((id) => {
        const records = graded.filter((record) => record.id === id);
        return {
          id,
          question: questions.get(id)?.question,
          category: records[0].category,
          answerable: records[0].answerable,
          runs: Object.fromEntries(
            records.map((r) => [
              r.mode,
              {
                verdict: r.verdict,
                durationMs: r.durationMs ?? null,
                tokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
              },
            ]),
          ),
        };
      }),
    },
    null,
    2,
  ),
);
console.log(`Charts: ${chartsDir}/`);
console.log(report.split('## Accuracy by category')[0]);
console.log(`Report: ${base}.md`);
