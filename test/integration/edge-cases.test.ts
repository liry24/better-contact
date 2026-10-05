import { afterEach, expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { setup } from '../utils'

const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0)) close()
})

it('validates onUpdate once, including transitions, with no factories for same-state transitions', async () => {
    let valid = true
    const onUpdate = vi.fn<() => number>(() => (valid ? 7 : Number.NaN))
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                states: { received: { default: true }, done: {} },
                fields: {
                    text: { type: 'string' },
                    optional: { type: 'string', required: false, validator: { input: z.string().min(2) } },
                    managed: { type: 'number', input: false, defaultValue: 0, onUpdate },
                },
                access: {
                    create: () => true,
                    transition: ({ changes }) => changes.managed === 7 || Object.keys(changes).length === 0,
                    update: () => true,
                },
            },
        },
    })
    cleanups.push(app.close)
    const initial = await app.auth.api.createContact({ body: { model: 'feedback', data: { text: 'hi' } } })
    const target = { model: 'feedback' as const, id: initial.id }
    await app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'received' } })
    expect(onUpdate).not.toHaveBeenCalled()
    const moved = await app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'done' } })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(moved.record).toMatchObject({ managed: 7, revision: 1 })
    valid = false
    await expect(
        app.auth.api.updateContact({ body: { ...target, revision: 1, data: { text: 'new' } } }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    expect(app.database.prepare('SELECT text,revision FROM contact_feedback').get()).toMatchObject({
        text: 'hi',
        revision: 1,
    })
})

it('keeps saved identity on output failures and isolates callback mutation from stored writes', async () => {
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                fields: { text: { type: 'string', validator: { output: z.never() } } },
                states: { received: { default: true } },
                access: {
                    create: (ctx) => {
                        ;(ctx.changes as Record<string, unknown>).text = 'spoof'
                        return true
                    },
                },
                hooks: {
                    create: {
                        before: (ctx) => {
                            ;(ctx.changes as Record<string, unknown>).state = 'injected'
                        },
                        after: () => {
                            throw new Error('notification')
                        },
                    },
                },
            },
        },
    })
    cleanups.push(app.close)
    const response = await app.request('create', { model: 'feedback', data: { text: 'accepted' } })
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toMatchObject({
        id: expect.any(String),
        revision: 0,
        record: null,
        output: 'failed',
        hooks: { status: 'failed' },
    })
    expect(app.database.prepare('SELECT text,state FROM contact_feedback').get()).toMatchObject({
        text: 'accepted',
        state: 'received',
    })
})

it('rejects non-native validator output and lossy JSON before writing; supports explicit native JSON/arrays/enums', async () => {
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                states: { received: { default: true } },
                fields: {
                    value: {
                        type: 'number',
                        validator: {
                            input: z
                                .string()
                                .transform((value) =>
                                    value === 'bad' ? ({ nested: true } as unknown as number) : Number(value),
                                ),
                        },
                    },
                    metadata: { type: 'json', required: false },
                    tags: { type: 'string[]', required: false },
                    kind: { type: ['bug', 'idea'] },
                },
                access: {
                    create: () => true,
                },
            },
        },
    })
    cleanups.push(app.close)
    const send = (data: unknown) => app.auth.api.createContact({ body: { model: 'feedback', data } as any })
    const base = { value: '3', kind: 'idea' }
    const sparse: unknown[] = []
    sparse.length = 2
    for (const metadata of [
        'text',
        '2026-10-05T01:02:03.123Z',
        3,
        true,
        { a: undefined },
        { a: NaN },
        { a: new Date() },
        sparse,
        { [Symbol('x')]: 1 },
    ])
        await expect(send({ ...base, metadata })).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    await expect(send({ ...base, value: 'bad' })).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    await expect(send({ ...base, kind: 'other' })).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    expect(await send({ ...base, tags: ['one'], metadata: { key: 1 } })).toMatchObject({
        record: { value: 3, kind: 'idea', tags: ['one'], metadata: { key: 1 } },
    })
    expect(app.database.prepare('SELECT count(*) AS total FROM contact_feedback').get()?.total).toBe(1)
})

it('runs an application abuse guard on both HTTP and direct calls before persistence', async () => {
    const guard = vi.fn<() => void>(() => {
        throw new Error('application rate limit')
    })
    const app = await setup({
        guard,
        models: {
            feedback: {
                idempotency: false as const,
                states: { received: { default: true } },
                fields: { text: { type: 'string' } },
                access: {
                    create: () => true,
                },
            },
        },
    })
    cleanups.push(app.close)
    const body = { model: 'feedback' as const, data: { text: 'hello' } }
    await expect(app.auth.api.createContact({ body })).rejects.toThrow('application rate limit')
    expect((await app.request('create', body)).status).toBe(500)
    expect(guard).toHaveBeenCalledTimes(2)
    expect(app.database.prepare('SELECT count(*) AS total FROM contact_feedback').get()?.total).toBe(0)
})
