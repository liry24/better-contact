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
const reserved = new Set(
    ['id', ...Object.keys(baseFields), '__proto__', 'constructor', 'prototype'].map((key) => key.toLowerCase()),
)
export const tableName = (model: string) => `contact_${model}`
const normalized = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()

export function buildSchema(models: ContactModels) {
    const schema: NonNullable<BetterAuthPlugin['schema']> = {}
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
        const physical = new Set(reserved)
        const logical = new Set(reserved)
        const generatedColumns = new Set(['id', ...Object.keys(baseFields)].map(normalized))
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
        schema[tableName(model)] = { modelName: tableName(model), fields: { ...baseFields, ...definition.fields } }
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
        // Native defaults/onUpdate are materialized once so policies see the exact proposed values.
        // Passing them explicitly prevents the adapter from running their factories a second time.
        let generated = false
        if (
            (value === undefined || (value === null && field.required === true)) &&
            mode === 'create' &&
            field.defaultValue !== undefined
        ) {
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
