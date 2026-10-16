import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'jsonl-search-'))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const home of homes.splice(0)) {
    const target = resolve(home)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('jsonl-search-')
    )
      throw new Error('Refusing unexpected scratch cleanup')
    rmSync(target, { recursive: true, force: true })
  }
})
const url = (file: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../../src', file)).href)

async function run(home: string, body: string): Promise<unknown> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { spyOn } from 'bun:test'
    import * as fs from 'node:fs/promises'
    import { mkdirSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs'
    import { join } from 'node:path'
    const home = ${JSON.stringify(home)}
    const { findSessionJsonlAsync, encodeProjectDir } = await import(${url('bridge/session-jsonl.ts')})
    const { fsSlot } = await import(${url('fs-pool.ts')})
    const assert = (ok, reason) => { if (!ok) throw Error(reason) }
    const put = (root, folder, time) => {
      const dir = join(root, folder); mkdirSync(dir, {recursive:true})
      const path = join(dir, 'invented-session-001.jsonl')
      writeFileSync(path, 'invented\\n'); utimesSync(path, new Date(time), new Date(time)); return path
    }
    ${body}
  `,
    ],
    { windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  expect(stderr).toBe('')
  return JSON.parse(stdout)
}

test('one search and four overlapping searches share eight raw I/O slots, including failures', async () => {
  const result = await run(
    fixture(),
    `
    const root = join(home, 'projects'), bad = join(home, 'denied')
    let expected
    for (let i=0; i<535; i++) {
      const dir = join(root, 'project-'+String(i).padStart(4,'0'))
      mkdirSync(dir, {recursive:true}); writeFileSync(join(dir,'unrelated.jsonl'),'invented')
      if (i === 0 || i === 534) expected = put(root, 'project-'+String(i).padStart(4,'0'), 1000+i*1000)
    }
    const nativeStat = fs.stat, nativeRead = fs.readdir
    let active=0, peak=0, calls=0
    const counted = call => {
      calls++; active++; peak=Math.max(peak,active)
      return Promise.resolve().then(call).finally(()=>active--)
    }
    const statSpy = spyOn(fs,'stat').mockImplementation((...args)=>counted(()=>Reflect.apply(nativeStat,fs,args)))
    const readSpy = spyOn(fs,'readdir').mockImplementation((path,...args)=>counted(()=> {
      if(path===bad) throw Object.assign(Error('invented unreadable root'),{code:'EACCES'})
      return Reflect.apply(nativeRead,fs,[path,...args])
    }))
    let heldCalls, singlePeak, overlapPeak
    try {
      const releases=[]
      const held=Array.from({length:8},()=>fsSlot(()=>new Promise(resolve=>releases.push(resolve))))
      const search=findSessionJsonlAsync('invented-session-001',[root])
      await new Promise(resolve=>setImmediate(resolve))
      heldCalls=calls; assert(heldCalls===0,'Discovery bypassed the shared quota')
      for(const release of releases) release()
      await Promise.all(held)
      assert(await search===expected,'Single lookup selected the wrong copy')
      singlePeak=peak; assert(singlePeak===8,'Single lookup was not bounded to eight raw calls')
      peak=0
      const results=await Promise.all(Array.from({length:4},()=>findSessionJsonlAsync('invented-session-001',[bad,root])))
      overlapPeak=peak
      assert(results.every(value=>value===expected),'Overlapping lookup lost readable roots')
      assert(overlapPeak===8 && active===0,'Overlapping lookups did not share/release the quota')
      await fsSlot(()=>Promise.reject(Error('invented raw rejection'))).catch(()=>{})
      await fsSlot(()=>{throw Error('invented synchronous raw failure')}).catch(()=>{})
      await Promise.all(Array.from({length:16},()=>fsSlot(()=>Promise.resolve())))
      assert(await findSessionJsonlAsync('missing-session-001',[root])===null,'Missing files changed result semantics')
      assert(await findSessionJsonlAsync('invented-session-001',[root])===expected,'Errors stranded quota capacity')
    } finally {statSpy.mockRestore();readSpy.mockRestore()}
    process.stdout.write(JSON.stringify({heldCalls,singlePeak,overlapPeak,active}))
  `,
  )
  expect(result).toEqual({ heldCalls: 0, singlePeak: 8, overlapPeak: 8, active: 0 })
}, 25_000)

test('cwd-first, newest/tie ordering and fresh file changes survive out-of-order I/O and misses', async () => {
  const result = await run(
    fixture(),
    `
    const sid='invented-session-001', cwd='C:/invented/work'
    const a=join(home,'a'),b=join(home,'b'),bad=join(home,'denied')
    const direct=put(a,encodeProjectDir(cwd),1000)
    const first=put(a,'a-first',5000),second=put(a,'b-second',5000)
    const other=put(b,'a-first',5000)
    writeFileSync(join(a,'not-a-directory'),'invented')
    const nativeStat=fs.stat,nativeRead=fs.readdir
    let readCalls=0,statCalls=0,vanish=null
    const statSpy=spyOn(fs,'stat').mockImplementation(async(path,...args)=>{
      statCalls++
      if(path===vanish) {unlinkSync(path);vanish=null}
      const st=await Reflect.apply(nativeStat,fs,[path,...args])
      if(path===first) await new Promise(resolve=>setTimeout(resolve,10))
      return st
    })
    const readSpy=spyOn(fs,'readdir').mockImplementation((path,...args)=>{
      readCalls++
      return path===bad ? Promise.reject(Object.assign(Error('invented unreadable root'),{code:'EACCES'})) : Reflect.apply(nativeRead,fs,[path,...args])
    })
    try {
      assert(await findSessionJsonlAsync('../invalid',[a,b])===null && statCalls===0 && readCalls===0,'Invalid ID touched disk')
      assert(await findSessionJsonlAsync(sid,[a,b],cwd)===direct && readCalls===0,'Cwd-first lookup scanned newer fallback copies')
      assert(await findSessionJsonlAsync(sid,[a,b],'missing')===first,'Cwd miss or completion order changed the tie')
      assert(await findSessionJsonlAsync(sid,[b,a])===other,'Input-root tie order changed')
      assert(await findSessionJsonlAsync(sid,[bad,a])===first,'Unreadable root hid a readable one')
      assert(await findSessionJsonlAsync(sid,[join(home,'absent'),a])===first,'Missing root hid a readable one')
      utimesSync(other,new Date(9000),new Date(9000))
      assert(await findSessionJsonlAsync(sid,[a,b])===other,'Updated timestamp was cached')
      vanish=other
      assert(await findSessionJsonlAsync(sid,[a,b])===first,'Deletion between listing and stat changed failure handling')
      const added=put(b,'new-project',12000)
      assert(await findSessionJsonlAsync(sid,[a,b])===added,'A new folder/file was not freshly discovered')
      unlinkSync(added)
      assert(await findSessionJsonlAsync(sid,[a,b])===first,'Deleted winning file remained cached')
      process.stdout.write(JSON.stringify({fresh:true,ties:true,cwd:true,errors:true}))
    }finally{statSpy.mockRestore();readSpy.mockRestore()}
  `,
  )
  expect(result).toEqual({ fresh: true, ties: true, cwd: true, errors: true })
}, 25_000)
