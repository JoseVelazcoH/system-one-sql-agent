# Features

A deeper guide to how the agent works, how to tune it, and how the benchmark measures it.

## How a question flows

```
question
   │
   ▼
┌──────────────────────┐   one boolean question per database
│ 1. Database routing  │── Jev: "does this database contain the data?"
└──────────────────────┘   keeps every database >= databaseThreshold
   │  (none selected → "no database can answer", the LLM is never called)
   ▼
┌──────────────────────┐   one boolean question per table of the chosen databases
│ 2. Table routing     │── Jev: "is this table needed to write the query?"
└──────────────────────┘   keeps the top maxPreloadedTables >= tableThreshold
   │
   ▼
┌──────────────────────┐   columns of the selected tables are read from Postgres
│ 3. Column preload    │   and written into the executor prompt
└──────────────────────┘
   │
   ▼
┌──────────────────────┐   LLM with two tools: listColumns and runQuery
│ 4. Execution         │   sees only the routed databases
└──────────────────────┘
   │
   ▼
answer + SQL + timings + tokens
```

The standard agent used for comparison skips steps 1 to 3: it receives every database in the
catalog and decides by itself.

## Routing with Jev

Jev is an evaluation model: it does not generate text, it answers typed questions (`boolean`,
`choice`, `score`) about a shared `state` with calibrated probabilities. The router asks it
one boolean question per candidate in a single call (`src/router.ts`).

Booleans are used instead of a single `choice` on purpose. Several databases overlap (for
example two death registries), and a `choice` would split the probability between them so
that none clears the threshold. Independent booleans let two databases both score high, and
both are passed to the executor.

### Tuning

| Knob | Effect of raising it | Effect of lowering it |
| --- | --- | --- |
| `router.databaseThreshold` | fewer databases, fewer tokens, more "no data" misses | more databases, more tokens |
| `router.tableThreshold` | fewer preloaded tables | more columns in the prompt |
| `router.maxPreloadedTables` | more context for the executor | smaller prompt |

Without a cap, table routing once preloaded 27 tables and pushed a prompt to 137K tokens, more
than the standard agent. Keep the cap.

## The catalog

`catalog.json` is built by `pnpm catalog` (`scripts/build-catalog.ts`) from the live
Postgres instance: database comments, and every table in every schema with its comment.
Tables matching `catalog.descriptionIgnore` (migrations, shared lookup tables) are left out
of the descriptions. Which databases are included comes from `postgres.databases` (an
allowlist) or `postgres.exclude`.

The description of each database is the only thing Jev reads to decide, so it is the
strongest lever on accuracy. Rewrite weak descriptions by hand; rebuilding the catalog keeps
your edits.

## Safety

- Every query runs in `BEGIN READ ONLY` with a `statement_timeout` (15 s by default) and is
  always rolled back (`src/db.ts`).
- The executor can only target the databases chosen by the router: the `database` argument
  of its tools is a closed enum.
- At most 100 rows are returned to the model per query.

## The comparison UI

`pnpm dev` serves the UI on port 3000 (override with `PORT`).

- **`/`**: type a question and both agents answer in parallel. Each card shows the routing
  decision, the answer, every SQL query with its row count or error, the time spent in each
  stage, and input and output tokens.
- **`/?q=...`**: runs the comparison on load, handy for sharing a question.

## Benchmark

| File | Purpose |
| --- | --- |
| `benchmark.questions` in `config.yaml` | the questions, written like a user would ask them |
| `benchmark.answers` in `config.yaml` | gold answers: verified reference SQL, expected values, accepted alternatives |
| `bench/run.ts` | runs every question in both modes, records latency, tokens and SQL |
| `bench/grade.ts` | grades each answer and writes a report, a summary and charts |
| `bench/refresh-answers.ts` | re-runs the gold SQL to detect data changes |

### Bring your own benchmark

Write two JSON files and point `benchmark.questions` and `benchmark.answers` at them. Every
question id needs a matching answer.

`questions.json`: what a user would ask. Write them before looking at the schemas, so they
include questions your data cannot answer: that is how hallucinations get measured.

```json
[
  { "id": 1, "category": "count", "question": "How many customers signed up in 2024?" },
  { "id": 2, "category": "out_of_scope", "question": "What is the weather today?" }
]
```

`answers.json`: the correct answer for each question.

```json
[
  {
    "id": 1,
    "answerable": true,
    "database": "sales",
    "goldSql": "SELECT count(*) FROM customers WHERE extract(year FROM created_at) = 2024",
    "expectedValues": [1834],
    "expectedAnswer": "1,834 customers signed up in 2024",
    "acceptable": [],
    "notes": "Counts by signup date, not first purchase"
  },
  {
    "id": 2,
    "answerable": false,
    "expectedValues": [],
    "expectedAnswer": "Not available: there is no weather data",
    "acceptable": []
  }
]
```

| Field | Meaning |
| --- | --- |
| `answerable` | `false` when the data cannot answer the question; the agent should say so |
| `goldSql`, `database` | a query that produces the answer; `pnpm bench:refresh` re-runs it |
| `expectedValues` | numbers or names that must appear in a correct answer |
| `expectedAnswer` | the correct answer in one sentence, read by the judge |
| `acceptable` | other answers that also count as correct (ambiguous questions) |
| `category` | free text; the report and charts group accuracy by it |

Run `pnpm bench:refresh` after writing the answers: it checks that every `goldSql` still
returns its `expectedValues`.

### Grading

Each answer gets two independent signals:

1. **Numeric check**: the expected values must appear in the answer, tolerant to rounding
   and to both `1,234.5` and `1.234,5` formats.
2. **Jev as judge**: a boolean question comparing the answer with the expected and accepted
   answers. For unanswerable questions, it checks that the agent says the data is not
   available instead of inventing figures.

When the two signals disagree the answer is marked **review** instead of guessing.

### Running it

From the UI at `/bench`, pick 5, 20 or 100 questions and press **Run**. From the CLI:

```sh
pnpm bench -- --limit 20 --concurrency 3
pnpm bench -- --resume bench/results/<run>.jsonl   # retry failed runs only
pnpm bench:grade -- --results bench/results/<run>.jsonl
```

Results go to `bench/results/` (ignored by git): the raw runs, the graded runs, a Markdown
report, a JSON summary for the UI, and the charts as SVG. The UI can export the report to PDF
and each chart to PNG.

### Costs

Every run records what it cost, and `bench:grade` writes `<run>.costs.csv` with one row per
question and mode:

- **Executor**: the billed cost that OpenRouter returns in each response (`usage.cost`),
  summed over every step of the tool loop. OpenAI's API does not report cost, so it is empty
  with the `openai:` provider.
- **Jev**: tokens and the list price (`marketCost`) that AI Gateway reports for both routing
  calls. The judge calls made while grading are not included.

The report adds total cost, cost per question and **cost per correct answer**, which is the
fairest comparison when the two modes differ in accuracy.

### Known caveats

- Latency includes the AI SDK's internal retries, so gateway outages inflate the numbers,
  mostly the p95. The report also shows Jev's time inside the provider (from the gateway's
  own timestamps), which is what a self-hosted Jev would cost in latency.
- The standard agent sends about 75K tokens per question and can hit per-minute rate limits
  under concurrency. Failed runs are excluded from the metrics and can be retried with
  `--resume`.
