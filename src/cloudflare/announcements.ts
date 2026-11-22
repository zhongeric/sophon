// The header of the status comment of each run, after its state (D21). This module has no runtime imports, so that a Node test can import it.

const header = (kind: string, run: string, by: string) =>
  `agent-factory ${kind} run \`${run}\` for \`${by}\`. Questions come here. Answer them with a \`/answer\` comment.`

/** The header of the status comment of a development run on an issue. */
export function developAnnouncement(run: string, by: string): string {
  return header('development', run, by)
}

/** The header of the status comment of a research run on an issue. */
export function researchAnnouncement(run: string, by: string): string {
  return header('research', run, by)
}

/** The header of the status comment of a review run on a PR. */
export function reviewAnnouncement(run: string, by: string): string {
  return header('review', run, by)
}
