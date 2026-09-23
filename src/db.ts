import 'dotenv/config';
import pg from 'pg';

const MAX_ROWS = 100;
const STATEMENT_TIMEOUT = '15s';

const pools = new Map<string, pg.Pool>();

function poolFor(database: string): pg.Pool {
  let pool = pools.get(database);
  if (!pool) {
    pool = new pg.Pool({ database, max: 2 });
    pools.set(database, pool);
  }
  return pool;
}

export type QueryOptions = {
  params?: unknown[];
  maxRows?: number;
  timeout?: string;
  rowMode?: 'object' | 'array';
};

export async function readOnlyQuery(
  database: string,
  sql: string,
  { params = [], maxRows = MAX_ROWS, timeout = STATEMENT_TIMEOUT, rowMode = 'object' }: QueryOptions = {},
) {
  if (!/^\d+(ms|s|min)$/.test(timeout)) throw new Error(`Invalid statement timeout "${timeout}"`);
  const client = await poolFor(database).connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${timeout}'`);
    const query = { text: sql, values: params, ...(rowMode === 'array' && { rowMode }) };
    const result = await client.query(query as pg.QueryConfig);
    return {
      rowCount: result.rowCount ?? result.rows.length,
      rows: result.rows.slice(0, maxRows),
      truncated: result.rows.length > maxRows,
    };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export type ColumnInfo = { table: string; column: string; type: string; comment: string | null };

export async function listColumns(database: string, tables: string[]) {
  const { rows } = await readOnlyQuery(
    database,
    `select t.name as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
            col_description(a.attrelid, a.attnum) as comment
       from unnest($1::text[]) with ordinality as t(name, position)
       join pg_attribute a on a.attrelid = to_regclass(t.name)
      where a.attnum > 0 and not a.attisdropped
      order by t.position, a.attnum`,
    { params: [tables], maxRows: Infinity },
  );
  return rows as ColumnInfo[];
}

export async function closePools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
