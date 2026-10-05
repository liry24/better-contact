/* oxlint-disable no-await-in-loop -- Bulk items are ordered independent mutations, including repeated record IDs. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Runtime schemas and shared service validate dynamic model records; generic endpoint declarations preserve model inference. */
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx } from 'better-auth/api'
import * as z from 'zod'

import { contactResponse } from './response'
import { baseFields, buildSchema, submissionFields } from './schema'
import { createService } from './service'
import type {
    BulkBody,
    BulkResult,
    ContactModels,
    ContactFields,
    InferredContactOptions,
    InferredModels,
    ContactOptions,
    CreateBody,
    CreateResult,
    DeleteResult,
    ListBody,
    ListResult,
    MutationResult,
    MaintenanceBody,
    ReadResult,
    TargetBody,
    TransitionBody,
    UpdateBody,
} from './types'

export type {
    AccessContext,
    InferredContactOptions,
    BulkBody,
    BulkResult,
    ContactFields,
    ContactInput,
    JsonValue,
    ContactModel,
    ContactModels,
    ContactOptions,
    ContactRecord,
    ContactStoredRecord,
    ContactChanges,
    ModelContext,
    ModelHookContext,
    ContactSession,
    CreateBody,
    CreateResult,
    DeleteResult,
    HookContext,
    HookResult,
    ListBody,
    ListQuery,
    ListResult,
    MutationResult,
    MaintenanceBody,
    Operation,
    ReadResult,
    Scope,
    ScopeTerm,
    StoredRecord,
    TargetBody,
    TransitionBody,
    UpdateBody,
} from './types'

const identifier = z.string().min(1).max(128)
const target = z.strictObject({ model: identifier, id: identifier })
const revision = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1)
const update = target.extend({ revision, data: z.unknown() })
const transition = target.extend({ revision, state: identifier })
const deletion = target.extend({ revision })
function typed<T>(schema: z.ZodType) {
    return z.custom<T>((value) => schema.safeParse(value).success)
}

type Bound<T, B extends boolean> = T extends unknown ? (B extends true ? Omit<T, 'model'> : T) : never
function endpointSet<M extends ContactModels, P extends string, B extends boolean>(
    service: ReturnType<typeof createService>,
    prefix: P,
    bound: B,
    model?: string,
) {
    const shape = <T extends z.ZodRawShape>(value: z.ZodObject<T>) =>
        bound
            ? z.strictObject(Object.fromEntries(Object.entries(value.shape).filter(([key]) => key !== 'model')))
            : value
    const body = <T>(value: T) => ({ ...value, ...(bound ? { model } : {}) })
    return {
        createContact: createAuthEndpoint(
            `${prefix}/create` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<Bound<CreateBody<M>, B>>(
                    shape(
                        z.strictObject({ model: identifier, data: z.unknown(), idempotencyKey: z.string().optional() }),
                    ),
                ),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                return contactResponse(
                    ctx,
                    (await service.create(
                        ctx.context.adapter,
                        actor,
                        body(ctx.body) as CreateBody<M>,
                    )) as CreateResult<M>,
                )
            },
        ),
        readContact: createAuthEndpoint(
            `${prefix}/read` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<Bound<TargetBody<M>, B>>(shape(target)),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                return contactResponse(
                    ctx,
                    (await service.read(ctx.context.adapter, actor, body(ctx.body) as TargetBody<M>)) as ReadResult<M>,
                )
            },
        ),
        listContacts: createAuthEndpoint(
            `${prefix}/list` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<Bound<ListBody<M>, B>>(
                    shape(
                        z.strictObject({
                            model: identifier,
                            cursor: z.string().min(1).max(131_072).optional(),
                            limit: z.number().int().positive().optional(),
                            filters: z
                                .array(
                                    z.strictObject({
                                        field: identifier,
                                        operator: z.enum(['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte']).optional(),
                                        value: z.union([
                                            z.string(),
                                            z.number().finite(),
                                            z.boolean(),
                                            z.date(),
                                            z.null(),
                                            z.array(z.string()),
                                            z.array(z.number().finite()),
                                        ]),
                                    }),
                                )
                                .max(20)
                                .optional(),
                            orderBy: z
                                .strictObject({ field: identifier, direction: z.enum(['asc', 'desc']) })
                                .optional(),
                            search: z.strictObject({ field: identifier, term: z.string().min(1).max(200) }).optional(),
                            count: z.boolean().optional(),
                        }),
                    ),
                ),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                return contactResponse(
                    ctx,
                    (await service.list(ctx.context.adapter, actor, body(ctx.body) as ListBody<M>)) as ListResult<M>,
                )
            },
        ),
        updateContact: createAuthEndpoint(
            `${prefix}/update` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<Bound<UpdateBody<M>, B>>(shape(update)),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                return contactResponse(
                    ctx,
                    (await service.mutate(
                        ctx.context.adapter,
                        actor,
                        'update',
                        body(ctx.body) as UpdateBody<M>,
                    )) as MutationResult<M>,
                )
            },
        ),
        transitionContact: createAuthEndpoint(
            `${prefix}/transition` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<Bound<TransitionBody<M>, B>>(shape(transition)),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                return contactResponse(
                    ctx,
                    (await service.mutate(
                        ctx.context.adapter,
                        actor,
                        'transition',
                        body(ctx.body) as TransitionBody<M>,
                    )) as MutationResult<M>,
                )
            },
        ),
        deleteContact: createAuthEndpoint(
            `${prefix}/delete` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<Bound<TargetBody<M> & { revision: number }, B>>(shape(deletion)),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                return contactResponse(
                    ctx,
                    (await service.mutate(
                        ctx.context.adapter,
                        actor,
                        'delete',
                        body(ctx.body) as TargetBody<M> & { revision: number },
                    )) as DeleteResult,
                )
            },
        ),
        bulkContacts: createAuthEndpoint(
            `${prefix}/bulk` as const,
            {
                method: 'POST',
                metadata: { noStore: true },
                body: typed<{ items: Bound<BulkBody<M>['items'][number], B>[] }>(
                    z.strictObject({
                        items: z
                            .array(
                                z.discriminatedUnion('operation', [
                                    shape(update).extend({ operation: z.literal('update') }),
                                    shape(transition).extend({ operation: z.literal('transition') }),
                                    shape(deletion).extend({ operation: z.literal('delete') }),
                                ]),
                            )
                            .min(1)
                            .max(service.maxBulk),
                    }),
                ),
            },
            async (ctx) => {
                const actor = {
                    session: await getAuthoritativeSessionFromCtx(ctx),
                    headers: new Headers(ctx.headers),
                }
                const results: BulkResult<M>['results'] = []
                // Each item is independently authorized and conditionally persisted. This is intentionally not atomic.
                for (const item of ctx.body.items) {
                    try {
                        results.push({
                            status: 'success',
                            result: (await service.mutate(
                                ctx.context.adapter,
                                actor,
                                item.operation,
                                body(item) as BulkBody<M>['items'][number],
                            )) as MutationResult<M> | DeleteResult,
                        })
                    } catch (error) {
                        results.push({
                            status: 'failed',
                            code: error instanceof APIError ? (error.body?.code ?? 'CONTACT_FAILED') : 'CONTACT_FAILED',
                        })
                    }
                }
                return contactResponse(ctx, { results })
            },
        ),
        // An explicit trusted boundary. No path, client action, or request-derived bypass flag.
        maintainContact: createAuthEndpoint.serverOnly(
            {
                method: 'POST',
                body: typed<MaintenanceBody<M>>(
                    z.discriminatedUnion('operation', [
                        update.extend({ operation: z.literal('update') }),
                        transition.extend({ operation: z.literal('transition') }),
                        deletion.extend({ operation: z.literal('delete') }),
                    ]),
                ),
            },
            async (ctx) =>
                (await service.mutate(
                    ctx.context.adapter,
                    { session: null, headers: new Headers() },
                    ctx.body.operation,
                    ctx.body,
                    true,
                )) as MutationResult<M> | DeleteResult,
        ),
    }
}

type ModelPath<S extends string> = S extends `${infer H}_${infer T}` ? `${H}-${ModelPath<T>}` : S
type Camel<S extends string> = S extends `${infer H}_${infer T}` ? `${H}${Capitalize<Camel<T>>}` : S
type ModelEndpointMap<M extends ContactModels> = {
    [K in keyof M & string]: {
        [
            E in keyof Omit<
                ReturnType<typeof endpointSet<Pick<M, K>, `/contact/${ModelPath<K>}`, true>>,
                'maintainContact'
            > as `${Camel<K>}${Capitalize<E & string>}`
        ]: ReturnType<typeof endpointSet<Pick<M, K>, `/contact/${ModelPath<K>}`, true>>[E]
    }
}[keyof M & string]
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never

/** Native endpoints for both fixed-model and discriminated generic operations. */
export function contact<
    const F extends Record<string, ContactFields>,
    const S extends Record<string, Record<string, unknown>>,
    const I extends Record<string, unknown>,
>(configuration: InferredContactOptions<F, S, I>) {
    type M = InferredModels<F, S, I>
    const options = configuration as unknown as ContactOptions<M>
    const schema = buildSchema(options.models) as {
        [K in keyof M & string as `contact_${K}`]: {
            modelName: string
            fields: M[K]['fields'] &
                typeof baseFields &
                (M[K] extends { idempotency: false } ? {} : typeof submissionFields)
        }
    }
    const service = createService(options)
    const models: Record<string, unknown> = {}
    for (const name of Object.keys(options.models)) {
        const endpoints = endpointSet(service, `/contact/${name.replaceAll('_', '-')}`, true, name)
        for (const [key, endpoint] of Object.entries(endpoints)) {
            if (key === 'maintainContact') continue
            const camel = name.replace(/_([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase())
            models[camel + key[0]!.toUpperCase() + key.slice(1)] = endpoint
        }
    }
    return {
        id: 'contact',
        version: '0.0.0',
        options: configuration as InferredContactOptions<F, S, I> & { models: M },
        schema,
        endpoints: {
            ...endpointSet<M, '/contact', false>(service, '/contact', false),
            ...(models as Intersection<ModelEndpointMap<M>> & {}),
        },
    } satisfies BetterAuthPlugin
}
