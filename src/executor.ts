import { createOpenAI } from '@ai-sdk/openai';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import type { DatabaseEntry, TableEntry } from './catalog.js';
import { config } from './config.js';
import { listColumns, readOnlyQuery, type ColumnInfo } from './db.js';

const MAX_STEPS = 10;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function executorModel() {
  const { provider, modelId } = config.model;
  if (!config.modelApiKey) throw new Error('Missing environment variable AI_MODEL_API_KEY');
  if (provider === 'openai') return createOpenAI({ apiKey: config.modelApiKey })(modelId);
  if (provider === 'openrouter') {
    return createOpenAI({ apiKey: config.modelApiKey, baseURL: OPENROUTER_BASE_URL }).chat(modelId);
  }
  throw new Error(`Unsupported AI_MODEL provider "${provider}". Use "openai" or "openrouter".`);
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
      return `Database "${db.name}":\n${tables}`;
    })
    .join('\n\n');
}

export type ExecutedQuery = {
  database: string;
  sql: string;
  rowCount?: number;
  error?: string;
};

export async function answerQuestion(
  question: string,
  databases: DatabaseEntry[],
  preloaded: PreloadedColumns = new Map(),
) {
  const queries: ExecutedQuery[] = [];
  const names = databases.map((db) => db.name) as [string, ...string[]];
  const databaseName = z.enum(names).describe('Database to use');

  const { text, totalUsage } = await generateText({
    model: executorModel(),
    temperature: config.modelTemperature,
    stopWhen: isStepCount(MAX_STEPS),
    instructions: [
      'You answer questions by querying PostgreSQL. Queries run in a read-only transaction.',
      'Use only the databases listed below.',
      'Tables listed with their columns are the most relevant ones: write the query directly with those columns.',
      'Never guess column names. For any other table, call listColumns before querying it.',
      'Answer in the same language as the question and mention which database you used.',
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
            queries.push({ database, sql, rowCount: result.rowCount });
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
  };
}
