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
    expect(() => contact({ models: { feedback: valid }, limits: { maxBulk: 101 } })).toThrow(/Contact|contact/u)
})
