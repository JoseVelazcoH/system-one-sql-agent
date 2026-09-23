import { loadCatalog } from './catalog.js';
import { config } from './config.js';
import { listColumns } from './db.js';
import { answerQuestion, type ExecutedQuery, type PreloadedColumns } from './executor.js';
import { routeQuestion, routeTables, type RouteMatch, type TableMatch } from './router.js';

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
  inputTokens: number;
  outputTokens: number;
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

  if (mode === 'jev') {
    const [routing, routeMs] = await timed(() => routeQuestion(question, catalog));
    route = routing.selected;
    timings.routeMs = routeMs;
    const chosen = new Set(route.map((match) => match.database));
    databases = catalog.filter((entry) => chosen.has(entry.name));

    const [tableMatches, tablesMs] = await timed(async () => {
      const matches = await routeTables(question, databases);
      preloaded = await preloadColumns(matches);
      return matches;
    });
    tables = tableMatches;
    timings.tablesMs = tablesMs;
  }

  const [result, executorMs] = await timed(async () =>
    databases.length > 0
      ? answerQuestion(question, databases, preloaded)
      : { text: NO_DATABASE_ANSWER, queries: [], inputTokens: 0, outputTokens: 0 },
  );
  timings.executorMs = executorMs;

  return {
    mode,
    model: config.model.modelId,
    databases: databases.map((entry) => entry.name),
    route,
    tables,
    durationMs: performance.now() - started,
    timings,
    ...result,
  };
}
