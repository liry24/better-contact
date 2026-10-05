/* oxlint-disable no-await-in-loop -- Compare explicit false and accidental undefined denial across the same protected record. */
import { expect, it, vi } from 'vite-plus/test'

import { setup } from '../utils'

it('denies missing, false and undefined access before lifecycle hooks for HTTP and direct calls', async () => {
    const before = vi.fn<() => void>()
    const after = vi.fn<() => void>()
    const lifecycle = { before, after }
    const access = {
        create: () => true,
        read: () => true,
        list: () => ({ where: [] }),
        update: () => true,
        transition: () => true,
        delete: () => true,
    }
    const app = await setup({
        models: {
            feedback: {
                fields: { message: { type: 'string' } },
                states: { received: { default: true } },
                idempotency: { anonymousScope: () => 'verified-test-visitor' },
                access,
                hooks: {
                    create: lifecycle,
                    read: lifecycle,
                    list: lifecycle,
                    update: lifecycle,
                    transition: lifecycle,
                    delete: lifecycle,
                },
            },
            unconfigured: {
                idempotency: false,
                fields: { message: { type: 'string' } },
                states: { received: { default: true } },
                hooks: { create: lifecycle, list: lifecycle },
            },
        },
    })
    try {
        const body = { model: 'feedback' as const, data: { message: 'saved' }, idempotencyKey: crypto.randomUUID() }
        const saved = await app.auth.api.createContact({ body })
        before.mockClear()
        after.mockClear()
        const target = { model: 'feedback' as const, id: saved.id }
        for (const denial of [false, undefined]) {
            // Exercise a JavaScript callback with a bad return without relaxing the public TypeScript contract.
            Object.assign(access, Object.fromEntries(Object.keys(access).map((operation) => [operation, () => denial])))
            await expect(app.auth.api.createContact({ body })).rejects.toMatchObject({
                body: { code: 'CONTACT_FORBIDDEN' },
            })
            expect(
                (await app.request('feedback/create', { data: body.data, idempotencyKey: crypto.randomUUID() })).status,
            ).toBe(403)
            await expect(app.auth.api.listContacts({ body: { model: 'feedback', count: true } })).rejects.toMatchObject(
                { body: { code: 'CONTACT_FORBIDDEN' } },
            )
            expect((await app.request('feedback/list', {})).status).toBe(403)
            await expect(app.auth.api.readContact({ body: target })).rejects.toMatchObject({
                body: { code: 'CONTACT_NOT_FOUND' },
            })
            await expect(
                app.auth.api.updateContact({ body: { ...target, revision: 0, data: { message: 'changed' } } }),
            ).rejects.toMatchObject({ body: { code: 'CONTACT_NOT_FOUND' } })
            // No-op transitions still need permission before skipping persistence and hooks.
            await expect(
                app.auth.api.transitionContact({ body: { ...target, revision: 0, state: 'received' } }),
            ).rejects.toMatchObject({ body: { code: 'CONTACT_NOT_FOUND' } })
            await expect(app.auth.api.deleteContact({ body: { ...target, revision: 0 } })).rejects.toMatchObject({
                body: { code: 'CONTACT_NOT_FOUND' },
            })
            expect(
                await app.auth.api.bulkContacts({ body: { items: [{ ...target, revision: 0, operation: 'delete' }] } }),
            ).toEqual({ results: [{ status: 'failed', code: 'CONTACT_NOT_FOUND' }] })
        }
        await expect(
            app.auth.api.unconfiguredCreateContact({ body: { data: { message: 'denied' } } }),
        ).rejects.toMatchObject({ body: { code: 'CONTACT_FORBIDDEN' } })
        expect((await app.request('unconfigured/list', {})).status).toBe(403)
        expect(before).not.toHaveBeenCalled()
        expect(after).not.toHaveBeenCalled()
        expect(app.database.prepare('SELECT message,revision FROM contact_feedback').all()).toEqual([
            { message: 'saved', revision: 0 },
        ])
        expect(app.database.prepare('SELECT count(*) AS n FROM contact_unconfigured').get()?.n).toBe(0)
    } finally {
        app.close()
    }
})
