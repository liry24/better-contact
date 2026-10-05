import { contactPath, dateDepthLimit, dateHeaderLimit, datePathLimit, objectValue, unsafePathKeys } from './wire'
const invalid = () => new Error('Missing or invalid contact date metadata')
function validPath(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= dateDepthLimit &&
        value.every((key: unknown) => typeof key === 'string' && !unsafePathKeys.has(key))
    )
}

export function isContactRequest(url: string | URL, baseURL: string | undefined): boolean {
    if (!baseURL) return false
    const target = new URL(url, 'http://contact.invalid')
    const base = new URL(baseURL, 'http://contact.invalid')
    const prefix = base.pathname.replace(/\/$/u, '')
    return (
        target.origin === base.origin &&
        target.pathname.startsWith(`${prefix}/`) &&
        contactPath(target.pathname.slice(prefix.length))
    )
}
export function parseContactResponse(text: string, header: string | null): unknown {
    if (!header || header.length > dateHeaderLimit || /[^\x20-\x7e]/u.test(header)) throw invalid()
    let metadata: unknown
    try {
        metadata = JSON.parse(header)
    } catch {
        throw invalid()
    }
    if (
        !objectValue(metadata) ||
        metadata.v !== 1 ||
        Object.keys(metadata).some((key) => !['v', 'paths'].includes(key)) ||
        !Array.isArray(metadata.paths) ||
        metadata.paths.length > datePathLimit
    )
        throw invalid()
    const value: unknown = JSON.parse(text)
    const seen = new Set<string>()
    const targets: { parent: Record<string, unknown>; key: string; date: Date }[] = []
    for (const path of metadata.paths as unknown[]) {
        if (!validPath(path)) throw invalid()
        const identity = JSON.stringify(path)
        if (seen.has(identity)) throw invalid()
        seen.add(identity)
        let parent: unknown = value
        const keys = path
        for (const key of keys.slice(0, -1)) {
            if (!objectValue(parent) || !Object.hasOwn(parent, key)) throw invalid()
            parent = parent[key]
        }
        const key = keys.at(-1)!
        if (!objectValue(parent) || !Object.hasOwn(parent, key) || typeof parent[key] !== 'string') throw invalid()
        const date = new Date(parent[key])
        if (!Number.isFinite(date.getTime()) || date.toISOString() !== parent[key]) throw invalid()
        targets.push({ parent, key, date })
    }
    // Validate every path before assigning, and never traverse an inherited/prototype property.
    for (const target of targets) target.parent[target.key] = target.date
    return value
}
