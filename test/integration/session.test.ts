import { expect, it } from 'vite-plus/test'

import { setup } from '../utils'

it('accepts real signup cookies and rejects tampered or revoked sessions', async () => {
    const app = await setup({
        models: {
            report: {
                idempotency: false as const,
                fields: { target: { type: 'string' } },
                states: { received: { default: true } },
                access: { create: ({ session }) => session !== null },
            },
        },
    })
    try {
        const user = await app.signup()
        const body = { model: 'report', data: { target: 'public-resource' } }
        expect((await app.request('create', body, user.headers)).status).toBe(200)
        const tampered = new Headers(user.headers)
        tampered.set('cookie', `${tampered.get('cookie')}tampered`)
        expect((await app.request('create', body, tampered)).status).toBe(403)
        await app.auth.api.signOut({ headers: user.headers })
        expect((await app.request('create', body, user.headers)).status).toBe(403)
    } finally {
        app.close()
    }
})
