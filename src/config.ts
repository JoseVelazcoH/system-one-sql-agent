import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_FILE = resolve(ROOT, process.env.CONFIG_FILE ?? 'config.yaml');

/** Secrets never live in the YAML file: it only names the environment variable that holds them. */
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable name');

const schema = z.object({
  executor: z.object({
    provider: z.enum(['openai', 'openrouter']),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).default(0.1),
    apiKeyEnv: envName.default('AI_MODEL_API_KEY'),
  }),
  router: z
    .object({
      model: z.string().default('typesafe-ai/jev'),
      databaseThreshold: z.number().min(0).max(1).default(0.5),
      tableThreshold: z.number().min(0).max(1).default(0.6),
      maxPreloadedTables: z.number().int().positive().default(6),
    })
    .prefault({}),
  postgres: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().default(5432),
    user: z.string(),
    passwordEnv: envName.default('PGPASSWORD'),
    /** Allowlist. When omitted, every database on the server except `exclude` is used. */
    databases: z.array(z.string()).optional(),
    exclude: z.array(z.string()).default(['postgres']),
  }),
  catalog: z
    .object({
      path: z.string().default('catalog.json'),
      /** Regexes for tables left out of the generated descriptions (lookups, migrations). */
      descriptionIgnore: z.array(z.string()).default(['^flyway_schema_history$']),
    })
    .prefault({}),
  benchmark: z
    .object({
      questions: z.string().default('bench/questions.json'),
      answers: z.string().default('bench/answers.json'),
      /** Optional logo (png/svg) embedded as a subtle watermark on every chart. */
      watermark: z.string().optional(),
    })
    .prefault({}),
  selector: z
    .object({
      /** Number of candidate answers generated in parallel for jev-bon mode. */
      candidates: z.number().int().positive().default(4),
      /** Sampling temperature for every candidate after the first (which keeps executor.temperature). */
      temperature: z.number().min(0).max(2).default(0.7),
      /** Minimum share of candidates that must agree on a number for consensus to skip the Jev call. */
      threshold: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),
});

function load() {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`Config file not found: ${CONFIG_FILE}. Copy config.example.yaml to config.yaml and edit it.`);
  }
  const parsed = schema.safeParse(parse(readFileSync(CONFIG_FILE, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid ${CONFIG_FILE}:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

const file = load();
// Relative paths in the config file are resolved against the file's own folder.
const fromConfig = (path: string) => pathToFileURL(resolve(dirname(CONFIG_FILE), path));

export const config = {
  model: { provider: file.executor.provider, modelId: file.executor.model },
  modelTemperature: file.executor.temperature,
  modelApiKey: process.env[file.executor.apiKeyEnv] ?? '',
  modelApiKeyEnv: file.executor.apiKeyEnv,
  routerModel: file.router.model,
  routerThreshold: file.router.databaseThreshold,
  tableThreshold: file.router.tableThreshold,
  maxPreloadedTables: file.router.maxPreloadedTables,
  postgres: {
    host: file.postgres.host,
    port: file.postgres.port,
    user: file.postgres.user,
    password: process.env[file.postgres.passwordEnv],
    databases: file.postgres.databases,
    exclude: file.postgres.exclude,
  },
  catalogPath: fromConfig(file.catalog.path),
  catalogIgnore: file.catalog.descriptionIgnore.map((pattern) => new RegExp(pattern)),
  benchmark: {
    questionsPath: fromConfig(file.benchmark.questions),
    answersPath: fromConfig(file.benchmark.answers),
    watermarkPath: file.benchmark.watermark ? fromConfig(file.benchmark.watermark) : undefined,
  },
  selector: {
    candidates: file.selector.candidates,
    temperature: file.selector.temperature,
    threshold: file.selector.threshold,
  },
};
