import { createOpenAI } from '@ai-sdk/openai';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import type { DatabaseEntry, TableEntry } from './catalog.js';
import { config } from './config.js';
import { listColumns, readOnlyQuery, type ColumnInfo } from './db.js';

const MAX_STEPS = 10;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Sums the billed cost that OpenRouter reports in every response (`usage.cost`). */
function costTrackingFetch(cost: { usd: number }): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    if (typeof body?.usage?.cost === 'number') cost.usd += body.usage.cost;
    return response;
  };
}

function executorModel(cost: { usd: number | null }) {
  const { provider, modelId } = config.model;
  if (!config.modelApiKey) throw new Error(`Missing environment variable ${config.modelApiKeyEnv}`);
  if (provider === 'openai') {
    cost.usd = null;
    return createOpenAI({ apiKey: config.modelApiKey })(modelId);
  }
  if (provider === 'openrouter') {
    cost.usd = 0;
    return createOpenAI({
      apiKey: config.modelApiKey,
      baseURL: OPENROUTER_BASE_URL,
      fetch: costTrackingFetch(cost as { usd: number }),
    }).chat(modelId);
  }
  throw new Error(`Unsupported executor.provider "${provider}". Use "openai" or "openrouter".`);
}

export type PreloadedColumns = Map<string, ColumnInfo[]>;

function describeTable(table: TableEntry, columns: ColumnInfo[]) {
  const header = `  - ${table.name}${table.comment ? `: ${table.comment}` : ''}`;
  if (columns.length === 0) return header;
  const lines = columns.map(
    (column) =>
      `      ${column.column} ${column.type}${column.comment ? ` -- ${column.comment}` : ''}`,
  );
  return [header, ...lines].join('\n');
}

function describeDatabases(databases: DatabaseEntry[], preloaded: PreloadedColumns) {
  return databases
    .map((db) => {
      const columns = preloaded.get(db.name) ?? [];
      const tables = db.tables
        .map((table) => describeTable(table, columns.filter((c) => c.table === table.name)))
        .join('\n');
      return `Database "${db.name}": ${db.description}\n${tables}`;
    })
    .join('\n\n');
}

/** Rows kept in memory for the best-of-N selector; capped so results stay small. */
const PREVIEW_ROW_LIMIT = 5;

export type ExecutedQuery = {
  database: string;
  sql: string;
  rowCount?: number;
  error?: string;
  /** First rows of the result, capped at PREVIEW_ROW_LIMIT. Only kept for successful queries. */
  preview?: Record<string, unknown>[];
};

export type AnswerQuestionOptions = {
  /** Overrides config.modelTemperature; used by the best-of-N selector to diversify candidates. */
  temperature?: number;
  /** Extra instruction appended to the system prompt, used by the best-of-N selector to diversify candidates. */
  hint?: string;
};

export async function answerQuestion(
  question: string,
  databases: DatabaseEntry[],
  preloaded: PreloadedColumns = new Map(),
  options: AnswerQuestionOptions = {},
) {
  const queries: ExecutedQuery[] = [];
  const cost: { usd: number | null } = { usd: null };
  const names = databases.map((db) => db.name) as [string, ...string[]];
  const databaseName = z.enum(names).describe('Database to use');

  const { text, totalUsage } = await generateText({
    model: executorModel(cost),
    temperature: options.temperature ?? config.modelTemperature,
    stopWhen: isStepCount(MAX_STEPS),
    instructions: [
      'You answer questions by querying PostgreSQL. Queries run in a read-only transaction.',
      'Use only the databases listed below.',
      'Tables listed with their columns are the most relevant ones: write the query directly with those columns.',
      'Never guess column names. For any other table, call listColumns before querying it.',
      'Answer in the same language as the question and mention which database you used.',
      'If no table measures exactly what the question asks, or the period asked is not covered, say that the data is not available. Never answer with a similar or proxy indicator (for example a different population or a different kind of record).',
      ...(options.hint ? ['', options.hint] : []),
      '',
      describeDatabases(databases, preloaded),
    ].join('\n'),
    prompt: question,
    tools: {
      listColumns: tool({
        description: 'List the columns of a table, with types and comments',
        inputSchema: z.object({ database: databaseName, table: z.string() }),
        execute: ({ database, table }) => listColumns(database, [table]),
      }),
      runQuery: tool({
        description: 'Run a single read-only SQL query. At most 100 rows are returned.',
        inputSchema: z.object({ database: databaseName, sql: z.string() }),
        execute: async ({ database, sql }) => {
          try {
            const result = await readOnlyQuery(database, sql);
            queries.push({
              database,
              sql,
              rowCount: result.rowCount,
              preview: (result.rows as Record<string, unknown>[]).slice(0, PREVIEW_ROW_LIMIT),
            });
            return result;
          } catch (error) {
            const message = (error as Error).message;
            queries.push({ database, sql, error: message });
            return { error: message };
          }
        },
      }),
    },
  });

  return {
    text,
    queries,
    inputTokens: totalUsage.inputTokens ?? 0,
    outputTokens: totalUsage.outputTokens ?? 0,
    /** Billed cost in USD when the provider reports it (OpenRouter), otherwise null. */
    costUsd: cost.usd,
  };
}
