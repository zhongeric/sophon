import { MemoryFileSystem } from 'nanocode-ts/bash'
import anti_slop from '../../agents/anti-slop.md'
import bugs from '../../agents/bugs.md'
import intent from '../../agents/intent.md'
import late_pass from '../../agents/late-pass.md'
import minimize from '../../agents/minimize.md'
import patch from '../../agents/patch.md'
import questions from '../../agents/questions.md'
import rules from '../../agents/rules.md'
import shared_factory from '../../agents/shared/factory.md'
import shared_reviewer from '../../agents/shared/reviewer.md'
import shared_solidity from '../../agents/shared/solidity.md'
import shared_ste from '../../agents/shared/ste.md'
import steDictionary from '../../agents/guides/ste/asd-ste100-issue-9.txt'
import type { Guides } from '../core/platform.ts'

/** The guideline files, bundled into the Worker by Wrangler's Text rules. */
const texts: Record<string, string> = {
  'anti-slop.md': anti_slop,
  'bugs.md': bugs,
  'intent.md': intent,
  'late-pass.md': late_pass,
  'minimize.md': minimize,
  'patch.md': patch,
  'questions.md': questions,
  'rules.md': rules,
  'shared/factory.md': shared_factory,
  'shared/reviewer.md': shared_reviewer,
  'shared/solidity.md': shared_solidity,
  'shared/ste.md': shared_ste,
}

export const bundledGuides: Guides = {
  mounts: { ste: MemoryFileSystem.create({ files: { '/asd-ste100-issue-9.txt': steDictionary } }) },
  read(file) {
    const text = texts[file]
    if (text === undefined) throw new Error(`agents/${file} is not bundled; add it to src/cloudflare/guides.ts`)
    return text
  },
}
