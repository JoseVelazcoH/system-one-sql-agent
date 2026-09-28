# Security Policy

## Supported versions

Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email
velazco.joseh@gmail.com with:

1. A description of the issue and its impact.
2. Steps to reproduce it, including the question you asked if relevant.
3. The commit you tested (`git rev-parse --short HEAD`).

You will get an answer within 7 days. Once a fix is available, the issue can be disclosed
publicly with credit to the reporter, if desired.

## Scope

The agent is meant to run locally, on `127.0.0.1`. Keep that in mind when reporting:

- **In scope:** any way to write to or modify a database (queries run through
  `readOnlyQuery` in `src/db.ts`, inside a `READ ONLY` transaction), a question that makes
  the agent leak API keys or the database password, reading data outside the configured
  databases, and starting paid LLM runs from outside localhost with the default settings.
- **Out of scope:** attacks that require exposing the UI with `HOST=0.0.0.0` without
  authentication, which is not a supported setup, and vulnerabilities in third-party
  services (LLM providers, Vercel AI Gateway, PostgreSQL). Report those to their owners.

## Handling secrets

- API keys and the database password live only in `.env`, which is gitignored.
  `config.yaml` stores the names of those variables, never their values.
- Use a PostgreSQL role with read-only permissions. The `READ ONLY` transaction is a second
  line of defense, not a replacement for database permissions.
- If you commit a secret by mistake, rotate it with the provider right away. Removing it
  from history is not enough.
