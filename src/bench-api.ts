import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../bench/results/', import.meta.url));

type Job = {
  name: string;
  phase: 'running' | 'grading' | 'done' | 'error';
  total: number;
  startedAt: string;
  error?: string;
};

let job: Job | null = null;

async function lineCount(path: string) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.trim()).length;
}

function runStep(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsx', ...args], { cwd: ROOT, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`))));
    child.on('error', reject);
  });
}

export async function listRuns() {
  const files = await readdir(RESULTS_DIR).catch(() => []);
  return files
    .filter((name) => name.endsWith('.summary.json'))
    .map((name) => name.replace('.summary.json', ''))
    .sort()
    .reverse();
}

export async function runSummary(name: string) {
  if (!/^[\w-]+$/.test(name)) throw new Error('Invalid run name');
  return JSON.parse(await readFile(`${RESULTS_DIR}${name}.summary.json`, 'utf8'));
}

export async function jobStatus() {
  if (!job) return null;
  const done = await lineCount(`${RESULTS_DIR}${job.name}.jsonl`);
  return { ...job, done };
}

export function startBenchmark({ limit }: { limit?: number }) {
  if (job && (job.phase === 'running' || job.phase === 'grading')) {
    throw new Error('A benchmark is already running');
  }
  const name = new Date().toISOString().replace(/[:.]/g, '-');
  const output = `${RESULTS_DIR}${name}.jsonl`;
  const limitArgs = limit ? ['--limit', String(limit)] : [];
  const current: Job = {
    name,
    phase: 'running',
    total: (limit ?? 100) * 2,
    startedAt: new Date().toISOString(),
  };
  job = current;

  (async () => {
    try {
      await runStep(['bench/run.ts', '--resume', output, ...limitArgs]);
      current.phase = 'grading';
      await runStep(['bench/grade.ts', '--results', output]);
      current.phase = 'done';
    } catch (error) {
      current.phase = 'error';
      current.error = (error as Error).message;
    }
  })();
  return current;
}
