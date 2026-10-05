import { DatabaseSync } from 'node:sqlite'

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { getMigrations } from 'better-auth/db/migration'
import { drizzle } from 'drizzle-orm/d1'
import { Miniflare } from 'miniflare'
import { expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { contact } from '../../packages/better-contact/src/index'
import * as schema from '../fixtures/d1-schema'

it.each(['native', 'drizzle'] as const)(
    'persists and races through the real local D1 %s adapter without transactions',
    async (driver) => {
        const worker = new Miniflare({
            modules: true,
            script: 'export default {fetch(){return new Response("test")}}',
            compatibilityDate: '2026-07-30',
            d1Databases: ['DB'],
        })
        try {
            const database = await worker.getD1Database('DB')
            let arrivals = 0,
                release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const afterCreate = vi.fn<() => void>()
            const transform = vi.fn<(value: unknown) => string>((value) => `stored:${String(value)}`)
            const plugin = contact({
                models: {
                    report: {
                        schema: { modelName: 'submissions', fields: { userId: { fieldName: 'author_id' } } },
                        fields: {
                            message: {
                                type: 'string',
                                fieldName: 'body',
                                validator: { input: z.string().trim() },
                                transform: { input: transform, output: (value: unknown) => String(value).slice(7) },
                            },
                            enabled: { type: 'boolean', defaultValue: true },
                            dueAt: { type: 'date' },
                        },
                        states: { received: { default: true }, reviewed: {} },
                        idempotency: { anonymousScope: () => 'server-verified-test-visitor' },
                        access: { create: () => true, list: () => ({ where: [] }), transition: () => true },
                        list: { count: true, filters: ['state'] },
                        hooks: {
                            beforeCreate: async () => {
                                if (++arrivals === 2) release()
                                await gate
                            },
                            afterCreate,
                        },
                    },
                },
            })
            const options = {
                database,
                baseURL: 'http://localhost:3000',
                secret: 'd1-test-contact-secret-at-least-thirty-two-characters',
                plugins: [plugin],
                logger: { disabled: true },
            }
            // Compile official DDL against empty SQLite: Better Auth 1.7.0's D1 introspection
            // queries protected internal tables. The runtime below still uses the real D1 binding.
            const bootstrap = new DatabaseSync(':memory:')
            try {
                const migrations = await getMigrations({ ...options, database: bootstrap })
                await database.exec(await migrations.compileMigrations())
            } finally {
                bootstrap.close()
            }
            const auth = betterAuth(
                driver === 'native'
                    ? options
                    : { ...options, database: drizzleAdapter(drizzle(database), { provider: 'sqlite', schema }) },
            )
            const adapter = (await auth.$context).adapter
            const transaction = vi
                .spyOn(adapter, 'transaction')
                .mockRejectedValue(new Error('D1 transactions unavailable'))
            const body = {
                model: 'report' as const,
                data: { message: ' hello ', dueAt: new Date('2026-01-01') },
                idempotencyKey: crypto.randomUUID(),
            }
            const raced = await Promise.all([auth.api.createContact({ body }), auth.api.createContact({ body })])
            expect(new Set(raced.map((result) => result.id)).size).toBe(1)
            expect(raced.filter((result) => !result.replayed)).toHaveLength(1)
            expect(afterCreate).toHaveBeenCalledTimes(1)
            expect(transaction).not.toHaveBeenCalled()
            const accepted = raced.find((result) => !result.replayed)!
            if (accepted.replayed) throw new Error('Expected first submission')
            expect(accepted.record).toMatchObject({ message: 'hello', enabled: true, dueAt: new Date('2026-01-01') })
            const raw = await database.prepare('SELECT body,submissionToken FROM submissions').first()
            expect(raw).toMatchObject({ body: 'stored:hello', submissionToken: expect.stringMatching(/^v1:/u) })
            const transformed = transform.mock.calls.length
            expect(await auth.api.createContact({ body })).toEqual({
                model: 'report',
                id: accepted.id,
                accepted: true,
                replayed: true,
            })
            expect(transform).toHaveBeenCalledTimes(transformed)
            await expect(auth.api.readContact({ body: { model: 'report', id: accepted.id } })).rejects.toMatchObject({
                body: { code: 'CONTACT_NOT_FOUND' },
            })
            const updated = await auth.api.transitionContact({
                body: { model: 'report', id: accepted.id, revision: 0, state: 'reviewed' },
            })
            expect(updated.record?.state).toBe('reviewed')
            const page = await auth.api.listContacts({
                body: { model: 'report', count: true, filters: [{ field: 'state', value: 'reviewed' }] },
            })
            expect(page.count).toBe(1)
            expect(page.records[0]).not.toHaveProperty('submissionToken')
            expect(page.records[0]).not.toHaveProperty('submissionFingerprint')
            await expect(
                auth.api.createContact({ body: { ...body, data: { ...body.data, message: 'different' } } }),
            ).rejects.toMatchObject({ body: { code: 'CONTACT_IDEMPOTENCY_CONFLICT' } })
        } finally {
            await worker.dispose()
        }
    },
    60_000,
)
