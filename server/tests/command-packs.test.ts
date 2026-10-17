// server/tests/command-packs.test.ts — a command pack's commands and skills reach every account folder,
// follow the pack, and never cost a person a file of their own (docs/COMMAND-PACKS.md).
//
// Every folder is scratch: `claude` stands in for a Claude config dir (`~/.claude` or a CLI instance's),
// `codex` for a Codex home, and each pack is a real git repo pulled by its path, as Settings pulls one by URL.

import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type PackTarget, syncCommandPacks } from '../src/core/command-packs'

const scratch = mkdtempSync(join(tmpdir(), 'command-packs-'))
// Each test runs git a dozen times or more (4 s for all three here); a cold, loaded CI box is far slower.
const GIT_TEST_MS = 60_000
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.test', ...args],
    { cwd, encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/** A file's text with git's Windows line endings undone, or null when it is not there. */
function text(root: string, rel: string): string | null {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null
}

function commit(repo: string, message: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', message)
}

function place(name: string) {
  const base = join(scratch, name)
  const pack = join(base, 'pack')
  const claude = join(base, 'claude')
  const codex = join(base, 'codex')
  const cacheRoot = join(base, 'cache')
  for (const d of [pack, claude, codex]) mkdirSync(d, { recursive: true })
  git(pack, 'init', '-q', '-b', 'main')
  const targets: PackTarget[] = [
    { kind: 'claude', dir: claude, label: 'Claude' },
    { kind: 'codex', dir: codex, label: 'Codex' },
  ]
  return { base, pack, claude, codex, cacheRoot, targets }
}

test(
  "a pack's commands and skills reach every account and follow the pack; an edited or own file is kept",
  async () => {
    const { pack, claude, codex, cacheRoot, targets } = place('follow')
    put(pack, 'commands/ship.md', '---\ndescription: Ship it\n---\nShip $ARGUMENTS\n')
    put(pack, 'commands/team/review.md', 'Review the diff.\n')
    put(pack, 'commands/mine.md', "The pack's mine.\n")
    put(pack, 'skills/tidy/SKILL.md', '---\nname: tidy\ndescription: Tidy\n---\nTidy up.\n')
    put(pack, 'skills/tidy/notes/more.md', 'More.\n')
    put(pack, 'skills/LICENSE', 'not a skill')
    put(pack, 'skills/loose/notes.md', 'no SKILL.md, so not a skill')
    put(pack, 'README.md', 'the pack itself')
    commit(pack, 'first')
    // The person's own command, there before the pack, under a name the pack also uses.
    put(claude, 'commands/mine.md', 'My own.\n')
    const packs = [{ url: pack }]

    const first = await syncCommandPacks({ packs, targets, cacheRoot })
    expect(first.packs[0]?.error).toBeNull()
    expect(text(claude, 'commands/ship.md')).toBe(
      '---\ndescription: Ship it\n---\nShip $ARGUMENTS\n',
    )
    expect(text(claude, 'commands/team/review.md')).toBe('Review the diff.\n')
    expect(text(claude, 'skills/tidy/notes/more.md')).toBe('More.\n')
    expect(text(claude, 'commands/mine.md')).toBe('My own.\n')
    expect(first.targets[0]?.keptOwn).toEqual(['commands/mine.md'])
    // Codex reads its commands as prompts: one folder, no subfolders.
    expect(text(codex, 'prompts/ship.md')).toBe(text(claude, 'commands/ship.md'))
    expect(text(codex, 'prompts/mine.md')).toBe("The pack's mine.\n")
    expect(existsSync(join(codex, 'prompts', 'team'))).toBe(false)
    expect(existsSync(join(codex, 'commands'))).toBe(false)
    expect(text(codex, 'skills/tidy/SKILL.md')).toBe(text(claude, 'skills/tidy/SKILL.md'))
    for (const root of [claude, codex]) {
      expect(existsSync(join(root, 'skills', 'LICENSE'))).toBe(false)
      expect(existsSync(join(root, 'skills', 'loose'))).toBe(false)
      expect(existsSync(join(root, 'README.md'))).toBe(false)
    }

    // The pack moves on, and meanwhile a person edits one copy of the skill.
    put(pack, 'commands/ship.md', 'Ship it, then tag it.\n')
    put(pack, 'skills/tidy/SKILL.md', '---\nname: tidy\ndescription: Tidy\n---\nTidy up, twice.\n')
    rmSync(join(pack, 'commands', 'team'), { recursive: true })
    rmSync(join(pack, 'skills', 'tidy', 'notes'), { recursive: true })
    commit(pack, 'second')
    put(claude, 'skills/tidy/SKILL.md', 'Edited on this PC.\n')

    const second = await syncCommandPacks({ packs, targets, cacheRoot })
    expect(text(claude, 'commands/ship.md')).toBe('Ship it, then tag it.\n')
    expect(text(codex, 'prompts/ship.md')).toBe('Ship it, then tag it.\n')
    expect(text(claude, 'skills/tidy/SKILL.md')).toBe('Edited on this PC.\n')
    expect(second.targets[0]?.edited).toEqual(['skills/tidy/SKILL.md'])
    expect(text(codex, 'skills/tidy/SKILL.md')).toBe(
      '---\nname: tidy\ndescription: Tidy\n---\nTidy up, twice.\n',
    )
    expect(existsSync(join(claude, 'commands', 'team'))).toBe(false)
    for (const root of [claude, codex])
      expect(existsSync(join(root, 'skills', 'tidy', 'notes'))).toBe(false)

    // The skill leaves the pack: the untouched copy goes, the edited one is the person's now.
    rmSync(join(pack, 'skills'), { recursive: true })
    commit(pack, 'third')
    await syncCommandPacks({ packs, targets, cacheRoot })
    expect(existsSync(join(codex, 'skills', 'tidy'))).toBe(false)
    expect(text(claude, 'skills/tidy/SKILL.md')).toBe('Edited on this PC.\n')
    expect(text(claude, 'commands/mine.md')).toBe('My own.\n')
  },
  GIT_TEST_MS,
)

test(
  'a pack that cannot be pulled keeps its copies; a pack taken off the list takes its untouched ones',
  async () => {
    const { base, pack, claude, codex, cacheRoot, targets } = place('offline')
    put(pack, 'commands/ship.md', 'Ship.\n')
    commit(pack, 'first')
    const other = join(base, 'other')
    mkdirSync(other)
    git(other, 'init', '-q', '-b', 'main')
    put(other, 'commands/ship.md', "The second pack's ship.\n")
    put(other, 'commands/lint.md', 'Lint.\n')
    commit(other, 'first')

    // Two packs with one name: the first listed wins, and the second says so.
    const both = [{ url: pack }, { url: other }]
    const run = await syncCommandPacks({ packs: both, targets, cacheRoot })
    expect(text(claude, 'commands/ship.md')).toBe('Ship.\n')
    expect(text(claude, 'commands/lint.md')).toBe('Lint.\n')
    expect(run.packs[1]?.shadowed).toEqual(['commands/ship.md'])

    // Unreachable, with no copy of it left on this PC: nothing of it is removed from an account.
    renameSync(pack, `${pack}-gone`)
    rmSync(cacheRoot, { recursive: true, force: true })
    const offline = await syncCommandPacks({ packs: both, targets, cacheRoot })
    expect(offline.packs[0]?.error).not.toBeNull()
    expect(text(claude, 'commands/ship.md')).toBe('Ship.\n')
    expect(text(codex, 'prompts/ship.md')).toBe('Ship.\n')

    // Off the list: its copies go from every account, and an empty commands folder stays a folder.
    renameSync(`${pack}-gone`, pack)
    await syncCommandPacks({ packs: [{ url: other }], targets, cacheRoot })
    expect(text(claude, 'commands/ship.md')).toBe("The second pack's ship.\n")
    await syncCommandPacks({ packs: [], targets, cacheRoot })
    for (const rel of ['commands/ship.md', 'commands/lint.md']) expect(text(claude, rel)).toBeNull()
    expect(text(codex, 'prompts/lint.md')).toBeNull()
    expect(existsSync(join(claude, 'commands'))).toBe(true)
  },
  GIT_TEST_MS,
)

test(
  'a skill folder an account links to somewhere else is never written through',
  async () => {
    const { base, pack, claude, cacheRoot } = place('linked')
    put(pack, 'skills/lint/SKILL.md', 'The pack lint.\n')
    put(pack, 'skills/lint/extra.md', 'Extra.\n')
    commit(pack, 'first')
    // CliMayte links the owner's own skills into an account folder (climayte-owner-sync.ts).
    const owner = join(base, 'owner-skills', 'lint')
    put(owner, 'SKILL.md', "The owner's lint.\n")
    mkdirSync(join(claude, 'skills'), { recursive: true })
    symlinkSync(
      owner,
      join(claude, 'skills', 'lint'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const run = await syncCommandPacks({
      packs: [{ url: pack }],
      targets: [{ kind: 'claude', dir: claude, label: 'Claude' }],
      cacheRoot,
    })
    expect(text(owner, 'SKILL.md')).toBe("The owner's lint.\n")
    expect(existsSync(join(owner, 'extra.md'))).toBe(false)
    expect(run.targets[0]?.keptOwn).toEqual(['skills/lint/'])
  },
  GIT_TEST_MS,
)
