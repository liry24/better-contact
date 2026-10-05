# Repository guide

- Read toolchain, package-manager pins and scripts from [package.json](package.json), and compatibility ranges from the [package manifest](packages/better-contact/package.json). Keep `bun.lock` synchronized.
- Run `vp run check` before pushing. Preserve [CI](.github/workflows/ci.yml)'s SHA pins, minimal permissions and `ci-ok` requirement that every blocking job succeeds.
- Markdown stays outside `vp fmt`. Maintain code snippets manually with two-space indentation.
- Use native Better Auth fields, plugin schema, adapters and the `auth` CLI; do not convert validators into schemas. Validate Standard Schema inputs in the shared service before writes, applying defaults and transforms only once.
- Deny access by default per model and operation. HTTP and ordinary `auth.api` calls share policies and server-resolved sessions; trusted maintenance stays explicitly server-only.
- Apply declarative scopes in the database before pagination or counting. Never authorize by filtering a fetched page.
- Use atomic revision-conditional writes. State meanings belong to the application; reject unknown states and skip hooks for no-op transitions.
- Run side-effect hooks after persistence. Report hook failures separately from accepted writes to avoid duplicate resubmission.
- Keep client runtime imports separate from server code; use type-only server inference. Respect managed-field input restrictions and output visibility.
- Preserve real database, generated-schema and inference tests. Claim adapter compatibility only when backed by integration tests.
- Test the same packed artifact across package managers with isolated temporary caches and installed-content verification. Never rebuild or modify a supplied release tarball.
- Follow the current [release workflow](.github/workflows/release.yml). Publishing, tags, releases and deployment require explicit authorization.
