import { expect, it } from 'vite-plus/test'

import { contact } from '../../packages/better-contact/src/index'

const valid = { states: { received: { default: true } }, fields: { message: { type: 'string' as const } } }
it('rejects unsafe names, ambiguous defaults, reserved fields and unsupported mappings', () => {
    for (const models of [
        {},
        { 'Bad-Name': valid },
        { feedback: { ...valid, states: { a: {}, b: {} } } },
        { feedback: { ...valid, states: { a: { default: true }, b: { default: true } } } },
        { feedback: { ...valid, fields: { state: { type: 'string' } } } },
        { feedback: { ...valid, fields: { submissionToken: { type: 'string' } } } },
        { feedback: { ...valid, fields: { submission_fingerprint: { type: 'string' } } } },
        { feedback: { ...valid, idempotency: { retentionSeconds: 60 } } },
        { feedback: { ...valid, fields: { x: { type: 'string', fieldName: 'USERID' } } } },
        { feedback: { ...valid, fields: { user_id: { type: 'string' } } } },
        { feedback: { ...valid, fields: { someKey: { type: 'string' }, some_key: { type: 'string' } } } },
        {
            feedback: {
                ...valid,
                fields: { x: { type: 'string', fieldName: 'same' }, y: { type: 'string', fieldName: 'SAME' } },
            },
        },
        { feedback: { ...valid, fields: { x: { type: 'object' } } } },
        { feedback: { ...valid, fields: { x: { type: 'number', bigint: true } } } },
        { feedback: { ...valid, fields: { x: { type: 'string', input: false } } } },
        { feedback: { ...valid, fields: JSON.parse('{"__proto__":{"type":"string"}}') } },
    ])
        expect(() => contact({ models } as any)).toThrow(/Contact|contact/u)
})

it('emits native model schemas with validators and transforms intact', () => {
    const plugin = contact({ models: { feedback: valid, rating: { ...valid, fields: { score: { type: 'number' } } } } })
    expect(Object.keys(plugin.schema)).toEqual(['contact_feedback', 'contact_rating'])
    expect(plugin.schema.contact_rating?.fields.score).toEqual({ type: 'number' })
    expect(plugin.schema.contact_feedback?.fields).not.toHaveProperty('data')
    expect(plugin.schema.contact_feedback?.fields.submissionToken).toMatchObject({
        unique: true,
        input: false,
        returned: false,
    })
    const disabled = contact({ models: { feedback: { ...valid, idempotency: false } } })
    expect(disabled.schema.contact_feedback?.fields).not.toHaveProperty('submissionToken')
    expect(disabled.schema.contact_feedback?.fields).not.toHaveProperty('submissionFingerprint')
    expect(() => contact({ models: { feedback: valid }, limits: { maxBulk: 101 } })).toThrow(/Contact|contact/u)
})

it('rejects client namespace collisions at startup and keeps canonical names bijective', () => {
    for (const name of [
        'create',
        'read',
        'list',
        'update',
        'transition',
        'delete',
        'bulk',
        'maintain',
        'then',
        'catch',
        'finally',
        'constructor',
        'to_string',
        'value_of',
        'a__b',
        'a_',
        'a_1',
        'a_b_c',
    ]) {
        expect(() => contact({ models: { [name]: valid } })).toThrow(/contact model/u)
    }
    expect(() => contact({ models: { a_b: valid, a__b: valid } })).toThrow(/contact model/u)
    const plugin = contact({ models: { abuse_report: valid } })
    expect(plugin.endpoints.abuseReportCreateContact.path).toBe('/contact/abuse-report/create')
    expect(plugin.endpoints.createContact.path).toBe('/contact/create')
})
