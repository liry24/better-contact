import { fail } from './schema'
import { dateDepthLimit, dateHeader, dateHeaderLimit, datePathLimit, objectValue, unsafePathKeys } from './wire'

type ResponseHeaders = { setHeader: (name: string, value: string) => void; responseHeaders: Headers }
function dateMetadata(value: unknown): string {
    const paths: string[][] = []
    const ancestors = new Set<object>()
    let nodes = 0
    function visit(current: unknown, path: string[]) {
        if (++nodes > 100_000 || path.length > dateDepthLimit) throw new Error('Contact output traversal limit')
        if (current instanceof Date) {
            if (
                !path.length ||
                !Number.isFinite(current.getTime()) ||
                current.toJSON !== Date.prototype.toJSON ||
                path.some((key) => unsafePathKeys.has(key))
            )
                throw new Error('Unsupported contact date output')
            paths.push(path)
            if (paths.length > datePathLimit) throw new Error('Contact date path limit')
            return
        }
        if (current === null || current === undefined || typeof current === 'string' || typeof current === 'boolean')
            return
        if (typeof current === 'number' && Number.isFinite(current)) return
        if (
            !objectValue(current) ||
            ancestors.has(current) ||
            (!Array.isArray(current) && ![null, Object.prototype].includes(Object.getPrototypeOf(current)))
        )
            throw new Error('Unsupported contact output value')
        const keys = Reflect.ownKeys(current)
        if (keys.length !== (Array.isArray(current) ? current.length + 1 : Object.keys(current).length))
            throw new Error('Unsupported contact output properties')
        ancestors.add(current)
        for (const [key, child] of Object.entries(current)) {
            if (
                Array.isArray(current) &&
                (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= current.length || child === undefined)
            )
                throw new Error('Unsupported contact array output')
            visit(child, [...path, key])
        }
        ancestors.delete(current)
    }
    visit(value, [])
    // Header values must be ASCII even when a JSON output validator creates Unicode keys.
    const encoded = JSON.stringify({ v: 1, paths }).replace(/[^\x20-\x7e]/gu, (character) =>
        character
            .split('')
            .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join(''),
    )
    if (encoded.length > dateHeaderLimit) throw new Error('Contact date metadata limit')
    return encoded
}
function omitMutationRecord(value: unknown): Record<string, unknown> | null {
    if (!objectValue(value) || !Object.hasOwn(value, 'record') || !Object.hasOwn(value, 'output')) return null
    return { ...value, record: null, output: 'failed' }
}
/** Explicit response headers preserve the ordinary JSON body and native direct-API values. */
export function contactResponse<T extends object>(context: ResponseHeaders, result: T): T {
    let metadata: string
    let output = result
    try {
        metadata = dateMetadata(result)
    } catch {
        // Output limits must never turn an already accepted write into an apparent write failure.
        let fallback = omitMutationRecord(result)
        if (!fallback && 'results' in result && Array.isArray(result.results)) {
            fallback = {
                ...result,
                results: result.results.map((item: unknown) => {
                    if (!objectValue(item) || item.status !== 'success') return item
                    const saved = omitMutationRecord(item.result)
                    return saved ? { ...item, result: saved } : item
                }),
            }
        }
        if (!fallback) fail('OUTPUT', 'Contact output exceeds supported transport limits; reduce the page size')
        metadata = dateMetadata(fallback)
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only mutation record/output variants change; every public mutation explicitly permits this saved-output failure.
        output = fallback as T
    }
    context.setHeader(dateHeader, metadata)
    const expose =
        context.responseHeaders
            .get('access-control-expose-headers')
            ?.split(',')
            .map((name) => name.trim())
            .filter(Boolean) ?? []
    if (!expose.some((name) => name.toLowerCase() === dateHeader)) expose.push(dateHeader)
    context.setHeader('access-control-expose-headers', expose.join(', '))
    return output
}
