import { DatabaseSync } from 'node:sqlite'

import { expect, it } from 'vite-plus/test'

import { verifyTransport } from '../fixtures/transport'
it('preserves ISO text, nested JSON, native dates and transform stages through the normal client', async () => {
    const database = new DatabaseSync(':memory:')
    try {
        await expect(verifyTransport(database)).resolves.toBeUndefined()
    } finally {
        database.close()
    }
})
