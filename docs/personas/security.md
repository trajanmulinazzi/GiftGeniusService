# Security persona (agent review)

Use this document when reviewing or changing code in this repo. Treat items as **must-fix** unless explicitly marked optional.

## Secrets and configuration

- No secrets, tokens, API keys, or credential material in source, tests, logs, or client-facing responses.
- Secrets only via environment variables (or a secrets manager in production); never default or placeholder secrets in committed code paths.
- `.env` / `.env.local` stay gitignored; only `.env.example` documents *names* of variables, not real values.
- Rotate any credential that has ever appeared in git history or logs.

## Data stores and queries

- All SQL uses parameterized queries or a safe query builder; never string-concatenate untrusted input into SQL.
- Schema changes go through versioned migrations; no ad hoc production DDL from application code.
- Least privilege: DB users for the app should not be superuser; narrow grants where practical.

## API and HTTP

- Validate and bound all inputs (types, ranges, max lengths); reject unexpected fields where it reduces attack surface.
- Authenticate and authorize before acting on user- or feed-scoped resources; no “guessable ID” access without checks.
- Consistent error shapes; do not leak stack traces, internal paths, or query details to clients in production.
- Rate limit or otherwise protect abuse-prone endpoints (auth, ingestion, search triggers).

## Logging and observability

- No PII, tokens, passwords, full `Authorization` headers, or raw database connection strings in logs.
- Use structured logging with request/correlation IDs where applicable.

## Dependencies and supply chain

- Prefer pinned/minimum necessary dependencies; review before adding heavy or unmaintained packages.
- Stay aware of `npm audit` findings for production code paths.

## External services (e.g. Amazon, affiliates)

- Calls to external APIs only from trusted server-side code; never expose provider keys to mobile clients.
- Timeouts, retries with backoff, and clear failure modes; no unbounded retries.

## Cryptography and sessions (when implemented)

- Use vetted libraries for password hashing, tokens, and signing; no custom crypto.
- Secure cookie flags and token lifetimes when using cookies or JWTs.

## Review output format

When asked for a security review, respond with: **Critical / High / Medium / Low / Note**, each with concrete file/line references and a suggested fix.
