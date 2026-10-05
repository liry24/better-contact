import { expect, it } from 'vite-plus/test'

import { setup } from '../utils'

it('intersects allowlisted filters/search/count with permission scopes and orders ties with stable cursors', async () => {
    const app = await setup({
        models: {
            report: {
                idempotency: false as const,
                fields: {
                    text: { type: 'string' },
                    category: { type: 'string' },
                    priority: { type: 'number', input: false, defaultValue: 0 },
                    secret: { type: 'string', returned: false, defaultValue: 'hidden' },
                },
                states: { received: { default: true }, done: {} },
                list: {
                    filters: ['state', 'userId', 'category'],
                    orderBy: ['createdAt', 'priority', 'category'],
                    search: ['text'],
                    count: true,
                },
                access: {
                    create: () => true,
                    list: ({ session }) => (session ? { where: [{ field: 'userId', value: session.user.id }] } : false),
                },
            },
        },
    })
    try {
        const owner = await app.user(),
            other = await app.user()
        for (let index = 0; index < 9; index++) {
            const entry = await app.auth.api.createContact({
                headers: index === 8 ? other.headers : owner.headers,
                body: {
                    model: 'report',
                    data: { text: index === 7 ? 'other' : 'needle', category: index < 4 ? '日本語' : 'ไทย' },
                },
            })
            app.database
                .prepare('UPDATE contact_report SET createdAt=?,priority=? WHERE id=?')
                .run(new Date(index < 5 ? 1000 : 2000).toISOString(), index % 3, entry.id)
        }
        const query = {
            model: 'report' as const,
            limit: 2,
            count: true,
            search: { field: 'text', term: 'needle' },
            filters: [{ field: 'state', value: 'received' }],
        }
        for (const field of ['createdAt', 'priority', 'category'])
            for (const direction of ['asc', 'desc'] as const) {
                const received: string[] = []
                let cursor: string | undefined
                do {
                    const page = await app.auth.api.listContacts({
                        headers: owner.headers,
                        body: { ...query, orderBy: { field, direction }, ...(cursor ? { cursor } : {}) },
                    })
                    expect(page.count).toBe(7)
                    received.push(...page.records.map((record) => record.id))
                    expect(page.records.every((record) => !('secret' in record))).toBe(true)
                    cursor = page.nextCursor ?? undefined
                } while (cursor)
                const expected = app.database
                    .prepare(
                        `SELECT id FROM contact_report WHERE userId=? AND text='needle' ORDER BY ${field} ${direction},id ${direction}`,
                    )
                    .all(owner.id)
                    .map((row) => row.id)
                expect(received).toEqual(expected)
                expect(new Set(received).size).toBe(7)
            }
        const first = await app.auth.api.listContacts({
            headers: owner.headers,
            body: { ...query, orderBy: { field: 'createdAt', direction: 'desc' } },
        })
        for (const headers of [other.headers, new Headers()]) {
            const response = await app.request(
                'list',
                { ...query, cursor: first.nextCursor, orderBy: { field: 'createdAt', direction: 'desc' } },
                headers,
            )
            expect(response.status).toBe(headers === other.headers ? 400 : 403)
        }
        expect(
            (
                await app.request(
                    'list',
                    { ...query, cursor: first.nextCursor, orderBy: { field: 'priority', direction: 'desc' } },
                    owner.headers,
                )
            ).status,
        ).toBe(400)
        const hidden = await app.auth.api.listContacts({
            headers: owner.headers,
            body: { model: 'report', count: true, filters: [{ field: 'userId', value: other.id }] },
        })
        expect(hidden).toMatchObject({ records: [], count: 0, nextCursor: null })
        for (const body of [
            { ...query, filters: [{ field: 'secret', value: 'hidden' }] },
            { ...query, search: { field: 'secret', term: 'hidden' } },
            { ...query, search: { field: 'text', term: '%' } },
            { ...query, orderBy: { field: 'secret', direction: 'asc' } },
            { ...query, filters: [{ field: 'userId', value: other.id, connector: 'OR' }] },
        ])
            expect((await app.request('list', body, owner.headers)).status).toBe(400)
    } finally {
        app.close()
    }
})

it('keeps query capabilities opt-in and rejects unsafe configured fields', async () => {
    const app = await setup({
        models: {
            feedback: {
                idempotency: false as const,
                fields: { text: { type: 'string' } },
                states: { received: { default: true } },
                access: { list: () => ({ where: [] }) },
            },
        },
    })
    try {
        for (const body of [
            { count: true },
            { filters: [{ field: 'state', value: 'received' }] },
            { orderBy: { field: 'createdAt', direction: 'desc' } },
            { search: { field: 'text', term: 'x' } },
        ])
            expect((await app.request('list', { model: 'feedback', ...body })).status).toBe(400)
    } finally {
        app.close()
    }
})
