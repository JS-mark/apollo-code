# Common errors

## Exit code 1

A runtime or provider failure: the request was understood but something failed
while executing it (provider errors, store IO, daemon faults). Run `volund doctor`
and inspect sanitized diagnostics.

## Exit code 2

Usage error: invalid flags, missing arguments, bad config values, or a missing
confirmation. Run `volund help` and correct the request.

## Exit code 3

Strict mode detected a degraded sandbox. Install the matching native package or fix the host mechanism; do not bypass it for acceptance.

## Exit code 130

The current turn was interrupted with Ctrl+C. The session remains available to resume.

## Ollama endpoint refused

Ollama defaults to `http://127.0.0.1:11434`. Loopback HTTP endpoints work without
confirmation. Any non-loopback endpoint requires an interactive, endpoint-specific
danger confirmation; non-interactive runs refuse it. Remote plaintext HTTP is
especially dangerous because prompts and tool data cross the network unencrypted.
Project-level config cannot override provider `baseUrl` or `endpoint` values.

Redirects are not followed. If a proxy is required, configure its final HTTPS URL
at user scope and approve that exact endpoint. `volund doctor` integrations should
use the Ollama version probe (`GET /api/version`) and report tool support only for
Ollama 0.3 or newer.

## Reading error notices

In-session error notices use a uniform `code: English detail` format. For the full
catalog of codes with their meanings and remediation, see
[Error code reference](/docs/reference/error-codes).
