# A five-minute task

Start with a small, reviewable repository task:

```sh
volund "Read the failing test, make the smallest fix, run that test, and show me the diff."
```

Passing a prompt runs a one-shot chat turn. Running `volund` without a
prompt in a TTY starts the Ink TUI for an interactive session with input history,
slash commands, streaming output, and permission prompts. Volund reads context,
proposes permission-gated actions, streams provider output, and records the
session locally. Inspect each permission prompt and the final diff. Run the
project test yourself before committing.

## Sending messages while a turn is running

You do not have to wait for a turn to finish. In the TUI, web console, and mobile,
typing another message while Volund is working **queues** it: the queue is visible
above the input (TUI shows numbered lines with `alt+<n>` to remove an entry), and
after the current turn finishes the queue is sent in order, one message per turn.
The web console and mobile also let you **drag** queued entries to reorder them or
remove them from the queue. Queues live in the client — a page refresh clears them.

For release dog-food evidence, the task must use the real Anthropic provider and cover reading, editing, tests, and a pull request. Record decisions and URLs in `docs/releases/L1-DOGFOOD.md` without recording credentials or sensitive prompt contents.
