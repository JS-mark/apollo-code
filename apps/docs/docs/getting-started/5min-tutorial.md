# A five-minute task

Start with a small, reviewable repository task:

```sh
apollo chat "Read the failing test, make the smallest fix, run that test, and show me the diff."
```

Apollo reads context, proposes permission-gated actions, streams provider output, and records the session locally. Inspect each permission prompt and the final diff. Run the project test yourself before committing.

For release dog-food evidence, the task must use the real Anthropic provider and cover reading, editing, tests, and a pull request. Record decisions and URLs in `docs/releases/L1-DOGFOOD.md` without recording credentials or sensitive prompt contents.
