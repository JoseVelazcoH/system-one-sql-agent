# Features

A deeper guide to how the agent works, how to tune it, and how the benchmark measures it.

## How a question flows

<p align="center">
  <img src="../assets/flow.png" width="820" alt="How a question flows: database routing and table routing with Jev, column preload from Postgres, then execution by the LLM" />
</p>

The diagram source is [`docs/diagrams/flow.html`](diagrams/flow.html). To re-render it after
editing, take a 2x screenshot of the page (for example with headless Chrome and
`--force-device-scale-factor=2`) and save it as `assets/flow.png`.

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

Set `benchmark.watermark` in `config.yaml` to a png/svg path to stamp every chart (including the
LinkedIn summary charts) with a small logo in the bottom-right corner. Leave it unset for
unwatermarked charts. `pnpm bench:png -- <charts dir>` renders every SVG in a folder to PNG at 2x
using a local headless Chrome/Chromium, useful for sharing charts where SVG is not supported.

Use `--label` on `pnpm bench` to name the series shown in the report and charts, instead of the
default mode name. This is how separate runs (e.g. different agent variants) get compared side
by side after merging their result files with `bench:grade --results a.jsonl,b.jsonl,c.jsonl`:

```sh
pnpm bench -- --mode standard --label Sol
pnpm bench -- --mode jev --label "Sol + Jev"
pnpm bench -- --mode jev --config bench/luna.config.yaml --label "Luna + Jev"
```

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

## Best-of-N selection (experimental)

`jev-bon` mode routes the question with Jev exactly like `jev` mode, then generates `N`
candidate answers with the executor in parallel instead of one, and lets Jev pick the best.

1. **Route** (`src/router.ts`): same database and table routing as `jev` mode. If no database
   is selected, `jev-bon` returns the same "no data" answer as `jev` mode and skips
   candidate generation entirely.
2. **Generate** (`src/pipeline.ts`): `selector.candidates` calls to `answerQuestion` run with
   `Promise.allSettled`. Candidate 0 uses the executor's normal settings; the rest use
   `selector.temperature` and rotate through hints that nudge them toward different readings
   of the question (default period, literal interpretation, official totals vs. sums). Failed
   candidates are dropped; if every candidate fails, the first error is thrown.
3. **Select** (`src/selector.ts`): consensus first, for free. If a strict majority of
   candidates agree on the same top 3 numbers (rounded to 3 significant digits), or a
   majority agree there is no data, that candidate wins with no Jev call. Otherwise Jev
   answers one `choice` question over the candidates (shuffled, so label order carries no
   signal), each described by its answer text, final SQL and a 5-row preview of its last
   successful query.

Cost and tokens in the benchmark and comparison UI are the sum of every candidate's executor
usage plus the selector's Jev usage (reported separately under `jev.selector`), so `jev-bon`
is directly comparable to `jev` and `standard` on cost per correct answer.

### Config

```yaml
selector:
  candidates: 4       # number of candidate answers generated in parallel
  temperature: 0.7    # sampling temperature for candidates after the first
```

### Running the experiment

`bench/run.ts` accepts `--config` to point at an alternate `config.yaml`, so `jev-bon` can be
benchmarked with a different executor model without touching the default config:

```sh
pnpm bench -- --mode jev-bon --config config.luna.yaml \
  --ids 9,17,31,33,55,74,79,92,54,51,1,2,3,4,5,6,18,19,20,21
```

The extra ids are 6 questions the existing `jev` run already answers correctly (1, 2, 3, 4,
5, 6) and 4 unanswerable questions it already refuses correctly (18, 19, 20, 21), picked from
`bench/results/2026-09-23T23-22-35-970Z.graded.jsonl`. They give the comparison a floor: if
`jev-bon` regresses on questions `jev` already gets right, best-of-N is not paying for itself.

`bench:grade` accepts a comma-separated `--results` list to merge the new run with the
existing one before grading, and `--out` to name the merged output:

```sh
pnpm bench:grade -- \
  --results bench/results/<jev-bon-run>.jsonl,bench/results/2026-09-23T23-22-35-970Z.jsonl \
  --out jev-bon-vs-jev
```

If the merged files used different executor models for the same mode, the report and charts
split that mode into one series per model, labeled `${mode} (${model})`.
