import { createAuthClient } from 'better-auth/client'
import { expect, it } from 'vite-plus/test'
import * as z from 'zod'

import { contactClient } from '../../packages/better-contact/src/client'
import { setup } from '../utils'

it('shares authorization, validation, scoping and hooks across native model and generic client/server routes', async () => {
    const events: string[] = []
    const errors: (string | null)[] = []
    const app = await setup({
        models: {
            feedback: {
                idempotency: false,
                fields: { message: { type: 'string' }, priority: { type: 'number', input: false, defaultValue: 0 } },
                states: { received: { default: true }, reviewed: {} },
                list: { count: true },
                operations: {
                    create: {
                        authorize: () => true,
                        after: () => {
                            events.push('create')
                        },
                    },
                    read: {
                        authorize: ({ session }) => !!session,
                        before: () => {
                            events.push('read.before')
                        },
                        after: () => {
                            events.push('read.after')
                        },
                    },
                    list: {
                        authorize: ({ session }) =>
                            session ? { where: [{ field: 'state', value: 'received' }] } : false,
                        after: () => {
                            throw new Error('observer')
                        },
                    },
                    update: { authorize: ({ session }) => !!session },
                    transition: { authorize: () => false },
                    delete: { authorize: ({ session }) => !!session },
                },
            },
            abuse_report: {
                idempotency: false,
                fields: { target: { type: 'string' } },
                states: { submitted: { default: true }, verified: {} },
                operations: {
                    create: { authorize: ({ session, changes }) => !!session && changes.target === 'verified-target' },
                },
            },
        },
        onHookError: ({ id }) => {
            errors.push(id)
        },
    })
    try {
        const requests: { path: string; method: string }[] = []
        const makeClient = (headers = new Headers()) =>
            createAuthClient({
                baseURL: 'http://localhost:3000',
                plugins: [contactClient<typeof app.auth>()],
                fetchOptions: {
                    headers,
                    customFetchImpl: async (input, init) => {
                        const request = new Request(input, init)
                        requests.push({ path: new URL(request.url).pathname, method: request.method })
                        return app.auth.handler(request)
                    },
                },
            })
        const client = makeClient()
        const fixed = await client.contact.feedback.create({ data: { message: 'fixed' } })
        const generic = await client.contact.create({ model: 'feedback', data: { message: 'generic' } })
        expect(fixed.error).toBeNull()
        expect(generic.error).toBeNull()
        const id = fixed.data!.id
        expect((await client.contact.feedback.read({ id })).error?.status).toBe(404)
        expect((await client.contact.read({ model: 'feedback', id })).error?.status).toBe(404)
        expect((await client.contact.feedback.list({})).error?.status).toBe(403)
        expect((await client.contact.list({ model: 'feedback' })).error?.status).toBe(403)
        expect((await client.contact.abuseReport.create({ data: { target: 'verified-target' } })).error?.status).toBe(
            403,
        )
        const staff = await app.user()
        const reviewer = makeClient(staff.headers)
        expect((await reviewer.contact.abuseReport.create({ data: { target: 'bad-target' } })).error?.status).toBe(403)
        expect(
            (await reviewer.contact.create({ model: 'abuse_report', data: { target: 'verified-target' } })).error,
        ).toBeNull()
        expect((await reviewer.contact.abuseReport.create({ data: { target: 'verified-target' } })).error).toBeNull()
        expect((await reviewer.contact.feedback.read({ id })).data?.record.message).toBe('fixed')
        expect(events.slice(-2)).toEqual(['read.before', 'read.after'])
        const page = await reviewer.contact.feedback.list({})
        expect(page.error).toBeNull()
        expect(page.data?.records).toHaveLength(2)
        expect(page.data?.hooks).toEqual({ status: 'failed', failed: ['list.after'] })
        expect(errors).toContain(null)
        expect((await reviewer.contact.list({ model: 'feedback', count: true })).data?.count).toBe(2)
        expect((await reviewer.contact.feedback.transition({ id, revision: 0, state: 'reviewed' })).error?.status).toBe(
            404,
        )
        expect(
            (await reviewer.contact.transition({ model: 'feedback', id, revision: 0, state: 'reviewed' })).error
                ?.status,
        ).toBe(404)
        await expect(
            app.auth.api.feedbackTransitionContact({
                headers: staff.headers,
                body: { id, revision: 0, state: 'reviewed' },
            }),
        ).rejects.toThrow('unavailable')
        expect(
            (await app.request('feedback/update', { id, revision: 0, data: { state: 'reviewed' } }, staff.headers))
                .status,
        ).toBe(400)
        expect(
            (await app.request('feedback/create', { model: 'abuse_report', data: { message: 'spoof' } })).status,
        ).toBe(400)
        expect(
            (
                await app.request(
                    'feedback/bulk',
                    { items: [{ model: 'abuse_report', id, revision: 0, operation: 'delete' }] },
                    staff.headers,
                )
            ).status,
        ).toBe(400)
        for (const data of [{ userId: staff.id }, { state: 'reviewed' }, { priority: 9 }])
            expect((await app.request('feedback/create', { data: { message: 'spoof', ...data } })).status).toBe(400)
        const bulk = await reviewer.contact.feedback.bulk({
            items: [{ operation: 'transition', id, revision: 0, state: 'reviewed' }],
        })
        expect(bulk.data?.results).toEqual([{ status: 'failed', code: 'CONTACT_NOT_FOUND' }])
        expect(
            (
                await reviewer.contact.bulk({
                    items: [{ operation: 'transition', model: 'feedback', id, revision: 0, state: 'reviewed' }],
                })
            ).data?.results,
        ).toEqual(bulk.data?.results)
        const saved = await reviewer.contact.feedback.update({ id, revision: 0, data: { message: 'updated' } })
        expect(saved.data?.record?.message).toBe('updated')
        await app.auth.api.maintainContact({
            body: { operation: 'transition', model: 'feedback', id, revision: 1, state: 'reviewed' },
        })
        expect((await reviewer.contact.feedback.list({ count: true })).data?.count).toBe(1)
        expect(
            (await app.request('feedback/maintain', { id, revision: 2, state: 'received' }, staff.headers)).status,
        ).toBe(404)
        expect((await reviewer.contact.feedback.delete({ id, revision: 2 })).data?.deleted).toBe(true)
        expect(requests.filter(({ path }) => path.includes('/contact/')).every(({ method }) => method === 'POST')).toBe(
            true,
        )
        expect(requests.some(({ path }) => path.endsWith('/contact/abuse-report/create'))).toBe(true)
    } finally {
        app.close()
    }
})

it('keeps saved identities and receipts when actual output Dates exceed metadata bounds', async () => {
    const app = await setup({
        models: {
            feedback: {
                fields: {
                    message: {
                        type: 'string',
                        validator: {
                            output: z
                                .string()
                                .transform(() => Array.from({ length: 200 }, () => new Date('2026-01-01'))),
                        },
                    },
                },
                states: { received: { default: true } },
                idempotency: { anonymousScope: () => 'verified-visitor' },
                operations: {
                    create: { authorize: () => true },
                    read: { authorize: () => true },
                    update: { authorize: () => true },
                },
            },
        },
    })
    try {
        const client = createAuthClient({
            baseURL: 'http://localhost:3000',
            plugins: [contactClient<typeof app.auth>()],
            fetchOptions: { customFetchImpl: (input, init) => app.auth.handler(new Request(input, init)) },
        })
        const body = { model: 'feedback' as const, data: { message: 'stored' }, idempotencyKey: crypto.randomUUID() }
        const first = await client.contact.create(body)
        expect(first.error).toBeNull()
        expect(first.data).toMatchObject({
            accepted: true,
            replayed: false,
            output: 'failed',
            record: null,
            revision: 0,
        })
        expect(app.database.prepare('SELECT count(*) AS n FROM contact_feedback').get()?.n).toBe(1)
        expect(
            (await client.contact.feedback.create({ data: body.data, idempotencyKey: body.idempotencyKey })).data,
        ).toEqual({ model: 'feedback', id: first.data!.id, accepted: true, replayed: true })
        expect((await client.contact.feedback.read({ id: first.data!.id })).error).toMatchObject({
            code: 'CONTACT_OUTPUT',
        })
        const changed = await client.contact.feedback.bulk({
            items: [{ operation: 'update', id: first.data!.id, revision: 0, data: { message: 'updated' } }],
        })
        expect(changed.error).toBeNull()
        expect(changed.data?.results[0]).toMatchObject({
            status: 'success',
            result: { id: first.data!.id, revision: 1, record: null, output: 'failed' },
        })
        expect(app.database.prepare('SELECT message,revision FROM contact_feedback').get()).toMatchObject({
            message: 'updated',
            revision: 1,
        })
    } finally {
        app.close()
    }
})
