import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep this harness runnable at the published Node floor, independently of development tooling.
const root = fileURLToPath(new URL('../../', import.meta.url))
assert(process.env.CONTACT_TARBALL, 'CONTACT_TARBALL must identify the already-built artifact')
const tarball = resolve(process.env.CONTACT_TARBALL)
const directory = await mkdtemp(join(tmpdir(), 'contact-runtime-'))
const version = process.env.CONTACT_BETTER_AUTH_VERSION ?? '^1.7.0'
const env = { ...process.env, npm_config_cache: join(directory, '.npm-cache'), npm_config_engine_strict: 'true' }
function run(program, args) {
    return execFileSync(program, args, { cwd: directory, env, encoding: 'utf8', timeout: 240_000 })
}
function npm(args) {
    return process.platform === 'win32'
        ? run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args])
        : run('npm', args)
}
const hash = async () =>
    createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex')
try {
    const before = await hash()
    const archiveName = `better-contact-${before}.tgz`
    const entries = run('tar', ['-tzf', tarball]).trim().split(/\r?\n/u)
    assert(entries.every((entry) => /^package\/(?:dist(?:\/.*)?|package.json|README.md|LICENSE)$/u.test(entry)))
    assert(!entries.some((entry) => entry.endsWith('.map')))
    for (const entry of entries.filter((name) => /\.(?:m?js|d\.m?ts)$/u.test(name)))
        assert(!/sourceMappingURL|declarationMap/u.test(run('tar', ['-xOf', tarball, entry])))
    assert.equal(run('tar', ['-xOf', tarball, 'package/LICENSE']), await readFile(join(root, 'LICENSE'), 'utf8'))
    const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']))
    assert.equal(manifest.engines.node, '>=22.0.0')
    await copyFile(tarball, join(directory, archiveName))
    await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
            name: 'contact-runtime-consumer',
            private: true,
            type: 'module',
            dependencies: {
                'better-contact': `file:./${archiveName}`,
                'better-auth': version,
                '@better-auth/core': version,
                'better-sqlite3': '12.11.1',
                zod: '^4.5.4',
                valibot: '^1.5.0',
            },
        }),
    )
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'])
    // Only this explicit test driver needs a native install script; never enable other package scripts.
    npm(['rebuild', 'better-sqlite3'])
    const installed = join(directory, 'node_modules/better-contact')
    assert.deepEqual(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')), manifest)
    await Promise.all(
        entries
            .filter((name) => name.startsWith('package/dist/') && !name.endsWith('/'))
            .map(async (entry) => {
                assert.equal(
                    await readFile(join(installed, entry.slice('package/'.length)), 'utf8'),
                    run('tar', ['-xOf', tarball, entry]),
                )
            }),
    )
    const authVersion = JSON.parse(
        await readFile(join(directory, 'node_modules/better-auth/package.json'), 'utf8'),
    ).version
    assert.equal(
        authVersion,
        JSON.parse(await readFile(join(directory, 'node_modules/@better-auth/core/package.json'), 'utf8')).version,
    )
    if (version === '1.7.0') assert.equal(authVersion, version)
    await writeFile(
        join(directory, 'consumer.mjs'),
        `import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { contact } from 'better-contact'
import { contactClient } from 'better-contact/client'
import { createAuthClient } from 'better-auth/client'
import * as z from 'zod'
import * as v from 'valibot'
const database = new Database(':memory:')
const auth = betterAuth({database, baseURL:'http://localhost:3000',secret:'runtime-contact-secret-more-than-thirty-two-characters',logger:{disabled:true},plugins:[contact({models:{
  feedback:{idempotency:{anonymousScope:()=> 'server-verified-runtime-visitor'},fields:{score:{type:'number',validator:{input:z.string().transform(Number)}},label:{type:'string',validator:{input:v.pipe(v.string(),v.trim())}},priority:{type:'number',input:false,defaultValue:0},text:{type:'string'},labels:{type:'string[]'},payload:{type:'json'},happenedAt:{type:'date'}},states:{received:{default:true},reviewed:{}},access: {
create: ()=>true,
update: ()=>true,
transition: ()=>true,
list: ()=>({where:[]})
},list:{filters:['state'],orderBy:['createdAt'],search:['label'],count:true}}
}})]})
await (await getMigrations(auth.options)).runMigrations()
const iso = '2026-10-05T01:02:03.123Z'
const body = {model:'feedback',data:{score:'4',label:' hi ',text:iso,labels:[iso],payload:{at:iso,nested:[{at:iso}]},happenedAt:new Date(iso)},idempotencyKey:crypto.randomUUID()}
const first = await auth.api.createContact({body})
assert.equal(first.replayed,false)
assert.deepEqual(await auth.api.createContact({body}),{model:'feedback',id:first.id,accepted:true,replayed:true})
assert.equal(first.record.score,4)
assert.equal(first.record.label,'hi')
assert.equal(first.record.priority,0)
assert.equal(database.prepare('SELECT score FROM contact_feedback').get().score,4)
await assert.rejects(auth.api.readContact({body:{model:'feedback',id:first.id}}))
await assert.rejects(auth.api.createContact({body:{...body,data:{score:'4',label:'hi',priority:1}}}))
const changed = await auth.api.updateContact({body:{model:'feedback',id:first.id,revision:first.revision,data:{label:' changed '}}})
assert.equal(changed.record.label,'changed')
const next = await auth.api.transitionContact({body:{model:'feedback',id:first.id,revision:changed.revision,state:'reviewed'}})
assert.equal(next.record.state,'reviewed')
const page = await auth.api.listContacts({body:{model:'feedback',count:true,orderBy:{field:'createdAt',direction:'desc'},filters:[{field:'state',value:'reviewed'}],search:{field:'label',term:'changed'}}})
assert.equal(page.count,1)
assert.equal(page.records[0].id,first.id)
const response = await auth.handler(new Request('http://localhost:3000/api/auth/contact/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'feedback'})}))
assert.equal(response.status,200)
assert.equal((await response.json()).records.length,1)
assert.equal((await auth.handler(new Request('http://localhost:3000/api/auth/contact/maintain',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status,404)
assert.equal(contactClient().id,'contact')
const client = createAuthClient({baseURL:'http://localhost:3000',plugins:[contactClient()],fetchOptions:{customFetchImpl:(input,init)=>auth.handler(new Request(input,init))}})
for (const listed of [await client.contact.feedback.list({}), await client.contact.list({model:'feedback'})]) {
  assert.equal(listed.data.records.length,1)
  const record = listed.data.records[0]
  assert.equal(record.text,iso)
  assert.deepEqual(record.labels,[iso])
  assert.deepEqual(record.payload,body.data.payload)
  assert(record.happenedAt instanceof Date)
  assert.equal(record.happenedAt.toISOString(),iso)
}
assert.equal((await client.contact.feedback.create({data:body.data,idempotencyKey:body.idempotencyKey})).data.id,first.id)
assert.equal((await client.contact.create(body)).data.id,first.id)
for (const created of [await client.contact.feedback.create({data:body.data,idempotencyKey:crypto.randomUUID()}), await client.contact.create({...body,idempotencyKey:crypto.randomUUID()})]) {
  assert.equal(created.error,null)
  assert.equal(created.data.record.text,iso)
  assert.deepEqual(created.data.record.payload,body.data.payload)
  assert(created.data.record.happenedAt instanceof Date)
}
database.close()
`,
    )
    run(process.execPath, ['consumer.mjs'])
    assert.equal(await hash(), before)
    process.stdout.write(`PASS Node ${process.version}, Better Auth ${authVersion}, SQLite, artifact ${before}\n`)
} finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(directory.startsWith(join(tmpdir(), 'contact-runtime-')))
    await rm(directory, { recursive: true, force: true })
}
