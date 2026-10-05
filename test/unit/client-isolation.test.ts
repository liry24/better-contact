import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { expect, it } from 'vite-plus/test'

import { contactClient } from '../../packages/better-contact/src/client'
import { contact } from '../../packages/better-contact/src/index'

it('keeps other auth routes and error parsers unchanged, and fails honestly on missing success metadata', async () => {
    const auth = betterAuth({
        plugins: [
            contact({
                models: {
                    feedback: {
                        idempotency: false,
                        fields: { message: { type: 'string' } },
                        states: { received: { default: true } },
                    },
                },
            }),
        ],
    })
    const iso = '2026-10-05T01:02:03.123Z'
    let broken = false,
        customParses = 0
    const client = createAuthClient({
        baseURL: 'http://localhost:3000/custom/auth',
        plugins: [contactClient<typeof auth>()],
        fetchOptions: {
            jsonParser: (text) => {
                customParses++
                return JSON.parse(text) as unknown
            },
            customFetchImpl: (input) => {
                const url = new URL(input instanceof Request ? input.url : input)
                if (url.pathname.endsWith('/get-session'))
                    return Promise.resolve(Response.json({ user: { name: iso }, session: { expiresAt: iso } }))
                if (!broken)
                    return Promise.resolve(Response.json({ message: iso, code: 'TEST_DENIED' }, { status: 403 }))
                return Promise.resolve(
                    Response.json({
                        model: 'feedback',
                        id: 'saved',
                        accepted: true,
                        replayed: false,
                        record: { message: iso },
                    }),
                )
            },
        },
    })
    const session = await client.getSession()
    expect(session.data?.user.name).toBe(iso)
    expect(customParses).toBe(1)
    const denied = await client.contact.feedback.create({ data: { message: iso } })
    expect(denied.error).toMatchObject({ message: iso, code: 'TEST_DENIED', status: 403 })
    expect(customParses).toBe(2)
    broken = true
    await expect(client.contact.feedback.create({ data: { message: iso } })).rejects.toThrow(/contact date metadata/u)
    expect(customParses).toBe(2)
})
