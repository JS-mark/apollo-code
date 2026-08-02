---
"@apollo-code/native-bridge": patch
---

Make the Windows Authenticode smoke test deterministic by creating, trusting,
using, and removing its ephemeral code-signing certificate through native
Windows certificate APIs.
