import type { DBAdapter } from '@better-auth/core/db/adapter'

import { fail, object, receiptTable } from './schema'
import type { ContactModel, ContactSession, HookResult } from './types'

export type ContactTransaction = Pick<
    DBAdapter,
    'create' | 'findOne' | 'findMany' | 'count' | 'incrementOne' | 'consumeOne' | 'update'
>
export type ContactAdapter = ContactTransaction & {
    options?: { adapterConfig: { transaction?: unknown } } | undefined
    transaction: <R>(callback: (transaction: ContactTransaction) => Promise<R>) => Promise<R>
}

// Tagged canonical encoding preserves Dates/undefined for direct API consumers without
// applying the model's adapter or validator transforms a second time.
type Encoded = null | boolean | number | string | Encoded[]
function encode(value: unknown): Encoded {
    if (value === undefined) return ['undefined']
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (value instanceof Date && Number.isFinite(value.getTime())) return ['date', value.toISOString()]
    if (Array.isArray(value)) return ['array', ...value.map(encode)]
    if (object(value))
        return [
            'object',
            ...Object.keys(value)
                .toSorted()
                .map((key) => [key, encode(value[key])]),
        ]
    throw new Error('Contact receipt requires serializable output')
}
function decode(value: Encoded): unknown {
    if (!Array.isArray(value)) return value
    if (value[0] === 'undefined') return undefined
    if (value[0] === 'date' && typeof value[1] === 'string') return new Date(value[1])
    if (value[0] === 'array') return value.slice(1).map(decode)
    if (value[0] === 'object')
        return Object.fromEntries(
            value.slice(1).map((entry) => {
                if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new Error('Invalid contact receipt')
                return [entry[0], decode(entry[1]!)]
            }),
        )
    throw new Error('Invalid contact receipt')
}
export function pack(value: unknown): string {
    return JSON.stringify(encode(value))
}
export function unpack(value: string): unknown {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only our tagged serializer writes this internal column.
    return decode(JSON.parse(value) as Encoded)
}
export async function digest(value: unknown): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pack(value)))
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export type Receipt = {
    id: string
    token: string
    fingerprint: string
    resourceId: string
    expiresAt: Date
    payload: string
    hooks: string
}
export type ReceiptResponse = {
    model: string
    id: string
    revision: number
    record: Record<string, unknown> | null
    output: 'ok' | 'failed'
    hooks: HookResult
    changed: boolean
}
export type ReceiptPayload = { data: Record<string, unknown>; response: ReceiptResponse }
export function payload(receipt: Receipt): ReceiptPayload {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Internal payload is written only by commitReceipt.
    return unpack(receipt.payload) as ReceiptPayload
}
export async function receiptToken(
    adapter: ContactAdapter,
    definition: ContactModel,
    actor: { session: ContactSession; headers: Headers },
    model: string,
    key: unknown,
) {
    if (typeof adapter.options?.adapterConfig.transaction !== 'function')
        fail('TRANSACTION_REQUIRED', 'Keyed creation requires an adapter with real transactions')
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(key))
        fail(
            'IDEMPOTENCY_KEY',
            'Use a 16–128 character submission key containing letters, numbers, hyphens or underscores',
        )
    const identity =
        actor.session?.user.id ??
        (await definition.idempotency?.anonymousScope?.({ model, headers: new Headers(actor.headers) }))
    if (typeof identity !== 'string' || !identity.length || identity.length > 512)
        fail('IDEMPOTENCY_SCOPE', 'Keyed anonymous creation requires a verified application identity', 'FORBIDDEN')
    return digest([model, actor.session ? 'user' : 'anonymous', identity, key])
}
export async function lookupReceipt(adapter: Pick<DBAdapter, 'findOne'>, token: string, now = Date.now()) {
    const receipt = await adapter.findOne<Receipt>({ model: receiptTable, where: [{ field: 'token', value: token }] })
    return receipt && receipt.expiresAt.getTime() > now ? receipt : null
}
export async function commitReceipt(
    adapter: ContactAdapter,
    token: string,
    fingerprint: string,
    retentionSeconds: number,
    data: Record<string, unknown>,
    persist: (transaction: ContactTransaction) => Promise<ReceiptResponse>,
) {
    try {
        return await adapter.transaction(async (transaction) => {
            const existing = await lookupReceipt(transaction, token)
            if (existing) return { receipt: existing, created: false }
            await transaction.consumeOne({
                model: receiptTable,
                where: [
                    { field: 'token', value: token },
                    { field: 'expiresAt', operator: 'lte', value: new Date() },
                ],
            })
            const response = await persist(transaction)
            let serialized: string
            try {
                serialized = pack({ data, response })
            } catch {
                response.record = null
                response.output = 'failed'
                serialized = pack({ data, response })
            }
            const receipt = await transaction.create<Receipt>({
                model: receiptTable,
                data: {
                    token,
                    fingerprint,
                    resourceId: response.id,
                    expiresAt: new Date(Date.now() + retentionSeconds * 1000),
                    payload: serialized,
                    hooks: pack(response.hooks),
                },
            })
            return { receipt, created: true }
        })
    } catch (error) {
        // A unique-key race or a lost COMMIT acknowledgement can already have a durable receipt.
        // Never re-run after hooks when ownership of that commit is uncertain.
        const existing = await lookupReceipt(adapter, token)
        if (existing) return { receipt: existing, created: false }
        throw error
    }
}
