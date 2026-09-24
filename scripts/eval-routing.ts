// Routing-only evaluation: runs database routing (no executor) on every benchmark question,
// and saves the full ranking so thresholds can be calibrated.
import { readFile, writeFile } from 'node:fs/promises';
import { loadCatalog } from '../src/catalog.js';
import { config } from '../src/config.js';
import { routeQuestion } from '../src/router.js';

type Question = { id: number; question: string; category: string };
type Answer = { id: number; answerable: boolean; database?: string };

const questions: Question[] = JSON.parse(await readFile(config.benchmark.questionsPath, 'utf8'));
const answers: Answer[] = JSON.parse(await readFile(config.benchmark.answersPath, 'utf8'));
const gold = new Map(answers.map((answer) => [answer.id, answer]));
const catalog = await loadCatalog();

const rows: unknown[] = [];
let costUsd = 0;
const queue = questions.map((question) => ({ question }));

async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { question } = job;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await routeQuestion(question.question, catalog);
        costUsd += result.usage.costUsd ?? 0;
        rows.push({
          id: question.id,
          category: question.category,
          answerable: gold.get(question.id)?.answerable,
          goldDatabase: gold.get(question.id)?.database ?? null,
          ranked: result.ranked,
        });
        break;
      } catch (error) {
        if (attempt >= 6) {
          console.error(`#${question.id} failed: ${(error as Error).message}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      }
    }
  }
}

await Promise.all(Array.from({ length: 2 }, worker));

const out = `bench/results/routing-${new Date().toISOString().replaceAll(':', '-')}.jsonl`;
await writeFile(out, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
console.log(`${rows.length} routing calls, $${costUsd.toFixed(4)} -> ${out}`);
