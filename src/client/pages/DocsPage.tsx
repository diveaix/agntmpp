import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Nav from '../components/Nav'
import { articles, docGroups } from '../docs/content'
import { toolReference, type DocTool } from '../docs/tool-reference'
import type { DocArticle, DocBlock } from '../docs/types'
import '../docs.css'

const docUrl = (id: string, section?: string) => `/docs#${id}${section ? `--${section}` : ''}`

function CodeBlock({ label, language, code }: { label: string; language: string; code: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const resetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(resetRef.current), [])
  async function copy() {
    clearTimeout(resetRef.current)
    try {
      await navigator.clipboard.writeText(code)
      setStatus('copied')
    } catch { setStatus('error') }
    resetRef.current = setTimeout(() => setStatus('idle'), 2200)
  }
  return <div className="manual-code">
    <div className="manual-code-heading"><span>{label}</span><button type="button" onClick={copy} aria-label={`Copy ${label}`} aria-live="polite">{status === 'copied' ? 'Copied ✓' : status === 'error' ? 'Select and copy' : 'Copy'}</button></div>
    <pre tabIndex={0}><code>{code}</code></pre><div className="manual-code-language">{language}</div>
  </div>
}

function DocTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return <div className="manual-table" tabIndex={0} role="region" aria-label={`${columns.join(', ')} table`}>
    <table><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, i) => i === 0 ? <th scope="row" key={i}>{cell}</th> : <td key={i}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>
}

function ToolEntry({ tool }: { tool: DocTool }) {
  return <section className="manual-tool" id={`tool-reference--${tool.name}`}>
    <div className="manual-tool-category">{tool.category}</div>
    <h2><a href={docUrl('tool-reference', tool.name)}>{tool.name}<span aria-hidden="true">#</span></a></h2>
    <p>{tool.description}</p>
    <div className="manual-actions" aria-label="Actions">{tool.actions.map(action => <code key={action}>{action}</code>)}</div>
    <details className="manual-parameters">
      <summary>Input parameters <span>{tool.parameters.length} fields</span></summary>
      <div className="manual-parameter-list">{tool.parameters.map(parameter => <div key={parameter.name}>
        <div className="manual-parameter-name"><code>{parameter.name}</code><span>{parameter.type}</span>{parameter.required && <b>required</b>}</div>
        <p>{parameter.description}</p>
        {parameter.values && <div className="manual-parameter-values">{parameter.values.map(value => <code key={value}>{value}</code>)}</div>}
      </div>)}</div>
    </details>
    <CodeBlock label={`${tool.name} · example arguments`} language="json" code={JSON.stringify({ name: tool.name, arguments: tool.example }, null, 2)} />
    <div className="manual-handler-notes"><h3>Action notes</h3><ul>{tool.notes.map(note => <li key={note}>{note}</li>)}</ul></div>
    <p className="manual-source">Source <code>{tool.source}</code></p>
  </section>
}

function Block({ block, article }: { block: DocBlock; article: DocArticle }) {
  switch (block.type) {
    case 'heading': return <h2 className="manual-heading" id={`${article.id}--${block.id}`}><a href={docUrl(article.id, block.id)}>{block.text}<span aria-hidden="true">#</span></a></h2>
    case 'text': return <p>{block.text}</p>
    case 'code': return <CodeBlock {...block} />
    case 'table': return <DocTable {...block} />
    case 'note': return <aside className="manual-note"><span aria-hidden="true">i</span><div><h3>{block.title}</h3><p>{block.text}</p></div></aside>
    case 'flow': return <ol className="manual-flow">{block.items.map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, '0')}</span>{item}</li>)}</ol>
    case 'list': return block.ordered ? <ol className="manual-list manual-list-ordered">{block.items.map(item => <li key={item}>{item}</li>)}</ol> : <ul className="manual-list">{block.items.map(item => <li key={item}>{item}</li>)}</ul>
    case 'links': return <div className="manual-links">{block.items.map(item => item.href.startsWith('/')
      ? <Link key={item.href} to={item.href}><span><strong>{item.title}</strong><small>{item.description}</small></span><span aria-hidden="true">↗</span></Link>
      : <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer"><span><strong>{item.title}</strong><small>{item.description}</small></span><span aria-hidden="true">↗</span></a>)}</div>
    case 'catalog': return <div className="manual-catalog">{toolReference.map(tool => <ToolEntry tool={tool} key={tool.name} />)}</div>
  }
}

// Plain text only: source examples remain inert and are never executed by the docs.
function blockText(block: DocBlock): string {
  switch (block.type) {
    case 'heading': case 'text': return block.text
    case 'code': return `${block.label} ${block.code}`
    case 'note': return `${block.title} ${block.text}`
    case 'table': return [...block.columns, ...block.rows.flat()].join(' ')
    case 'flow': case 'list': return block.items.join(' ')
    case 'links': return block.items.map(item => `${item.title} ${item.description}`).join(' ')
    default: return ''
  }
}

const searchable = articles.flatMap(article => {
  const entries = [{ title: article.title, group: article.group, text: article.description, href: docUrl(article.id) }]
  let entry = entries[0]
  article.blocks.forEach(block => {
    if (block.type === 'heading') {
      entry = { title: `${article.title.replace(/\.$/, '')} / ${block.text}`, group: article.group, text: '', href: docUrl(article.id, block.id) }
      entries.push(entry)
    } else entry.text += ` ${blockText(block)}`
  })
  return entries
}).concat(toolReference.map(tool => ({ title: tool.name, group: 'Tool reference', text: `${tool.description} ${tool.actions.join(' ')} ${tool.parameters.map(p => `${p.name} ${p.description}`).join(' ')} ${tool.notes.join(' ')}`, href: docUrl('tool-reference', tool.name) })))

export default function DocsPage() {
  const { hash } = useLocation()
  const rawId = hash.slice(1).split('--')[0]
  const article = articles.find(item => item.id === rawId) ?? articles[0]
  const articleIndex = articles.indexOf(article)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const headings = useMemo(() => article.id === 'tool-reference'
    ? toolReference.map(tool => ({ id: `tool-reference--${tool.name}`, text: tool.name }))
    : article.blocks.flatMap(block => block.type === 'heading' ? [{ id: `${article.id}--${block.id}`, text: block.text }] : []), [article])
  const words = article.blocks.map(blockText).join(' ').split(/\s+/).length
  const results = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return searchable.filter(entry => terms.every(term => `${entry.title} ${entry.text}`.toLowerCase().includes(term)))
      .sort((a, b) => Number(b.title.toLowerCase().includes(query.toLowerCase().trim())) - Number(a.title.toLowerCase().includes(query.toLowerCase().trim())))
  }, [query])

  useEffect(() => {
    const oldTitle = document.title
    document.title = `${article.title.replace(/\.$/, '')} — AGENT Docs`
    return () => { document.title = oldTitle }
  }, [article])

  useEffect(() => {
    setQuery('')
    setMenuOpen(false)
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(hash.slice(1))
      if (hash.includes('--') && target) target.scrollIntoView({ block: 'start', behavior: 'instant' })
      else window.scrollTo({ top: 0, behavior: 'instant' })
    })
    return () => cancelAnimationFrame(frame)
  }, [hash])

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
      if (visible.length) setActiveHeading(visible[0].target.id)
    }, { rootMargin: '-100px 0px -65% 0px' })
    setActiveHeading(headings[0]?.id ?? '')
    headings.forEach(heading => {
      const target = document.getElementById(heading.id)
      if (target) observer.observe(target)
    })
    return () => observer.disconnect()
  }, [headings])

  useEffect(() => {
    const sidebar = sidebarRef.current
    const selected = sidebar?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!sidebar?.clientHeight || !selected) return
    const top = selected.offsetTop
    if (top < sidebar.scrollTop || top + selected.offsetHeight > sidebar.scrollTop + sidebar.clientHeight) {
      sidebar.scrollTop = Math.max(0, top - sidebar.clientHeight / 2)
    }
  }, [article.id])

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.scrollIntoView({ block: 'center' })
      }
      if (event.key === 'Escape') { setQuery(''); setMenuOpen(false) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  function selectResult() {
    setQuery('')
    requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }))
  }

  return <div className="manual-page">
    <Nav />
    <a className="manual-skip" href="#manual-article" onClick={event => { event.preventDefault(); articleRef.current?.focus(); articleRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }) }}>Skip to article</a>
    <div className="manual-shell">
      <header className="manual-topbar">
        <Link className="manual-wordmark" to="/docs"><img src="/dotslashagent.svg?v=2" alt="" /><span>AGENT <b> / Docs</b></span></Link>
        <div className="manual-search">
          <span className="manual-search-icon" aria-hidden="true">⌕</span>
          <input ref={searchRef} type="search" aria-label="Search documentation" aria-controls={query.trim() ? 'manual-search-results' : undefined} placeholder="Search guides, tools, and concepts…" value={query} onChange={event => setQuery(event.target.value)} />
          {query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus() }}>×</button> : <kbd>Ctrl K</kbd>}
          {query.trim() && <div className="manual-search-results" id="manual-search-results">
            <p role="status">{results.length ? `${results.length} results${results.length > 12 ? ' · showing the first 12' : ''}` : 'No matches. Try a tool name, network, or action.'}</p>
            {results.slice(0, 12).map(result => <Link key={result.href} to={result.href} onClick={selectResult}><small>{result.group}</small><strong>{result.title}</strong><span>{result.text.trim().slice(0, 145)}…</span></Link>)}
          </div>}
        </div>
        <span className="manual-edition">Developer manual <span>v2.1</span></span>
      </header>
      <div className="manual-mobile-bar"><span>{article.group}</span><button type="button" aria-expanded={menuOpen} aria-controls="manual-sidebar" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? 'Close contents −' : 'Browse docs +'}</button></div>
      <div className="manual-layout">
        <aside ref={sidebarRef} className={`manual-sidebar${menuOpen ? ' is-open' : ''}`} id="manual-sidebar" aria-label="Documentation navigation">
          {docGroups.map(group => <div className="manual-nav-group" key={group}><h2>{group}</h2>{articles.filter(item => item.group === group).map(item => <Link key={item.id} to={docUrl(item.id)} aria-current={article.id === item.id ? 'page' : undefined} onClick={() => setMenuOpen(false)}>{item.title.replace(/\.$/, '')}</Link>)}</div>)}
          <Link className="manual-sidebar-cta" to="/toolkit">Open the toolkit <span aria-hidden="true">↗</span></Link>
        </aside>
        <main className="manual-content" ref={articleRef} id="manual-article" tabIndex={-1}>
          <article key={article.id}>
            <header className="manual-hero" id={article.id}>
              <div className="manual-breadcrumb"><Link to="/docs">Docs</Link><span>/</span><span>{article.group}</span></div>
              <h1>{article.title}</h1><p>{article.description}</p>
              <div className="manual-meta"><span>{article.id === 'tool-reference' ? `${toolReference.length} tools · ${toolReference.reduce((sum, tool) => sum + tool.parameters.length, 0)} parameters` : `${Math.max(2, Math.ceil(words / 200))} min read`}</span><span>{article.id === 'tool-reference' ? 'Schema reference' : `${headings.length} sections`}</span></div>
            </header>
            <div className="manual-body">{article.blocks.map((block, index) => <Block key={index} block={block} article={article} />)}</div>
          </article>
          <div className="manual-pager">
            {articleIndex > 0 ? <Link to={docUrl(articles[articleIndex - 1].id)}><small>← Previous</small><span>{articles[articleIndex - 1].title}</span></Link> : <span />}
            {articleIndex < articles.length - 1 && <Link to={docUrl(articles[articleIndex + 1].id)}><small>Next →</small><span>{articles[articleIndex + 1].title}</span></Link>}
          </div>
          <footer className="manual-bottom"><span>./AGENT · Developer documentation</span><button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'instant' })}>Back to top ↑</button></footer>
        </main>
        <aside className="manual-toc" aria-label="On this page"><h2>On this page</h2>{headings.map(heading => <Link key={heading.id} to={`/docs#${heading.id}`} aria-current={activeHeading === heading.id ? 'location' : undefined}>{heading.text.replace(/\.$/, '')}</Link>)}<div className="manual-toc-footer"><span>One connection.</span><span>Three wallets.</span><Link to="/docs#architecture">Explore the architecture ↗</Link></div></aside>
      </div>
    </div>
  </div>
}
