# Repository guide

- Use Vite+ exactly 1.0.0 with pinned Bun and bun.lock; run `vp run check`.
- Use native Better Auth fields/schema/adapter and the `auth` CLI. Do not convert validators into schemas.
- Authorization is per model/operation and denies by default. HTTP and auth.api share the same service.
- List authorization is a declarative AND scope executed by the database. Never filter a page after pagination.
- Revision-conditional writes detect races. State has no built-in meaning; no-op transitions never replay hooks.
- After-hook failures are separate from persisted success. Never throw a notification failure as a failed submission.
- Real SQLite and packed-tarball consumer tests are required. Only SQLite/Better Auth 1.7.x are currently verified.
- Keep client runtime imports separate from server code; server inference uses type-only imports.
- Release preparation uses SHA-pinned uppt and feat! commits for the future 0.1.0. Publishing needs explicit approval.
- Preserve CI's SHA pins, minimal permissions and a ci-ok job requiring every blocking job to succeed.
