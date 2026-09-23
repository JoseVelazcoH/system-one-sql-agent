# Features

A deeper guide to how the agent works, how to tune it, and how the benchmark measures it.

## How a question flows

```
question
   │
   ▼
┌──────────────────────┐   one boolean question per database
│ 1. Database routing  │── Jev: "does this database contain the data?"
└──────────────────────┘   keeps every database >= ROUTER_THRESHOLD
   │  (none selected → "no database can answer", the LLM is never called)
   ▼
┌──────────────────────┐   one boolean question per table of the chosen databases
│ 2. Table routing     │── Jev: "is this table needed to write the query?"
└──────────────────────┘   keeps the top MAX_PRELOADED_TABLES >= TABLE_THRESHOLD
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
| `ROUTER_THRESHOLD` | fewer databases, fewer tokens, more "no data" misses | more databases, more tokens |
| `TABLE_THRESHOLD` | fewer preloaded tables | more columns in the prompt |
| `MAX_PRELOADED_TABLES` | more context for the executor | smaller prompt |

Without a cap, table routing once preloaded 27 tables and pushed a prompt to 137K tokens, more
than the standard agent. Keep the cap.

## The catalog

`catalog.json` is built by `pnpm catalog` (`scripts/build-catalog.ts`) from the live
Postgres instance: database comments, and every table in every schema with its comment.
Migration and shared lookup tables are left out of the descriptions.

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
| `bench/questions.json` | 100 questions written like a user would ask them |
| `bench/answers.json` | gold answers: verified reference SQL, expected values, accepted alternatives |
| `bench/run.ts` | runs every question in both modes, records latency, tokens and SQL |
| `bench/grade.ts` | grades each answer and writes a report, a summary and charts |
| `bench/refresh-answers.ts` | re-runs the gold SQL to detect data changes |

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

### Known caveats

- Latency includes the AI SDK's internal retries, so gateway outages inflate the numbers,
  mostly the p95.
- The standard agent sends about 75K tokens per question and can hit per-minute rate limits
  under concurrency. Failed runs are excluded from the metrics and can be retried with
  `--resume`.
