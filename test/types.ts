import type { DBFieldAttribute } from '@better-auth/core/db'
import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import * as v from 'valibot'
import * as z from 'zod'

import { contactClient } from '../packages/better-contact/src/client'
import { contact } from '../packages/better-contact/src/index'

const auth = betterAuth({
    plugins: [
        contact({
            models: {
                feedback: {
                    states: { received: { default: true }, reviewed: {} },
                    fields: {
                        score: { type: 'number', validator: { input: z.string().transform(Number) } },
                        label: { type: 'string', validator: { input: v.pipe(v.string(), v.trim()) } },
                        defaulted: { type: 'string', validator: { input: z.string().default('default') } },
                        secret: { type: 'string', input: false, returned: false, defaultValue: 'secret' },
                        priority: { type: 'number', input: false, defaultValue: 0 },
                        result: {
                            type: 'string',
                            required: false,
                            validator: {
                                output: z
                                    .string()
                                    .nullable()
                                    .transform((value) => value?.length ?? 0),
                            },
                        },
                    },
                },
                inquiry: {
                    states: { new: { default: true }, answered: {} },
                    fields: { question: { type: 'string' } },
                    idempotency: { replay: () => true },
                },
            },
        }),
    ],
})
const client = createAuthClient({ plugins: [contactClient<typeof auth>()] })
const native: DBFieldAttribute = { type: 'string' }
void native

async function assertions() {
    const read = await auth.api.readContact({ body: { model: 'inquiry', id: 'x' } })
    if (read.model === 'inquiry') {
        const question: string = read.record.question
        void question
    }
    const bulk = await client.contact.bulk({ items: [{ operation: 'delete', model: 'inquiry', id: 'x', revision: 0 }] })
    const item = bulk.data?.results[0]
    if (item?.status === 'success' && 'deleted' in item.result) {
        const status: 'ok' | 'failed' | 'unknown' = item.result.hooks.status
        void status
    }
    const result = await auth.api.createContact({ body: { model: 'feedback', data: { score: '3', label: 'hi' } } })
    if (result.model === 'feedback' && result.record) {
        const n: number = result.record.score
        const state: 'received' | 'reviewed' = result.record.state
        const output: number | null | undefined = result.record.result
        void n
        void state
        void output
        // @ts-expect-error Output is native number, not validator input string.
        const wrong: string = result.record.score
        // @ts-expect-error Hidden fields are not returned.
        void result.record.secret
        void wrong
    }
    await client.contact.create({ model: 'inquiry', data: { question: 'hello' }, idempotencyKey: crypto.randomUUID() })
    // @ts-expect-error A keyed model requires its key.
    await client.contact.create({ model: 'inquiry', data: { question: 'hello' } })
    await client.contact.create({
        model: 'inquiry',
        data: { question: 'hello' },
        idempotencyKey: crypto.randomUUID(),
        // @ts-expect-error Clients cannot choose an authoritative actor scope.
        scope: 'someone-else',
    })
    await client.contact.transition({ model: 'inquiry', id: 'x', revision: 0, state: 'answered' })
    // @ts-expect-error Zod input must be string.
    await auth.api.createContact({ body: { model: 'feedback', data: { score: 3, label: 'hi' } } })
    // @ts-expect-error Valibot input must be string.
    await client.contact.create({ model: 'feedback', data: { score: '3', label: 3 } })
    // @ts-expect-error Fields from another model are rejected.
    await client.contact.create({ model: 'inquiry', data: { score: '3', label: 'hi' } })
    // @ts-expect-error Managed fields cannot be supplied.
    await client.contact.create({ model: 'feedback', data: { score: '3', label: 'hi', priority: 1 } })
    // @ts-expect-error Unknown model.
    await client.contact.create({ model: 'other', data: {} })
    // @ts-expect-error State belongs to another model.
    await client.contact.transition({ model: 'inquiry', id: 'x', revision: 0, state: 'reviewed' })
    // @ts-expect-error Update cannot set state.
    await client.contact.update({ model: 'inquiry', id: 'x', revision: 0, data: { state: 'answered' } })
    // @ts-expect-error Maintenance is server-only.
    await client.maintainContact({})
    // @ts-expect-error No contact maintenance HTTP path is inferred.
    await client.contact.maintain({})
}
void assertions
