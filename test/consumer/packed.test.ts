import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vite-plus/test'

const root = fileURLToPath(new URL('../../', import.meta.url))
function run(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
    if (process.platform === 'win32' && program === 'npm')
        return run(
            process.execPath,
            [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args],
            cwd,
            env,
        )
    if (program === 'pnpm')
        return run('npm', ['exec', '--yes', '--package=pnpm@10.25.0', '--', 'pnpm', ...args], cwd, env)
    try {
        return execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 240_000 })
    } catch (error) {
        if (error instanceof Error && 'stdout' in error)
            throw new Error(`${error.message}\n${String(error.stdout)}`, { cause: error })
        throw error
    }
}

it('verifies one exact MIT-licensed tarball with real auth, CLI, types and browser consumers under npm/pnpm/Bun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contact-consumer-'))
    try {
        let tarball = process.env.CONTACT_TARBALL
        if (!tarball) {
            run(process.execPath, [join(root, 'node_modules/vite-plus/dist/bin.js'), 'run', 'build'], root)
            const pack = join(directory, 'pack')
            await mkdir(pack)
            run('bun', ['pm', 'pack', '--destination', pack, '--ignore-scripts'], join(root, 'packages/better-contact'))
            const archives = (await readdir(pack)).filter((name) => name.endsWith('.tgz'))
            assert.equal(archives.length, 1)
            tarball = join(pack, archives[0]!)
        }
        const hash = () => readFile(tarball).then((bytes) => createHash('sha256').update(bytes).digest('hex'))
        const before = await hash()
        const entries = run('tar', ['-tzf', tarball], directory).trim().split(/\r?\n/u)
        expect(
            entries.every((entry) => /^package\/(?:dist(?:\/.*)?|package.json|README.md|LICENSE)$/u.test(entry)),
        ).toBe(true)
        expect(entries).toContain('package/LICENSE')
        expect(run('tar', ['-xOf', tarball, 'package/LICENSE'], directory)).toBe(
            await readFile(join(root, 'LICENSE'), 'utf8'),
        )
        const packedManifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json'], directory)) as {
            name: string
            version: string
            license: string
        }
        expect(packedManifest.license).toBe('MIT')
        expect(packedManifest.name).toBe('better-contact')
        const archiveName = `better-contact-${before}.tgz`
        const managers = process.env.CONTACT_PACKAGE_MANAGER
            ? [process.env.CONTACT_PACKAGE_MANAGER]
            : ['bun', 'npm', 'pnpm']
        const versions = process.env.CONTACT_BETTER_AUTH_VERSION
            ? [process.env.CONTACT_BETTER_AUTH_VERSION]
            : ['1.7.0', '^1.7.0']
        for (const { manager, version } of managers.flatMap((packageManager) =>
            versions.map((authVersion) => ({ manager: packageManager, version: authVersion })),
        )) {
            assert(['bun', 'npm', 'pnpm'].includes(manager))
            const consumer = join(directory, `${manager}-${encodeURIComponent(version)}`)
            await mkdir(consumer)
            await copyFile(tarball, join(consumer, archiveName))
            await writeFile(
                join(consumer, 'package.json'),
                JSON.stringify({
                    name: 'contact-consumer',
                    private: true,
                    type: 'module',
                    dependencies: {
                        'better-contact': `file:./${archiveName}`,
                        'better-auth': version,
                        '@better-auth/core': version,
                        zod: '^4.5.4',
                        valibot: '^1.5.0',
                    },
                    devDependencies: { typescript: '^7.0.2', '@types/node': '^26.6.3', auth: version },
                }),
            )
            // Bun caches relative file tarballs across projects. Keep concurrent package checks isolated.
            run(manager, ['install', '--ignore-scripts'], consumer, {
                ...process.env,
                BUN_INSTALL_CACHE_DIR: join(consumer, '.bun-cache'),
            })
            const installed = join(consumer, 'node_modules/better-contact')
            expect(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))).toMatchObject({
                name: packedManifest.name,
                version: packedManifest.version,
            })
            const installedAuth = JSON.parse(
                await readFile(join(consumer, 'node_modules/better-auth/package.json'), 'utf8'),
            ) as { version: string }
            const installedCore = JSON.parse(
                await readFile(join(consumer, 'node_modules/@better-auth/core/package.json'), 'utf8'),
            ) as { version: string }
            expect(installedAuth.version).toBe(installedCore.version)
            expect(version === '1.7.0' ? installedAuth.version : installedCore.version).toBe(
                version === '1.7.0' ? '1.7.0' : installedAuth.version,
            )
            for (const entry of entries.filter((name) => name.startsWith('package/dist/') && !name.endsWith('/'))) {
                expect(await readFile(join(installed, entry.slice('package/'.length)), 'utf8')).toBe(
                    run('tar', ['-xOf', tarball, entry], directory),
                )
            }
            expect(
                createHash('sha256')
                    .update(await readFile(join(consumer, archiveName)))
                    .digest('hex'),
            ).toBe(before)
            await writeFile(
                join(consumer, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        module: 'NodeNext',
                        moduleResolution: 'NodeNext',
                        target: 'ES2022',
                        types: ['node'],
                        strict: true,
                        skipLibCheck: true,
                        noEmit: true,
                        allowImportingTsExtensions: true,
                    },
                    include: ['consumer.ts', 'client.ts'],
                }),
            )
            await writeFile(
                join(consumer, 'consumer.ts'),
                `import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { contact } from 'better-contact'
import * as z from 'zod'
import * as v from 'valibot'
const database = new DatabaseSync(':memory:')
export const auth = betterAuth({ database, baseURL: 'http://localhost:3000', secret: 'packed-contact-secret-more-than-thirty-two-characters', plugins: [contact({models: {
  feedback: { fields: {score: {type:'number', validator:{input:z.string().transform(Number)}}, label:{type:'string',validator:{input:v.pipe(v.string(),v.trim())}}, priority:{type:'number',input:false,defaultValue:0}}, states: {received:{default:true},reviewed:{}}, list:{filters:['state'],orderBy:['createdAt'],search:['label'],count:true}, idempotency:{replay:()=>true,anonymousScope:()=> 'server-verified-test-visitor'}, access:{create:()=>true,list:()=>({where:[]}),transition:()=>true} },
}})], logger:{disabled:true} })
await (await getMigrations(auth.options)).runMigrations()
const body={model:'feedback' as const,data:{score:'4',label:' hi '},idempotencyKey:crypto.randomUUID()}
const first=await auth.api.createContact({body})
assert.equal(first.replayed,false); if(first.replayed) throw new Error("Expected new submission")
assert.equal((await auth.api.createContact({body})).id,first.id)
assert.equal(first.record?.score,4); assert.equal(first.record?.label,'hi')
assert.equal(database.prepare('SELECT score FROM contact_feedback').get()?.score,4)
const next=await auth.api.transitionContact({body:{model:'feedback',id:first.id,revision:first.revision,state:'reviewed'}})
assert.equal(next.record?.state,'reviewed')
const page=await auth.api.listContacts({body:{model:'feedback',count:true,orderBy:{field:'createdAt',direction:'desc'},filters:[{field:'state',value:'reviewed'}],search:{field:'label',term:'hi'}}})
assert.equal(page.count,1)
const response=await auth.handler(new Request('http://localhost:3000/api/auth/contact/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'feedback'})}))
assert.equal(response.status,200); assert.equal((await response.json()).records.length,1)
assert.equal((await auth.handler(new Request('http://localhost:3000/api/auth/contact/maintain',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status,404)
if(false){
  // @ts-expect-error transformed field takes schema input
  await auth.api.createContact({body:{...body,data:{score:4,label:'hi'}}})
  // @ts-expect-error managed field cannot be supplied
  await auth.api.createContact({body:{...body,data:{score:'4',label:'hi',priority:1}}})
  // @ts-expect-error keyed models require a submission key
  await auth.api.createContact({body:{model:'feedback',data:{score:'4',label:'hi'}}})
}
database.close()
`,
            )
            await writeFile(
                join(consumer, 'client.ts'),
                `import {createAuthClient} from 'better-auth/client'
import {contactClient} from 'better-contact/client'
import type {auth} from './consumer.ts'
export const client=createAuthClient({plugins:[contactClient<typeof auth>()]})
void client.contact.create({model:'feedback',data:{score:'4',label:'hi'},idempotencyKey:crypto.randomUUID()}).then(({data})=>{
  if(data && !data.replayed && data.record){ const n:number=data.record.score; void n
    // @ts-expect-error output is a number
    const bad:string=data.record.score; void bad
  }
})
// @ts-expect-error state keys are literal
void client.contact.transition({model:'feedback',id:'x',revision:0,state:'closed'})
// @ts-expect-error management method is server-only
void client.maintainContact({})
`,
            )
            run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '--noEmit'], consumer)
            run(process.execPath, ['consumer.ts'], consumer)
            await writeFile(
                join(consumer, 'auth.ts'),
                `import {betterAuth} from 'better-auth'
import {contact} from 'better-contact'
export const auth=betterAuth({plugins:[contact({models:{report:{schema:{modelName:'moderation_reports',fields:{userId:{fieldName:'author_id',references:{model:'user',field:'id',onDelete:'set null'}}}},idempotency:{replay:()=>true},fields:{targetId:{type:'string'},rating:{type:'number',required:false}},states:{received:{default:true}}}}})]})
`,
            )
            run(
                process.execPath,
                [
                    join(consumer, 'node_modules/auth/dist/index.mjs'),
                    'generate',
                    '--config',
                    './auth.ts',
                    '--adapter',
                    'drizzle',
                    '--dialect',
                    'sqlite',
                    '--output',
                    './generated-schema.ts',
                    '--yes',
                ],
                consumer,
            )
            const schema = await readFile(join(consumer, 'generated-schema.ts'), 'utf8')
            expect(schema).toMatch(/moderation_reports/u)
            expect(schema).toMatch(/author_id/u)
            expect(schema).toMatch(/set null/u)
            expect(schema).not.toMatch(/contact__receipt/u)
            expect(schema).toMatch(/submissionToken:[^\n]*unique/u)
            expect(schema).toMatch(/submissionFingerprint/u)
            expect(schema).toMatch(/targetId:\s*text\(["']target_id["']\)\.notNull\(\)/u)
            expect(schema).toMatch(/rating:\s*(?:integer|real|numeric)\(["']rating["']\)/u)
            expect(schema).not.toMatch(/rating:[^\n]*notNull/u)
            await writeFile(
                join(consumer, 'auth.ts'),
                (await readFile(join(consumer, 'auth.ts'), 'utf8')).replace(
                    'idempotency:{replay:()=>true}',
                    'idempotency:false',
                ),
            )
            run(
                process.execPath,
                [
                    join(consumer, 'node_modules/auth/dist/index.mjs'),
                    'generate',
                    '--config',
                    './auth.ts',
                    '--adapter',
                    'drizzle',
                    '--dialect',
                    'sqlite',
                    '--output',
                    './disabled-schema.ts',
                    '--yes',
                ],
                consumer,
            )
            expect(await readFile(join(consumer, 'disabled-schema.ts'), 'utf8')).not.toMatch(
                /submissionToken|submissionFingerprint|submission_token|submission_fingerprint|contact__receipt/u,
            )
            run('bun', ['build', 'client.ts', '--target', 'browser', '--outdir', 'bundle'], consumer)
            expect(await readFile(join(consumer, 'bundle/client.js'), 'utf8')).not.toMatch(
                /createAuthEndpoint|node:sqlite|createService|packed-contact-secret/u,
            )
            expect(await hash()).toBe(before)
        }
    } finally {
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
        assert(directory.startsWith(join(tmpdir(), 'contact-consumer-')))
        await rm(directory, { recursive: true, force: true })
    }
}, 900_000)
