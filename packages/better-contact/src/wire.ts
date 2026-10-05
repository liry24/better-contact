// Private, versioned transport metadata. Application data stays in ordinary JSON.
export const dateHeader = 'x-better-contact-dates'
export const dateHeaderLimit = 4096
export const dateDepthLimit = 32
export const datePathLimit = 512
export const unsafePathKeys = new Set(['__proto__', 'constructor', 'prototype'])
export const contactPath = (path: string) =>
    /^\/contact\/(?:[a-z][a-z0-9-]*\/)?(?:create|read|list|update|transition|delete|bulk)$/u.test(path)
export function objectValue(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object'
}
