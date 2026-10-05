/* oxlint-disable no-await-in-loop -- The adapter supports one sort column; disjoint ordered groups preserve the ID tie-breaker. */
import type { DBFieldAttribute } from '@better-auth/core/db'
import type { DBAdapter, Where } from '@better-auth/core/db/adapter'

import { digest, pack, unpack } from './receipt'
import { baseFields, fail, object, present, storageValue, tableName } from './schema'
import type { ContactModel, ListQuery, StoredRecord } from './types'

function scalar(definition: ContactModel, name: string): DBFieldAttribute {
    const fields: Record<string, DBFieldAttribute> = { id: { type: 'string' }, ...baseFields, ...definition.fields }
    const field = Object.hasOwn(fields, name) ? fields[name] : undefined
    if (
        !field ||
        field.returned === false ||
        field.transform ||
        field.validator?.output ||
        !['string', 'number', 'date', 'boolean'].includes(String(field.type))
    )
        fail('QUERY', 'Contact list queries require visible, untransformed scalar fields')
    return field
}
export function validateList(definition: ContactModel) {
    for (const kind of ['filters', 'orderBy', 'search'] as const) {
        const names = definition.list?.[kind] ?? []
        if (names.length > 20 || new Set(names).size !== names.length)
            throw new Error('Invalid contact list field allowlist')
        for (const name of names) {
            const field = scalar(definition, name)
            if (kind === 'orderBy' && (field.required === false || field.type === 'boolean'))
                throw new Error('Contact ordering requires non-null string, number or date fields')
            if (kind === 'search' && field.type !== 'string') throw new Error('Contact search requires string fields')
        }
    }
}
function queryValue(field: DBFieldAttribute, value: unknown): Where['value'] {
    const parsed = field.type === 'date' && typeof value === 'string' ? new Date(value) : value
    if (!storageValue(field, parsed) || parsed === undefined) fail('QUERY', 'Invalid contact query value')
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scalar and storageValue restrict the native predicate type.
    return parsed as Where['value']
}
export async function listRecords(
    adapter: Pick<DBAdapter, 'findMany' | 'count'>,
    definition: ContactModel,
    name: string,
    query: ListQuery,
    policyScope: Where[],
    maxPage: number,
) {
    const limit = query.limit ?? Math.min(20, maxPage)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPage) fail('LIMIT', 'Invalid contact page size')
    const where = [...policyScope]
    if ((query.filters?.length ?? 0) > 20) fail('QUERY', 'Too many contact filters')
    for (const term of query.filters ?? []) {
        if (!definition.list?.filters?.includes(term.field)) fail('QUERY', 'Contact filter not enabled')
        const field = scalar(definition, term.field)
        const operator = term.operator ?? 'eq'
        if (!['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte'].includes(operator))
            fail('QUERY', 'Unsupported contact filter')
        const value =
            operator === 'in'
                ? (() => {
                      if (
                          !Array.isArray(term.value) ||
                          !term.value.length ||
                          term.value.length > 100 ||
                          !['string', 'number'].includes(String(field.type))
                      )
                          fail('QUERY', 'Invalid contact filter values')
                      for (const item of term.value) queryValue(field, item)
                      return term.value
                  })()
                : queryValue(field, term.value)
        where.push({ field: term.field, operator, value, connector: 'AND' })
    }
    if (query.search) {
        if (
            !definition.list?.search?.includes(query.search.field) ||
            !query.search.term.trim() ||
            query.search.term.length > 200 ||
            /[%_\\]/u.test(query.search.term)
        )
            fail('QUERY', 'Search requires an enabled field and 1–200 characters without wildcard escapes')
        where.push({ field: query.search.field, operator: 'contains', value: query.search.term, connector: 'AND' })
    }
    if (query.count && !definition.list?.count) fail('QUERY', 'Contact counts are not enabled')
    const sort = query.orderBy ?? { field: 'id', direction: 'asc' }
    if (sort.field !== 'id' && !definition.list?.orderBy?.includes(sort.field))
        fail('QUERY', 'Contact ordering not enabled')
    if (!['asc', 'desc'].includes(sort.direction)) fail('QUERY', 'Invalid contact sort direction')
    const field = scalar(definition, sort.field)
    const binding = await digest([name, where, sort])
    let anchor: { value: Where['value']; id: string } | undefined
    if (query.cursor) {
        try {
            const parsed = unpack(
                new TextDecoder().decode(Uint8Array.from(atob(query.cursor), (char) => char.charCodeAt(0))),
            )
            if (
                !object(parsed) ||
                parsed.binding !== binding ||
                typeof parsed.id !== 'string' ||
                !parsed.id.length ||
                parsed.id.length > 128
            )
                fail('CURSOR', 'Cursor does not match this contact query')
            anchor = { value: queryValue(field, parsed.value), id: parsed.id }
        } catch {
            fail('CURSOR', 'Invalid or mismatched contact cursor')
        }
    }
    const model = tableName(name)
    const operator = sort.direction === 'asc' ? 'gt' : 'lt'
    const rows: StoredRecord[] = []
    if (sort.field === 'id') {
        rows.push(
            ...(await adapter.findMany<StoredRecord>({
                model,
                where: [...where, ...(anchor ? [{ field: 'id', operator, value: anchor.id } satisfies Where] : [])],
                limit: limit + 1,
                sortBy: sort,
            })),
        )
    } else {
        // No OR clause can escape the policy scope. Each group query carries every predicate.
        let value = anchor?.value
        while (rows.length <= limit) {
            if (value === undefined) {
                const next = await adapter.findMany<StoredRecord>({ model, where, limit: 1, sortBy: sort })
                if (!next.length) break
                value = queryValue(field, next[0]![sort.field])
            }
            const group = await adapter.findMany<StoredRecord>({
                model,
                where: [
                    ...where,
                    { field: sort.field, value },
                    ...(anchor ? [{ field: 'id', operator, value: anchor.id } satisfies Where] : []),
                ],
                limit: limit + 1 - rows.length,
                sortBy: { field: 'id', direction: sort.direction },
            })
            rows.push(...group)
            if (rows.length > limit) break
            const next = await adapter.findMany<StoredRecord>({
                model,
                where: [...where, { field: sort.field, operator, value }],
                limit: 1,
                sortBy: sort,
            })
            if (!next.length) break
            value = queryValue(field, next[0]![sort.field])
            anchor = undefined
        }
    }
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
        model: name,
        records: await Promise.all(page.map((row) => present(definition.fields, row))),
        nextCursor:
            rows.length > limit && last
                ? btoa(
                      Array.from(
                          new TextEncoder().encode(pack({ binding, id: last.id, value: last[sort.field] })),
                          (byte) => String.fromCharCode(byte),
                      ).join(''),
                  )
                : null,
        ...(query.count ? { count: await adapter.count({ model, where }) } : {}),
    }
}
