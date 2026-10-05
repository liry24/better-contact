import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import * as v from 'valibot'
import * as z from 'zod'

import { contactClient } from '../packages/better-contact/src/client'
import { contact } from '../packages/better-contact/src/index'
import type { ContactInput, ContactRecord, CreateBody, JsonValue } from '../packages/better-contact/src/index'

type IsAny<T> = 0 extends 1 & T ? true : false
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Generic function comparison detects exact type equality, including any widening.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- An explicit type argument is the compile-time assertion under test.
const assertType = <_T extends true>() => {}
const auth = betterAuth({
    plugins: [
        contact({
            guard(event) {
                assertType<Equal<IsAny<typeof event>, false>>()
                if (event.model === 'feedback') assertType<Equal<typeof event.changes.score, number | undefined>>()
            },
            onHookError(event) {
                assertType<Equal<typeof event.model, 'feedback' | 'inquiry' | 'abuse_report'>>()
            },
            models: {
                feedback: {
                    idempotency: false,
                    fields: {
                        message: { type: 'string', validator: { input: v.pipe(v.string(), v.trim()) } },
                        score: { type: 'number', validator: { input: z.string().transform(Number) } },
                        hidden: { type: 'string', input: false, returned: false, defaultValue: 'private' },
                        priority: { type: 'number', input: false, defaultValue: 0 },
                        serialized: {
                            type: 'json',
                            defaultValue: {},
                            transform: { output: (value: unknown) => JSON.stringify(value) },
                        },
                        encodedDate: { type: 'date', required: false, transform: { output: () => String(new Date()) } },
                        encodedBoolean: { type: 'boolean', required: false, transform: { output: () => Number(true) } },
                        encoded: {
                            type: 'string',
                            required: false,
                            transform: { output: (value: unknown) => String(value).length },
                            validator: { output: z.number().transform(String) },
                        },
                    },
                    states: {
                        received: {
                            default: true,
                            hooks: {
                                beforeEnter(event) {
                                    assertType<Equal<typeof event.model, 'feedback'>>()
                                    assertType<Equal<typeof event.targetState, 'received' | 'reviewed' | null>>()
                                    assertType<Equal<IsAny<typeof event>, false>>()
                                },
                            },
                        },
                        reviewed: {},
                    },
                    operations: {
                        create: {
                            authorize(event) {
                                assertType<Equal<typeof event.model, 'feedback'>>()
                                assertType<Equal<typeof event.operation, 'create'>>()
                                assertType<Equal<typeof event.changes.score, number | undefined>>()
                                assertType<Equal<IsAny<typeof event.changes>, false>>()
                                // @ts-expect-error Input validation has already produced a native number.
                                const wrong: string = event.changes.score
                                // @ts-expect-error Another model's field is absent.
                                void event.changes.question
                                void wrong
                                return true
                            },
                            after: async (event): Promise<void> => {
                                assertType<Equal<IsAny<typeof event>, false>>()
                                assertType<Equal<IsAny<typeof event.record>, false>>()
                                if (!event.record) return
                                assertType<Equal<typeof event.record.message, string>>()
                                assertType<Equal<typeof event.record.score, number>>()
                                assertType<Equal<typeof event.record.state, 'received' | 'reviewed'>>()
                                assertType<Equal<typeof event.record.hidden, string>>()
                                // Adapter output has run; response validation has not run in this hook.
                                assertType<Equal<typeof event.record.encoded, number | null | undefined>>()
                                assertType<Equal<typeof event.record.serialized, JsonValue>>()
                                assertType<Equal<typeof event.record.encodedDate, Date | string | null | undefined>>()
                                assertType<
                                    Equal<typeof event.record.encodedBoolean, number | boolean | null | undefined>
                                >()
                                // Auth self-reference is supported without a manually imported context.
                                const page = await auth.api.listContacts({ body: { model: 'inquiry' } })
                                assertType<Equal<IsAny<typeof page>, false>>()
                                if (page.model === 'inquiry') {
                                    const question: string | undefined = page.records[0]?.question
                                    void question
                                }
                            },
                        },
                        transition: {
                            authorize(event) {
                                assertType<Equal<typeof event.targetState, 'received' | 'reviewed' | null>>()
                                return !!event.session
                            },
                        },
                    },
                },
                inquiry: {
                    fields: { question: { type: 'string' } },
                    states: { waiting: { default: true }, answered: {} },
                    operations: { list: { authorize: () => ({ where: [] }) } },
                    idempotency: {
                        anonymousScope: ({ model }) => {
                            assertType<Equal<typeof model, 'inquiry'>>()
                            return 'verified'
                        },
                    },
                },
                abuse_report: {
                    idempotency: false,
                    fields: { target: { type: 'string' } },
                    states: { submitted: { default: true } },
                },
            },
        }),
    ],
})
const client = createAuthClient({ plugins: [contactClient<typeof auth>()] })
type Plugin = (typeof auth.options.plugins)[0]
type Models = { [K in keyof Plugin['options']['models']]: Plugin['options']['models'][K] }
assertType<Equal<IsAny<typeof contact>, false>>()
assertType<Equal<IsAny<typeof contactClient>, false>>()
assertType<Equal<IsAny<typeof auth>, false>>()
assertType<Equal<IsAny<typeof auth.api>, false>>()
assertType<Equal<IsAny<typeof auth.api.feedbackCreateContact>, false>>()
assertType<Equal<IsAny<typeof auth.api.createContact>, false>>()
assertType<Equal<IsAny<typeof client.contact>, false>>()
assertType<Equal<IsAny<typeof client.contact.feedback.create>, false>>()
assertType<Equal<IsAny<Plugin['schema']['contact_feedback']['fields']['message']>, false>>()
assertType<Equal<Plugin['schema']['contact_feedback']['fields']['message']['type'], 'string'>>()
assertType<Equal<IsAny<ContactInput<Models['feedback']['fields']>>, false>>()
assertType<Equal<IsAny<ContactRecord<Models['feedback']>>, false>>()

async function contracts(model: 'feedback' | 'inquiry', dynamic: string) {
    const fixed = await client.contact.feedback.create({ data: { message: 'hi', score: '2' } })
    assertType<Equal<IsAny<typeof fixed.data>, false>>()
    if (fixed.data?.record) {
        assertType<Equal<typeof fixed.data.model, 'feedback'>>()
        assertType<Equal<typeof fixed.data.record.score, number>>()
        assertType<Equal<typeof fixed.data.record.encoded, string | null | undefined>>()
        assertType<Equal<typeof fixed.data.record.serialized, JsonValue>>()
        // @ts-expect-error Native JSON decoding happens after an output transform returning encoded JSON.
        const encodedText: string = fixed.data.record.serialized
        void encodedText
        // @ts-expect-error Hidden output fields stay server-only.
        void fixed.data.record.hidden
    }
    await client.contact.feedback.list({})
    await client.contact.feedback.read({ id: 'a' })
    await client.contact.feedback.update({ id: 'a', revision: 0, data: { score: '3' } })
    await client.contact.feedback.transition({ id: 'a', revision: 0, state: 'reviewed' })
    await client.contact.feedback.delete({ id: 'a', revision: 0 })
    await client.contact.feedback.bulk({
        items: [{ operation: 'transition', id: 'a', revision: 0, state: 'reviewed' }],
    })
    await client.contact.abuseReport.create({ data: { target: 'a' } })
    const body: CreateBody<Models> =
        model === 'feedback'
            ? { model, data: { message: 'hi', score: '1' } }
            : { model, data: { question: 'hello' }, idempotencyKey: 'retry' }
    const generic = await client.contact.create(body)
    if (generic.data?.model === 'inquiry' && !generic.data.replayed && generic.data.record) {
        const question = generic.data.record.question
        assertType<Equal<typeof question, string>>()
        // @ts-expect-error Narrowed result cannot have fields from another model.
        void generic.data.record.score
    }
    if (dynamic === 'inquiry')
        await client.contact.create({ model: dynamic, data: { question: 'hello' }, idempotencyKey: 'retry' })
    // @ts-expect-error Union model plus one model's data is not a discriminated input.
    await client.contact.create({ model, data: { message: 'hi', score: '1' }, idempotencyKey: 'retry' })
    // @ts-expect-error Runtime names must be narrowed.
    await client.contact.create({ model: dynamic, data: { question: 'hello' }, idempotencyKey: 'retry' })
    // @ts-expect-error Model typo.
    await client.contact.feedbak.create({ data: { message: 'hi', score: '1' } })
    // @ts-expect-error Operation typo.
    await client.contact.feedback.upsert({ data: {} })
    // @ts-expect-error Fixed-model callers cannot spoof the binding.
    await client.contact.feedback.create({ model: 'inquiry', data: { message: 'hi', score: '1' } })
    // @ts-expect-error Zod input is a string.
    await client.contact.feedback.create({ data: { message: 'hi', score: 1 } })
    // @ts-expect-error Valibot input is a string.
    await client.contact.feedback.create({ data: { message: 1, score: '1' } })
    // @ts-expect-error Managed fields cannot be supplied.
    await client.contact.feedback.update({ id: 'a', revision: 0, data: { priority: 1 } })
    // @ts-expect-error State belongs to another model.
    await client.contact.feedback.transition({ id: 'a', revision: 0, state: 'answered' })
    await client.contact.feedback.bulk({
        // @ts-expect-error Fixed bulk cannot smuggle a different state.
        items: [{ operation: 'transition', id: 'a', revision: 0, state: 'answered' }],
    })
    await client.contact.bulk({
        // @ts-expect-error Generic bulk preserves state/model correlation too.
        items: [{ operation: 'transition', model: 'feedback', id: 'a', revision: 0, state: 'answered' }],
    })
    // @ts-expect-error Server-only maintenance does not become a model route.
    await client.contact.feedback.maintain({})
    // @ts-expect-error Keys are mandatory on protected models.
    await client.contact.inquiry.create({ data: { question: 'hello' } })
}
void contracts
