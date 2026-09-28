# Configuration

Everything specific to you lives in two files that git ignores:

- **`config.yaml`**: executor model, router thresholds, Postgres server, which databases to use, and your benchmark files. Start from the commented [`config.example.yaml`](../config.example.yaml).
- **`.env`**: secrets only. The YAML never holds a key: it names the variable that does (`apiKeyEnv: AI_MODEL_API_KEY`), so a config file can be shared safely.

```yaml
executor:
  provider: openrouter          # openai | openrouter
  model: openai/gpt-5.6-luna
  apiKeyEnv: AI_MODEL_API_KEY
router:
  databaseThreshold: 0.5
  tableThreshold: 0.6
postgres:
  host: localhost
  user: postgres
  passwordEnv: PGPASSWORD
  databases: [sales, hr, inventory]   # or `exclude: [...]` to use the rest of the server
benchmark:
  questions: my-data/questions.json
  answers: my-data/answers.json
```

| **Environment variable** | **Purpose**                                         |
| :----------------------- | :-------------------------------------------------- |
| `AI_MODEL_API_KEY`       | Executor provider key (name configurable)           |
| `AI_GATEWAY_API_KEY`     | Vercel AI Gateway key, used by Jev                  |
| `PGPASSWORD`             | Postgres password (name configurable)               |
| `CONFIG_FILE`            | Use another config file instead of `config.yaml`    |
| `HOST`, `PORT`           | Where the UI listens (`127.0.0.1`, `3000`)          |

To bring your own benchmark, write your questions and gold answers in the format described in [features.md](features.md#bring-your-own-benchmark) and point `benchmark` at them. The repo ships an example dataset about public statistics of Mexico in [`examples/mexico-public-data`](../examples/mexico-public-data).
