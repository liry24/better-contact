import type { DBAdapter } from '@better-auth/core/db/adapter'

import { digest } from './canonical'
import { fail, tableName } from './schema'
import type { ContactModel, ContactSession, StoredRecord } from './types'

export type ContactAdapter = Pick<
    DBAdapter,
    'create' | 'findOne' | 'findMany' | 'count' | 'incrementOne' | 'consumeOne'
>

export async function submissionToken(
    definition: ContactModel,
    actor: { session: ContactSession; headers: Headers },
    model: string,
    key: unknown,
) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(key))
        fail(
            'IDEMPOTENCY_KEY',
            'Use a 16–128 character submission key containing letters, numbers, hyphens or underscores',
        )
    const settings = definition.idempotency || {}
    const identity =
        actor.session?.user.id ?? (await settings.anonymousScope?.({ model, headers: new Headers(actor.headers) }))
    if (typeof identity !== 'string' || !identity.length || identity.length > 512)
        fail(
            'IDEMPOTENCY_SCOPE',
            'Protected anonymous creation requires a configured, verified application identity',
            'FORBIDDEN',
        )
    return 'v1:' + (await digest(['contact-token-v1', model, actor.session ? 'user' : 'anonymous', identity, key]))
}

export async function lookupSubmission(adapter: Pick<DBAdapter, 'findOne'>, model: string, token: string) {
    return adapter.findOne<StoredRecord>({
        model: tableName(model),
        where: [{ field: 'submissionToken', value: token }],
    })
}
