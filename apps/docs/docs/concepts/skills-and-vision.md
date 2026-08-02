# Skills and image attachments

Apollo discovers skills from `~/.apollo/skills/<name>/SKILL.md`. Startup reads only YAML metadata and contributes a compact index to the system prompt. Activating a skill loads its body and only the resources explicitly listed in its frontmatter. Resources must remain inside the skill directory. Skills are prompt content: they never execute code and do not grant permissions.

An incompatible `apolloVersion` produces a warning but does not hide the skill. Activation is idempotent, and deactivation removes the prompt contribution immediately.

Image attachments are stored as content-addressed files under the session's `attachments` directory. Session JSONL contains only an opaque handle, MIME type, and message metadata; binary bytes never enter the event log. PNG, JPEG, GIF, and WebP are accepted after signature and size checks. Provider adapters enforce their own capability, MIME, and size limits again before sending a request.

If the selected provider does not support vision, Apollo replaces the image part in that request with a visible text placeholder. The durable session message keeps the original handle, so resuming the session or choosing a vision-capable provider does not lose the attachment.

Real provider vision calls require user credentials and are an explicit manual verification gate. Fixture tests cover Anthropic and OpenAI request mapping without claiming online-provider evidence.
