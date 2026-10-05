import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { setup } from '../utils'

const key = (): string => crypto.randomUUID()
const base = {
    fields: {
        text: {
            type: 'string' as const,
            validator: {
                input: z
                    .string()
                    .trim()
                    .min(1)
                    .refine(async () => true),
            },
        },
    },
    states: { received: { default: true }, done: {} },
    access: { create: () => true },
    idempotency: { replay: () => true },
}

it('does not reserve rejected creations and replays accepted output failures without repeating state hooks', async () => {
    let reject = true
    const afterEnter = vi.fn<() => void>()
    const app = await setup({
        models: {
            report: {
                ...base,
                fields: { text: { type: 'string', validator: { output: z.never() } } },
                states: { received: { default: true, hooks: { afterEnter } } },
                hooks: {
                    beforeCreate: () => {
                        if (reject) throw new Error('application veto')
                    },
                },
            },
        },
    })
    try {
        const user = await app.user()
        const body = { model: 'report' as const, data: { text: 'accepted' }, idempotencyKey: key() }
        await expect(app.auth.api.createContact({ headers: user.headers, body })).rejects.toThrow('application veto')
        expect(app.database.prepare('SELECT count(*) AS total FROM contact__receipt').get()?.total).toBe(0)
        reject = false
        const first = await app.auth.api.createContact({ headers: user.headers, body })
        const retry = await app.auth.api.createContact({ headers: user.headers, body })
        expect(first).toMatchObject({ record: null, output: 'failed', replayed: false })
        expect(retry).toMatchObject({ id: first.id, record: null, output: 'failed', replayed: true })
        expect(afterEnter).toHaveBeenCalledTimes(1)
    } finally {
        app.close()
    }
})

it('replays normalized creation results without regenerating defaults or exposing later management changes', async () => {
    let allowed = true,
        replayAllowed = true
    const defaultValue = vi.fn<() => string>(() => crypto.randomUUID())
    const transform = vi.fn<(value: unknown) => string>((value: unknown) => `${String(value)}!`)
    const notification = vi.fn<() => void>()
    const hidden = { type: 'string' as const, defaultValue: 'visible-at-creation', returned: true }
    const app = await setup({
        models: {
            report: {
                ...base,
                fields: {
                    ...base.fields,
                    generated: { type: 'string', input: false, defaultValue },
                    secret: { type: 'string', returned: false, defaultValue: 'never returned' },
                    changeable: hidden,
                    encoded: {
                        type: 'string',
                        transform: { input: transform, output: (value: unknown) => String(value).slice(0, -1) },
                    },
                },
                idempotency: { replay: () => replayAllowed },
                access: { create: ({ session }) => allowed && !!session },
                hooks: { afterCreate: notification },
            },
        },
    })
    try {
        const user = await app.user()
        const body = { model: 'report' as const, data: { text: '  hello  ', encoded: 'once' }, idempotencyKey: key() }
        const first = await app.auth.api.createContact({ headers: user.headers, body })
        expect(first.replayed).toBe(false)
        await app.auth.api.maintainContact({
            body: {
                operation: 'update',
                model: 'report',
                id: first.id,
                revision: 0,
                data: { text: 'staff-only later change' },
            },
        })
        const replay = await app.auth.api.createContact({
            headers: user.headers,
            body: { ...body, data: { encoded: 'once', text: 'hello' } },
        })
        expect(replay).toMatchObject({ ...first, changed: false, replayed: true })
        expect(replay.record?.createdAt).toBeInstanceOf(Date)
        expect(defaultValue).toHaveBeenCalledTimes(1)
        expect(transform).toHaveBeenCalledTimes(1)
        expect(notification).toHaveBeenCalledTimes(1)
        expect(replay.record).not.toHaveProperty('secret')
        expect((await app.request('read', { model: 'report', id: first.id }, user.headers)).status).toBe(404)
        expect((await app.request('list', { model: 'report' }, user.headers)).status).toBe(403)
        expect(
            (await app.request('create', { ...body, data: { text: 'changed', encoded: 'once' } }, user.headers)).status,
        ).toBe(409)
        replayAllowed = false
        expect((await app.request('create', body, user.headers)).status).toBe(404)
        replayAllowed = true
        allowed = false
        expect((await app.request('create', body, user.headers)).status).toBe(403)
        allowed = true
        hidden.returned = false
        expect((await app.auth.api.createContact({ headers: user.headers, body })).record).not.toHaveProperty(
            'changeable',
        )
        expect(app.database.prepare('SELECT count(*) AS total FROM contact_report').get()?.total).toBe(1)
    } finally {
        app.close()
    }
})

it('binds keys to model and authoritative actors, requiring an explicit trusted anonymous identity', async () => {
    const proofA = key(),
        proofB = key()
    const proofs = new Map([
        [proofA, 'visitor-a'],
        [proofB, 'visitor-b'],
    ])
    const app = await setup({
        models: {
            feedback: {
                ...base,
                idempotency: {
                    replay: () => true,
                    anonymousScope: ({ headers }) => proofs.get(headers.get('x-verified-test-proof') ?? '') ?? null,
                },
            },
            report: base,
            other: base,
        },
    })
    try {
        const user = await app.user(),
            other = await app.user()
        const idempotencyKey = key()
        const body = { model: 'report' as const, data: { text: 'same' }, idempotencyKey }
        const first = await app.auth.api.createContact({ headers: user.headers, body })
        const second = await app.auth.api.createContact({ headers: other.headers, body })
        const anotherModel = await app.auth.api.createContact({
            headers: user.headers,
            body: { ...body, model: 'other' },
        })
        expect(new Set([first.id, second.id, anotherModel.id]).size).toBe(3)
        expect((await app.request('create', body)).status).toBe(403)
        expect((await app.request('create', { ...body, model: 'feedback' })).status).toBe(403)
        const headersA = new Headers({ 'x-verified-test-proof': proofA }),
            headersB = new Headers({ 'x-verified-test-proof': proofB })
        const anonymousBody = { ...body, model: 'feedback' as const }
        const anonymous = await app.auth.api.createContact({ headers: headersA, body: anonymousBody })
        expect((await app.auth.api.createContact({ headers: headersA, body: anonymousBody })).id).toBe(anonymous.id)
        expect((await app.auth.api.createContact({ headers: headersB, body: anonymousBody })).id).not.toBe(anonymous.id)
        for (const bad of [
            { ...body, scope: user.id },
            { ...body, userId: user.id },
            { ...body, idempotencyKey: 'short' },
            { model: 'report', data: { text: 'same' } },
        ])
            expect((await app.request('create', bad, user.headers)).status).toBe(400)
        proofs.delete(proofA)
        expect((await app.request('create', anonymousBody, headersA)).status).toBe(403)
    } finally {
        app.close()
    }
})

it('commits row and receipt together, rolls back a receipt failure, and handles a lost commit acknowledgement', async () => {
    const hook = vi.fn<() => void>()
    const app = await setup({ models: { report: { ...base, hooks: { afterCreate: hook } } } })
    try {
        const user = await app.user()
        const body = { model: 'report' as const, data: { text: 'atomic' }, idempotencyKey: key() }
        app.database.exec(
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON contact__receipt BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
        )
        await expect(app.auth.api.createContact({ headers: user.headers, body })).rejects.toThrow(/receipt failure/u)
        expect(app.database.prepare('SELECT count(*) AS total FROM contact_report').get()?.total).toBe(0)
        expect(app.database.prepare('SELECT count(*) AS total FROM contact__receipt').get()?.total).toBe(0)
        expect(hook).not.toHaveBeenCalled()
        app.database.exec('DROP TRIGGER fail_receipt')
        const adapter = (await app.auth.$context).adapter
        const transaction = adapter.transaction.bind(adapter)
        adapter.transaction = async (callback) => {
            await transaction(callback)
            throw new Error('commit acknowledgement lost')
        }
        const accepted = await app.auth.api.createContact({ headers: user.headers, body })
        expect(accepted).toMatchObject({ replayed: true, hooks: { status: 'unknown' }, record: { text: 'atomic' } })
        adapter.transaction = transaction
        const retry = await app.auth.api.createContact({ headers: user.headers, body })
        expect(retry.id).toBe(accepted.id)
        expect(hook).not.toHaveBeenCalled()
        expect(app.database.prepare('SELECT count(*) AS total FROM contact_report').get()?.total).toBe(1)
    } finally {
        app.close()
    }
})

it('never repeats after hooks after notification or outcome-persistence failure and refuses unsupported transactions', async () => {
    const hook = vi.fn<() => void>(() => {
        throw new Error('notification offline')
    })
    const app = await setup({ models: { report: { ...base, hooks: { afterCreate: hook } } } })
    try {
        const user = await app.user()
        const body = { model: 'report' as const, data: { text: 'accepted' }, idempotencyKey: key() }
        const accepted = await app.auth.api.createContact({ headers: user.headers, body })
        expect(accepted.hooks).toEqual({ status: 'failed', failed: ['afterCreate'] })
        expect((await app.auth.api.createContact({ headers: user.headers, body })).hooks).toEqual(accepted.hooks)
        expect(hook).toHaveBeenCalledTimes(1)
        app.database.exec(
            "CREATE TRIGGER fail_outcome BEFORE UPDATE ON contact__receipt BEGIN SELECT RAISE(ABORT,'outcome failure'); END",
        )
        const next = { ...body, idempotencyKey: key() }
        expect((await app.auth.api.createContact({ headers: user.headers, body: next })).hooks.status).toBe('failed')
        expect((await app.auth.api.createContact({ headers: user.headers, body: next })).hooks.status).toBe('unknown')
        expect(hook).toHaveBeenCalledTimes(2)
        const adapter = (await app.auth.$context).adapter
        adapter.options!.adapterConfig.transaction = false
        await expect(
            app.auth.api.createContact({ headers: user.headers, body: { ...body, idempotencyKey: key() } }),
        ).rejects.toMatchObject({ body: { code: 'CONTACT_TRANSACTION_REQUIRED' } })
        expect(app.database.prepare('SELECT count(*) AS total FROM contact_report').get()?.total).toBe(2)
    } finally {
        app.close()
    }
})

it('handles independent database connection races, deletion tombstones and bounded key reuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contact-race-'))
    const hook = vi.fn<() => void>()
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const options = {
        models: {
            report: {
                ...base,
                idempotency: { replay: () => true, retentionSeconds: 60 },
                hooks: {
                    beforeCreate: async () => {
                        if (++arrivals === 2) release()
                        await gate
                    },
                    afterCreate: hook,
                },
            },
        },
    }
    const first = await setup(options, join(directory, 'race.sqlite'))
    const second = await setup(options, join(directory, 'race.sqlite'))
    try {
        const user = await first.user()
        const body = { model: 'report' as const, data: { text: 'race' }, idempotencyKey: key() }
        const raced = await Promise.allSettled([
            first.auth.api.createContact({ headers: user.headers, body }),
            second.auth.api.createContact({ headers: user.headers, body }),
        ])
        expect(raced.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
        const accepted = await first.auth.api.createContact({ headers: user.headers, body })
        const retried = await second.auth.api.createContact({ headers: user.headers, body })
        expect(retried.id).toBe(accepted.id)
        expect(hook).toHaveBeenCalledTimes(1)
        expect(first.database.prepare('SELECT count(*) AS total FROM contact_report').get()?.total).toBe(1)
        await first.auth.api.maintainContact({
            body: { operation: 'delete', model: 'report', id: accepted.id, revision: 0 },
        })
        expect((await second.request('create', body, user.headers)).status).toBe(404)
        expect(first.database.prepare('SELECT count(*) AS total FROM contact_report').get()?.total).toBe(0)
        first.database.prepare('UPDATE contact__receipt SET expiresAt=?').run(new Date(0).toISOString())
        const reused = await second.auth.api.createContact({ headers: user.headers, body })
        expect(reused.id).not.toBe(accepted.id)
        expect(reused.replayed).toBe(false)
        expect(hook).toHaveBeenCalledTimes(2)
    } finally {
        first.close()
        second.close()
        await rm(directory, { recursive: true, force: true })
    }
}, 20_000)
