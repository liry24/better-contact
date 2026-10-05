/* oxlint-disable typescript/no-unsafe-type-assertion -- Better Auth requires a type-only server plugin inference marker. */
import type { BetterAuthClientPlugin, BetterAuthOptions } from 'better-auth'

import { isContactRequest, parseContactResponse } from './client-response'
import { dateHeader } from './wire'

type ServerPlugin<A extends { options: BetterAuthOptions }> = Extract<
    NonNullable<A['options']['plugins']>[number],
    { id: 'contact' }
>

/** Pass typeof auth through a type-only import. This module contains no server runtime imports. */
export function contactClient<A extends { options: BetterAuthOptions }>(): {
    id: 'contact'
    $InferServerPlugin: ServerPlugin<A>
} & Pick<BetterAuthClientPlugin, 'pathMethods' | 'fetchPlugins'> {
    return {
        id: 'contact',
        $InferServerPlugin: {} as ServerPlugin<A>,
        pathMethods: {
            '/contact/create': 'POST',
            '/contact/read': 'POST',
            '/contact/list': 'POST',
            '/contact/update': 'POST',
            '/contact/transition': 'POST',
            '/contact/delete': 'POST',
            '/contact/bulk': 'POST',
        },
        // Model names exist only in the server type. Native routes need POST even for list({}).
        fetchPlugins: [
            {
                id: 'contact-methods',
                name: 'Contact endpoint transport',
                hooks: {
                    onRequest(request) {
                        if (!isContactRequest(request.url, request.baseURL)) return
                        request.method = 'POST'
                        if (request.body == null) {
                            request.body = '{}'
                            request.headers.set('content-type', 'application/json')
                        }
                    },
                    onResponse({ request, response }) {
                        if (response.ok && isContactRequest(request.url, request.baseURL)) {
                            const metadata = response.headers.get(dateHeader)
                            request.jsonParser = (text) => parseContactResponse(text, metadata)
                        }
                    },
                },
            },
        ],
    } satisfies BetterAuthClientPlugin
}
