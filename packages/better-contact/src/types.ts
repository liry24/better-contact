import type { DBFieldAttribute, InferDBValueType } from '@better-auth/core/db'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Session, User } from 'better-auth'

export type ContactFields = Record<string, DBFieldAttribute>
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
    access?: Partial<Record<Exclude<Operation, 'list'>, Policy>> & { list?: ListPolicy }
    hooks?: {
        beforeCreate?: Hook
        afterCreate?: Hook
        beforeUpdate?: Hook
        afterUpdate?: Hook
        beforeTransition?: Hook
        afterTransition?: Hook
        beforeDelete?: Hook
        afterDelete?: Hook
    }
}
export type ContactModels = Record<string, ContactModel>
export type ContactOptions<M extends ContactModels> = {
    models: M
    limits?: { maxBytes?: number; maxBulk?: number; maxPage?: number; createsPerMinute?: number }
    /** Runs for HTTP and direct API creation. Use a shared atomic rate limiter in production. */
    guard?: (context: AccessContext) => void | Promise<void>
    onHookError?: (event: { model: string; id: string; hook: string; error: unknown }) => void | Promise<void>
}
type InputValue<F extends DBFieldAttribute> = F extends { validator: { input: infer S extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferInput<S>
    : InferDBValueType<F['type']>
type OutputValue<F extends DBFieldAttribute> = F extends { validator: { output: infer S extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferOutput<S>
    : F extends { transform: { output: (...args: never[]) => infer R } }
      ? Awaited<R>
      : InferDBValueType<F['type']>
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
export type ContactRecord<D extends ContactModel> = {
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
export type CreateBody<M extends ContactModels> = {
    [K in keyof M & string]: { model: K; data: ContactInput<M[K]['fields']> } & (M[K] extends {
        idempotency: false
    }
        ? { idempotencyKey?: never }
        : { idempotencyKey: string })
}[keyof M & string]
export type CreateResult<M extends ContactModels> = {
    [K in keyof M & string]:
        | (MutationResult<Pick<M, K>> & { accepted: true; replayed: false })
        | (M[K] extends { idempotency: false } ? never : { model: K; id: string; accepted: true; replayed: true })
}[keyof M & string]
export type TargetBody<M extends ContactModels> = { model: keyof M & string; id: string }
export type UpdateBody<M extends ContactModels> = {
    [K in keyof M & string]: { model: K; id: string; revision: number; data: Partial<ContactInput<M[K]['fields']>> }
}[keyof M & string]
export type TransitionBody<M extends ContactModels> = {
    [K in keyof M & string]: { model: K; id: string; revision: number; state: keyof M[K]['states'] & string }
}[keyof M & string]
export type MutationResult<M extends ContactModels> = {
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
export type ListBody<M extends ContactModels> = ListQuery & { model: keyof M & string }
export type ReadResult<M extends ContactModels> = {
    [K in keyof M & string]: { model: K; record: ContactRecord<M[K]> }
}[keyof M & string]
export type ListResult<M extends ContactModels> = {
    [K in keyof M & string]: { model: K; records: ContactRecord<M[K]>[]; nextCursor: string | null; count?: number }
}[keyof M & string]
export type BulkBody<M extends ContactModels> = {
    items: (
        | (TransitionBody<M> & { operation: 'transition' })
        | (UpdateBody<M> & { operation: 'update' })
        | (TargetBody<M> & { revision: number; operation: 'delete' })
    )[]
}
export type BulkResult<M extends ContactModels> = {
    results: ({ status: 'success'; result: MutationResult<M> | DeleteResult } | { status: 'failed'; code: string })[]
}
