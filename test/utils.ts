import { DatabaseSync } from 'node:sqlite'

import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'

import { contact } from '../packages/better-contact/src/index'
import type { ContactModels, ContactOptions } from '../packages/better-contact/src/index'

export async function setup<const M extends ContactModels>(options: ContactOptions<M>, filename = ':memory:') {
    const database = new DatabaseSync(filename)
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const auth = betterAuth({
        database,
        baseURL: 'http://localhost:3000',
        secret: 'test-contact-secret-at-least-thirty-two-characters',
        emailAndPassword: { enabled: true },
        plugins: [contact(options)],
        logger: { disabled: true },
    })
    await (await getMigrations(auth.options)).runMigrations()
    async function user(name = crypto.randomUUID()) {
        const response = await auth.api.signUpEmail({
            body: { name, email: `${name}@example.com`, password: 'a-long-contact-password' },
            asResponse: true,
        })
        if (!response.ok) throw new Error(await response.text())
        const data = (await response.json()) as { user: { id: string } }
        const headers = new Headers({
            origin: 'http://localhost:3000',
            cookie: response.headers
                .getSetCookie()
                .map((value) => value.split(';')[0])
                .join('; '),
        })
        return { id: data.user.id, headers }
    }
    function request(path: string, body: unknown, headers = new Headers()) {
        const requestHeaders = new Headers(headers)
        requestHeaders.set('content-type', 'application/json')
        return auth.handler(
            new Request(`http://localhost:3000/api/auth/contact/${path}`, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(body),
            }),
        )
    }
    return {
        auth,
        database,
        user,
        request,
        close: () => {
            if (database.isOpen) database.close()
        },
    }
}
