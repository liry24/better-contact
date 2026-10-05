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
    // database: your database or adapter
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

List permission grants access to every matching row; it does not call `read` for each result. Keep these policies consistent. Scopes accept up to 20 AND conditions on untransformed scalar columns, with `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`. Unsupported scopes are rejected. Filtering happens in the database before pagination; no totals or unscoped counts are returned. Pages sort by unique ID, using the last ID as `nextCursor`. This is a live traversal, not a snapshot: concurrent inserts whose IDs sort before the cursor appear on a fresh traversal.

## Operations and state hooks

| Client               | Server API          | Input                                                  |
| -------------------- | ------------------- | ------------------------------------------------------ |
| `contact.create`     | `createContact`     | `{ model, data }`                                      |
| `contact.read`       | `readContact`       | `{ model, id }`                                        |
| `contact.list`       | `listContacts`      | `{ model, limit?, cursor? }`                           |
| `contact.update`     | `updateContact`     | `{ model, id, revision, data }`                        |
| `contact.transition` | `transitionContact` | `{ model, id, revision, state }`                       |
| `contact.delete`     | `deleteContact`     | `{ model, id, revision }`                              |
| `contact.bulk`       | `bulkContacts`      | `{ items: [{ operation, model, id, revision, ... }] }` |

Exactly one configured state has `default: true`. State keys are inferred as literals and have no built-in open/closed/terminal meaning. Unknown states are rejected. A same-state transition checks permission and revision but does not write or call hooks.

Model hooks are `beforeCreate`/`afterCreate`, `beforeUpdate`/`afterUpdate`, `beforeTransition`/`afterTransition`, and `beforeDelete`/`afterDelete`. Each state's `hooks` may define `beforeEnter`/`afterEnter` and `beforeLeave`/`afterLeave`.

Creation runs model `beforeCreate`, initial-state `beforeEnter`, persistence, model `afterCreate`, then initial-state `afterEnter`. A transition runs model `beforeTransition`, old-state `beforeLeave`, new-state `beforeEnter`, persistence, old-state `afterLeave`, new-state `afterEnter`, then model `afterTransition`. Hooks receive policy context plus `previous`; after hooks see the saved `record` (null after deletion). Before hooks can reject by throwing. They can run for a write that subsequently loses a race, so keep external side effects in after hooks.

Mutations require the last read revision and use the adapter's atomic guarded operations. A concurrent write returns `CONTACT_CONFLICT`; reload before retrying. Bulk actions are sequential, bounded (50 by default, maximum 100), and return an ordered result for every item. They are not a transaction and may partially succeed. Duplicate items are not silently deduplicated.

Accepted mutations return `{ model, id, revision, record, changed, hooks, output }`. After-hook failures return `hooks: { status: 'failed', failed: [...] }`; other after hooks still run. `onHookError` can capture details. A failed output validator returns `output: 'failed'` and `record: null`, retaining the saved identity/revision. Neither failure should trigger resubmission. Hooks are best-effort within the request, not a durable delivery queue. Use an application outbox if delivery must survive process crashes. Adapter/database failures can still have an ambiguous outcome; this plugin does not promise submission idempotency.

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
