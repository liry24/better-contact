import * as v from 'valibot'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import type { HookContext, ContactModels } from '../../packages/better-contact/src/index'
import { setup } from '../utils'

const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0)) close()
})
const states = { received: { default: true }, reviewed: {}, custom_done: {} } as const
const allow = () => true

it('persists real native columns and async validators, defaults, mappings and transforms exactly once', async () => {
    const input = vi.fn<(value: unknown) => string>((value) => `stored:${String(value)}`)
    const output = vi.fn<(value: unknown) => string>((value) => String(value).replace(/^stored:/u, ''))
    const generated = vi.fn<() => string>(() => 'generated')
    const validation = vi.fn<(value: unknown) => Promise<{ value: number }>>(async (value) => ({
        value: Number(value),
    }))
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                states,
                fields: {
                    text: {
                        type: 'string',
                        fieldName: 'message_text',
                        transform: { input, output },
                        validator: { input: v.pipe(v.string(), v.trim(), v.minLength(2)) },
                    },
                    rating: {
                        idempotency: false as const,
                        type: 'number',
                        validator: { input: { '~standard': { version: 1, vendor: 'test', validate: validation } } },
                    },
                    enabled: { type: 'boolean', defaultValue: false },
                    token: { type: 'string', input: false, returned: false, defaultValue: generated },
                    priority: { type: 'number', input: false, defaultValue: 0 },
                    optional: { type: 'string', required: false },
                    schemaDefault: { type: 'string', validator: { input: z.string().default('schema') } },
                    date: { type: 'date', required: false },
                },
                access: {
                    create: allow,
                    read: allow,
                    update: allow,
                },
            },
        },
    })
    cleanups.push(app.close)
    const result = await app.auth.api.createContact({
        body: { model: 'feedback', data: { text: ' hi ', rating: '3', date: new Date('2026-01-01') } },
    })
    expect(result).toMatchObject({
        model: 'feedback',
        output: 'ok',
        record: {
            text: 'hi',
            rating: 3,
            state: 'received',
            revision: 0,
            enabled: false,
            priority: 0,
            schemaDefault: 'schema',
        },
    })
    expect(result.record).not.toHaveProperty('token')
    expect(generated).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenCalledTimes(1)
    expect(validation).toHaveBeenCalledTimes(1)
    expect(app.database.prepare('SELECT message_text, rating, token FROM contact_feedback').get()).toMatchObject({
        message_text: 'stored:hi',
        rating: 3,
        token: 'generated',
    })
    expect(
        app.database
            .prepare('PRAGMA table_info(contact_feedback)')
            .all()
            .map((row) => row.name),
    ).not.toContain('data')
    const id = result.record!.id
    await app.auth.api.readContact({ body: { model: 'feedback', id } })
    expect(validation).toHaveBeenCalledTimes(1)
    await expect(
        app.auth.api.createContact({ body: { model: 'feedback', data: { text: 'x', rating: '3' } } }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_VALIDATION' } })
    for (const spoof of [
        { state: 'reviewed' },
        { userId: 'fake' },
        { createdAt: new Date() },
        { revision: 9 },
        { priority: 10 },
        { token: 'x' },
        { role: 'admin' },
        { bypass: true },
    ]) {
        await expect(
            app.auth.api.createContact({
                body: { model: 'feedback', data: { text: 'hi', rating: '3', ...spoof } } as any,
            }),
        ).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    }
    await expect(
        app.auth.api.updateContact({
            body: { model: 'feedback', id, revision: 0, data: { state: 'reviewed' } } as any,
        }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    await expect(
        app.auth.api.updateContact({ body: { model: 'feedback', id, revision: 0, data: { priority: 1 } } as any }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_FIELDS' } })
    const managed = await app.auth.api.maintainContact({
        body: { operation: 'update', model: 'feedback', id, revision: 0, data: { priority: 1 } },
    })
    expect(managed).toMatchObject({ record: { priority: 1, revision: 1 } })
    for (const path of ['maintain', 'maintain-contact', 'maintainContact'])
        expect((await app.request(path, { operation: 'delete', model: 'feedback', id, revision: 1 })).status).toBe(404)
})

it('uses authoritative sessions and per-operation policies for HTTP and direct API; no implicit own history', async () => {
    const staff = new Set<string>()
    const targets = new Map([['post-1', 'owner-1']])
    const isStaff = ({ session }: HookContext | { session: { user: { id: string } } | null }) =>
        !!session && staff.has(session.user.id)
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                states,
                fields: { text: { type: 'string' } },
                access: {
                    create: allow,
                },
            },
            report: {
                idempotency: false as const,
                states,
                fields: { targetId: { type: 'string' }, reason: { type: 'string' } },
                access: {
                    create: ({ session, changes }) => !!session && targets.get(String(changes.targetId)) === 'owner-1',
                    read: isStaff,
                    list: (ctx) => (isStaff(ctx) ? { where: [] } : false),
                    update: isStaff,
                    transition: () => false,
                },
            },
        },
    })
    cleanups.push(app.close)
    expect((await app.request('create', { model: 'feedback', data: { text: 'Anonymous' } })).status).toBe(200)
    const submitter = await app.user()
    const reader = await app.user()
    staff.add(reader.id)
    const body = { model: 'report' as const, data: { targetId: 'post-1', reason: 'Abuse' } }
    await expect(app.auth.api.createContact({ body })).rejects.toMatchObject({ body: { code: 'CONTACT_FORBIDDEN' } })
    expect((await app.request('create', body)).status).toBe(403)
    expect(
        (await app.request('create', { ...body, data: { ...body.data, targetId: 'missing' } }, submitter.headers))
            .status,
    ).toBe(403)
    const response = await app.request('create', body, submitter.headers)
    expect(response.status).toBe(200)
    const created = (await response.json()) as { record: { id: string; userId: string } }
    expect(created.record.userId).toBe(submitter.id)
    const target = { model: 'report' as const, id: created.record.id }
    await expect(app.auth.api.readContact({ body: target, headers: submitter.headers })).rejects.toMatchObject({
        body: { code: 'CONTACT_NOT_FOUND' },
    })
    await expect(
        app.auth.api.listContacts({ body: { model: 'report' }, headers: submitter.headers }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_FORBIDDEN' } })
    expect((await app.auth.api.readContact({ body: target, headers: reader.headers })).record?.id).toBe(target.id)
    await expect(
        app.auth.api.transitionContact({
            body: { ...target, revision: 0, state: 'reviewed' },
            headers: reader.headers,
        }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_NOT_FOUND' } })
    expect(
        (await app.request('transition', { ...target, revision: 0, state: 'reviewed' }, reader.headers)).status,
    ).toBe(404)
    expect(
        (
            await app.auth.api.bulkContacts({
                headers: reader.headers,
                body: {
                    items: [
                        { ...target, operation: 'transition', revision: 0, state: 'reviewed' },
                        { ...target, operation: 'update', revision: 0, data: { state: 'reviewed' } },
                    ] as any,
                },
            })
        ).results.map((row) => row.status),
    ).toEqual(['failed', 'failed'])
    await expect(
        app.auth.api.deleteContact({ body: { ...target, revision: 0 }, headers: reader.headers }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_NOT_FOUND' } })
    await app.auth.api.signOut({ headers: reader.headers })
    await expect(app.auth.api.readContact({ body: target, headers: reader.headers })).rejects.toMatchObject({
        body: { code: 'CONTACT_NOT_FOUND' },
    })
})

it('orders custom state hooks, rejects before persistence, skips no-ops and reports after failures as saved', async () => {
    const calls: string[] = []
    const hook = (name: string) => () => {
        calls.push(name)
    }
    const app = await setup({
        models: {
            inquiry: {
                idempotency: false as const,
                fields: { text: { type: 'string' } },
                states: {
                    received: {
                        default: true,
                        hooks: {
                            beforeEnter: hook('initial-before'),
                            afterEnter: hook('initial-after'),
                            beforeLeave: hook('leave-before'),
                            afterLeave: hook('leave-after'),
                        },
                    },
                    triaged: {
                        hooks: {
                            beforeEnter: hook('enter-before'),
                            afterEnter: () => {
                                calls.push('enter-after')
                                throw new Error('notification failed')
                            },
                        },
                    },
                    blocked: {
                        hooks: {
                            beforeEnter: () => {
                                throw new Error('rejected')
                            },
                        },
                    },
                },
                access: {
                    create: allow,
                    transition: allow,
                    read: allow,
                },
                hooks: {
                    create: { before: hook('create-before'), after: hook('create-after') },
                    transition: { before: hook('transition-before'), after: hook('transition-after') },
                },
            },
        },
    })
    cleanups.push(app.close)
    const first = await app.auth.api.createContact({ body: { model: 'inquiry', data: { text: 'Hello' } } })
    const target = { model: 'inquiry' as const, id: first.record!.id }
    expect(calls.splice(0)).toEqual(['create-before', 'initial-before', 'create-after', 'initial-after'])
    expect(await app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'received' } })).toMatchObject(
        { changed: false },
    )
    expect(calls).toEqual([])
    await expect(
        app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'unknown' } } as any),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_STATE' } })
    await expect(
        app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'blocked' } }),
    ).rejects.toThrow('rejected')
    expect((await app.auth.api.readContact({ body: target })).record?.revision).toBe(0)
    calls.splice(0)
    const moved = await app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'triaged' } })
    expect(calls).toEqual([
        'transition-before',
        'leave-before',
        'enter-before',
        'leave-after',
        'enter-after',
        'transition-after',
    ])
    expect(moved).toMatchObject({
        record: { state: 'triaged', revision: 1 },
        hooks: { status: 'failed', failed: ['afterEnter'] },
    })
    expect(app.database.prepare('SELECT state,revision FROM contact_inquiry').get()).toMatchObject({
        state: 'triaged',
        revision: 1,
    })
    await expect(
        app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'received' } }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_CONFLICT' } })
})

it('CAS makes concurrent transitions have exactly one winner and one after hook', async () => {
    let entered = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
        release = resolve
    })
    const after = vi.fn<() => void>()
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                states,
                fields: { text: { type: 'string' } },
                access: {
                    create: allow,
                    transition: allow,
                },
                hooks: {
                    transition: {
                        before: async () => {
                            entered++
                            if (entered === 2) release()
                            await barrier
                        },
                        after: after,
                    },
                },
            },
        },
    })
    cleanups.push(app.close)
    const initial = await app.auth.api.createContact({ body: { model: 'feedback', data: { text: 'x' } } })
    const body = { model: 'feedback' as const, id: initial.record!.id, revision: 0, state: 'reviewed' as const }
    const results = await Promise.allSettled([
        app.auth.api.transitionContact({ body }),
        app.auth.api.transitionContact({ body }),
    ])
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1)
    expect(after).toHaveBeenCalledTimes(1)
})

it('scopes before pagination, isolates owners and rejects unsupported scopes and overlarge batches', async () => {
    let unsafe = false
    const app = await setup({
        limits: { maxBulk: 2 },
        models: {
            rating: {
                idempotency: false as const,
                states,
                fields: { score: { type: 'number', validator: { input: z.number().int().min(1).max(5) } } },
                access: {
                    create: ({ session }) => !!session,
                    list: ({ session }) =>
                        unsafe
                            ? ({ where: [{ field: 'userId', value: session!.user.id, connector: 'OR' }] } as any)
                            : session
                              ? { where: [{ field: 'userId', value: session.user.id }] }
                              : false,
                },
            },
        },
    })
    cleanups.push(app.close)
    const a = await app.user()
    const b = await app.user()
    const aIds = new Set<string>()
    for (let i = 0; i < 5; i++)
        for (const user of [a, b]) {
            const row = await app.auth.api.createContact({
                headers: user.headers,
                body: { model: 'rating', data: { score: 5 } },
            })
            if (user === a) aIds.add(row.record!.id)
        }
    let cursor: string | undefined
    const found: string[] = []
    do {
        const page = await app.auth.api.listContacts({
            headers: a.headers,
            body: { model: 'rating', limit: 2, ...(cursor ? { cursor } : {}) },
        })
        for (const row of page.records) {
            expect(row.userId).toBe(a.id)
            found.push(row.id)
        }
        cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(found)).toEqual(aIds)
    expect(found).toHaveLength(5)
    unsafe = true
    await expect(app.auth.api.listContacts({ headers: a.headers, body: { model: 'rating' } })).rejects.toMatchObject({
        body: { code: 'CONTACT_SCOPE' },
    })
    expect(
        (
            await app.request(
                'bulk',
                {
                    items: Array.from({ length: 3 }, () => ({
                        model: 'rating',
                        operation: 'delete',
                        id: found[0],
                        revision: 0,
                    })),
                },
                a.headers,
            )
        ).status,
    ).toBe(400)
})

it('guards size/rate, validates defaults/async output and preserves accepted submissions on hook failure', async () => {
    const app = await setup({
        limits: { maxBytes: 100, createsPerMinute: 5 },
        models: {
            feedback: {
                idempotency: false as const,
                states,
                fields: {
                    text: {
                        type: 'string',
                        validator: {
                            input: z.string(),
                            output: z.string().transform(async (value) => value.toUpperCase()),
                        },
                    },
                },
                access: {
                    create: allow,
                },
                hooks: {
                    create: {
                        after: () => {
                            throw new Error('private notification error')
                        },
                    },
                },
            },
        },
    })
    cleanups.push(app.close)
    const body = { model: 'feedback' as const, data: { text: 'hello' } }
    const result = await app.auth.api.createContact({ body })
    expect(result).toMatchObject({ record: { text: 'HELLO' }, hooks: { status: 'failed', failed: ['create.after'] } })
    expect((await app.request('create', body)).status).toBe(200)
    await expect(
        app.auth.api.createContact({ body: { model: 'feedback', data: { text: 'x'.repeat(100) } } }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_SIZE' } })
    await expect(
        app.auth.api.createContact({ body: { model: 'feedback', data: { text: 42 } } } as any),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_VALIDATION' } })
    await app.auth.api.createContact({ body })
    await expect(app.auth.api.createContact({ body })).rejects.toMatchObject({ body: { code: 'CONTACT_RATE_LIMIT' } })
    expect(app.database.prepare('SELECT count(*) AS total FROM contact_feedback').get()?.total).toBe(3)
})

it('bulk returns honest ordered partial results and management never bypasses validation', async () => {
    const models = {
        feedback: {
            idempotency: false as const,
            states,
            fields: { text: { type: 'string' } },
            access: {
                create: allow,
                update: allow,
                delete: allow,
                transition: allow,
            },
        },
    } satisfies ContactModels
    const app = await setup({ models })
    cleanups.push(app.close)
    const created = await app.auth.api.createContact({ body: { model: 'feedback', data: { text: 'one' } } })
    const target = { model: 'feedback' as const, id: created.record!.id }
    const result = await app.auth.api.bulkContacts({
        body: {
            items: [
                { ...target, operation: 'update', revision: 0, data: { text: 'two' } },
                { ...target, operation: 'transition', revision: 0, state: 'reviewed' },
                { ...target, operation: 'delete', revision: 1 },
            ],
        },
    })
    expect(result.results.map((row) => row.status)).toEqual(['success', 'failed', 'success'])
    expect(result.results[1]).toMatchObject({ code: 'CONTACT_CONFLICT' })
    expect(app.database.prepare('SELECT count(*) AS total FROM contact_feedback').get()?.total).toBe(0)
    await expect(
        // @ts-expect-error Runtime callers must also reject unknown states.
        app.auth.api.maintainContact({ body: { ...target, operation: 'transition', revision: 0, state: 'nonsense' } }),
    ).rejects.toMatchObject({ body: { code: 'CONTACT_STATE' } })
})
