# better-contact

Feedback, abuse reports, ratings and inquiries as a Better Auth plugin. Your application defines the fields, states and permissions; each model gets native database columns.

```sh
npm install better-contact
```

```ts
import { betterAuth } from 'better-auth'
import { contact } from 'better-contact'
import { z } from 'zod'

export const auth = betterAuth({
  plugins: [
    contact({
      models: {
        feedback: {
          fields: {
            message: { type: 'string', validator: { input: z.string().trim().min(1).max(2000) } },
            priority: { type: 'number', input: false, defaultValue: 0 },
          },
          states: { received: { default: true }, reviewed: {} },
          access: { create: () => true },
          hooks: {
            afterCreate: async ({ record }) => {
              // Notify staff here, optionally through better-notif.
              // Persisted success is preserved if this hook fails.
            },
          },
        },
      },
    }),
  ],
})
```

Generate the schema through Better Auth, then apply the migration using your database tooling:

```sh
npx auth@latest generate
```

The example creates `contact_feedback` with `message`, `priority`, `id`, `userId`, `state`, `revision`, `createdAt` and `updatedAt`. Model keys must be lowercase ASCII identifiers. Field names and optional native `fieldName` mappings must be safe, distinct identifiers. Reserved names and unsupported storage mappings fail at configuration time. There is no mandatory JSON column; `type: 'json'` is an explicit choice.

```ts
import { createAuthClient } from 'better-auth/client'
import { contactClient } from 'better-contact/client'
import type { auth } from './auth'

const client = createAuthClient({ plugins: [contactClient<typeof auth>()] })
const { data, error } = await client.contact.create({
  model: 'feedback',
  data: { message: 'Please add keyboard shortcuts' },
})
```

The server API is `auth.api.createContact({ body: { model, data }, headers })`. It runs the same validation and authorization as HTTP. Missing headers mean an anonymous caller, never privileged access. Native fields infer inputs and outputs; Standard Schema inputs support asynchronous validation and transformations (including Zod and Valibot). Defaults and adapter transforms run once per write. `input: false` fields are managed by server code, and `returned: false` fields stay out of responses. Output validators run after adapter output transforms; input validators never rerun on reads.

## Access

Every operation denies by default, including reading your own submission. Configure `access.create`, `read`, `update`, `transition`, `delete`, and `list` separately. Policies receive `{ model, operation, session, record, changes, targetState, headers }`. Sessions are resolved by Better Auth from the caller's headers. Policies and hooks receive copies; mutating them does not modify the write.

For a report, require `session` in `create` and verify the submitted target against your application's data and access rules. There is no admin plugin dependency. An application may grant staff `read` and `list` while denying `transition`. `update` accepts only configured input fields and cannot set state, identity, timestamps or revision. Bulk operations cannot bypass these rules.

`list` returns `false` or `{ where: [...] }`. Returning `{ where: [] }` deliberately grants access to every row in that model. A scoped example:

```ts
list: ({ session }) => (session ? { where: [{ field: 'userId', value: session.user.id }] } : false)
```

List permission grants access to every matching row; it does not call `read` for each result. Keep these policies consistent. Scopes accept up to 20 AND conditions on untransformed scalar columns, with `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`. Unsupported scopes are rejected. Filtering happens in the database before pagination.

Enable public query capabilities per model:

```ts
list: {
  filters: ['state', 'userId'],
  orderBy: ['createdAt', 'priority'],
  search: ['message'],
  count: true,
}
```

```ts
await client.contact.list({
  model: 'feedback',
  filters: [{ field: 'state', value: 'received' }],
  orderBy: { field: 'createdAt', direction: 'desc' },
  search: { field: 'message', term: 'keyboard' },
  count: true,
  limit: 20,
})
```

Client filters and one text search are always ANDed with the current policy scope. `count` covers that same filtered scope, independent of the page cursor. Hidden, transformed and non-scalar fields cannot be queried; ordering additionally requires a non-null string, number or date column. Search uses the adapter's `contains` operator on one enabled string column, with its native case/collation behavior. `%`, `_` and backslash patterns are rejected. Unsupported adapter operations fail; there is no in-memory search or authorization fallback.

Pages default to ID ascending. Other orders use ID in the same direction to break ties. Pass the opaque `nextCursor` unchanged with the same filters, sort and current permission scope. The adapter supports one sort column, so secondary ordering queries disjoint equal-value groups, always retaining every scope predicate. This may make multiple database queries per page. Pages and optional counts are live reads, not a snapshot: concurrent edits/inserts can move records across the cursor. Related-resource hydration remains application-owned.

## Safe creation retries

Enable receipts on a model with `idempotency: { replay: ({ session, record }) => !!session && record?.userId === session.user.id }`. That model then requires `idempotencyKey` on every create call. Generate a random key once per submission and reuse it after a lost response:

```ts
const submission = {
  model: 'report' as const,
  idempotencyKey: crypto.randomUUID(),
  data: { targetId: 'public-resource', reason: 'incorrect information' },
}
await client.contact.create(submission)
```

Keys accept 16–128 ASCII letters, digits, hyphens or underscores. They are scoped to the model and server-resolved user ID. Anonymous keyed creation requires `idempotency.anonymousScope({ model, headers })` to return an application-verified, stable identity (for example, a verified signed visitor cookie); returning null denies creation. Never derive it from an unverified client-supplied identity. No body parameter can select the actor scope.

The native contact row and an internal `contact__receipt` row commit in one **real adapter transaction**. The receipt's unique hashed token resolves races; its encoded snapshot preserves the original accepted response without replacing native model columns. Adapters must explicitly advertise an enabled transaction implementation. A silently sequential `transaction()` fallback is rejected before writing. **The current native D1 adapter is unsupported for keyed creation.** There is no custom persistence callback or public prepare/commit API. Wrapping `createContact` with a separate idempotency write cannot make them atomic.

Replays validate the submitted fields, recheck `access.create`, run the guard, and require the explicit `idempotency.replay` policy against the current record. They return the original creation snapshot with `replayed: true` and `changed: false`, never later management changes. Currently hidden/removed fields are stripped. The replay policy must authorize returning historical submitted values (`changes` contains the original normalized data); deny old receipts if application privacy/presentation rules change. Serializers are not reapplied to already-presented snapshots. This grants no ordinary read/list permission. Deletion or revoked replay permission makes the receipt unavailable without creating a replacement. Same key with different normalized submitted content returns `CONTACT_IDEMPOTENCY_CONFLICT`; new keys can intentionally submit identical content. Input validators must normalize deterministically. Native generated defaults are preserved for replay and excluded from the content fingerprint; adapter transforms are not reapplied to the snapshot.

Receipts expire after seven days (`retentionSeconds`, 60 seconds through thirty days). After expiry the key may create a new record. Expired rows are replaced lazily on key reuse; schedule application database maintenance to purge expired `contact__receipt` rows if needed. Receipt snapshots contain submission data and need the same storage access controls and retention review as contact rows.

After hooks execute only for the request that knows it committed. Replays never repeat them. A crash or ambiguous commit acknowledgement can leave `hooks.status: 'unknown'`; it still identifies an accepted submission, not permission to retry notification delivery. Receipt outcome-update failures also leave this status. Use a separate durable application delivery mechanism when notification delivery must survive crashes.

## Native storage mapping

Each model can configure `schema.modelName` and `schema.fields` for base-column aliases; application fields already accept native `fieldName`:

```ts
schema: {
  modelName: 'moderation_reports',
  fields: {
    userId: {
      fieldName: 'author_id',
      references: { model: 'user', field: 'id', onDelete: 'set null' },
    },
    createdAt: { fieldName: 'submitted_at' },
  },
}
```

`userId` remains server-controlled and nullable. By default it has no foreign key. Opt into a native `user.id` reference with `set null`, `cascade`, `restrict` or `no action`; omitted `onDelete` follows Better Auth's cascade default. Other base-column types, defaults and input rules cannot be overridden. Aliases must be safe and distinct. Generate and apply migrations before use, checking for collisions with other plugins and existing tables. Existing tables need the declared application columns and `id`, state, revision and timestamp columns (or their aliases). String record IDs are verified; numeric-ID migration compatibility is not claimed.

## Operations and state hooks

| Client               | Server API          | Input                                                  |
| -------------------- | ------------------- | ------------------------------------------------------ |
| `contact.create`     | `createContact`     | `{ model, data, idempotencyKey? }`                     |
| `contact.read`       | `readContact`       | `{ model, id }`                                        |
| `contact.list`       | `listContacts`      | `{ model, limit?, cursor?, filters?, orderBy?, search?, count? }` |
| `contact.update`     | `updateContact`     | `{ model, id, revision, data }`                        |
| `contact.transition` | `transitionContact` | `{ model, id, revision, state }`                       |
| `contact.delete`     | `deleteContact`     | `{ model, id, revision }`                              |
| `contact.bulk`       | `bulkContacts`      | `{ items: [{ operation, model, id, revision, ... }] }` |

Exactly one configured state has `default: true`. State keys are inferred as literals and have no built-in open/closed/terminal meaning. Unknown states are rejected. A same-state transition checks permission and revision but does not write or call hooks.

Model hooks are `beforeCreate`/`afterCreate`, `beforeUpdate`/`afterUpdate`, `beforeTransition`/`afterTransition`, and `beforeDelete`/`afterDelete`. Each state's `hooks` may define `beforeEnter`/`afterEnter` and `beforeLeave`/`afterLeave`.

Creation runs model `beforeCreate`, initial-state `beforeEnter`, persistence, model `afterCreate`, then initial-state `afterEnter`. A transition runs model `beforeTransition`, old-state `beforeLeave`, new-state `beforeEnter`, persistence, old-state `afterLeave`, new-state `afterEnter`, then model `afterTransition`. Hooks receive policy context plus `previous`; after hooks see the saved `record` (null after deletion). Before hooks can reject by throwing. They can run for a write that subsequently loses a race, so keep external side effects in after hooks.

Mutations require the last read revision and use the adapter's atomic guarded operations. A concurrent write returns `CONTACT_CONFLICT`; reload before retrying. Bulk actions are sequential, bounded (50 by default, maximum 100), and return an ordered result for every item. They are not a transaction and may partially succeed. Duplicate items are not silently deduplicated.

Accepted mutations return `{ model, id, revision, record, changed, hooks, output }`; creation also returns `replayed`. After-hook failures return `hooks: { status: 'failed', failed: [...] }`; other after hooks still run. `onHookError` can capture details. A failed output validator returns `output: 'failed'` and `record: null`, retaining the saved identity/revision. Neither failure should trigger resubmission. Hooks are best-effort within the request, not a durable delivery queue. Models without idempotency receipts can still have ambiguous database outcomes.

`auth.api.maintainContact` is an explicit **server-only** maintenance API for update, transition and delete. It bypasses access policies and permits `input: false` fields, while preserving field/state validation, revision checks and hooks. It has no HTTP path or client action. Do not wrap it in an unprotected route. Ordinary `auth.api` operations never bypass policies.

## Public submissions

The shared service limits input and validated fields to 16 KiB, page size to 100, and creation attempts to 60 per minute per model per plugin instance. Configure `limits.maxBytes`, `maxPage`, `maxBulk`, `createsPerMinute` as needed. The process-local creation limit bounds load across HTTP and direct calls; use `guard` for a shared atomic, application-specific abuse limiter across instances. Configure ingress/body limits and Better Auth's HTTP rate limiting as well. Avoid performing expensive external work in field validators.

Reply threads, internal messages, attachments, ticketing and SLA behavior are intentionally outside this package. Stable model/record IDs and persistence hooks allow future extensions. The verified database target is SQLite; other adapters need their own integration and atomic-operation tests.

## Development

```sh
vp install --frozen-lockfile
vp run check
```

The package starts at `0.0.0`. SHA-pinned uppt prepares a future `0.1.0` release from `feat!` history. Release creation and npm publication are separate manual decisions; nothing publishes on push. MIT licensed.
