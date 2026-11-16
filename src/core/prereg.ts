import type { Contracts } from 'nanocode-ts'
import { artifactId } from './artifacts.ts'

/** The sections that every prereg has. The domain adds its own prereg_sections. */
export const coreSections = ['Hypothesis', 'Data', 'Method', 'Known set', 'Injection grid', 'Decision rules']

export type PreregSection = { name: string; text: string }

/** A checked preregistration of one picked hypothesis. */
export type Prereg = {
  hypothesis: string
  sections: PreregSection[]
  /** The recall threshold of the Known set, from 0 to 1. */
  known_recall: number
}

export type PreregOptions = {
  /** The hypothesis IDs that the user picked. */
  picked: string[]
  /** The prereg_sections of the domain. */
  domainSections: string[]
}

export const submitPrereg: Contracts.HostTool = {
  name: 'submit_prereg',
  description:
    `Submit the prereg one time: the picked hypothesis ID, the sections, and the recall threshold of the Known set. ` +
    `The sections must include ${coreSections.join(', ')} and the domain sections that your task names, each with text. ` +
    'Section names match without case and without the whitespace at the start and end. Extra sections are permitted, a repeated section name is not. ' +
    'The host refuses an unknown hypothesis ID, a missing or empty section, and a known_recall that is not a number from 0 to 1.',
  parameters: {
    type: 'object',
    properties: {
      hypothesis: { type: 'string', description: 'The ID of the picked hypothesis, for example hyp-001' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, text: { type: 'string', description: 'The section in Markdown' } },
          required: ['name', 'text'],
          additionalProperties: false,
        },
      },
      known_recall: { type: 'number', description: 'The recall on the known set that the search must get before the sweep, from 0 to 1' },
    },
    required: ['hypothesis', 'sections', 'known_recall'],
    additionalProperties: false,
  },
}

const sectionKey = (name: string) => name.trim().toLowerCase()

/** Refuses a prereg with an unknown hypothesis, a missing, empty or repeated section, or a bad known_recall. */
export function checkPrereg(input: unknown, options: PreregOptions): Prereg {
  const prereg = input as Prereg
  const problems: string[] = []
  if (typeof prereg?.hypothesis !== 'string' || !options.picked.includes(prereg.hypothesis))
    problems.push(`hypothesis must be one of the picked IDs: ${options.picked.join(', ')}`)
  const sections = Array.isArray(prereg?.sections) ? prereg.sections : []
  if (!Array.isArray(prereg?.sections)) problems.push('sections must be a list')
  const seen = new Set<string>()
  sections.forEach((section, index) => {
    if (typeof section?.name !== 'string' || typeof section.text !== 'string' || !section.name.trim()) {
      problems.push(`sections[${index}]: name and text are required`)
      return
    }
    const key = sectionKey(section.name)
    if (seen.has(key)) problems.push(`sections[${index}]: the section "${section.name.trim()}" repeats`)
    seen.add(key)
  })
  const required = [...coreSections, ...options.domainSections].filter((name, index, all) => all.findIndex((other) => sectionKey(other) === sectionKey(name)) === index)
  for (const name of required)
    if (!sections.some((section) => typeof section?.name === 'string' && sectionKey(section.name) === sectionKey(name) && typeof section.text === 'string' && section.text.trim()))
      problems.push(`the prereg needs the section "${name.trim()}" with text`)
  const recall = prereg?.known_recall
  if (typeof recall !== 'number' || !Number.isFinite(recall) || recall < 0 || recall > 1) problems.push('known_recall must be a number from 0 to 1')
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { hypothesis: prereg.hypothesis, sections: sections.map((section) => ({ name: section.name, text: section.text })), known_recall: prereg.known_recall }
}

/** A prereg as the host commits it. The hash goes into the ledger, the path is protected. */
export type FrozenPrereg = {
  hypothesis: string
  version: number
  path: string
  markdown: string
  /** The SHA-256 lowercase hex of the UTF-8 Markdown. */
  sha256: string
}

/**
 * Makes the frozen Markdown of a checked prereg. The same input always gives the same text.
 * Without an amendment, the version is 1. An amendment gives the earlier frozen version and a reason, and gets the next version.
 */
export async function freezePrereg(prereg: Prereg, amendment: { previous?: FrozenPrereg; reason?: string } = {}): Promise<FrozenPrereg> {
  const { previous, reason } = amendment
  const amends = previous !== undefined || reason !== undefined
  if (amends) {
    const problems = [
      ...(previous === undefined ? ['an amendment needs the earlier frozen version'] : []),
      ...(!reason?.trim() ? ['an amendment needs a reason'] : []),
      ...(previous !== undefined && previous.hypothesis !== prereg.hypothesis ? [`an amendment must be for ${previous.hypothesis}, not ${prereg.hypothesis}`] : []),
    ]
    if (problems.length > 0) throw new Error(problems.join('\n'))
  }
  const version = previous ? previous.version + 1 : 1
  const markdown = [
    `# Prereg ${prereg.hypothesis} v${version}`,
    '',
    `Known recall: ${prereg.known_recall}`,
    '',
    ...(previous && reason ? ['## Amendment', '', `Amends v${previous.version} (SHA-256 ${previous.sha256}).`, '', reason.trim(), ''] : []),
    ...prereg.sections.flatMap((section) => [`## ${section.name.trim()}`, '', section.text.trim(), '']),
  ].join('\n')
  const sha256 = await artifactId(new TextEncoder().encode(markdown))
  return { hypothesis: prereg.hypothesis, version, path: `prereg/${prereg.hypothesis}-v${version}.md`, markdown, sha256 }
}

/**
 * True when a path is prereg/ or inside it, for the protect rail. The path is relative to the repository root,
 * absolute in the repository tree, or under /repo. A path that uses .. to leave prereg/ is not inside it.
 */
export function isPreregPath(path: string): boolean {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.pop() === undefined) return false
    } else parts.push(part)
  }
  if (path.startsWith('/') && parts[0] === 'repo') parts.shift()
  return parts[0] === 'prereg'
}
