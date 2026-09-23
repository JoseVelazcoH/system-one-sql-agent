<h1 align="center">system-one-sql-agent</h1>

<p align="center">
  A text-to-SQL agent that lets a fast System One model decide <em>where</em> to look,
  so the LLM only has to think about <em>how</em> to query it.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/built%20with-TypeScript-3178c6?style=flat-square" alt="TypeScript">
  <img src="https://img.shields.io/badge/AI%20SDK-7-black?style=flat-square" alt="AI SDK 7">
  <img src="https://img.shields.io/badge/database-PostgreSQL-336791?style=flat-square" alt="PostgreSQL">
</p>

> In *Thinking, Fast and Slow*, Daniel Kahneman describes two modes of thought: **System 1**,
> fast and intuitive, and **System 2**, slow and deliberate. TypeSafe AI borrowed the name for
> [System One models](https://typesafe.ai/blog/introducing-system-one-models-and-jev) such as
> Jev: models that make typed decisions instead of generating text. This project puts both
> systems to work together: System 1 routes, System 2 writes the SQL.

When a question can be answered by one of dozens of databases, a standard agent has to read
every schema before it can even start. This project splits that work in two:

1. **Route (System 1).** [Jev](https://vercel.com/ai-gateway/models/jev) scores every database,
   and then every table of the chosen databases, against the question in a single call each.
2. **Execute (System 2).** An LLM receives only the selected databases, with the columns of the
   most relevant tables preloaded, and writes read-only SQL to answer.

## Features

- **Two-stage routing** - one Jev call picks the databases (boolean question per database), a
  second one picks the tables and preloads their columns into the prompt.
- **Honest "no data" answers** - when no database clears the threshold the agent says so
  instead of guessing, and skips the LLM entirely.
- **Read-only by construction** - every query runs inside a `READ ONLY` transaction with a
  statement timeout, and is always rolled back.
- **Side-by-side UI** - ask a question and watch the routed agent and a standard agent answer
  in parallel, with the SQL they ran, per-stage timings, and input/output tokens.
- **Reproducible benchmark** - 100 user-style questions, a verified gold-answer dataset with
  reference SQL, an automatic grader, and charts, all runnable from the UI or the CLI.
- **Pluggable executor** - any OpenAI-compatible model through `openai:` or `openrouter:`.

See [docs/features.md](docs/features.md) for how each piece works.

## Benchmark results

100 questions written like a real user would ask them, without looking at the schemas. 75 can
be answered with the data and 25 cannot (out-of-scope topics or data that is not loaded), so
the benchmark also measures hallucinations. Both agents use `gpt-5.6-luna` as the executor.

<p align="center">
  <img src="assets/benchmark/accuracy.png" width="760" alt="Accuracy by question category" />
</p>

<p align="center">
  <img src="assets/benchmark/tokens.png" width="760" alt="Tokens per question" />
</p>

<p align="center">
  <img src="assets/benchmark/latency.png" width="760" alt="Response time" />
</p>

| Metric | With Jev routing | Standard agent |
| --- | --- | --- |
| Accuracy on answerable questions | 48.6% | **61.3%** |
| Hallucination rate on unanswerable questions | **28.0%** | 52.0% |
| Out-of-scope questions answered correctly | **100%** | 57.1% |
| Average input tokens per question | **12,372** | 74,150 |
| Latency p50 | **9.3 s** | 14.0 s |
| Executor time (average) | **8.9 s** | 14.8 s |
| Latency p95 | 38.9 s | **28.7 s** |

**p50** is the median: half of the questions were answered faster than that. **p95** is the
tail: 95% were faster and the slowest 5% took longer, so it shows the worst typical case.

What the numbers say:

- **Routing cuts input tokens by ~6x** and makes the executor ~40% faster, because the LLM no
  longer reads 30 schemas.
- **It hallucinates far less.** When the data is not there, the router stops the question
  before the LLM can invent an answer.
- **It is less accurate on answerable questions.** Most of the gap comes from the router
  discarding a database that was actually needed (threshold and catalog descriptions still
  need calibration).
- **The p95 latency is dominated by AI Gateway retries during outages**, not by Jev itself;
  warm routing takes about 1 s.

Treat these as a first baseline rather than a verdict: thresholds are not tuned yet and 23
answers were flagged for manual review.

## Install

Requirements: Node.js 22+, [pnpm](https://pnpm.io), a PostgreSQL server with the databases
you want to query, an [AI Gateway](https://vercel.com/ai-gateway) key (for Jev) and an
OpenAI or OpenRouter key (for the executor).

```sh
git clone https://github.com/JoseVelazcoH/system-one-sql-agent.git
cd system-one-sql-agent
pnpm install
cp .env.example .env   # fill in the keys and the Postgres connection
pnpm catalog           # build catalog.json from your databases
```

`catalog.json` holds a short description of every database and table. **Routing quality
depends on it**: review the generated descriptions and rewrite the weak ones by hand. Your
edits survive the next `pnpm catalog`.

## Quick start

```sh
pnpm dev               # UI on http://localhost:3000
```

- **`/`** compares both agents on the same question.
- **`/bench`** runs the benchmark (5, 20 or 100 questions), shows the charts and per-question
  results, and exports them to PDF or PNG.

From the command line:

```sh
pnpm ask "¿Cuántos habitantes tiene Jalisco?"
pnpm bench             # run the benchmark in both modes
pnpm bench:grade       # grade the latest run, write the report and charts
pnpm bench:refresh     # re-run the gold SQL to check the answers are still valid
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_MODEL` | - | Executor as `provider:model`, e.g. `openrouter:openai/gpt-5.6-luna` |
| `AI_MODEL_API_KEY` | - | Key for the executor provider |
| `AI_MODEL_TEMPERATURE` | `0.1` | Ignored by reasoning models |
| `AI_GATEWAY_API_KEY` | - | Vercel AI Gateway key, used for Jev |
| `ROUTER_THRESHOLD` | `0.5` | Minimum Jev probability for a database to be used |
| `TABLE_THRESHOLD` | `0.6` | Minimum Jev probability for a table to be preloaded |
| `MAX_PRELOADED_TABLES` | `6` | Cap on preloaded tables, to keep the prompt small |
| `EXCLUDED_DATABASES` | - | Databases never offered to the router |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` | - | Standard Postgres connection settings |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Where the UI listens |

The UI has no authentication and `/bench` can start paid LLM runs, so it only listens on
localhost by default. Put it behind authentication before exposing it with `HOST=0.0.0.0`.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and please
follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Released under the [GNU General Public License v3.0](LICENSE).
