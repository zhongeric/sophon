// The header of the status comment of each run, after its state (D21). This module has no runtime imports, so that a Node test can import it.

/** The header of the status comment of a development, research or review run. */
export const statusHeader = (kind: 'development' | 'research' | 'review', run: string, by: string) =>
  `agent-factory ${kind} run \`${run}\` for \`${by}\`. Questions come here. Answer them with a \`/answer\` comment.`
