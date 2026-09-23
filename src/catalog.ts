import { readFile } from 'node:fs/promises';
import { config } from './config.js';

export type TableEntry = { name: string; comment: string | null };

export type DatabaseEntry = {
  name: string;
  description: string;
  tables: TableEntry[];
};

export async function loadCatalog(): Promise<DatabaseEntry[]> {
  try {
    return JSON.parse(await readFile(config.catalogPath, 'utf8'));
  } catch {
    throw new Error('catalog.json not found. Run "npm run catalog" first.');
  }
}
