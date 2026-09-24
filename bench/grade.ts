/**
 * Grades benchmark results against answers.json and writes a markdown report.
 *
 *   npm run bench:grade -- [--results bench/results/<file>.jsonl[,<file2>.jsonl,...]] [--concurrency N] [--out name]
 *
 * `--results` accepts a comma-separated list of files: they are merged (last record per
 * id+mode wins) before grading, which is how a jev-bon run gets compared against an
 * existing standard/jev run. Output is named after the first file, or `--out` when given.
 *
 * Each answer gets two independent signals:
 *   - numeric: expected values found in the text (deterministic, rounding tolerant)
 *   - jev: a Jev boolean judgment against the expected and acceptable answers
 * When they disagree the answer is marked "review" instead of guessing.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { experimental_evaluate as evaluate } from 'ai';
import { config } from '../src/config.js';
import type { AgentMode } from '../src/pipeline.js';
import { COLORS, groupedBarChart, linkedinAccuracyChart, summaryChart } from './charts.js';
import {
  latestResults,
  loadAnswers,
  loadQuestions,
  mean,
  normalizeText,
  parseArgs,
  percentile,
  readJsonl,
  RESULTS_DIR,
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
const resultsUrls =
  typeof args.results === 'string'
    ? args.results.split(',').map((path) => pathToFileURL(path.trim()))
    : [await latestResults()];
const resultsUrl = resultsUrls[0];
const concurrency = Number(args.concurrency ?? 3);

/** Every plausible reading of each number in the text (1,234.5 vs 1.234,5, "3 mil"). */
function extractNumbers(raw: string): number[] {
  // Spaces as thousands separators ("10 348", "939 969,53", also no-break spaces) become plain digits.
  const text = raw.replace(/(\d)[   ](?=\d{3}(?!\d))/g, '$1');
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
// --label mode=Name,mode2=Name2 names the series of runs recorded without a label (older runs).
const labelOverrides = new Map(
  typeof args.label === 'string'
    ? args.label.split(',').map((pair) => {
        const [mode, ...rest] = pair.split('=');
        return [mode.trim(), rest.join('=').trim()] as const;
      })
    : [],
);
const records = (await Promise.all(resultsUrls.map((url) => readJsonl<RunRecord>(url))))
  .flat()
  .map((record) => (record.label || !labelOverrides.has(record.mode) ? record : { ...record, label: labelOverrides.get(record.mode) }));

// Keep the last record per (id, mode, model, label), so resumed runs replace earlier failures
// while merged files with the same mode but a different executor model (or a different
// --label) stay as separate rows.
const latest = [
  ...new Map(
    records.map((record) => [`${record.id}:${record.mode}:${record.model ?? ''}:${record.label ?? ''}`, record]),
  ).values(),
];

const outputBase =
  typeof args.out === 'string'
    ? new URL(args.out, RESULTS_DIR).pathname.replace(/\.jsonl$/, '')
    : resultsUrl.pathname.replace(/\.jsonl$/, '');

// --reuse-judge keeps the Jev judge probability from the previous grade of the same run (matched
// by id, mode, model, label and start time), so charts and the report can be regenerated without
// paying for the judge again or letting its verdicts drift. The numeric check is always recomputed.
const runKey = (record: RunRecord) =>
  `${record.id}:${record.mode}:${record.model ?? ''}:${record.startedAt ?? ''}`;
const previousJudge = new Map<string, number>();
if (args['reuse-judge']) {
  // `--reuse-judge <file.graded.jsonl>` reuses exactly that grade, so charts in another size
  // or name keep identical verdicts. A bare flag falls back to this --out name and the default
  // grade of each results file.
  const gradedFiles = new Set(typeof args['reuse-judge'] === 'string' ? [args['reuse-judge']] : [
    `${outputBase}.graded.jsonl`,
    ...resultsUrls.map((url) => url.pathname.replace(/\.jsonl$/, '.graded.jsonl')),
  ]);
  for (const file of [...gradedFiles].filter((path) => existsSync(path))) {
    for (const record of await readJsonl<GradedRecord>(pathToFileURL(file))) {
      // Earlier files in the list win: the --out grade is the most specific one.
      if (typeof record.jevProbability === 'number' && !previousJudge.has(runKey(record))) {
        previousJudge.set(runKey(record), record.jevProbability);
      }
    }
  }
}

async function gradeRecord(record: RunRecord): Promise<GradedRecord> {
  const question = questions.get(record.id)!;
  const answer = gold.get(record.id);
  if (!answer) throw new Error(`answers.json has no entry for question ${record.id}`);
  const base = { ...record, category: question.category, answerable: answer.answerable };
  if (record.status !== 'ok' || record.text === undefined) {
    return { ...base, numeric: 'n/a', verdict: 'failed' };
  }
  const numeric = numericCheck(record.text, answer);
  const jevProbability =
    previousJudge.get(runKey(record)) ?? (await jevJudgeWithRetry(question, answer, record.text));
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

// A series is normally one per mode. When merged result files run the same mode against
// different executor models, each (mode, model) pair becomes its own series instead, so the
// report and charts do not average unrelated runs together. When rows carry a `--label`, the
// label takes precedence and is used verbatim as the series key and name.
const modelsByMode = new Map<AgentMode, Set<string>>();
for (const record of graded) {
  if (!record.model) continue;
  const models = modelsByMode.get(record.mode) ?? new Set<string>();
  models.add(record.model);
  modelsByMode.set(record.mode, models);
}
const seriesKeyOf = (record: RunRecord) =>
  record.label ?? ((modelsByMode.get(record.mode)?.size ?? 0) > 1 ? `${record.mode}::${record.model}` : record.mode);

function modeSummary(key: string) {
  const runs = graded.filter((record) => seriesKeyOf(record) === key);
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
    key,
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

const MODE_NAMES: Record<AgentMode, string> = { jev: 'With JEV', standard: 'Standard', 'jev-bon': 'Best of N' };
const MODE_COLORS: Record<AgentMode, string> = { jev: COLORS.jev, standard: COLORS.standard, 'jev-bon': '#3a86ff' };
// Fixed colors for the standard "Sol" comparison, keyed by the exact --label value.
const LABEL_COLORS: Record<string, string> = {
  Sol: '#d9376e',
  'Sol + Jev': '#ff8e3c',
  'Luna + Jev': '#3a86ff',
};
const EXTRA_COLORS = ['#7209b7', '#2a9d8f', '#e9c46a', '#ff006e'];

// Series order follows first appearance across the --results files (in the order given), not
// grading order, so the user controls it via --results file order / --label.
const seriesKeys = [...new Set(records.map(seriesKeyOf))].filter((key) =>
  graded.some((record) => seriesKeyOf(record) === key),
);
const usedColors = new Set<string>();
let extraColorIndex = 0;
function colorForMode(mode: AgentMode) {
  const base = MODE_COLORS[mode] ?? COLORS.muted;
  if (!usedColors.has(base)) {
    usedColors.add(base);
    return base;
  }
  const color = EXTRA_COLORS[extraColorIndex++ % EXTRA_COLORS.length];
  usedColors.add(color);
  return color;
}
function colorForKey(key: string, mode: AgentMode) {
  if (LABEL_COLORS[key] && !usedColors.has(LABEL_COLORS[key])) {
    usedColors.add(LABEL_COLORS[key]);
    return LABEL_COLORS[key];
  }
  return colorForMode(mode);
}
const seriesStyle = new Map(
  seriesKeys.map((key) => {
    const sample = graded.find((record) => seriesKeyOf(record) === key)!;
    const mode = sample.mode;
    const model = sample.model;
    const name = sample.label
      ? sample.label
      : model && (modelsByMode.get(mode)?.size ?? 0) > 1
        ? `${MODE_NAMES[mode] ?? mode} (${model})`
        : (MODE_NAMES[mode] ?? mode);
    return [key, { name, color: colorForKey(key, mode), mode }];
  }),
);
const seriesLabel = (key: string) => seriesStyle.get(key)!.name;

const summaries = seriesKeys.map(modeSummary);
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
  `- Results: ${resultsUrls.map((url) => `\`${url.pathname}\``).join(', ')}`,
  `- Executor model: \`${graded.find((r) => r.model)?.model ?? 'unknown'}\``,
  `- Judge: numeric check + \`${config.routerModel}\` (threshold ${JUDGE_THRESHOLD})`,
  '',
  '## Summary',
  '',
  row(['Metric', ...seriesKeys.map(seriesLabel)]),
  row(['---', ...seriesKeys.map(() => '---')]),
  ...metricRows.map(([label, key]) => row([label, ...summaries.map((summary) => summary[key])])),
  '',
  '## Accuracy by category',
  '',
  row(['Category', ...seriesKeys.map(seriesLabel)]),
  row(['---', ...seriesKeys.map(() => '---')]),
  ...categories.map((category) =>
    row([
      category,
      ...seriesKeys.map((key) => {
        const runs = graded.filter(
          (r) => seriesKeyOf(r) === key && r.category === category && r.verdict !== 'failed',
        );
        return pct(runs.filter((r) => r.verdict === 'correct').length, runs.length);
      }),
    ]),
  ),
  '',
  '## Per question',
  '',
  row(['#', 'Category', 'Answerable', ...seriesKeys.map(seriesLabel)]),
  row(['---', '---', '---', ...seriesKeys.map(() => '---')]),
  ...byQuestion.map((id) => {
    const records = graded.filter((record) => record.id === id);
    return row([
      id,
      records[0].category,
      records[0].answerable ? 'yes' : 'no',
      ...seriesKeys.map((key) => cell(records.find((record) => seriesKeyOf(record) === key))),
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

const CATEGORY_LABELS: Record<string, string> = {
  count: 'Counts',
  lookup: 'Lookups',
  ranking: 'Rankings',
  comparison: 'Comparisons',
  aggregate: 'Aggregates',
  ambiguous: 'Ambiguous',
  out_of_scope: 'Out of scope',
};

const completed = (key: string, filter: (record: GradedRecord) => boolean = () => true) =>
  graded.filter((record) => seriesKeyOf(record) === key && record.verdict !== 'failed' && filter(record));

/** Share of correct verdicts, or null when there is nothing to grade (drawn as N/A). */
function accuracyOf(records: GradedRecord[]) {
  return records.length ? (records.filter((r) => r.verdict === 'correct').length / records.length) * 100 : null;
}

const seriesFor = (valueOf: (key: string) => (number | null)[]) =>
  seriesKeys.map((key) => ({ name: seriesStyle.get(key)!.name, color: seriesStyle.get(key)!.color, values: valueOf(key) }));
const secondsLabel = (value: number) => `${value.toFixed(1)} s`;
const tokensLabel = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(Math.round(value));
const nullable = (value: number) => (Number.isNaN(value) ? null : value);
/** Formats a USD amount with enough significant digits for small per-question costs. */
function usdLabel(value: number) {
  if (value === 0) return '$0';
  const decimals = value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return `$${value.toFixed(decimals)}`;
}

// Categories with the biggest accuracy gap between series, for the LinkedIn accuracy card.
const categorySpread = categories.map((category) => {
  const values = seriesKeys
    .map((key) => accuracyOf(completed(key, (r) => r.category === category)))
    .filter((v): v is number => v !== null);
  return { category, spread: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0 };
});
const topCategories = [...categorySpread]
  .sort((a, b) => b.spread - a.spread)
  .slice(0, 4)
  .map((entry) => entry.category);

// --size WxH changes the card size of the grouped charts, e.g. 1200x675 for 16:9.
const sizeMatch = typeof args.size === 'string' ? args.size.match(/^(\d+)x(\d+)$/) : null;
const size = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : undefined;

const charts: Record<string, string> = {
  accuracy: groupedBarChart({
    size,
    title: 'Accuracy by question category',
    subtitle: 'Correct answers, including correctly refusing questions the data cannot answer',
    groups: ['All', ...categories.map((category) => CATEGORY_LABELS[category] ?? category)],
    series: seriesFor((mode) => [
      accuracyOf(completed(mode)),
      ...categories.map((category) => accuracyOf(completed(mode, (r) => r.category === category))),
    ]),
    // Whole percents keep three labels per group readable; the report keeps one decimal.
    format: (value) => `${Math.round(value)}%`,
    tickFormat: (value) => `${value}%`,
    max: 100,
  }),
  latency: groupedBarChart({
    size,
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
    size,
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
  costs: groupedBarChart({
    size,
    title: 'Total cost (USD)',
    subtitle: 'Billed executor cost plus Jev cost, summed over every graded question',
    groups: ['Total cost'],
    series: seriesFor((key) => [totalCost(completed(key), (costs) => costs.totalUsd)]),
    format: usdLabel,
    tickFormat: usdLabel,
  }),
  'linkedin-summary': summaryChart({
    headline: seriesKeys.map(seriesLabel).join(' vs '),
    subtitle: `${byQuestion.length} questions`,
    accuracy: seriesKeys.map((key) => ({
      name: seriesLabel(key),
      color: seriesStyle.get(key)!.color,
      value: accuracyOf(completed(key)),
    })),
    cost: seriesKeys.map((key) => ({
      name: seriesLabel(key),
      color: seriesStyle.get(key)!.color,
      value: totalCost(completed(key), (costs) => costs.totalUsd),
    })),
    costFormat: usdLabel,
  }),
  'linkedin-accuracy': linkedinAccuracyChart({
    title: 'Accuracy: all questions vs biggest gaps by category',
    subtitle: `${byQuestion.length} questions`,
    groups: ['All', ...topCategories.map((category) => CATEGORY_LABELS[category] ?? category)],
    series: seriesFor((key) => [
      accuracyOf(completed(key)),
      ...topCategories.map((category) => accuracyOf(completed(key, (r) => r.category === category))),
    ]),
  }),
};

const base = outputBase;
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
  ['label', (r) => r.label],
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
        values: Object.fromEntries(summaries.map((s) => [s.key, s[key]])),
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
              seriesKeyOf(r),
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
