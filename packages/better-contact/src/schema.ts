/* oxlint-disable no-await-in-loop -- Field validation/default/transform order is deterministic. */
import type { DBFieldAttribute } from '@better-auth/core/db'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError } from 'better-auth/api'

import type { ContactFields, ContactModels, StoredRecord } from './types'

export function fail(
    code: string,
    message: string,
    status: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'TOO_MANY_REQUESTS' = 'BAD_REQUEST',
): never {
    throw APIError.from(status, { code: `CONTACT_${code}`, message })
}
export const baseFields = {
    userId: { type: 'string', required: false, input: false, index: true },
    state: { type: 'string', input: false, index: true },
    revision: { type: 'number', input: false },
    createdAt: { type: 'date', input: false },
    updatedAt: { type: 'date', input: false },
} satisfies ContactFields
export const submissionFields = {
    submissionToken: { type: 'string', required: false, input: false, returned: false, unique: true },
    submissionFingerprint: { type: 'string', required: false, input: false, returned: false },
} satisfies ContactFields
const reserved = new Set(
    ['id', ...Object.keys(baseFields), '__proto__', 'constructor', 'prototype'].map((key) => key.toLowerCase()),
)
export const tableName = (model: string) => `contact_${model}`
const normalized = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
export function modelFields(definition: ContactModels[string]): ContactFields {
    return {
        ...(definition.idempotency !== false ? submissionFields : {}),
        ...Object.fromEntries(
            Object.entries(baseFields).map(([key, value]) => [
                key,
                {
                    ...value,
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Keys come from the closed baseFields object above.
                    ...definition.schema?.fields?.[key as keyof typeof baseFields],
                },
            ]),
        ),
    }
}

export function buildSchema(models: ContactModels) {
    const schema: NonNullable<BetterAuthPlugin['schema']> = {}
    const tables = new Set(['user', 'session', 'account', 'verification'])
    if (!Object.keys(models).length) throw new Error('Contact requires at least one model')
    for (const [model, definition] of Object.entries(models)) {
        if (!/^[a-z][a-z0-9_]{0,39}$/u.test(model) || reserved.has(model))
            throw new Error(`Unsafe contact model: ${model}`)
        const states = Object.entries(definition.states)
        if (states.filter(([, value]) => value.default === true).length !== 1)
            throw new Error(`Contact ${model} requires exactly one default state`)
        for (const [key] of states)
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(key) || reserved.has(key.toLowerCase()))
                throw new Error(`Unsafe contact state: ${key}`)
        const modelName = definition.schema?.modelName ?? tableName(model)
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u.test(modelName) || tables.has(normalized(modelName)))
            throw new Error(`Unsafe or colliding contact table: ${modelName}`)
        tables.add(normalized(modelName))
        for (const [key, override] of Object.entries(definition.schema?.fields ?? {})) {
            if (
                !Object.hasOwn(baseFields, key) ||
                Object.keys(override).some(
                    (attr) => attr !== 'fieldName' && !(key === 'userId' && attr === 'references'),
                )
            )
                throw new Error(`Unsupported contact base field override: ${key}`)
        }
        const reference = definition.schema?.fields?.userId?.references
        if (
            reference &&
            (reference.model !== 'user' ||
                reference.field !== 'id' ||
                !['set null', 'cascade', 'restrict', 'no action'].includes(reference.onDelete ?? 'cascade'))
        )
            throw new Error('Contact userId must reference user.id with a supported deletion action')
        const core = modelFields(definition)
        const columns = Object.values(core).map((field) => field.fieldName)
        if (columns.some((column) => column !== undefined && !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u.test(column)))
            throw new Error('Unsafe contact base field mapping')
        const coreColumns = ['id', ...Object.entries(core).map(([key, field]) => field.fieldName ?? key)]
        if (new Set(coreColumns.map(normalized)).size !== coreColumns.length)
            throw new Error('Colliding contact base field mappings')
        const physical = new Set([...reserved, ...coreColumns.map((column) => column.toLowerCase())])
        const logical = new Set([...reserved, ...Object.keys(core).map((key) => key.toLowerCase())])
        const generatedColumns = new Set(coreColumns.map(normalized))
        for (const [key, field] of Object.entries(definition.fields)) {
            const column = field.fieldName ?? key
            if (
                !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u.test(key) ||
                logical.has(key.toLowerCase()) ||
                !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u.test(column) ||
                physical.has(column.toLowerCase()) ||
                generatedColumns.has(normalized(column))
            )
                throw new Error(`Unsafe or colliding contact field: ${key}`)
            physical.add(column.toLowerCase())
            logical.add(key.toLowerCase())
            generatedColumns.add(normalized(column))
            if (
                field.bigint ||
                !(Array.isArray(field.type)
                    ? field.type.length > 0 && field.type.every((value) => typeof value === 'string')
                    : ['string', 'number', 'boolean', 'date', 'json', 'string[]', 'number[]'].includes(field.type))
            )
                throw new Error(`Unsupported contact storage mapping: ${key}`)
            if (field.input === false && field.required !== false && field.defaultValue === undefined)
                throw new Error(`Required managed contact field needs a default: ${key}`)
        }
        schema[tableName(model)] = { modelName, fields: { ...core, ...definition.fields } }
        if (
            definition.idempotency !== undefined &&
            definition.idempotency !== false &&
            (!object(definition.idempotency) ||
                Object.keys(definition.idempotency).some((key) => !['replay', 'anonymousScope'].includes(key)) ||
                Object.values(definition.idempotency).some((value) => typeof value !== 'function'))
        )
            throw new Error('Unsupported contact idempotency configuration')
    }
    return schema
}

export function object(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    )
}

function jsonValue(value: unknown, seen = new Set<object>()): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    let valid = false
    if (Array.isArray(value))
        valid =
            Reflect.ownKeys(value).length === value.length + 1 &&
            Array.from(value).every((item) => jsonValue(item, seen))
    else if (object(value))
        valid =
            Reflect.ownKeys(value).length === Object.keys(value).length &&
            Object.values(value).every((item) => jsonValue(item, seen))
    seen.delete(value)
    return valid
}

export function storageValue(field: DBFieldAttribute, value: unknown): boolean {
    if (value === undefined || value === null) return field.required === false
    if (Array.isArray(field.type)) return typeof value === 'string' && field.type.includes(value)
    switch (field.type) {
        case 'string':
            return typeof value === 'string'
        case 'number':
            return typeof value === 'number' && Number.isFinite(value)
        case 'boolean':
            return typeof value === 'boolean'
        case 'date':
            return value instanceof Date && Number.isFinite(value.getTime())
        case 'string[]':
            return Array.isArray(value) && Array.from(value).every((item) => typeof item === 'string')
        case 'number[]':
            return (
                Array.isArray(value) &&
                Array.from(value).every((item) => typeof item === 'number' && Number.isFinite(item))
            )
        case 'json':
            return jsonValue(value)
        default:
            return false
    }
}

export function checkSize(value: unknown, maxBytes: number) {
    try {
        if (new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes) return
    } catch {
        /* Non-serializable submissions are rejected before application code runs. */
    }
    fail('SIZE', 'Contact submission is not serializable or exceeds the size limit')
}

export async function prepare(
    fields: ContactFields,
    input: unknown,
    mode: 'create' | 'update',
    managed: boolean,
    maxBytes: number,
    defaults?: { keys: string[]; replay?: boolean },
) {
    if (!object(input) || Reflect.ownKeys(input).length !== Object.keys(input).length)
        fail('FIELDS', 'Expected contact fields')
    checkSize(input, maxBytes)
    for (const key of Object.keys(input))
        if (!Object.hasOwn(fields, key) || (!managed && fields[key]!.input === false))
            fail('FIELDS', 'Unknown or managed contact field')
    const result: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(fields)) {
        if (mode === 'update' && !Object.hasOwn(input, key) && !field.onUpdate) continue
        let value = input[key]
        // A replay only validates submitted values: no factories or omitted-value validators run again.
        if (defaults?.replay && value === undefined) continue
        // Native defaults/onUpdate are materialized once so policies see the exact proposed values.
        // Passing them explicitly prevents the adapter from running their factories a second time.
        let generated = false
        if (
            (value === undefined || (value === null && field.required === true)) &&
            mode === 'create' &&
            field.defaultValue !== undefined
        ) {
            defaults?.keys.push(key)
            if (defaults?.replay) continue
            value = typeof field.defaultValue === 'function' ? field.defaultValue() : field.defaultValue
            generated = true
        } else if (value === undefined && mode === 'update' && field.onUpdate) {
            value = field.onUpdate()
            generated = true
        }
        if (!generated && field.validator?.input && !(value == null && field.required === false)) {
            try {
                const validated = await field.validator.input['~standard'].validate(value)
                if (validated.issues) fail('VALIDATION', 'Contact field validation failed')
                value = validated.value
            } catch {
                fail('VALIDATION', 'Contact field validation failed')
            }
        }
        if (field.type === 'date' && typeof value === 'string') value = new Date(value)
        if (!storageValue(field, value) || (generated && value === undefined))
            fail('FIELDS', 'Contact value is incompatible with its native storage type')
        if (value !== undefined) result[key] = value
    }
    checkSize(result, maxBytes)
    return result
}

export async function present(fields: ContactFields, row: StoredRecord) {
    const output: Record<string, unknown> = {
        id: row.id,
        userId: row.userId,
        state: row.state,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
    for (const [key, field] of Object.entries(fields)) {
        if (field.returned === false) continue
        let value = row[key]
        if (field.validator?.output) {
            const validated = await field.validator.output['~standard'].validate(value)
            if (validated.issues) fail('OUTPUT', 'Stored contact field failed output validation')
            value = validated.value
        }
        output[key] = value
    }
    return output
}
