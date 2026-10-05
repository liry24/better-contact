/* oxlint-disable typescript/no-unsafe-type-assertion -- Better Auth requires a type-only server plugin inference marker. */
import type { BetterAuthClientPlugin, BetterAuthOptions } from 'better-auth'

type ServerPlugin<A extends { options: BetterAuthOptions }> = Extract<
    NonNullable<A['options']['plugins']>[number],
    { id: 'contact' }
>

/** Pass typeof auth through a type-only import. This module contains no server runtime imports. */
export function contactClient<A extends { options: BetterAuthOptions }>() {
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
    } satisfies BetterAuthClientPlugin
}
