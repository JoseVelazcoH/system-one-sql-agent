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

export type AgentMode = 'jev' | 'standard';

export type AgentRun = {
  mode: AgentMode;
  model: string;
  text: string;
  databases: string[];
  route?: RouteMatch[];
  tables?: TableMatch[];
  queries: ExecutedQuery[];
  durationMs: number;
  timings: { routeMs?: number; tablesMs?: number; executorMs: number };
  /** Executor tokens (the LLM). Jev tokens are reported separately in `jev`. */
  inputTokens: number;
  outputTokens: number;
  /** Usage of each Jev call (only in jev mode). */
  jev?: { route: JevUsage; tables: JevUsage };
  /** USD; null when the provider does not report cost (e.g. OpenAI direct). */
  costs: { executorUsd: number | null; jevUsd: number; totalUsd: number | null };
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
  let tables: TableMatch[] | undefined;
  let preloaded: PreloadedColumns = new Map();
  const timings: AgentRun['timings'] = { executorMs: 0 };
  let jev: AgentRun['jev'];

  if (mode === 'jev') {
    const [routing, routeMs] = await timed(() => routeQuestion(question, catalog));
    route = routing.selected;
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
    tables,
    durationMs: performance.now() - started,
    timings,
    jev,
    costs: { executorUsd, jevUsd, totalUsd: executorUsd === null ? null : executorUsd + jevUsd },
    ...answer,
  };
}
