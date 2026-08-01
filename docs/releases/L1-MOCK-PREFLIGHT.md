# L1 mock pre-flight

Status: **PRE-FLIGHT ONLY — NOT REAL ANTHROPIC DOG-FOOD.**

This fixture checks the acceptance shape without claiming production acceptance. It uses no
credential and cannot change `L1-DOGFOOD.md` from `BLOCKED`.

## Sanitized orchestration record

| Step | Operation | Permission decision | Evidence |
| --- | --- | --- | --- |
| 1 | Read the scoped source and failing test | allow-once: read within fixture workspace | source and test identified |
| 2 | Edit the scoped implementation | allow-once: write one fixture file | redacted diff recorded |
| 3 | Run the focused test | allow-once: sandboxed command | exit code 0 |
| 4 | Attempt an out-of-scope write | deny: outside fixture workspace | denial recorded |
| 5 | Run the regression test | allow-once: sandboxed command | exit code 0 |

The evidence contains normalized scopes and decisions only. It excludes prompts, file contents,
environment values, authorization headers, credentials, and command output that could contain
sensitive data. A real authorized operator must still complete the independent procedure in
`L1-FINAL-VERIFICATION.md` using the verified masked login flow, normal permissions, and sandbox.
