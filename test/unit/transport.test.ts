import { expect, it } from 'vite-plus/test'

import { isContactRequest, parseContactResponse } from '../../packages/better-contact/src/client-response'
import { contactResponse } from '../../packages/better-contact/src/response'
import { dateHeader, dateHeaderLimit } from '../../packages/better-contact/src/wire'
const iso = '2026-10-05T01:02:03.123Z'
const metadata = (paths: unknown) => JSON.stringify({ v: 1, paths })

it('revives only explicit date paths and rejects every invalid path before mutation', () => {
    const body = JSON.stringify({ text: iso, nested: { dates: [iso, iso] } })
    expect(parseContactResponse(body, metadata([['nested', 'dates', '0']]))).toEqual({
        text: iso,
        nested: { dates: [new Date(iso), iso] },
    })
    for (const header of [
        null,
        '',
        'bad',
        '{}',
        JSON.stringify({ v: 2, paths: [] }),
        metadata([['missing']]),
        metadata([
            ['nested', 'dates', '0'],
            ['nested', 'dates', '0'],
        ]),
        metadata([['__proto__', 'x']]),
        metadata([['constructor', 'prototype']]),
        metadata([['nested', 'dates', 0]]),
        metadata([Array.from({ length: 33 }, () => 'x')]),
        ' '.repeat(dateHeaderLimit + 1),
    ]) {
        expect(() => parseContactResponse(body, header)).toThrow(/contact date metadata/u)
    }
    for (const value of ['2026-10-05T01:02:03Z', '2026-02-31T01:02:03.123Z', 'not-a-date', 1, null]) {
        expect(() => parseContactResponse(JSON.stringify({ value }), metadata([['value']]))).toThrow(
            /contact date metadata/u,
        )
    }
    expect(() =>
        parseContactResponse('{"__proto__":{"x":"2026-10-05T01:02:03.123Z"}}', metadata([['__proto__', 'x']])),
    ).toThrow(/contact date metadata/u)
    expect(Object.hasOwn(Object.prototype, 'x')).toBe(false)
})

it('matches the exact contact route family relative to the auth base path', () => {
    expect(
        isContactRequest('https://example.test/custom/auth/contact/feedback/list', 'https://example.test/custom/auth'),
    ).toBe(true)
    expect(isContactRequest('/custom/auth/contact/create?x=1', '/custom/auth')).toBe(true)
    for (const url of [
        'https://elsewhere.test/custom/auth/contact/create',
        'https://example.test/custom/auth/sign-in/email',
        'https://example.test/custom/auth/contact/create/extra',
        'https://example.test/custom/auth/contact/feedback/unknown',
        'https://example.test/custom/auth/contact/maintain',
        'https://example.test/other/contact/create',
    ])
        expect(isContactRequest(url, 'https://example.test/custom/auth')).toBe(false)
})

it('keeps plain bodies/direct Dates and existing CORS exposure while describing actual nested and mixed Dates', () => {
    const responseHeaders = new Headers({ 'access-control-expose-headers': 'x-existing' })
    const context = {
        responseHeaders,
        setHeader: (name: string, value: string) => {
            responseHeaders.set(name, value)
        },
    }
    const original = {
        records: [
            { value: new Date(iso), nested: { 日時: new Date(iso) } },
            { value: iso, nested: { 日時: iso } },
        ],
    }
    expect(contactResponse(context, original)).toBe(original)
    expect(original.records[0]?.value).toBeInstanceOf(Date)
    expect(Object.hasOwn(original, 'toJSON')).toBe(false)
    expect(JSON.parse(JSON.stringify(original))).toEqual({
        records: [
            { value: iso, nested: { 日時: iso } },
            { value: iso, nested: { 日時: iso } },
        ],
    })
    expect(responseHeaders.get('access-control-expose-headers')).toBe('x-existing, x-better-contact-dates')
    expect(parseContactResponse(JSON.stringify(original), responseHeaders.get(dateHeader))).toEqual(original)
    const hiddenSerializer = Object.defineProperty({}, 'toJSON', { value: () => 'changed' })
    expect(() => contactResponse(context, { records: [hiddenSerializer] })).toThrow(/transport limits/u)
    expect(() => contactResponse(context, { records: [Array<string>(2)] })).toThrow(/transport limits/u)
})

it('bounds date metadata and preserves accepted identities for mutations and partial bulk output failures', () => {
    const responseHeaders = new Headers()
    const context = {
        responseHeaders,
        setHeader: (name: string, value: string) => {
            responseHeaders.set(name, value)
        },
    }
    const dates = Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`field_${i}_${'x'.repeat(35)}`, new Date(iso)]),
    )
    const saved = {
        model: 'feedback',
        id: 'saved',
        revision: 1,
        accepted: true,
        record: dates,
        output: 'ok' as 'ok' | 'failed',
        changed: true,
    }
    expect(contactResponse(context, saved)).toEqual({ ...saved, record: null, output: 'failed' })
    expect(saved.record).toBe(dates)
    expect(responseHeaders.get(dateHeader)!.length).toBeLessThanOrEqual(dateHeaderLimit)
    expect(() => contactResponse(context, { model: 'feedback', records: [dates] })).toThrow(/transport limits/u)
    const bulk = {
        results: [
            { status: 'success', result: saved },
            { status: 'failed', code: 'CONTACT_NOT_FOUND' },
            { status: 'success', result: { deleted: true } },
        ],
    }
    expect(contactResponse(context, bulk)).toEqual({
        results: [
            { status: 'success', result: { ...saved, record: null, output: 'failed' } },
            bulk.results[1],
            bulk.results[2],
        ],
    })
})
