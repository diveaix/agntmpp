export type DocBlock =
  | { type: 'heading'; id: string; text: string }
  | { type: 'text'; text: string }
  | { type: 'code'; label: string; language: string; code: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'note'; title: string; text: string }
  | { type: 'links'; items: { title: string; description: string; href: string }[] }
  | { type: 'flow'; items: string[] }
  | { type: 'catalog' }

export type DocArticle = {
  id: string
  group: string
  title: string
  description: string
  blocks: DocBlock[]
}
