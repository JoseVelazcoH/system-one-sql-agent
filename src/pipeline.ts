import { loadCatalog } from './catalog.js';
import { config } from './config.js';
import { listColumns } from './db.js';
import { answerQuestion, type ExecutedQuery, type PreloadedColumns } from './executor.js';
import {
  NO_JEV_USAGE,
  routeQuestion,
  routeTables,
  type JevUsage,
  type RouteMatch,
  type TableMatch,
} from './router.js';
import { pickCandidate, type SelectorCandidate } from './selector.js';

export type AgentMode = 'jev' | 'standard' | 'jev-bon';

/** Hints rotated across best-of-N candidates (after the first, which uses default settings). */
const CANDIDATE_HINTS = [
  'If the question does not state a period, use the most recent complete year available and say so.',
  'Use the most literal interpretation of the question and state any assumption.',
  'Prefer official totals over sums of partial records when both exist.',
];

export type AgentRun = {
  mode: AgentMode;
  model: string;
  text: string;
  databases: string[];
  route?: RouteMatch[];
  /** Every database with its probability, including the ones below the threshold. */
  routeRanked?: RouteMatch[];
  tables?: TableMatch[];
  queries: ExecutedQuery[];
  durationMs: number;
  timings: { routeMs?: number; tablesMs?: number; executorMs: number; selectMs?: number };
  /** Executor tokens (the LLM). Jev tokens are reported separately in `jev`. */
  inputTokens: number;
  outputTokens: number;
  /** Usage of each Jev call (route/tables in jev mode, selector in jev-bon mode). */
  jev?: { route: JevUsage; tables: JevUsage; selector?: JevUsage };
  /** USD; null when the provider does not report cost (e.g. OpenAI direct). */
  costs: { executorUsd: number | null; jevUsd: number; totalUsd: number | null };
  /** Every candidate generated in jev-bon mode, in original (unshuffled) order. */
  candidates?: {
    text: string;
    queries: ExecutedQuery[];
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }[];
  /** Which candidate was chosen and how, in jev-bon mode. */
  selection?: { index: number; probabilities: number[]; consensus: boolean };
};

const NO_DATABASE_ANSWER =
  'Ninguna base de datos disponible puede responder esta pregunta. Intenta reformularla.';

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

async function preloadColumns(tables: TableMatch[]): Promise<PreloadedColumns> {
  const byDatabase = Map.groupBy(tables, (match) => match.database);
  const entries = await Promise.all(
    [...byDatabase].map(async ([database, matches]) => {
      const columns = await listColumns(database, matches.map((match) => match.table));
      return [database, columns] as const;
    }),
  );
  return new Map(entries);
}

export async function runAgent(mode: AgentMode, question: string): Promise<AgentRun> {
  const started = performance.now();
  const catalog = await loadCatalog();
  let databases = catalog;
  let route: RouteMatch[] | undefined;
  let routeRanked: RouteMatch[] | undefined;
  let tables: TableMatch[] | undefined;
  let preloaded: PreloadedColumns = new Map();
  const timings: AgentRun['timings'] = { executorMs: 0 };
  let jev: AgentRun['jev'];

  if (mode === 'jev' || mode === 'jev-bon') {
    const [routing, routeMs] = await timed(() => routeQuestion(question, catalog));
    route = routing.selected;
    routeRanked = routing.ranked;
    timings.routeMs = routeMs;
    const chosen = new Set(route.map((match) => match.database));
    databases = catalog.filter((entry) => chosen.has(entry.name));

    const [tableRouting, tablesMs] = await timed(async () => {
      const routed = databases.length > 0 ? await routeTables(question, databases) : null;
      preloaded = await preloadColumns(routed?.matches ?? []);
      return routed;
    });
    tables = tableRouting?.matches ?? [];
    timings.tablesMs = tablesMs;
    jev = { route: routing.usage, tables: tableRouting?.usage ?? NO_JEV_USAGE };
  }

  if (mode === 'jev-bon' && databases.length > 0) {
    return runBestOfN(question, databases, preloaded, { route, routeRanked, tables, timings, jev, started });
  }

  const [result, executorMs] = await timed(async () =>
    databases.length > 0
      ? answerQuestion(question, databases, preloaded)
      : { text: NO_DATABASE_ANSWER, queries: [], inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  timings.executorMs = executorMs;

  const { costUsd: executorUsd, ...answer } = result;
  const jevUsd = (jev?.route.costUsd ?? 0) + (jev?.tables.costUsd ?? 0);

  return {
    mode,
    model: config.model.modelId,
    databases: databases.map((entry) => entry.name),
    route,
    routeRanked,
    tables,
    durationMs: performance.now() - started,
    timings,
    jev,
    costs: { executorUsd, jevUsd, totalUsd: executorUsd === null ? null : executorUsd + jevUsd },
    ...answer,
  };
}

type BestOfNContext = {
  route?: RouteMatch[];
  routeRanked?: RouteMatch[];
  tables?: TableMatch[];
  timings: AgentRun['timings'];
  jev?: AgentRun['jev'];
  started: number;
};

async function runBestOfN(
  question: string,
  databases: Awaited<ReturnType<typeof loadCatalog>>,
  preloaded: PreloadedColumns,
  { route, routeRanked, tables, timings, jev, started }: BestOfNContext,
): Promise<AgentRun> {
  const count = config.selector.candidates;

  const [settled, executorMs] = await timed(() =>
    Promise.allSettled(
      Array.from({ length: count }, (_, index) =>
        answerQuestion(question, databases, preloaded, {
          ...(index > 0 && { temperature: config.selector.temperature }),
          ...(index > 0 && { hint: CANDIDATE_HINTS[(index - 1) % CANDIDATE_HINTS.length] }),
        }),
      ),
    ),
  );
  timings.executorMs = executorMs;

  const results = settled
    .map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : null))
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (results.length === 0) {
    const firstRejected = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    throw firstRejected?.reason ?? new Error('All best-of-N candidates failed.');
  }

  const candidateInputs: SelectorCandidate[] = results.map((result) => ({
    text: result.text,
    queries: result.queries,
  }));

  const [selection, selectMs] = await timed(() => pickCandidate(question, candidateInputs));
  timings.selectMs = selectMs;

  const chosen = results[selection.index];
  const executorUsd = results.every((result) => result.costUsd !== null)
    ? results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0)
    : null;
  const jevUsd =
    (jev?.route.costUsd ?? 0) + (jev?.tables.costUsd ?? 0) + (selection.usage.costUsd ?? 0);

  return {
    mode: 'jev-bon',
    model: config.model.modelId,
    databases: databases.map((entry) => entry.name),
    route,
    routeRanked,
    tables,
    text: chosen.text,
    queries: chosen.queries,
    durationMs: performance.now() - started,
    timings,
    inputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
    outputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
    jev: jev && { ...jev, selector: selection.usage },
    costs: { executorUsd, jevUsd, totalUsd: executorUsd === null ? null : executorUsd + jevUsd },
    candidates: results.map((result) => ({
      text: result.text,
      queries: result.queries,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    })),
    selection: {
      index: selection.index,
      probabilities: selection.probabilities,
      consensus: selection.consensus,
    },
  };
}
