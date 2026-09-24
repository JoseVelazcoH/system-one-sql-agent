import { readdir, readFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import type { AgentMode, AgentRun } from '../src/pipeline.js';

export const RESULTS_DIR = new URL('./results/', import.meta.url);

export type Question = { id: number; category: string; question: string };

export type GoldAnswer = {
  id: number;
  answerable: boolean;
  database?: string;
  goldSql?: string;
  expectedValues: (number | string)[];
  expectedAnswer: string;
  acceptable: string[];
  notes?: string;
};

export type RunRecord = {
  id: number;
  mode: AgentMode;
  status: 'ok' | 'failed';
  error?: string;
  attempts: number;
  startedAt: string;
  /** Wall-clock time of the successful attempt, as measured by runAgent. */
  durationMs?: number;
  /** Optional series label set with --label; takes precedence over mode/model for grouping. */
  label?: string;
} & Partial<Omit<AgentRun, 'mode' | 'durationMs'>>;

async function readJson<T>(url: URL, what: string): Promise<T> {
  const text = await readFile(url, 'utf8').catch(() => {
    throw new Error(`Benchmark ${what} not found at ${url.pathname}. Check benchmark.${what} in config.yaml.`);
  });
  return JSON.parse(text);
}

export const loadQuestions = () => readJson<Question[]>(config.benchmark.questionsPath, 'questions');
export const loadAnswers = () => readJson<GoldAnswer[]>(config.benchmark.answersPath, 'answers');

export async function readJsonl<T>(url: URL): Promise<T[]> {
  const text = await readFile(url, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

/** Most recent raw results file (excludes graded outputs). */
export async function latestResults(): Promise<URL> {
  const files = (await readdir(RESULTS_DIR).catch(() => []))
    .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.graded.jsonl'))
    .sort();
  const last = files.at(-1);
  if (!last) throw new Error('No results found in bench/results. Run "npm run bench" first.');
  return new URL(last, RESULTS_DIR);
}

export function parseArgs(argv: string[]) {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[token.slice(2)] = true;
    } else {
      args[token.slice(2)] = next;
      i++;
    }
  }
  return args;
}

/** Lowercase, accent-free text for loose comparisons. */
export function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Postgres returns bigint/numeric as strings; turn numeric strings into numbers. */
export function normalizeValue(value: unknown): number | string {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function percentile(values: number[], p: number) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
