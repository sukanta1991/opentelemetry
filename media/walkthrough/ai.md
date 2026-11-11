# Ask Copilot about your telemetry (optional)

With `otel.ai.enabled` turned on, Copilot can read the collected telemetry and investigate for you. Mention `@otel` in chat, or let agent mode use the `otel_*` tools.

Try:

- `@otel /errors` — what is failing and why
- `@otel /slow` — the slowest requests and where the time goes
- `@otel why did checkout get slower after my last change?`

Privacy:

- Off by default. Only a user setting can turn it on; workspace settings can't.
- VS Code asks you to confirm each tool call before any data is read.
- Secrets in attributes (authorization, cookies, tokens, passwords, API keys, connection strings) are masked before anything reaches the model. Add your own keys with `otel.ai.redactAttributeKeys`.
- Data goes only to the language model you selected in chat.
