/* oxlint-disable vitest/no-conditional-expect -- Each deletion policy intentionally has a different database outcome. */
import { expect, it } from 'vite-plus/test'

import { contact } from '../../packages/better-contact/src/index'
import { setup } from '../utils'

it('uses native table/column mappings and preserves configured user deletion behavior', async () => {
    for (const onDelete of ['set null', 'cascade', 'restrict'] as const) {
        const app = await setup({
            models: {
                report: {
                    schema: {
                        modelName: 'moderation_reports',
                        fields: {
                            userId: { fieldName: 'author_id', references: { model: 'user', field: 'id', onDelete } },
                            state: { fieldName: 'status' },
                            createdAt: { fieldName: 'submitted_at' },
                        },
                    },
                    fields: { text: { type: 'string', fieldName: 'body' } },
                    states: { received: { default: true } },
                    access: { create: ({ session }) => !!session, read: () => true, list: () => ({ where: [] }) },
                },
            },
        })
        try {
            const user = await app.user()
            const result = await app.auth.api.createContact({
                headers: user.headers,
                body: { model: 'report', data: { text: 'retained content' } },
            })
            expect(app.database.prepare('SELECT author_id,status,body FROM moderation_reports').get()).toMatchObject({
                author_id: user.id,
                status: 'received',
                body: 'retained content',
            })
            const remove = () => app.database.prepare('DELETE FROM user WHERE id=?').run(user.id)
            if (onDelete === 'restrict') expect(remove).toThrow(/FOREIGN KEY/u)
            else {
                remove()
                const rows = await app.auth.api.listContacts({ body: { model: 'report' } })
                expect(rows.records).toHaveLength(onDelete === 'cascade' ? 0 : 1)
                if (onDelete === 'set null')
                    expect(rows.records[0]).toMatchObject({ id: result.id, userId: null, text: 'retained content' })
            }
        } finally {
            app.close()
        }
    }
})

it('rejects aliases that collide or change authoritative base field semantics', () => {
    const base = { fields: { text: { type: 'string' as const } }, states: { received: { default: true } } }
    for (const schema of [
        { modelName: 'user' },
        { modelName: 'bad;drop' },
        { fields: { userId: { fieldName: 'status' }, state: { fieldName: 'status' } } },
        { fields: { userId: { input: true } } },
        { fields: { userId: { references: { model: 'session', field: 'id' } } } },
        { fields: { state: { fieldName: 'text' } } },
    ])
        expect(() => contact({ models: { report: { ...base, schema } } } as any)).toThrow(/contact/iu)
    expect(() =>
        contact({
            models: {
                one: { ...base, schema: { modelName: 'same' } },
                two: { ...base, schema: { modelName: 'same' } },
            },
        }),
    ).toThrow(/contact/iu)
    for (const list of [
        { filters: ['secret'] },
        { orderBy: ['userId'] },
        { search: ['revision'] },
        { filters: ['computed'] },
    ])
        expect(() =>
            contact({
                models: {
                    report: {
                        ...base,
                        fields: {
                            ...base.fields,
                            secret: { type: 'string', returned: false },
                            computed: { type: 'string', transform: { output: () => 'transformed' } },
                        },
                        list,
                    },
                },
            }),
        ).toThrow(/contact/iu)
})
