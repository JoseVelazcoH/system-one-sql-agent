import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import type { DatabaseEntry, TableEntry } from '../src/catalog.js';
import { config } from '../src/config.js';
import { connectionFor } from '../src/db.js';

const MAX_DESCRIPTION_LENGTH = 1200;

const catalogUrl = config.catalogPath;
const { databases: allowlist, exclude } = config.postgres;
const excluded = new Set(exclude);

/** Matches the bare table name, so "schema.table" and "table" behave the same. */
const ignoredInDescription = (name: string) =>
  config.catalogIgnore.some((pattern) => pattern.test(name.split('.').at(-1)!));

async function withClient<T>(database: string, fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client(connectionFor(database));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function listDatabases() {
  return withClient('postgres', async (client) => {
    const { rows } = await client.query<{ name: string; comment: string | null }>(
      `select datname as name, shobj_description(oid, 'pg_database') as comment
         from pg_database where not datistemplate order by datname`,
    );
    return rows.filter((row) =>
      allowlist ? allowlist.includes(row.name) : !excluded.has(row.name),
    );
  });
}

async function listTables(database: string): Promise<TableEntry[]> {
  return withClient(database, async (client) => {
    const { rows } = await client.query<TableEntry>(
      `select case when n.nspname = 'public' then c.relname else n.nspname || '.' || c.relname end as name,
              obj_description(c.oid, 'pg_class') as comment
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
          and c.relkind in ('r', 'v', 'm')
        order by 1`,
    );
    return rows;
  });
}

function describe(databaseComment: string | null, tables: TableEntry[]): string {
  const relevant = tables
    .filter((table) => !ignoredInDescription(table.name))
    .map((table) => (table.comment ? `${table.name} (${table.comment})` : table.name));
  const text = [databaseComment, `Tables: ${relevant.join('; ')}`].filter(Boolean).join('. ');
  return text.slice(0, MAX_DESCRIPTION_LENGTH);
}

const previous: DatabaseEntry[] = existsSync(catalogUrl)
  ? JSON.parse(await readFile(catalogUrl, 'utf8'))
  : [];
const previousByName = new Map(previous.map((entry) => [entry.name, entry]));

const catalog: DatabaseEntry[] = [];
for (const database of await listDatabases()) {
  const tables = await listTables(database.name);
  catalog.push({
    name: database.name,
    description:
      previousByName.get(database.name)?.description ?? describe(database.comment, tables),
    tables,
  });
  console.log(`${database.name}: ${tables.length} tables`);
}

await writeFile(catalogUrl, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${catalog.length} databases to ${catalogUrl.pathname}`);
