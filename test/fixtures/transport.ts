import assert from 'node:assert/strict'

import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { getMigrations } from 'better-auth/db/migration'
import * as z from 'zod'

import { contactClient } from '../../packages/better-contact/src/client'
import { contact } from '../../packages/better-contact/src/index'

/** Runs unchanged against source and the emitted, installed package. */
export async function verifyTransport(database: NonNullable<BetterAuthOptions['database']>) {
    const json = z.object({ at: z.string(), nested: z.array(z.object({ at: z.string() })) })
    const iso = '2026-10-05T01:02:03.123Z'
    const seen: { change: number | undefined; encoded: number | null | undefined; hidden: string }[] = []
    const auth = betterAuth({
        database,
        baseURL: 'http://localhost:3000',
        secret: 'transport-test-secret-at-least-thirty-two-characters',
        logger: { disabled: true },
        plugins: [
            contact({
                models: {
                    entry: {
                        idempotency: false,
                        fields: {
                            text: { type: 'string' },
                            labels: { type: 'string[]' },
                            happenedAt: { type: 'date' },
                            encodedDate: { type: 'date', transform: { output: () => iso } },
                            encodedBoolean: { type: 'boolean', transform: { output: () => Number(true) } },
                            payload: { type: 'json', validator: { input: json, output: json } },
                            serialized: {
                                type: 'json',
                                transform: {
                                    output: (value: unknown) =>
                                        typeof value === 'string' ? value : JSON.stringify(value),
                                },
                                validator: { output: json },
                            },
                            score: { type: 'number', validator: { input: z.string().transform(Number) } },
                            encoded: {
                                type: 'string',
                                required: false,
                                transform: { output: (value: unknown) => String(value).length },
                                validator: { output: z.number().transform(String) },
                            },
                            hidden: { type: 'string', input: false, returned: false, defaultValue: 'private' },
                        },
                        states: { received: { default: true } },
                        operations: {
                            create: {
                                authorize: () => true,
                                after: ({ changes, record }) => {
                                    assert(record)
                                    assert(record.encodedDate instanceof Date)
                                    assert.equal(record.encodedBoolean, true)
                                    seen.push({ change: changes.score, encoded: record.encoded, hidden: record.hidden })
                                },
                            },
                            read: { authorize: () => true },
                            list: { authorize: () => ({ where: [] }) },
                        },
                    },
                },
            }),
        ],
    })
    await (await getMigrations(auth.options)).runMigrations()
    let callbacks = 0
    const client = createAuthClient({
        baseURL: 'http://localhost:3000',
        plugins: [contactClient<typeof auth>()],
        fetchOptions: { customFetchImpl: (input, init) => auth.handler(new Request(input, init)) },
    })
    const data = {
        text: iso,
        labels: [iso],
        happenedAt: new Date(iso),
        encodedDate: new Date(iso),
        encodedBoolean: true,
        payload: { at: iso, nested: [{ at: iso }] },
        serialized: { at: iso, nested: [{ at: iso }] },
        score: '3',
        encoded: 'abcd',
    }
    const direct = await auth.api.entryCreateContact({ body: { data } })
    assert(direct.record)
    assert.equal(direct.record.text, iso)
    assert(direct.record?.happenedAt instanceof Date)
    for (const created of [
        await client.contact.entry.create({
            data,
            fetchOptions: {
                onSuccess: ({ data: result }) => {
                    assert.equal(result.record.text, iso)
                    assert(result.record.happenedAt instanceof Date)
                    callbacks++
                },
            },
        }),
        await client.contact.create({ model: 'entry', data }),
    ]) {
        assert.equal(created.error, null)
        const record = created.data?.record
        assert(record)
        assert.equal(record.text, iso)
        assert.deepEqual(record.labels, [iso])
        assert.deepEqual(record.payload, data.payload)
        assert.deepEqual(record.serialized, data.serialized)
        assert(record.happenedAt instanceof Date)
        assert(record.encodedDate instanceof Date)
        assert.equal(record.encodedBoolean, true)
        assert.equal(record.happenedAt.toISOString(), iso)
        assert(record.createdAt instanceof Date)
        assert.equal(record.encoded, '4')
        assert(!('hidden' in record))
        for (const read of [
            await client.contact.entry.read({ id: record.id }),
            await client.contact.read({ model: 'entry', id: record.id }),
        ]) {
            assert.equal(read.data?.record.text, iso)
            assert.deepEqual(read.data?.record.payload, data.payload)
            assert(read.data?.record.happenedAt instanceof Date)
        }
    }
    for (const listed of [await client.contact.entry.list({}), await client.contact.list({ model: 'entry' })]) {
        assert.equal(listed.error, null)
        assert.equal(listed.data?.records.length, 3)
        for (const record of listed.data.records) {
            assert.equal(record.text, iso)
            assert.deepEqual(record.payload, data.payload)
            assert(record.happenedAt instanceof Date)
        }
    }
    assert.equal(callbacks, 1)
    assert.deepEqual(
        seen,
        Array.from({ length: 3 }, () => ({ change: 3, encoded: 4, hidden: 'private' })),
    )
}
