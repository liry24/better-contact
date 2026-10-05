import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vite-plus/test'

const root = fileURLToPath(new URL('../../', import.meta.url))
function run(program: string, args: string[], cwd: string): string {
    if (process.platform === 'win32' && program === 'npm')
        return run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], cwd)
    if (program === 'pnpm') return run('npm', ['exec', '--yes', '--package=pnpm@10.25.0', '--', 'pnpm', ...args], cwd)
    try {
        return execFileSync(program, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 240_000 })
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
        expect(JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json'], directory)).license).toBe('MIT')
        const managers = process.env.CONTACT_PACKAGE_MANAGER
            ? [process.env.CONTACT_PACKAGE_MANAGER]
            : ['bun', 'npm', 'pnpm']
        const version = process.env.CONTACT_BETTER_AUTH_VERSION ?? '1.7.7'
        for (const manager of managers) {
            assert(['bun', 'npm', 'pnpm'].includes(manager))
            const consumer = join(directory, manager)
            await mkdir(consumer)
            await copyFile(tarball, join(consumer, 'package.tgz'))
            await writeFile(
                join(consumer, 'package.json'),
                JSON.stringify({
                    name: 'contact-consumer',
                    private: true,
                    type: 'module',
                    dependencies: {
                        'better-contact': 'file:./package.tgz',
                        'better-auth': version,
                        '@better-auth/core': version,
                        zod: '^4.5.4',
                        valibot: '^1.5.0',
                    },
                    devDependencies: { typescript: '^7.0.2', '@types/node': '^26.6.3', auth: '1.7.7' },
                }),
            )
            run(manager, ['install', '--ignore-scripts'], consumer)
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
  feedback: { fields: {score: {type:'number', validator:{input:z.string().transform(Number)}}, label:{type:'string',validator:{input:v.pipe(v.string(),v.trim())}}, priority:{type:'number',input:false,defaultValue:0}}, states: {received:{default:true},reviewed:{}}, access:{create:()=>true,list:()=>({where:[]}),transition:()=>true} },
}})], logger:{disabled:true} })
await (await getMigrations(auth.options)).runMigrations()
const first=await auth.api.createContact({body:{model:'feedback',data:{score:'4',label:' hi '}}})
assert.equal(first.record?.score,4); assert.equal(first.record?.label,'hi')
assert.equal(database.prepare('SELECT score FROM contact_feedback').get()?.score,4)
const next=await auth.api.transitionContact({body:{model:'feedback',id:first.id,revision:first.revision,state:'reviewed'}})
assert.equal(next.record?.state,'reviewed')
const response=await auth.handler(new Request('http://localhost:3000/api/auth/contact/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'feedback'})}))
assert.equal(response.status,200); assert.equal((await response.json()).records.length,1)
assert.equal((await auth.handler(new Request('http://localhost:3000/api/auth/contact/maintain',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status,404)
if(false){
  // @ts-expect-error transformed field takes schema input
  await auth.api.createContact({body:{model:'feedback',data:{score:4,label:'hi'}}})
  // @ts-expect-error managed field cannot be supplied
  await auth.api.createContact({body:{model:'feedback',data:{score:'4',label:'hi',priority:1}}})
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
void client.contact.create({model:'feedback',data:{score:'4',label:'hi'}}).then(({data})=>{
  if(data?.record){ const n:number=data.record.score; void n
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
export const auth=betterAuth({plugins:[contact({models:{report:{fields:{targetId:{type:'string'},rating:{type:'number',required:false}},states:{received:{default:true}}}}})]})
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
            expect(schema).toMatch(/contact_report/u)
            expect(schema).toMatch(/targetId:\s*text\(["']target_id["']\)\.notNull\(\)/u)
            expect(schema).toMatch(/rating:\s*(?:integer|real|numeric)\(["']rating["']\)/u)
            expect(schema).not.toMatch(/rating:[^\n]*notNull/u)
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
