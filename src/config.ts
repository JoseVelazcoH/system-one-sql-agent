import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function parseModel(spec: string) {
  const [provider, ...rest] = spec.split(':');
  const modelId = rest.join(':');
  if (!provider || !modelId) {
    throw new Error(`AI_MODEL must look like "provider:model", got "${spec}"`);
  }
  return { provider, modelId };
}

export const config = {
  model: parseModel(required('AI_MODEL')),
  modelTemperature: Number(process.env.AI_MODEL_TEMPERATURE ?? 0.1),
  modelApiKey: process.env.AI_MODEL_API_KEY ?? '',
  routerModel: 'typesafe-ai/jev',
  routerThreshold: Number(process.env.ROUTER_THRESHOLD ?? 0.5),
  tableThreshold: Number(process.env.TABLE_THRESHOLD ?? 0.6),
  maxPreloadedTables: Number(process.env.MAX_PRELOADED_TABLES ?? 6),
  excludedDatabases: (process.env.EXCLUDED_DATABASES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
  catalogPath: new URL('../catalog.json', import.meta.url),
};
