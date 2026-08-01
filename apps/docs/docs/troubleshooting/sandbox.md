# Sandbox issues

Run `apollo doctor --strict` and read the reported tier, mechanism, and limitation. A missing native platform package or unsupported kernel can lower the tier; strict mode exits with code 3 instead of silently accepting that degradation.

Do not use `--dangerously-no-sandbox` to make a release test pass. Capture the target, probe output without secrets, and escape-suite ratio, then link the remediation issue from the release notes.
