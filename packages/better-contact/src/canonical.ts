import { object } from './schema'

// Tagged canonical encoding preserves Dates/undefined for direct API consumers without
// applying the model's adapter or validator transforms a second time.
type Encoded = null | boolean | number | string | Encoded[]
function encode(value: unknown): Encoded {
    if (value === undefined) return ['undefined']
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (value instanceof Date && Number.isFinite(value.getTime())) return ['date', value.toISOString()]
    if (Array.isArray(value)) return ['array', ...value.map(encode)]
    if (object(value))
        return [
            'object',
            ...Object.keys(value)
                .toSorted()
                .map((key) => [key, encode(value[key])]),
        ]
    throw new Error('Unsupported contact canonical value')
}
function decode(value: Encoded): unknown {
    if (!Array.isArray(value)) return value
    if (value[0] === 'undefined') return undefined
    if (value[0] === 'date' && typeof value[1] === 'string') return new Date(value[1])
    if (value[0] === 'array') return value.slice(1).map(decode)
    if (value[0] === 'object')
        return Object.fromEntries(
            value.slice(1).map((entry) => {
                if (!Array.isArray(entry) || typeof entry[0] !== 'string')
                    throw new Error('Invalid contact canonical value')
                return [entry[0], decode(entry[1]!)]
            }),
        )
    throw new Error('Invalid contact canonical value')
}
export function pack(value: unknown): string {
    return JSON.stringify(encode(value))
}
export function unpack(value: string): unknown {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The tagged codec is validated by decode.
    return decode(JSON.parse(value) as Encoded)
}
export async function digest(value: unknown): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pack(value)))
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
