import { closePools } from './db.js';
import { runAgent } from './pipeline.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}

try {
  const run = await runAgent('jev', question);
  for (const match of run.route ?? []) {
    console.log(`  ${match.probability.toFixed(2)}  ${match.database}`);
  }
  console.log(`\n${run.text}`);
} finally {
  await closePools();
}
