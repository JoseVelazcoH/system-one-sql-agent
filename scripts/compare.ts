import { closePools } from '../src/db.js';
import { runAgent, type AgentRun } from '../src/pipeline.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: pnpm compare "your question"');
  process.exit(1);
}

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const color = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(4)}`);

function print(title: string, tint: number, run: AgentRun) {
  console.log(`\n${bold(color(tint, `■ ${title}`))}`);
  if (run.route) {
    const picked = run.databases.length ? run.databases.join(', ') : 'none';
    console.log(`  ${dim('databases')}  ${picked}`);
  }
  if (run.tables?.length) {
    console.log(`  ${dim('tables   ')}  ${run.tables.map((match) => match.table).join(', ')}`);
  }
  console.log(`  ${dim('queries  ')}  ${run.queries.length}`);
  console.log(`  ${dim('time     ')}  ${seconds(run.durationMs)}`);
  console.log(`  ${dim('tokens   ')}  ${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out`);
  console.log(`  ${dim('cost     ')}  ${usd(run.costs.totalUsd)}`);
  console.log(`\n  ${run.text.replaceAll('\n', '\n  ')}`);
}

try {
  console.log(dim('Running both agents in parallel...'));
  const [jev, standard] = await Promise.all([
    runAgent('jev', question),
    runAgent('standard', question),
  ]);
  print('Agent with JEV', 208, jev);
  print('Standard agent', 161, standard);
} finally {
  await closePools();
}
