# Contributing

First of all, thank you so much for taking the time to contribute to system-one-sql-agent!

## Guidelines

The following is a set of guidelines for contributing to this repository. They are
guidelines, not strict rules, so use your best judgment, and feel free to propose changes
to this document in a pull request.

## Development setup

This is a TypeScript project that runs directly with [tsx](https://tsx.is). You will need
Node.js 22+, [pnpm](https://pnpm.io), and a PostgreSQL server with some databases to query.

```sh
git clone https://github.com/JoseVelazcoH/system-one-sql-agent.git
cd system-one-sql-agent
pnpm install
cp config.example.yaml config.yaml   # your model, databases and benchmark files
cp .env.example .env                 # your API keys and database password
pnpm catalog                         # build catalog.json from your databases
pnpm dev               # UI on http://localhost:3000, restarts on code changes
```

The codebase is organized as follows:

- `src/` - the agent: routing (`router.ts`), execution (`executor.ts`), the pipeline that
  ties them together (`pipeline.ts`), database access (`db.ts`), and the HTTP server.
- `public/` - the comparison and benchmark UI (plain HTML, CSS and JavaScript).
- `bench/` - benchmark questions, gold answers, runner, grader and charts.
- `scripts/` - maintenance scripts such as the catalog builder.

## Issues

Before opening an issue, please search the existing issues (open and closed) to make sure
the feature or bug you want to propose does not already exist.

### Bugs

A bug report must include the following:

1. The commit you are running and the executor model (`executor` in `config.yaml`).
2. The question you asked and the exact steps to reproduce the bug.
3. A proposed fix or a hypothesis about the cause.

### Features

Feature issues are split into two kinds: **UI** and **Code**.

#### UI

UI issues are specific improvements to the user experience. The proposal must include at
least:

1. The section you want to improve or add.
2. An image or mockup of the result you want to reach.

#### Code

Code issues are improvements to the codebase itself, whether for better component handling
or structure. The proposal must include at least:

1. The section you want to improve or add.
2. A proposed solution.

## Pull Requests

To contribute, take one of the open issues in the repository. Anything tagged `type:bug`,
`good-first-issue`, or `help-wanted` would be fantastic. To claim an issue, leave a comment
asking for it and a maintainer will assign it to you.

Open your pull request against `main` and link the issue it resolves.

### Quality bar

Before you submit, make sure the checks below pass locally, since the same ones are enforced
on review:

```sh
pnpm typecheck
```

Changes that affect routing or execution must include benchmark numbers. Run at least a
20-question benchmark before and after your change and add both summaries to the pull
request. If you touch the gold answers, run `pnpm bench:refresh`.

Database access must stay read-only: go through `readOnlyQuery` in `src/db.ts` and never
build SQL by concatenating user input outside the executor's own queries.

### Review cycle

To speed up the review cycle, you can allow maintainers to push directly to your branch.
This is only done for small fixes.

### Commits

Commits must follow the [commit convention](docs/commit-convention.md). If a pull request
does not follow it, it will be rejected and you will be asked to correct the commit history.

## AI

We are not at odds with the use of AI. On the contrary, we push for more people to use it
to speed up the production process. That said, using AI correctly matters to us: every
change, and every issue and pull request description, must be tested and understood by a
human.
