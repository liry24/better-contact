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
          idempotency: false, // Anonymous example without a verified visitor identity.
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

Retry protection is **on by default**. Every protected model requires an `idempotencyKey` on creation. Generate a random key once per submission and retain it until the result is known:

```ts
const submission = {
  model: 'report' as const,
  idempotencyKey: crypto.randomUUID(),
  data: { targetId: 'public-resource', reason: 'incorrect information' },
}
const result = await client.contact.create(submission)
```

Set `idempotency: false` on a model to opt out. Its generated schema has no protection columns or indexes, and supplying a key is rejected. Each accepted call then creates a new record. The anonymous introductory example uses this option. Changing configuration does not modify an existing database: generate, review and apply an ordinary migration to remove obsolete columns or tables.

Keys accept 16–128 ASCII letters, digits, hyphens or underscores. A versioned SHA-256 token binds each key to the model and server-resolved user ID. Authenticated callers need no scope configuration. Anonymous callers of protected models must have a stable, application-verified identity:

```ts
idempotency: {
  anonymousScope: async ({ headers }) => {
    const visitor = await verifySignedVisitorCookie(headers) // Your application verifier.
    return visitor?.id ?? null
  },
}
```

Missing or invalid anonymous scope rejects creation before writing. The plugin never derives identity from an IP address, unverified cookie or submitted user ID. Keep the resolver's identity namespace stable across deployments. `idempotency.replay` is an optional additional policy receiving the current record; deny it when an application's rules require revoking receipt access.

Two private native columns, `submissionToken` (unique) and `submissionFingerprint`, are saved in the same INSERT as the contact fields. There is no receipt table, snapshot, transaction requirement or D1-specific wrapper. Protected rows retain these values for their lifetime; there is no TTL or automatic cleanup. Physical deletion, including a configured cascade, ends protection: the same key can then create a new row. Columns are nullable for pre-existing records, which gain no retrospective retry protection.

The first accepted write returns its normal creation result plus `accepted: true, replayed: false`. A retry returns only `{ model, id, accepted: true, replayed: true }`. Narrow on `replayed` before accessing creation data. Receipts grant no read/list access and expose neither original content nor later staff edits. Replays recheck `access.create`, the guard and any replay policy. The create policy receives normalized submitted values on replay; omitted defaults are not regenerated or reconstructed from mutable rows. Keep creation policies compatible with that distinction, or deny replay explicitly.

The content fingerprint uses deterministic normalization of explicitly supplied values, with sorted object keys and distinct representations for dates and arrays. Native defaults, omitted-value validator defaults and adapter encodings are excluded. Submitted input validators run again; they must be deterministic. Same key with different normalized content returns `CONTACT_IDEMPOTENCY_CONFLICT`. Fingerprints have an explicit format version; unknown versions or changed normalization fail closed instead of permitting a second insert. New keys may intentionally submit identical content.

An INSERT error proves nothing by itself. Only a successful lookup of the same actor-bound token and matching content confirms an already accepted submission; otherwise the original database error remains. This covers unique-key races and lost acknowledgements without depending on a database error string. After hooks run only for the request that knows it inserted the row, and never on replay. A lost acknowledgement or crash can therefore skip delivery. Receipts make no claim about hook outcomes; use an application-owned durable delivery mechanism if delivery must survive crashes.

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

Accepted mutations return `{ model, id, revision, record, changed, hooks, output }`; the first creation also returns `accepted: true, replayed: false`. After-hook failures return `hooks: { status: 'failed', failed: [...] }`; other after hooks still run. `onHookError` can capture details. A failed output validator returns `output: 'failed'` and `record: null`, retaining the saved identity/revision. Neither failure should trigger resubmission. Hooks are best-effort within the request, not a durable delivery queue. Models with protection disabled can still have ambiguous database outcomes.

`auth.api.maintainContact` is an explicit **server-only** maintenance API for update, transition and delete. It bypasses access policies and permits `input: false` fields, while preserving field/state validation, revision checks and hooks. It has no HTTP path or client action. Do not wrap it in an unprotected route. Ordinary `auth.api` operations never bypass policies.

## Public submissions

The shared service limits input and validated fields to 16 KiB, page size to 100, and creation attempts to 60 per minute per model per plugin instance. Configure `limits.maxBytes`, `maxPage`, `maxBulk`, `createsPerMinute` as needed. The process-local creation limit bounds load across HTTP and direct calls; use `guard` for a shared atomic, application-specific abuse limiter across instances. Configure ingress/body limits and Better Auth's HTTP rate limiting as well. Avoid performing expensive external work in field validators.

Reply threads, internal messages, attachments, ticketing and SLA behavior are intentionally outside this package. Stable model/record IDs and persistence hooks allow future extensions. Tests cover real SQLite and local Cloudflare D1 through native Better Auth and Drizzle adapters. Production D1 service behavior and other adapters need their own integration checks.

## Development

```sh
vp install --frozen-lockfile
vp run check
```

The package starts at `0.0.0`. SHA-pinned uppt prepares a future `0.1.0` release from `feat!` history. Release creation and npm publication are separate manual decisions; nothing publishes on push. MIT licensed.
