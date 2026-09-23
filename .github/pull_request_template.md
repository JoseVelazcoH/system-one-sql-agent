## Summary

<!-- What does this PR do? One paragraph max. -->

## Motivation

<!-- Why is this change needed? Link to an issue if applicable. Closes #<issue> -->

## Changes

<!-- Bullet list of what changed. Focus on the "what", not the "how". -->

-
-

## Test plan

<!-- How was this tested? Check all that apply. -->

- [ ] `pnpm typecheck` passes
- [ ] Manual check in the comparison UI (`/`)
- [ ] Benchmark run before and after (paste both summaries below)
- [ ] `pnpm bench:refresh` passes (if gold answers changed)

## Benchmark

<!-- Required for changes to routing or execution. Accuracy, hallucination rate, p50 and tokens, before and after. -->

## Review checklist

- [ ] Follows [commit convention](../docs/commit-convention.md)
- [ ] Database access stays read-only (goes through `readOnlyQuery`)
- [ ] No secrets, `.env`, `catalog.json` or `bench/results/` committed
- [ ] Docs updated if behavior or configuration changed

## Breaking changes

<!-- List any breaking changes, or write "None". -->

None
