/* oxlint-disable no-await-in-loop -- Bulk items are ordered independent mutations, including repeated record IDs. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Runtime schemas and shared service validate dynamic model records; generic endpoint declarations preserve model inference. */
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx } from 'better-auth/api'
import * as z from 'zod'

import { buildSchema } from './schema'
import { createService } from './service'
import type {
    BulkBody,
    BulkResult,
    ContactModels,
    ContactOptions,
    CreateBody,
    CreateResult,
    DeleteResult,
    ListBody,
    ListResult,
    MutationResult,
    ReadResult,
    TargetBody,
    TransitionBody,
    UpdateBody,
} from './types'

export type {
    AccessContext,
    BulkBody,
    BulkResult,
    ContactFields,
    ContactInput,
    ContactModel,
    ContactModels,
    ContactOptions,
    ContactRecord,
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

/** Native Better Auth plugin. Every public endpoint resolves its session and invokes the same policy service. */
export function contact<const M extends ContactModels>(options: ContactOptions<M>) {
    const schema = buildSchema(options.models)
    const service = createService(options)
    return {
        id: 'contact',
        version: '0.0.0',
        options,
        schema,
        endpoints: {
            createContact: createAuthEndpoint(
                '/contact/create',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<CreateBody<M>>(
                        z.strictObject({ model: identifier, data: z.unknown(), idempotencyKey: z.string().optional() }),
                    ),
                },
                async (ctx) => {
                    const actor = {
                        session: await getAuthoritativeSessionFromCtx(ctx),
                        headers: new Headers(ctx.headers),
                    }
                    return (await service.create(ctx.context.adapter, actor, ctx.body)) as CreateResult<M>
                },
            ),
            readContact: createAuthEndpoint(
                '/contact/read',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<TargetBody<M>>(target),
                },
                async (ctx) => {
                    const actor = {
                        session: await getAuthoritativeSessionFromCtx(ctx),
                        headers: new Headers(ctx.headers),
                    }
                    return (await service.read(ctx.context.adapter, actor, ctx.body)) as ReadResult<M>
                },
            ),
            listContacts: createAuthEndpoint(
                '/contact/list',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<ListBody<M>>(
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
                },
                async (ctx) => {
                    const actor = {
                        session: await getAuthoritativeSessionFromCtx(ctx),
                        headers: new Headers(ctx.headers),
                    }
                    return (await service.list(ctx.context.adapter, actor, ctx.body)) as ListResult<M>
                },
            ),
            updateContact: createAuthEndpoint(
                '/contact/update',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<UpdateBody<M>>(update),
                },
                async (ctx) => {
                    const actor = {
                        session: await getAuthoritativeSessionFromCtx(ctx),
                        headers: new Headers(ctx.headers),
                    }
                    return (await service.mutate(ctx.context.adapter, actor, 'update', ctx.body)) as MutationResult<M>
                },
            ),
            transitionContact: createAuthEndpoint(
                '/contact/transition',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<TransitionBody<M>>(transition),
                },
                async (ctx) => {
                    const actor = {
                        session: await getAuthoritativeSessionFromCtx(ctx),
                        headers: new Headers(ctx.headers),
                    }
                    return (await service.mutate(
                        ctx.context.adapter,
                        actor,
                        'transition',
                        ctx.body,
                    )) as MutationResult<M>
                },
            ),
            deleteContact: createAuthEndpoint(
                '/contact/delete',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<TargetBody<M> & { revision: number }>(deletion),
                },
                async (ctx) => {
                    const actor = {
                        session: await getAuthoritativeSessionFromCtx(ctx),
                        headers: new Headers(ctx.headers),
                    }
                    return (await service.mutate(ctx.context.adapter, actor, 'delete', ctx.body)) as DeleteResult
                },
            ),
            bulkContacts: createAuthEndpoint(
                '/contact/bulk',
                {
                    method: 'POST',
                    metadata: { noStore: true },
                    body: typed<BulkBody<M>>(
                        z.strictObject({
                            items: z
                                .array(
                                    z.discriminatedUnion('operation', [
                                        update.extend({ operation: z.literal('update') }),
                                        transition.extend({ operation: z.literal('transition') }),
                                        deletion.extend({ operation: z.literal('delete') }),
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
                                result: (await service.mutate(ctx.context.adapter, actor, item.operation, item)) as
                                    | MutationResult<M>
                                    | DeleteResult,
                            })
                        } catch (error) {
                            results.push({
                                status: 'failed',
                                code:
                                    error instanceof APIError
                                        ? (error.body?.code ?? 'CONTACT_FAILED')
                                        : 'CONTACT_FAILED',
                            })
                        }
                    }
                    return { results }
                },
            ),
            // An explicit trusted boundary. No path, client action, or request-derived bypass flag.
            maintainContact: createAuthEndpoint.serverOnly(
                {
                    method: 'POST',
                    body: z.discriminatedUnion('operation', [
                        update.extend({ operation: z.literal('update') }),
                        transition.extend({ operation: z.literal('transition') }),
                        deletion.extend({ operation: z.literal('delete') }),
                    ]),
                },
                async (ctx) =>
                    service.mutate(
                        ctx.context.adapter,
                        { session: null, headers: new Headers() },
                        ctx.body.operation,
                        ctx.body,
                        true,
                    ),
            ),
        },
    } satisfies BetterAuthPlugin
}
