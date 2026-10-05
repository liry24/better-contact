/* oxlint-disable no-await-in-loop -- Hook lifecycle order is part of the public contract. */
import type { DBFieldAttribute } from '@better-auth/core/db'
import type { DBAdapter, Where } from '@better-auth/core/db/adapter'

import { baseFields, fail, object, prepare, present, storageValue, tableName } from './schema'
import type {
    AccessContext,
    ContactModel,
    ContactModels,
    ContactOptions,
    ContactSession,
    Hook,
    HookContext,
    HookResult,
    Operation,
    Scope,
    StoredRecord,
} from './types'

type ContactAdapter = Pick<DBAdapter, 'create' | 'findOne' | 'findMany' | 'incrementOne' | 'consumeOne'>

type Actor = { session: ContactSession; headers: Headers }
type Target = { model: string; id: string; revision?: number }
type NamedHook = readonly [string, Hook | undefined]

function isolated<T extends AccessContext>(event: T): T {
    const copy: T = structuredClone({ ...event, headers: null })
    copy.headers = new Headers(event.headers)
    return copy
}

function context(
    actor: Actor,
    name: string,
    operation: Operation,
    record: StoredRecord | null,
    changes: Record<string, unknown> = {},
    targetState: string | null = null,
): AccessContext {
    return { ...actor, model: name, operation, record, changes, targetState }
}

async function authorize(definition: ContactModel, event: AccessContext, managed = false) {
    if (managed) return
    const policy = definition.access?.[event.operation === 'list' ? 'read' : event.operation]
    const allowed: unknown = policy ? await policy(isolated(event)) : false
    if (allowed !== true) {
        if (event.record) fail('NOT_FOUND', 'Contact record unavailable', 'NOT_FOUND')
        fail('FORBIDDEN', 'Contact operation denied', 'FORBIDDEN')
    }
}

async function before(hooks: NamedHook[], event: HookContext) {
    for (const [, hook] of hooks) if (hook) await hook(isolated(event))
}

async function result(name: string, definition: ContactModel, record: StoredRecord, hooks: HookResult, changed = true) {
    // Response validation also happens after persistence. An incompatible serializer must not invite resubmission.
    try {
        return {
            model: name,
            id: record.id,
            revision: record.revision,
            record: await present(definition.fields, record),
            output: 'ok' as const,
            hooks,
            changed,
        }
    } catch {
        return {
            model: name,
            id: record.id,
            revision: record.revision,
            record: null,
            output: 'failed' as const,
            hooks,
            changed,
        }
    }
}

async function find(adapter: ContactAdapter, target: Target) {
    const record = await adapter.findOne<StoredRecord>({
        model: tableName(target.model),
        where: [{ field: 'id', value: target.id }],
    })
    if (!record) fail('NOT_FOUND', 'Contact record unavailable', 'NOT_FOUND')
    return record
}

function revision(target: Target, record: StoredRecord) {
    if (target.revision !== record.revision)
        fail('CONFLICT', 'Contact revision changed; reload before retrying', 'CONFLICT')
    return [
        { field: 'id', value: record.id },
        { field: 'revision', value: record.revision },
    ] satisfies Where[]
}

function scope(definition: ContactModel, value: unknown): Where[] {
    if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.where) || value.where.length > 20)
        fail('SCOPE', 'List policy must return a bounded declarative AND scope')
    const fields: Record<string, DBFieldAttribute> = { id: { type: 'string' }, ...baseFields, ...definition.fields }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every term is checked below before becoming a DB predicate.
    return (value as Scope).where.map((term) => {
        if (
            !object(term) ||
            Object.keys(term).some((key) => !['field', 'operator', 'value'].includes(key)) ||
            !Object.hasOwn(fields, term.field)
        )
            fail('SCOPE', 'Unsupported list scope')
        const field = fields[term.field]!
        if (field.transform || !['string', 'number', 'date', 'boolean'].includes(String(field.type)))
            fail('SCOPE', 'Scope requires an untransformed scalar column')
        const operator = term.operator ?? 'eq'
        if (!['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte'].includes(operator))
            fail('SCOPE', 'Unsupported list scope operator')
        if (operator === 'in') {
            if (
                !Array.isArray(term.value) ||
                term.value.length < 1 ||
                term.value.length > 100 ||
                !term.value.every((item) => storageValue(field, item))
            )
                fail('SCOPE', 'Invalid list scope values')
        } else if (!storageValue({ ...field, required: false }, term.value)) fail('SCOPE', 'Invalid list scope value')
        return { field: term.field, operator, value: term.value, connector: 'AND' }
    })
}

export function createService<M extends ContactModels>(options: ContactOptions<M>) {
    const maxBytes = options.limits?.maxBytes ?? 16_384
    const maxPage = options.limits?.maxPage ?? 100
    const maxBulk = options.limits?.maxBulk ?? 50
    const createsPerMinute = options.limits?.createsPerMinute ?? 60
    for (const limit of [maxBytes, maxPage, maxBulk, createsPerMinute])
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Contact limits must be positive integers')
    if (maxPage > 1000 || maxBulk > 100) throw new Error('Contact page/bulk limits exceed supported bounds')
    // Bounded by configured models, covering direct API and HTTP alike. Apps can add a distributed guard.
    const windows = new Map<string, { start: number; count: number }>()
    function model(name: string): ContactModel {
        if (!Object.hasOwn(options.models, name)) fail('MODEL', 'Unknown contact model')
        return options.models[name]!
    }
    async function after(hooks: NamedHook[], event: HookContext): Promise<HookResult> {
        const failed: string[] = []
        for (const [name, hook] of hooks) {
            if (!hook) continue
            try {
                await hook(isolated(event))
            } catch (error) {
                failed.push(name)
                try {
                    await options.onHookError?.({
                        model: event.model,
                        id: event.record?.id ?? event.previous!.id,
                        hook: name,
                        error,
                    })
                } catch {
                    /* Observability failures do not change the persisted result. */
                }
            }
        }
        return { status: failed.length ? 'failed' : 'ok', failed }
    }
    async function create(adapter: ContactAdapter, actor: Actor, body: { model: string; data: unknown }) {
        const definition = model(body.model)
        const now = Date.now()
        const window = windows.get(body.model)
        if (!window || now - window.start >= 60_000) windows.set(body.model, { start: now, count: 1 })
        else {
            if (window.count >= createsPerMinute)
                fail('RATE_LIMIT', 'Contact submission limit reached', 'TOO_MANY_REQUESTS')
            window.count++
        }
        const data = await prepare(definition.fields, body.data, 'create', false, maxBytes)
        const state = Object.entries(definition.states).find(([, value]) => value.default === true)![0]
        const event = context(actor, body.model, 'create', null, data, state)
        await authorize(definition, event)
        await options.guard?.(isolated(event))
        const entering = definition.states[state]!.hooks
        await before(
            [
                ['beforeCreate', definition.hooks?.beforeCreate],
                ['beforeEnter', entering?.beforeEnter],
            ],
            { ...event, previous: null },
        )
        const record = await adapter.create<StoredRecord>({
            model: tableName(body.model),
            data: {
                ...data,
                state,
                userId: actor.session?.user.id ?? null,
                revision: 0,
                createdAt: new Date(now),
                updatedAt: new Date(now),
            },
        })
        const hooks = await after(
            [
                ['afterCreate', definition.hooks?.afterCreate],
                ['afterEnter', entering?.afterEnter],
            ],
            { ...event, record, previous: null },
        )
        return result(body.model, definition, record, hooks)
    }
    async function read(adapter: ContactAdapter, actor: Actor, body: Target) {
        const definition = model(body.model)
        const record = await find(adapter, body)
        await authorize(definition, context(actor, body.model, 'read', record))
        return { model: body.model, record: await present(definition.fields, record) }
    }
    async function list(
        adapter: ContactAdapter,
        actor: Actor,
        body: { model: string; limit?: number; cursor?: string },
    ) {
        const definition = model(body.model)
        const policy = definition.access?.list
        const allowed = policy ? await policy(isolated(context(actor, body.model, 'list', null))) : false
        if (allowed === false) fail('FORBIDDEN', 'Contact operation denied', 'FORBIDDEN')
        const where = scope(definition, allowed)
        const limit = body.limit ?? Math.min(20, maxPage)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPage) fail('LIMIT', 'Invalid contact page size')
        if (body.cursor) where.push({ field: 'id', operator: 'gt', value: body.cursor, connector: 'AND' })
        const rows = await adapter.findMany<StoredRecord>({
            model: tableName(body.model),
            where,
            limit: limit + 1,
            sortBy: { field: 'id', direction: 'asc' },
        })
        const page = rows.slice(0, limit)
        return {
            model: body.model,
            records: await Promise.all(page.map((row) => present(definition.fields, row))),
            nextCursor: rows.length > limit ? page.at(-1)!.id : null,
        }
    }
    async function mutate(
        adapter: ContactAdapter,
        actor: Actor,
        operation: 'update' | 'transition' | 'delete',
        body: Target & { data?: unknown; state?: string },
        managed = false,
    ) {
        const definition = model(body.model)
        if (operation === 'transition' && (!body.state || !Object.hasOwn(definition.states, body.state)))
            fail('STATE', 'Unknown contact state')
        const record = await find(adapter, body)
        const changes =
            operation === 'update'
                ? await prepare(definition.fields, body.data, 'update', managed, maxBytes)
                : operation === 'transition' && record.state !== body.state
                  ? await prepare(definition.fields, {}, 'update', true, maxBytes)
                  : {}
        const event = context(actor, body.model, operation, record, changes, body.state ?? null)
        await authorize(definition, event, managed)
        const where = revision(body, record)
        if (operation === 'transition' && record.state === body.state)
            return result(body.model, definition, record, { status: 'ok', failed: [] }, false)
        if (operation === 'update' && !Object.keys(changes).length)
            return result(body.model, definition, record, { status: 'ok', failed: [] }, false)
        const previous = record
        if (operation === 'delete') {
            await before([['beforeDelete', definition.hooks?.beforeDelete]], { ...event, previous })
            const deleted = await adapter.consumeOne<StoredRecord>({ model: tableName(body.model), where })
            if (!deleted) fail('CONFLICT', 'Contact revision changed; reload before retrying', 'CONFLICT')
            return {
                deleted: true as const,
                hooks: await after([['afterDelete', definition.hooks?.afterDelete]], {
                    ...event,
                    record: null,
                    previous: deleted,
                }),
            }
        }
        const leaving = definition.states[record.state]?.hooks
        const entering = body.state ? definition.states[body.state]?.hooks : undefined
        const beforeHooks: NamedHook[] =
            operation === 'transition'
                ? [
                      ['beforeTransition', definition.hooks?.beforeTransition],
                      ['beforeLeave', leaving?.beforeLeave],
                      ['beforeEnter', entering?.beforeEnter],
                  ]
                : [['beforeUpdate', definition.hooks?.beforeUpdate]]
        await before(beforeHooks, { ...event, previous })
        const saved = await adapter.incrementOne<StoredRecord>({
            model: tableName(body.model),
            where,
            increment: { revision: 1 },
            set: { ...changes, ...(operation === 'transition' ? { state: body.state } : {}), updatedAt: new Date() },
        })
        if (!saved) fail('CONFLICT', 'Contact revision changed; reload before retrying', 'CONFLICT')
        const afterHooks: NamedHook[] =
            operation === 'transition'
                ? [
                      ['afterLeave', leaving?.afterLeave],
                      ['afterEnter', entering?.afterEnter],
                      ['afterTransition', definition.hooks?.afterTransition],
                  ]
                : [['afterUpdate', definition.hooks?.afterUpdate]]
        const hooks = await after(afterHooks, { ...event, record: saved, previous })
        return result(body.model, definition, saved, hooks)
    }
    return { create, read, list, mutate, maxBulk }
}
