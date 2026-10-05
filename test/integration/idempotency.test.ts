import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { contact } from '../../packages/better-contact/src/index'
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
}
it('protects by default without reserving rejected submissions or repeating hooks after output failures', async () => {
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
                        if (reject) throw new Error('veto')
                    },
                },
            },
        },
    })
    try {
        const user = await app.user(),
            body = { model: 'report' as const, data: { text: 'accepted' }, idempotencyKey: key() }
        await expect(app.auth.api.createContact({ headers: user.headers, body })).rejects.toThrow('veto')
        expect(app.database.prepare('SELECT count(*) AS n FROM contact_report').get()?.n).toBe(0)
        expect(
            app.database.prepare("SELECT name FROM sqlite_master WHERE name='contact__receipt'").get(),
        ).toBeUndefined()
        reject = false
        const first = await app.auth.api.createContact({ headers: user.headers, body })
        expect(first).toMatchObject({ accepted: true, record: null, output: 'failed', replayed: false })
        expect(await app.auth.api.createContact({ headers: user.headers, body })).toEqual({
            model: 'report',
            id: first.id,
            accepted: true,
            replayed: true,
        })
        expect(afterEnter).toHaveBeenCalledTimes(1)
    } finally {
        app.close()
    }
})
it('replays identity only, rechecks policies and never regenerates defaults or reapplies adapter transforms', async () => {
    let allowed = true,
        replayAllowed = true
    const generated = vi.fn<() => string>(() => key()),
        schemaDefault = vi.fn<() => string>(() => key()),
        notification = vi.fn<() => void>()
    const transform = vi.fn<(value: unknown) => string>((value) => `${String(value)}!`)
    const app = await setup({
        models: {
            report: {
                ...base,
                fields: {
                    ...base.fields,
                    generated: { type: 'string', input: false, defaultValue: generated },
                    schemaDefault: { type: 'string', validator: { input: z.string().default(schemaDefault) } },
                    secret: { type: 'string', returned: false, defaultValue: 'hidden' },
                    encoded: {
                        type: 'string',
                        transform: { input: transform, output: (value: unknown) => String(value).slice(0, -1) },
                    },
                },
                access: { create: ({ session }) => allowed && !!session },
                idempotency: { replay: () => replayAllowed },
                hooks: { afterCreate: notification },
            },
        },
    })
    try {
        const user = await app.user(),
            body = { model: 'report' as const, data: { text: ' hello ', encoded: 'once' }, idempotencyKey: key() }
        const first = await app.auth.api.createContact({ headers: user.headers, body })
        if (first.replayed) throw new Error('Expected new submission')
        expect(first.record).not.toHaveProperty('submissionToken')
        expect(first.record).not.toHaveProperty('submissionFingerprint')
        await app.auth.api.maintainContact({
            body: {
                operation: 'update',
                model: 'report',
                id: first.id,
                revision: 0,
                data: { text: 'staff-only change' },
            },
        })
        expect(
            await app.auth.api.createContact({
                headers: user.headers,
                body: { ...body, data: { encoded: 'once', text: 'hello' } },
            }),
        ).toEqual({ model: 'report', id: first.id, accepted: true, replayed: true })
        for (const fn of [generated, schemaDefault, transform, notification]) expect(fn).toHaveBeenCalledTimes(1)
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
    } finally {
        app.close()
    }
})
it('binds keys to model and server-resolved actor, requiring a verified anonymous scope only at use', async () => {
    const proofA = key(),
        proofB = key(),
        proofs = new Map([
            [proofA, 'a'],
            [proofB, 'b'],
        ])
    const app = await setup({
        models: {
            feedback: {
                ...base,
                idempotency: { anonymousScope: ({ headers }) => proofs.get(headers.get('x-test-proof') ?? '') ?? null },
            },
            report: base,
            other: base,
        },
    })
    try {
        const user = await app.user(),
            other = await app.user(),
            body = { model: 'report' as const, data: { text: 'same' }, idempotencyKey: key() }
        const first = await app.auth.api.createContact({ headers: user.headers, body }),
            second = await app.auth.api.createContact({ headers: other.headers, body }),
            another = await app.auth.api.createContact({ headers: user.headers, body: { ...body, model: 'other' } })
        expect(new Set([first.id, second.id, another.id]).size).toBe(3)
        expect((await app.request('create', body)).status).toBe(403)
        const a = new Headers({ 'x-test-proof': proofA }),
            b = new Headers({ 'x-test-proof': proofB }),
            anonymousBody = { ...body, model: 'feedback' as const }
        const anonymous = await app.auth.api.createContact({ headers: a, body: anonymousBody })
        expect((await app.auth.api.createContact({ headers: a, body: anonymousBody })).id).toBe(anonymous.id)
        expect((await app.auth.api.createContact({ headers: b, body: anonymousBody })).id).not.toBe(anonymous.id)
        for (const bad of [
            { ...body, scope: user.id },
            { ...body, userId: user.id },
            { ...body, idempotencyKey: 'short' },
            { model: 'report', data: { text: 'same' } },
            { ...body, data: { text: 'same', submissionToken: 'spoof' } },
            { ...body, data: { text: 'same', submissionFingerprint: 'spoof' } },
        ])
            expect((await app.request('create', bad, user.headers)).status).toBe(400)
        proofs.delete(proofA)
        expect((await app.request('create', anonymousBody, a)).status).toBe(403)
    } finally {
        app.close()
    }
})
it('uses one insert without transactions and recovers only positively verified lost acknowledgements', async () => {
    const hook = vi.fn<() => void>(),
        app = await setup({ models: { report: { ...base, hooks: { afterCreate: hook } } } })
    try {
        const user = await app.user(),
            adapter = (await app.auth.$context).adapter,
            body = { model: 'report' as const, data: { text: 'atomic' }, idempotencyKey: key() }
        const transaction = vi.spyOn(adapter, 'transaction').mockRejectedValue(new Error('unavailable'))
        app.database.exec(
            "CREATE TRIGGER fail_contact BEFORE INSERT ON contact_report BEGIN SELECT RAISE(ABORT,'insert failure'); END",
        )
        await expect(app.auth.api.createContact({ headers: user.headers, body })).rejects.toThrow(/insert failure/u)
        expect(app.database.prepare('SELECT count(*) AS n FROM contact_report').get()?.n).toBe(0)
        app.database.exec('DROP TRIGGER fail_contact')
        const create = adapter.create.bind(adapter)
        const insert = vi.spyOn(adapter, 'create').mockImplementation(async (args) => {
            await create(args)
            throw new Error('ack lost')
        })
        const accepted = await app.auth.api.createContact({ headers: user.headers, body })
        expect(accepted).toEqual({ model: 'report', id: expect.any(String), accepted: true, replayed: true })
        insert.mockRestore()
        expect((await app.auth.api.createContact({ headers: user.headers, body })).id).toBe(accepted.id)
        expect(hook).not.toHaveBeenCalled()
        expect(transaction).not.toHaveBeenCalled()
        const original = new Error('uncertain insert'),
            find = adapter.findOne.bind(adapter)
        let attempted = false
        const read = vi.spyOn(adapter, 'findOne').mockImplementation(async (args) => {
            if (attempted && args.model === 'contact_report') throw new Error('lookup unavailable')
            return find(args)
        })
        const failed = vi.spyOn(adapter, 'create').mockImplementation(async () => {
            attempted = true
            throw original
        })
        await expect(
            app.auth.api.createContact({ headers: user.headers, body: { ...body, idempotencyKey: key() } }),
        ).rejects.toBe(original)
        failed.mockRestore()
        read.mockRestore()
    } finally {
        app.close()
    }
})
it('does not treat unrelated uniqueness errors as success or repeat failed notification hooks', async () => {
    const hook = vi.fn<() => void>(() => {
            throw new Error('offline')
        }),
        app = await setup({
            models: {
                report: { ...base, fields: { text: { type: 'string', unique: true } }, hooks: { afterCreate: hook } },
            },
        })
    try {
        const user = await app.user(),
            body = { model: 'report' as const, data: { text: 'accepted' }, idempotencyKey: key() }
        const accepted = await app.auth.api.createContact({ headers: user.headers, body })
        if (accepted.replayed) throw new Error('Expected new submission')
        expect(accepted.hooks).toEqual({ status: 'failed', failed: ['afterCreate'] })
        const replay = await app.auth.api.createContact({ headers: user.headers, body })
        expect(replay).not.toHaveProperty('hooks')
        expect(replay).not.toHaveProperty('record')
        await expect(
            app.auth.api.createContact({ headers: user.headers, body: { ...body, idempotencyKey: key() } }),
        ).rejects.toThrow(/UNIQUE constraint/iu)
        expect(hook).toHaveBeenCalledTimes(1)
    } finally {
        app.close()
    }
})
it('handles independent connection races and physical deletion ends protection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contact-race-')),
        hook = vi.fn<() => void>()
    let arrivals = 0,
        release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const options = {
        models: {
            report: {
                ...base,
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
    const first = await setup(options, join(directory, 'race.sqlite')),
        second = await setup(options, join(directory, 'race.sqlite'))
    try {
        const user = await first.user(),
            body = { model: 'report' as const, data: { text: 'race' }, idempotencyKey: key() }
        const raced = await Promise.allSettled([
            first.auth.api.createContact({ headers: user.headers, body }),
            second.auth.api.createContact({ headers: user.headers, body }),
        ])
        expect(raced.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
        const accepted = await first.auth.api.createContact({ headers: user.headers, body })
        expect((await second.auth.api.createContact({ headers: user.headers, body })).id).toBe(accepted.id)
        expect(hook).toHaveBeenCalledTimes(1)
        expect(first.database.prepare('SELECT count(*) AS n FROM contact_report').get()?.n).toBe(1)
        await first.auth.api.maintainContact({
            body: { operation: 'delete', model: 'report', id: accepted.id, revision: 0 },
        })
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
it('emits no protection columns or indexes when disabled and rejects unused keys', async () => {
    const definition = { ...base, idempotency: false as const }
    expect(contact({ models: { feedback: definition } }).schema.contact_feedback?.fields).not.toHaveProperty(
        'submissionToken',
    )
    const app = await setup({ models: { feedback: definition } })
    try {
        const body = { model: 'feedback' as const, data: { text: 'same' } },
            first = await app.auth.api.createContact({ body }),
            second = await app.auth.api.createContact({ body })
        expect(first.id).not.toBe(second.id)
        expect(
            JSON.stringify(
                app.database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='contact_feedback'").all(),
            ),
        ).not.toMatch(/submission|fingerprint|receipt/iu)
        expect((await app.request('create', { ...body, idempotencyKey: key() })).status).toBe(400)
    } finally {
        app.close()
    }
})
it('uses versioned canonical content and fails closed on changed normalization', async () => {
    let suffix = ''
    const app = await setup({
        models: {
            report: {
                ...base,
                fields: {
                    text: {
                        type: 'string',
                        validator: { input: z.string().transform((value) => value.trim() + suffix) },
                    },
                    date: { type: 'date' },
                    details: { type: 'json' },
                },
            },
        },
    })
    try {
        const user = await app.user(),
            body = {
                model: 'report' as const,
                data: { text: ' hello ', date: new Date('2026-01-01'), details: { a: 1, b: ['x', false] } },
                idempotencyKey: key(),
            }
        const first = await app.auth.api.createContact({ headers: user.headers, body }),
            reordered = { ...body, data: { ...body.data, details: { b: ['x', false], a: 1 } } }
        expect((await app.auth.api.createContact({ headers: user.headers, body: reordered })).id).toBe(first.id)
        expect((await app.request('create', reordered, user.headers)).status).toBe(200)
        const row = app.database.prepare('SELECT submissionToken,submissionFingerprint FROM contact_report').get()
        expect(row?.submissionToken).toMatch(/^v1:[0-9a-f]{64}$/u)
        expect(row?.submissionFingerprint).toMatch(/^v1:[0-9a-f]{64}$/u)
        suffix = 'changed'
        expect((await app.request('create', body, user.headers)).status).toBe(409)
        suffix = ''
        app.database.prepare('UPDATE contact_report SET submissionFingerprint=?').run('v0:unknown')
        expect((await app.request('create', body, user.headers)).status).toBe(409)
        expect(app.database.prepare('SELECT count(*) AS n FROM contact_report').get()?.n).toBe(1)
    } finally {
        app.close()
    }
})
