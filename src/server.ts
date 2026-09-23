import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobStatus, listRuns, RESULTS_DIR, runSummary, startBenchmark } from './bench-api.js';
import { config } from './config.js';
import { runAgent, type AgentMode } from './pipeline.js';

const PORT = Number(process.env.PORT ?? 3000);
// Local by default: the benchmark endpoint starts paid LLM runs and has no authentication.
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const MODES: AgentMode[] = ['jev', 'standard'];
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleAsk(req: IncomingMessage, res: ServerResponse) {
  const { question, mode } = await readJson(req);
  if (typeof question !== 'string' || !question.trim() || !MODES.includes(mode)) {
    return sendJson(res, 400, { error: 'Expected { question: string, mode: "jev" | "standard" }' });
  }
  try {
    sendJson(res, 200, await runAgent(mode, question.trim()));
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: (error as Error).message });
  }
}

const BENCH_RESULTS_PREFIX = '/bench-results/';
const PAGES: Record<string, string> = { '/': 'index.html', '/bench': 'bench.html' };

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const [root, relative] = pathname.startsWith(BENCH_RESULTS_PREFIX)
    ? [RESULTS_DIR, pathname.slice(BENCH_RESULTS_PREFIX.length)]
    : [PUBLIC_DIR, PAGES[pathname] ?? pathname];
  const filePath = normalize(join(root, relative));
  if (!filePath.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' });

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return sendJson(res, 404, { error: 'Not found' });

  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

async function handleBench(req: IncomingMessage, res: ServerResponse, pathname: string) {
  try {
    if (req.method === 'GET' && pathname === '/api/bench/runs') return sendJson(res, 200, await listRuns());
    if (req.method === 'GET' && pathname === '/api/bench/status') return sendJson(res, 200, await jobStatus());
    if (req.method === 'GET' && pathname.startsWith('/api/bench/runs/')) {
      return sendJson(res, 200, await runSummary(pathname.slice('/api/bench/runs/'.length)));
    }
    if (req.method === 'POST' && pathname === '/api/bench/start') {
      const { limit } = await readJson(req);
      const parsed = Number(limit);
      return sendJson(res, 202, startBenchmark({ limit: parsed > 0 ? Math.min(parsed, 100) : undefined }));
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname.startsWith('/api/bench/')) return void handleBench(req, res, pathname);
  if (req.method === 'POST' && req.url === '/api/ask') return void handleAsk(req, res);
  if (req.method === 'GET' && req.url === '/api/config') {
    return sendJson(res, 200, { model: config.model.modelId });
  }
  if (req.method === 'GET') return void serveStatic(req, res);
  sendJson(res, 405, { error: 'Method not allowed' });
}).listen(PORT, HOST, () => {
  console.log(`system-one-sql-agent UI on http://${HOST}:${PORT}`);
});
