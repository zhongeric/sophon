/** The text of a Markdown body that GitHub shows before a click: without the <details> blocks and the HTML comments. */
export function visible(markdown: string): string {
  return markdown.replace(/<details>[\s\S]*?<\/details>/g, '').replace(/<!--[\s\S]*?-->/g, '')
}

export const visibleLines = (markdown: string): string[] => visible(markdown).split('\n').filter((line) => line.trim() !== '')

export const visibleWords = (markdown: string): number => visible(markdown).split(/\s+/).filter((word) => word !== '').length
