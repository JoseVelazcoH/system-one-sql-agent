# Commit Convention

This project follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

## Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Rules

- The description must be in lowercase and must not end with a period.
- The body wraps at 72 characters.
- Breaking changes are declared with `!` after the type/scope, or with a `BREAKING CHANGE:` footer.

---

## Types

| Type       | When to use                                              |
|------------|----------------------------------------------------------|
| `feat`     | A new feature visible to the user                        |
| `fix`      | A bug fix                                                |
| `docs`     | Documentation only changes                               |
| `style`    | Formatting, whitespace - no logic change                 |
| `refactor` | Code change that is neither a fix nor a feature          |
| `perf`     | Performance improvement                                  |
| `test`     | Adding or updating tests or benchmark data               |
| `build`    | Build system or external dependency changes              |
| `ci`       | CI/CD pipeline changes                                   |
| `chore`    | Maintenance tasks that don't touch production code       |
| `revert`   | Reverts a previous commit                                |

---

## Scopes

Scopes are optional and should match the module or layer being changed.

| Scope      | Area                                                  |
|------------|-------------------------------------------------------|
| `router`   | System One routing (`src/router.ts`)                  |
| `executor` | LLM execution and tools (`src/executor.ts`)           |
| `pipeline` | Orchestration of routing and execution (`src/pipeline.ts`) |
| `db`       | Database access (`src/db.ts`)                         |
| `catalog`  | Catalog model and builder (`src/catalog.ts`, `scripts/`) |
| `server`   | HTTP server and API (`src/server.ts`, `src/bench-api.ts`) |
| `ui`       | Web UI (`public/`)                                    |
| `bench`    | Benchmark runner, grader, charts and datasets (`bench/`) |
| `config`   | Configuration and environment (`src/config.ts`, `.env.example`) |
| `deps`     | Dependency / packaging changes                        |

---

## Examples

```
feat(router): add table-level routing with column preload

fix(db): keep duplicated column names when reading gold sql

test(bench): add gold answers for the 100 benchmark questions

docs: add benchmark results to the readme

feat(executor)!: require provider prefix in AI_MODEL

BREAKING CHANGE: AI_MODEL must now look like "openai:gpt-4.1-mini".
```
