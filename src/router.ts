import { experimental_evaluate as evaluate } from 'ai';
import type { DatabaseEntry } from './catalog.js';
import { config } from './config.js';

export type RouteMatch = { database: string; probability: number };

export type JevUsage = {
  inputTokens: number;
  outputTokens: number;
  /** List price reported by AI Gateway (marketCost), in USD. */
  costUsd: number | null;
  /** Time spent inside the provider, without gateway queueing or network. */
  providerMs: number | null;
};

type GatewayMetadata = {
  marketCost?: string;
  routing?: {
    modelAttempts?: { providerAttempts?: { success: boolean; startTime: number; endTime: number }[] }[];
  };
};

/** Extracts cost/latency/tokens from an `evaluate` result the same way for every Jev call site. */
export function jevUsage(result: Awaited<ReturnType<typeof evaluate>>): JevUsage {
  const gateway = result.providerMetadata?.gateway as GatewayMetadata | undefined;
  const attempt = gateway?.routing?.modelAttempts
    ?.flatMap((model) => model.providerAttempts ?? [])
    .findLast((provider) => provider.success);
  return {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    costUsd: gateway?.marketCost === undefined ? null : Number(gateway.marketCost),
    providerMs: attempt ? attempt.endTime - attempt.startTime : null,
  };
}

export const NO_JEV_USAGE: JevUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, providerMs: 0 };

export async function routeQuestion(question: string, catalog: DatabaseEntry[]) {
  const questions = Object.fromEntries(
    catalog.map((entry) => [
      entry.name,
      {
        type: 'boolean' as const,
        instructions: `Does the "${entry.name}" database contain the data needed to answer the user's question? Database contents: ${entry.description}`,
      },
    ]),
  );

  const result = await evaluate({
    model: config.routerModel,
    state: question,
    questions,
  });

  const ranked: RouteMatch[] = Object.entries(result.answers)
    .map(([database, answer]) => ({
      database,
      probability: answer.type === 'boolean' ? answer.probability : 0,
    }))
    .sort((a, b) => b.probability - a.probability);

  return {
    selected: ranked.filter((match) => match.probability >= config.routerThreshold),
    ranked,
    usage: jevUsage(result),
  };
}

export type TableMatch = { database: string; table: string; probability: number };

const MIGRATION_TABLE = /(^|\.)flyway_schema_history$/;

export async function routeTables(question: string, databases: DatabaseEntry[]) {
  const candidates = databases.flatMap((entry) =>
    entry.tables
      .filter((table) => !MIGRATION_TABLE.test(table.name))
      .map((table) => ({ database: entry.name, table })),
  );
  if (candidates.length === 0) return { matches: [], usage: NO_JEV_USAGE };

  const questions = Object.fromEntries(
    candidates.map(({ database, table }, index) => [
      `t${index}`,
      {
        type: 'boolean' as const,
        instructions: `Is the table "${table.name}" of the "${database}" database needed to write a SQL query that answers the user's question?${table.comment ? ` Table contents: ${table.comment}` : ''}`,
      },
    ]),
  );

  const result = await evaluate({
    model: config.routerModel,
    state: question,
    questions,
  });

  const matches = candidates
    .map(({ database, table }, index) => {
      const answer = result.answers[`t${index}`];
      return {
        database,
        table: table.name,
        probability: answer?.type === 'boolean' ? answer.probability : 0,
      };
    })
    .filter((match) => match.probability >= config.tableThreshold)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, config.maxPreloadedTables);
  return { matches, usage: jevUsage(result) };
}
