import { parseLocation, type Finding } from './findings.ts'

/** Changed lines (added and removed) for each bugs reviewer of a large change. */
export const bugsShardLines = 600
/** The most bugs reviewers for one diff. They run at the same time. */
export const maxBugsShards = 4
/** The most patch agents for one patch step. They run at the same time. */
export const maxPatchGroups = 4

export type DiffFile = { path: string; lines: number; section: string }

/** The file sections of a git diff, each with its count of added and removed lines. */
export function diffFiles(diff: string): DiffFile[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
    .map((section) => {
      const header = section.split('\n', 1)[0]!
      const lines = section.split('\n').filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line)).length
      return { path: / b\/(.+)$/.exec(header)?.[1] ?? header, lines, section }
    })
}

/** The sections of `diff` for the files in `paths`. */
export function diffOf(diff: string, paths: string[]): string {
  const wanted = new Set(paths)
  return diffFiles(diff)
    .filter((file) => wanted.has(file.path))
    .map((file) => file.section)
    .join('')
}

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const linesOf = (files: DiffFile[]) => files.reduce((sum, file) => sum + file.lines, 0)

/**
 * Splits the files of a diff across bugs reviewers: one reviewer for each `bugsShardLines` changed lines, at most
 * `maxBugsShards`. The files of one directory stay with one reviewer, unless the directory alone is larger than one
 * share. Returns the paths of each reviewer, and one list when one reviewer is enough.
 */
export function bugsShards(diff: string): string[][] {
  const files = diffFiles(diff)
  const total = linesOf(files)
  const count = Math.min(maxBugsShards, Math.max(1, Math.ceil(total / bugsShardLines)))
  if (count === 1) return [files.map((file) => file.path)]
  const share = total / count
  const dirs = new Map<string, DiffFile[]>()
  for (const file of files) dirs.set(dirOf(file.path), [...(dirs.get(dirOf(file.path)) ?? []), file])
  const units = [...dirs.values()].flatMap((group) => (linesOf(group) > share ? group.map((file) => [file]) : [group]))
  units.sort((a, b) => linesOf(b) - linesOf(a) || a[0]!.path.localeCompare(b[0]!.path))
  // The largest unit first, each to the reviewer with the fewest lines so far.
  const shards = Array.from({ length: count }, () => ({ lines: 0, paths: [] as string[] }))
  for (const unit of units) {
    const target = shards.reduce((least, shard) => (shard.lines < least.lines ? shard : least))
    target.lines += linesOf(unit)
    target.paths.push(...unit.map((file) => file.path))
  }
  return shards.filter((shard) => shard.paths.length > 0).map((shard) => shard.paths.sort())
}

/** The findings of one patch agent, and the files that only this agent may write. */
export type PatchGroup = { findings: Finding[]; files: string[] }

const fileOf = (finding: Finding) => parseLocation(finding.location)?.path ?? finding.location

/**
 * Splits the kept findings across patch agents that work at the same time. The findings in one file go to one agent,
 * which owns that file. An info finding goes to the agent that owns its file, and the other info findings go
 * together to one agent of their own. Above `maxPatchGroups`, the two groups with the fewest findings merge, until
 * the count is correct. The info group does not merge.
 */
export function patchGroups(kept: Finding[]): PatchGroup[] {
  const owner = new Map<string, PatchGroup>()
  const groups: PatchGroup[] = []
  for (const finding of kept.filter((item) => item.severity !== 'info')) {
    const file = fileOf(finding)
    let group = owner.get(file)
    if (!group) {
      group = { findings: [], files: [file] }
      owner.set(file, group)
      groups.push(group)
    }
    group.findings.push(finding)
  }
  const info: PatchGroup = { findings: [], files: [] }
  for (const finding of kept.filter((item) => item.severity === 'info')) {
    const file = fileOf(finding)
    const group = owner.get(file)
    if (group) group.findings.push(finding)
    else {
      info.findings.push(finding)
      if (!info.files.includes(file)) info.files.push(file)
    }
  }
  const limit = maxPatchGroups - (info.findings.length > 0 ? 1 : 0)
  while (groups.length > limit) {
    const [first, second] = [...groups.keys()].sort((a, b) => groups[a]!.findings.length - groups[b]!.findings.length || a - b)
    const [keep, merge] = first! < second! ? [first!, second!] : [second!, first!]
    groups[keep] = { findings: [...groups[keep]!.findings, ...groups[merge]!.findings], files: [...groups[keep]!.files, ...groups[merge]!.files] }
    groups.splice(merge, 1)
  }
  const order = new Map(kept.map((finding, index) => [finding.id, index]))
  const sorted = (group: PatchGroup) => ({ ...group, findings: group.findings.sort((a, b) => order.get(a.id)! - order.get(b.id)!) })
  return [...groups, ...(info.findings.length > 0 ? [info] : [])].map(sorted)
}

/**
 * Who may write each file while patch agents work at the same time: the agent whose group owns the file. A file that
 * no group owns goes to the first agent that writes it. `claims` holds those first writes, and `save` records them,
 * so that a resumed step keeps them.
 */
export function fileOwners(groups: PatchGroup[], claims: Record<string, number>, save: (claims: Record<string, number>) => void) {
  const owners = new Map(groups.flatMap((group, index) => group.files.map((file) => [file, index] as const)))
  return (agent: number) =>
    (path: string): boolean => {
      const owner = owners.get(path) ?? claims[path]
      if (owner !== undefined) return owner === agent
      claims[path] = agent
      save(claims)
      return true
    }
}
