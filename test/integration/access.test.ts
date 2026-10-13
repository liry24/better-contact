/* oxlint-disable no-await-in-loop -- Compare explicit false and accidental undefined denial across the same protected record. */
import { expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { setup } from '../utils'

it('validates updates before record lookup across entry points and authorizes normalized changes once', async () => {
    let allowed = false
    const normalize = vi.fn<(value: string) => string>((value) => value.trim())
    const onUpdate = vi.fn<() => number>(() => 7)
    const update = vi.fn<(context: { changes: unknown }) => boolean>(() => allowed)
    const before = vi.fn<() => void>()
    const app = await setup({
        limits: { maxBytes: 128 },
        models: {
            feedback: {
                idempotency: false,
                fields: {
                    message: { type: 'string', validator: { input: z.string().min(2).transform(normalize) } },
                    score: { type: 'number', required: false },
                    managed: { type: 'number', input: false, defaultValue: 0, onUpdate },
                },
                states: { received: { default: true } },
                access: { create: () => true, update },
                hooks: { update: { before } },
            },
        },
    })
    try {
        const saved = await app.auth.api.createContact({ body: { model: 'feedback', data: { message: 'saved' } } })
        const invalid = [
            { data: { unknown: 'x' }, code: 'CONTACT_FIELDS' },
            { data: { managed: 1 }, code: 'CONTACT_FIELDS' },
            { data: { score: 'wrong' }, code: 'CONTACT_FIELDS' },
            { data: { message: '' }, code: 'CONTACT_VALIDATION' },
            { data: { message: 'x'.repeat(128) }, code: 'CONTACT_SIZE' },
        ]
        for (const id of [saved.id, 'missing-id']) {
            for (const { data, code } of invalid) {
                const body = { model: 'feedback' as const, id, revision: 0, data }
                await expect(app.auth.api.updateContact({ body } as any)).rejects.toMatchObject({ body: { code } })
                await expect(
                    app.auth.api.feedbackUpdateContact({ body: { id, revision: 0, data } } as any),
                ).rejects.toMatchObject({ body: { code } })
                for (const [path, input] of [
                    ['update', body],
                    ['feedback/update', { id, revision: 0, data }],
                ] as const) {
                    const response = await app.request(path, input)
                    expect(response.status).toBe(400)
                    expect(await response.json()).toMatchObject({ code })
                }
                expect(
                    await app.auth.api.bulkContacts({ body: { items: [{ ...body, operation: 'update' }] } } as any),
                ).toEqual({ results: [{ status: 'failed', code }] })
            }
            // Maintenance accepts managed fields but still validates every other malformed update.
            for (const { data, code } of invalid.filter((item) => !Object.hasOwn(item.data, 'managed')))
                await expect(
                    app.auth.api.maintainContact({
                        body: { model: 'feedback', id, revision: 0, data, operation: 'update' },
                    } as any),
                ).rejects.toMatchObject({ body: { code } })
        }
        expect(update).not.toHaveBeenCalled()
        for (const id of [saved.id, 'missing-id'])
            await expect(
                app.auth.api.updateContact({
                    body: { model: 'feedback', id, revision: 0, data: { message: 'valid' } },
                }),
            ).rejects.toMatchObject({ body: { code: 'CONTACT_NOT_FOUND' } })
        expect(before).not.toHaveBeenCalled()
        expect(app.database.prepare('SELECT message,managed,revision FROM contact_feedback').all()).toEqual([
            { message: 'saved', managed: 0, revision: 0 },
        ])
        allowed = true
        normalize.mockClear()
        onUpdate.mockClear()
        update.mockClear()
        const result = await app.auth.api.updateContact({
            body: { model: 'feedback', id: saved.id, revision: 0, data: { message: ' next ' } },
        })
        expect(result.record).toMatchObject({ message: 'next', managed: 7, revision: 1 })
        expect(update).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ changes: { message: 'next', managed: 7 } }),
        )
        expect(normalize).toHaveBeenCalledTimes(1)
        expect(onUpdate).toHaveBeenCalledTimes(1)
        expect(before).toHaveBeenCalledTimes(1)
    } finally {
        app.close()
    }
})

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
