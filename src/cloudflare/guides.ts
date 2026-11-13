import { MemoryFileSystem } from 'nanocode-ts/bash'
import anti_slop from '../../agents/anti-slop.md'
import builder from '../../agents/builder.md'
import bugs from '../../agents/bugs.md'
import intake from '../../agents/intake.md'
import intent from '../../agents/intent.md'
import late_pass from '../../agents/late-pass.md'
import light from '../../agents/light.md'
import minimize from '../../agents/minimize.md'
import patch from '../../agents/patch.md'
import planner from '../../agents/planner.md'
import profiles_solidity from '../../agents/profiles/solidity.md'
import profiles_typescript from '../../agents/profiles/typescript.md'
import questions from '../../agents/questions.md'
import rules from '../../agents/rules.md'
import shared_factory from '../../agents/shared/factory.md'
import shared_reviewer from '../../agents/shared/reviewer.md'
import shared_ste from '../../agents/shared/ste.md'
import spec from '../../agents/spec.md'
import type { Guides } from '../core/platform.ts'

/** The guideline files, bundled into the Worker by Wrangler's Text rules. */
const texts: Record<string, string> = {
  'anti-slop.md': anti_slop,
  'builder.md': builder,
  'bugs.md': bugs,
  'intake.md': intake,
  'intent.md': intent,
  'late-pass.md': late_pass,
  'light.md': light,
  'minimize.md': minimize,
  'patch.md': patch,
  'planner.md': planner,
  'profiles/solidity.md': profiles_solidity,
  'profiles/typescript.md': profiles_typescript,
  'questions.md': questions,
  'rules.md': rules,
  'shared/factory.md': shared_factory,
  'shared/reviewer.md': shared_reviewer,
  'shared/ste.md': shared_ste,
  'spec.md': spec,
}

const steFile = 'asd-ste100-issue-9.txt'

/**
 * The STE dictionary is not in the repository. When agents/guides/ste holds it at deploy, Wrangler adds it as a
 * module of its own (`find_additional_modules`), and the agents get it at /guides/ste.
 */
async function steDictionary(): Promise<string | null> {
  const path = `./ste/${steFile}`
  try {
    return ((await import(path)) as { default: string }).default
  } catch {
    return null
  }
}

export async function bundledGuides(): Promise<Guides> {
  const ste = await steDictionary()
  return {
    mounts: ste === null ? {} : { ste: MemoryFileSystem.create({ files: { [`/${steFile}`]: ste } }) },
    read(file) {
      const text = texts[file]
      if (text === undefined) throw new Error(`agents/${file} is not bundled; add it to src/cloudflare/guides.ts`)
      return text
    },
  }
}
