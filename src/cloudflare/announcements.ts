// The start comments of the runs. This module has no runtime imports, so that a Node test can import it.

/** The one-line start comment of a development run on an issue. */
export function developAnnouncement(run: string, by: string): string {
  return `agent-factory started development run \`${run}\` for \`${by}\`. Questions come here. Answer them with a \`/answer\` comment.`
}

/** The one-line start comment of a review run on a PR. */
export function reviewAnnouncement(run: string, by: string): string {
  return `agent-factory started review run \`${run}\` for \`${by}\`. Questions come here. Answer them with a \`/answer\` comment.`
}
