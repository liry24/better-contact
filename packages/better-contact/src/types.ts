import type { DBFieldAttribute, InferDBValueType } from '@better-auth/core/db'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Session, User } from 'better-auth'

export type ContactFields = Record<string, DBFieldAttribute>
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }
type NativeValue<T extends DBFieldAttribute['type']> = T extends 'json'
    ? JsonValue[] | { [key: string]: JsonValue }
    : InferDBValueType<T>
// Native adapters can decode the transform's result after invoking it. JSON decoding is
// explicit in this plugin; date/boolean normalization still depends on adapter capabilities.
type DecodedOutput<F extends DBFieldAttribute, R> = F extends { references: { field: 'id' } }
    ? R extends null | undefined
        ? R
        : string
    : F['type'] extends 'json' | 'string[]' | 'number[]'
      ? R extends string
          ? JsonValue
          : R
      : F['type'] extends 'date'
        ? R extends string
            ? R | Date
            : R
        : F['type'] extends 'boolean'
          ? R extends number
              ? R | boolean
              : R
          : R
type AdapterOutput<F extends DBFieldAttribute> = DecodedOutput<
    F,
    F extends { transform: { output: (...args: never[]) => infer R } } ? Awaited<R> : NativeValue<F['type']>
>
export type ContactSession = { user: User; session: Session } | null
export type Operation = 'create' | 'list' | 'read' | 'update' | 'transition' | 'delete'
export type StoredRecord = {
    id: string
    userId: string | null
    state: string
    revision: number
    createdAt: Date
    updatedAt: Date
} & Record<string, unknown>
export type ScopeTerm = {
    field: string
    operator?: 'eq' | 'ne' | 'in' | 'lt' | 'lte' | 'gt' | 'gte'
    value: string | number | boolean | Date | null | string[] | number[]
}
export type Scope = { where: readonly ScopeTerm[] }
export type AccessContext = {
    model: string
    operation: Operation
    session: ContactSession
    record: Readonly<StoredRecord> | null
    changes: Readonly<Record<string, unknown>>
    targetState: string | null
    headers: Headers
}
export type Policy = (context: AccessContext) => boolean | Promise<boolean>
export type ListPolicy = (context: AccessContext) => false | Scope | Promise<false | Scope>
export type HookContext = AccessContext & { previous: Readonly<StoredRecord> | null }
export type Hook = (context: HookContext) => void | Promise<void>
export type ContactModel = {
    fields: ContactFields
    schema?: {
        modelName?: string
        fields?: Partial<
            Record<'state' | 'revision' | 'createdAt' | 'updatedAt', Pick<DBFieldAttribute, 'fieldName'>>
        > & {
            userId?: Pick<DBFieldAttribute, 'fieldName' | 'references'>
        }
    }
    list?: {
        filters?: readonly string[]
        orderBy?: readonly string[]
        search?: readonly string[]
        count?: boolean
    }
    idempotency?:
        | false
        | {
              /** Optional additional restriction on receipt-only replay; receives the current record. */
              replay?: Policy
              /** Resolve a verified anonymous identity, never a raw client-selected scope. */
              anonymousScope?: (
                  context: Pick<AccessContext, 'model' | 'headers'>,
              ) => string | null | Promise<string | null>
          }
    states: Record<
        string,
        { default?: boolean; hooks?: { beforeEnter?: Hook; afterEnter?: Hook; beforeLeave?: Hook; afterLeave?: Hook } }
    >
    access?: { [O in Operation]?: O extends 'list' ? ListPolicy : Policy }
    hooks?: { [O in Operation]?: { before?: Hook; after?: Hook } }
}
export type ContactModels = Record<string, ContactModel>
export type ContactDefinition = { fields: ContactFields; states: Record<string, unknown>; idempotency?: unknown }
export type ContactDefinitions = Record<string, ContactDefinition>
export type ContactOptions<M extends ContactModels> = {
    models: M
    limits?: { maxBytes?: number; maxBulk?: number; maxPage?: number; createsPerMinute?: number }
    /** Runs for HTTP and direct API creation. Use a shared atomic rate limiter in production. */
    guard?: (context: AccessContext) => void | Promise<void>
    onHookError?: (event: { model: string; id: string | null; hook: string; error: unknown }) => void | Promise<void>
}

/** Adapter output, before response validators and returned-field filtering. Available only on the server. */
export type ContactStoredRecord<D extends ContactDefinition> = Pick<
    StoredRecord,
    'id' | 'userId' | 'revision' | 'createdAt' | 'updatedAt'
> & { state: keyof D['states'] & string } & {
    [K in keyof D['fields']]:
        | AdapterOutput<D['fields'][K]>
        | (D['fields'][K] extends { required: false } ? null | undefined : never)
}
/** Validated native values before adapter input transforms. Partial on updates and receipt replays. */
export type ContactChanges<F extends ContactFields> = Readonly<
    Partial<{
        [K in keyof F]: NativeValue<F[K]['type']> | (F[K] extends { required: false } ? null : never)
    }>
>
export type ModelContext<K extends string, D extends ContactDefinition, O extends Operation = Operation> = Omit<
    AccessContext,
    'model' | 'operation' | 'record' | 'changes' | 'targetState'
> & {
    model: K
    operation: O
    record: Readonly<ContactStoredRecord<D>> | null
    changes: ContactChanges<D['fields']>
    targetState: (keyof D['states'] & string) | null
}
export type ModelHookContext<
    K extends string,
    D extends ContactDefinition,
    O extends Operation = Operation,
> = ModelContext<K, D, O> & { previous: Readonly<ContactStoredRecord<D>> | null }
type ModelHook<K extends string, D extends ContactDefinition, O extends Operation = Operation> = (
    context: ModelHookContext<K, D, O>,
) => void | Promise<void>
type ModelAccess<K extends string, D extends ContactDefinition> = {
    [O in Operation]?: (
        context: ModelContext<K, D, O>,
    ) => O extends 'list' ? false | Scope | Promise<false | Scope> : boolean | Promise<boolean>
}
type ModelHooks<K extends string, D extends ContactDefinition> = {
    [O in Operation]?: { before?: ModelHook<K, D, O>; after?: ModelHook<K, D, O> }
}
type Definition<F extends ContactFields, S> = { fields: F; states: { [T in keyof S & string]: { default?: boolean } } }
export type InferredModels<
    F extends Record<string, ContactFields>,
    S extends Record<string, Record<string, unknown>>,
    I extends Record<string, unknown>,
> = {
    [K in keyof F & string]: Definition<F[K], S[K]> & (I[K] extends false ? { idempotency: false } : {})
}
/** Separate reverse mappings retain field values and state keys while contextually typing inline callbacks. */
export type InferredContactOptions<
    F extends Record<string, ContactFields>,
    S extends Record<string, Record<string, unknown>>,
    I extends Record<string, unknown>,
> = {
    models: { [K in keyof F]: { fields: F[K] } } & { [K in keyof I]: { idempotency?: I[K] } } & {
        [K in keyof S]: Pick<ContactModel, 'schema' | 'list'> & {
            states: {
                [T in keyof S[K]]: {
                    default?: boolean
                    hooks?: {
                        beforeEnter?: ModelHook<K & string, Definition<F[K & string], S[K]>, 'create' | 'transition'>
                        afterEnter?: ModelHook<K & string, Definition<F[K & string], S[K]>, 'create' | 'transition'>
                        beforeLeave?: ModelHook<K & string, Definition<F[K & string], S[K]>, 'transition'>
                        afterLeave?: ModelHook<K & string, Definition<F[K & string], S[K]>, 'transition'>
                    }
                }
            }
            access?: ModelAccess<K & string, Definition<F[K & string], S[K]>>
            hooks?: ModelHooks<K & string, Definition<F[K & string], S[K]>>
            idempotency?:
                | false
                | {
                      replay?: (
                          context: ModelContext<K & string, Definition<F[K & string], S[K]>, 'create'>,
                      ) => boolean | Promise<boolean>
                      anonymousScope?: (context: {
                          model: K & string
                          headers: Headers
                      }) => string | null | Promise<string | null>
                  }
        }
    }
} & Omit<ContactOptions<ContactModels>, 'models' | 'guard' | 'onHookError'> & {
        guard?: (
            context: {
                [K in keyof F & string]: ModelContext<K, Definition<F[K], S[K]>, 'create'>
            }[keyof F & string],
        ) => void | Promise<void>
        onHookError?: (event: {
            model: keyof F & string
            id: string | null
            hook: `${Operation}.after` | 'afterEnter' | 'afterLeave'
            error: unknown
        }) => void | Promise<void>
    }
type InputValue<F extends DBFieldAttribute> = F extends { validator: { input: infer S extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferInput<S>
    : NativeValue<F['type']>
type OutputValue<F extends DBFieldAttribute> = F extends { validator: { output: infer S extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferOutput<S>
    : AdapterOutput<F>
type OptionalInput<F extends DBFieldAttribute> = F extends { required: false } | { defaultValue: unknown }
    ? true
    : undefined extends InputValue<F>
      ? true
      : false
export type ContactInput<F extends ContactFields> = {
    [K in keyof F as F[K] extends { input: false } ? never : OptionalInput<F[K]> extends true ? never : K]: InputValue<
        F[K]
    >
} & {
    [K in keyof F as F[K] extends { input: false } ? never : OptionalInput<F[K]> extends true ? K : never]?:
        | InputValue<F[K]>
        | (F[K] extends { required: false } ? null : never)
}
export type ContactRecord<D extends ContactDefinition> = {
    id: string
    userId: string | null
    state: keyof D['states'] & string
    revision: number
    createdAt: Date
    updatedAt: Date
} & {
    [K in keyof D['fields'] as D['fields'][K] extends { returned: false } ? never : K]:
        | OutputValue<D['fields'][K]>
        | (D['fields'][K] extends { required: false } ? null | undefined : never)
}
export type HookResult = { status: 'ok' | 'failed'; failed: string[] }
export type DeleteResult = { deleted: true; hooks: HookResult }
export type CreateBody<M extends ContactDefinitions> = {
    [K in keyof M & string]: { model: K; data: ContactInput<M[K]['fields']> } & (M[K] extends {
        idempotency: false
    }
        ? { idempotencyKey?: never }
        : { idempotencyKey: string })
}[keyof M & string]
export type CreateResult<M extends ContactDefinitions> = {
    [K in keyof M & string]:
        | (MutationResult<Pick<M, K>> & { accepted: true; replayed: false })
        | (M[K] extends { idempotency: false } ? never : { model: K; id: string; accepted: true; replayed: true })
}[keyof M & string]
export type TargetBody<M extends ContactDefinitions> = { model: keyof M & string; id: string }
export type UpdateBody<M extends ContactDefinitions> = {
    [K in keyof M & string]: { model: K; id: string; revision: number; data: Partial<ContactInput<M[K]['fields']>> }
}[keyof M & string]
export type TransitionBody<M extends ContactDefinitions> = {
    [K in keyof M & string]: { model: K; id: string; revision: number; state: keyof M[K]['states'] & string }
}[keyof M & string]
export type MutationResult<M extends ContactDefinitions> = {
    [K in keyof M & string]: {
        model: K
        id: string
        revision: number
        record: ContactRecord<M[K]> | null
        output: 'ok' | 'failed'
        hooks: HookResult
        changed: boolean
    }
}[keyof M & string]
export type ListQuery = {
    cursor?: string
    limit?: number
    filters?: ScopeTerm[]
    orderBy?: { field: string; direction: 'asc' | 'desc' }
    search?: { field: string; term: string }
    count?: boolean
}
export type ListBody<M extends ContactDefinitions> = ListQuery & { model: keyof M & string }
export type ReadResult<M extends ContactDefinitions> = {
    [K in keyof M & string]: { model: K; record: ContactRecord<M[K]>; hooks: HookResult }
}[keyof M & string]
export type ListResult<M extends ContactDefinitions> = {
    [K in keyof M & string]: {
        model: K
        records: ContactRecord<M[K]>[]
        nextCursor: string | null
        count?: number
        hooks: HookResult
    }
}[keyof M & string]
export type BulkBody<M extends ContactDefinitions> = {
    items: (
        | (TransitionBody<M> & { operation: 'transition' })
        | (UpdateBody<M> & { operation: 'update' })
        | (TargetBody<M> & { revision: number; operation: 'delete' })
    )[]
}
export type BulkResult<M extends ContactDefinitions> = {
    results: ({ status: 'success'; result: MutationResult<M> | DeleteResult } | { status: 'failed'; code: string })[]
}

export type MaintenanceBody<M extends ContactDefinitions> = {
    [K in keyof M & string]:
        | {
              operation: 'update'
              model: K
              id: string
              revision: number
              data: Partial<{
                  [P in keyof M[K]['fields']]:
                      | InputValue<M[K]['fields'][P]>
                      | (M[K]['fields'][P] extends { required: false } ? null : never)
              }>
          }
        | (TransitionBody<Pick<M, K>> & { operation: 'transition' })
        | (TargetBody<Pick<M, K>> & { operation: 'delete'; revision: number })
}[keyof M & string]
