import { experimental_evaluate as evaluate } from 'ai';
import type { DatabaseEntry } from './catalog.js';
import { config } from './config.js';

export type RouteMatch = { database: string; probability: number };

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

  const { answers } = await evaluate({
    model: config.routerModel,
    state: question,
    questions,
  });

  const ranked: RouteMatch[] = Object.entries(answers)
    .map(([database, answer]) => ({
      database,
      probability: answer.type === 'boolean' ? answer.probability : 0,
    }))
    .sort((a, b) => b.probability - a.probability);

  return {
    selected: ranked.filter((match) => match.probability >= config.routerThreshold),
    ranked,
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
  if (candidates.length === 0) return [];

  const questions = Object.fromEntries(
    candidates.map(({ database, table }, index) => [
      `t${index}`,
      {
        type: 'boolean' as const,
        instructions: `Is the table "${table.name}" of the "${database}" database needed to write a SQL query that answers the user's question?${table.comment ? ` Table contents: ${table.comment}` : ''}`,
      },
    ]),
  );

  const { answers } = await evaluate({
    model: config.routerModel,
    state: question,
    questions,
  });

  return candidates
    .map(({ database, table }, index) => {
      const answer = answers[`t${index}`];
      return {
        database,
        table: table.name,
        probability: answer?.type === 'boolean' ? answer.probability : 0,
      };
    })
    .filter((match) => match.probability >= config.tableThreshold)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, config.maxPreloadedTables);
}
