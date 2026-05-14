import { useState, useCallback } from 'react'

/* ─── Types ─── */
interface CopyableBlock {
  type: 'comment' | 'command' | 'code' | 'blank'
  text: string
  copyValue?: string   // what gets copied (for multi-line code blocks, the whole block)
}

interface TabData {
  id: string
  label: string
  color: string
  logo?: string
  blocks: CopyableBlock[]
  deepLink?: string
  quickAction?: { label: string; text: string }
}

/* ─── Domain & URLs ─── */
const MCP_SSE = 'https://mcp.agntmpp.xyz/sse'
const MCP_HTTP = 'https://mcp.agntmpp.xyz/mcp'
const MCP_SSE_WITH_CONNECTOR = `${MCP_SSE}?agnt_connector_token=<your connector token>`
const MCP_HTTP_WITH_CONNECTOR = `${MCP_HTTP}?agnt_connector_token=<your connector token>`

/* ─── One-Click Install Deep Links ─── */
const cursorConfig = btoa(JSON.stringify({ url: MCP_SSE_WITH_CONNECTOR }))
const CURSOR_DEEP_LINK = `cursor://anysphere.cursor-deeplink/mcp/install?name=agnt&config=${cursorConfig}`

const vscodeConfig = encodeURIComponent(JSON.stringify({ name: 'agnt', url: MCP_SSE_WITH_CONNECTOR }))
const VSCODE_DEEP_LINK = `vscode://mcp/install?${vscodeConfig}`

/* ─── Reusable snippets ─── */
const JSON_CONFIG = JSON.stringify({ mcpServers: { agnt: { url: MCP_SSE_WITH_CONNECTOR } } }, null, 2)
const VSCODE_JSON = JSON.stringify({ servers: { agnt: { type: 'sse', url: MCP_SSE_WITH_CONNECTOR } } }, null, 2)
const AG_JSON = JSON.stringify({ mcpServers: { agnt: { url: MCP_HTTP, headers: { 'x-agnt-api-key': '<your API key>' } } } }, null, 2)
const OPENCODE_JSON = JSON.stringify({ mcp: { agnt: { type: 'remote', url: MCP_SSE_WITH_CONNECTOR, enabled: true } } }, null, 2)
const GEMINI_JSON = JSON.stringify({ mcpServers: { agnt: { url: MCP_SSE_WITH_CONNECTOR } } }, null, 2)
const AMP_CONFIG = `"amp.mcpServers": {
  "agnt": {
    "url": "${MCP_SSE_WITH_CONNECTOR}"
  }
}`

/* ─── Helpers to build structured blocks ─── */
function comment(text: string): CopyableBlock { return { type: 'comment', text } }
function cmd(text: string): CopyableBlock { return { type: 'command', text, copyValue: text } }
function code(text: string): CopyableBlock { return { type: 'code', text, copyValue: text } }
function blank(): CopyableBlock { return { type: 'blank', text: '' } }

/* ─── Tab data ─── */
const AGENT_TABS: TabData[] = [
  {
    id: 'claude', label: 'Claude', color: '#D97757', logo: '/claudecode-color.svg',
    blocks: [
      comment('─── Option 1: Claude App / Web ───'),
      comment('Go to Settings → Connectors → Add custom connector'),
      comment('Name: agnt'),
      comment('Create a Claude connector URL in your AGNT dashboard, then paste it here:'),
      cmd(MCP_HTTP_WITH_CONNECTOR),
      blank(),
      comment('Legacy SSE URL if your Claude client asks for SSE:'),
      cmd(MCP_SSE_WITH_CONNECTOR),
      blank(),
      comment('─── Option 2: Claude Code (CLI) ───'),
      cmd(`claude mcp add agnt --transport sse "${MCP_SSE_WITH_CONNECTOR}"`),
      blank(),
      comment('─── Start Using ───'),
      comment('"Create a wallet called Trading Bot"'),
      comment('"Swap 100 USDC.e for wETH — show me the fees"'),
    ],
  },
  {
    id: 'codex', label: 'Codex', color: '#10A37F', logo: '/codex-color.svg',
    blocks: [
      comment('─── Add to Codex ───'),
      comment('1. Press Ctrl+Shift+P'),
      comment('2. Search "MCP" → Click "Add Server"'),
      comment('3. Name: agnt'),
      comment('4. Change type to "Streamable HTTP"'),
      comment('5. Paste URL:'),
      cmd(MCP_HTTP),
      comment('6. Add header x-agnt-api-key with your AGNT API key'),
      comment('7. Click Save'),
      blank(),
      comment('─── Start Using ───'),
      comment('"Create a DeFi wallet called Alpha"'),
      comment('"What\'s the best yield for USDC above 5% APY?"'),
    ],
  },
  {
    id: 'cursor', label: 'Cursor', color: '#00A0FF', logo: '/cursor-for-terminal.svg',
    deepLink: CURSOR_DEEP_LINK,
    blocks: [
      comment('─── Alternative: Manual Setup ───'),
      comment('1. Press Ctrl+Shift+P'),
      comment('2. Search "Cursor Settings"'),
      comment('3. Navigate to Tools & MCPs'),
      comment('4. Click "New MCP Server"'),
      comment('5. Paste the JSON below:'),
      code(JSON_CONFIG),
      comment('6. Press Ctrl+S to save'),
    ],
  },
  {
    id: 'vscode', label: 'VS Code', color: '#007ACC', logo: '/vscode.svg',
    deepLink: VSCODE_DEEP_LINK,
    blocks: [
      comment('─── Alternative: Manual Setup ───'),
      comment('1. Press Ctrl+Shift+P'),
      comment('2. Search "MCP: Add Server" and click'),
      comment('3. Select "HTTP" (HTTP or Server-Sent Events)'),
      comment('4. Enter URL:'),
      cmd(MCP_SSE_WITH_CONNECTOR),
      comment('5. Enter name: agnt'),
      comment('6. Choose "Global"'),
      blank(),
      comment('─── Or create .vscode/mcp.json: ───'),
      code(VSCODE_JSON),
    ],
  },
  {
    id: 'opencode', label: 'OpenCode', color: '#E8E8E8', logo: '/opencode-for-terminal.svg',
    blocks: [
      comment('─── Option 1: CLI ───'),
      cmd('opencode mcp add'),
      blank(),
      comment('Follow the prompts:'),
      comment('  Name: agnt'),
      comment('  Type: Remote'),
      comment('  URL:'),
      cmd(MCP_SSE_WITH_CONNECTOR),
      blank(),
      comment('─── Option 2: Config File ───'),
      comment('Add to opencode.json in your project root:'),
      code(OPENCODE_JSON),
      blank(),
      comment('Verify:'),
      cmd('opencode mcp list'),
    ],
  },
  {
    id: 'gemini', label: 'Gemini CLI', color: '#4285F4', logo: '/geminicli-color.svg',
    blocks: [
      comment('─── Add to Gemini CLI ───'),
      comment('Edit ~/.gemini/settings.json and add:'),
      code(GEMINI_JSON),
      blank(),
      comment('Restart Gemini CLI and verify:'),
      cmd('/mcp list'),
    ],
  },
  {
    id: 'antigravity', label: 'Antigravity', color: '#8B5CF6', logo: '/antigravity-color.svg',
    blocks: [
      comment('─── Alternative: Manual Setup ───'),
      comment('1. Press Ctrl+Shift+P'),
      comment('2. Search "Manage MCP Servers"'),
      comment('3. Click "View Raw Config"'),
      comment('4. Paste the JSON below:'),
      code(AG_JSON),
      comment('5. Press Ctrl+S to save'),
    ],
  },
  {
    id: 'windsurf', label: 'Windsurf', color: '#00C896', logo: '/windsurf-for-terminal.svg',
    blocks: [
      comment('─── Add to Windsurf ───'),
      comment('1. Press Ctrl+Shift+P'),
      comment('2. Search "MCP Registry"'),
      comment('3. Click the Settings icon ⚙️'),
      comment('4. Paste the JSON below:'),
      code(JSON_CONFIG),
      comment('5. Press Ctrl+S to save'),
    ],
  },
  {
    id: 'amp', label: 'Amp', color: '#FF6B35', logo: '/amp-color.svg',
    blocks: [
      comment('─── Option 1: CLI (Recommended) ───'),
      cmd(`amp mcp add agnt "${MCP_SSE_WITH_CONNECTOR}"`),
      blank(),
      comment('─── Option 2: Config File ───'),
      comment('Add to your Amp configuration:'),
      code(AMP_CONFIG),
    ],
  },
  {
    id: 'openclaw', label: 'OpenClaw', color: '#C0C0C0', logo: '/openclaw.svg',
    blocks: [
      comment('─── Add to OpenClaw ───'),
      comment('Edit ~/.openclaw/openclaw.json and add:'),
      code(JSON.stringify({ mcpServers: { agnt: { url: MCP_SSE_WITH_CONNECTOR } } }, null, 2)),
      blank(),
      comment('Or if you have an existing config, add under mcpServers:'),
      code(`"agnt": {\n  "url": "${MCP_SSE_WITH_CONNECTOR}"\n}`),
      blank(),
      comment('Restart your OpenClaw runtime to connect'),
    ],
  },
  {
    id: 'hermes', label: 'Hermes', color: '#7C3AED', logo: '/hermesagents.webp',
    blocks: [
      comment('─── Add to Hermes Agent ───'),
      comment('Edit ~/.hermes/.env or hermes config and add:'),
      code(JSON.stringify({ mcpServers: { agnt: { url: MCP_SSE_WITH_CONNECTOR } } }, null, 2)),
      blank(),
      comment('Or add via Hermes plugin CLI:'),
      cmd('hermes plugins add agnt --mcp-url "' + MCP_SSE_WITH_CONNECTOR + '"'),
      blank(),
      comment('Verify:'),
      cmd('hermes plugins list'),
    ],
  },
  {
    id: 'kimi', label: 'Kimi CLI', color: '#6366F1', logo: '/kimi-for-terminal.svg',
    blocks: [
      comment('─── Option 1: CLI (Recommended) ───'),
      cmd(`kimi mcp add --transport http agnt "${MCP_HTTP_WITH_CONNECTOR}"`),
      blank(),
      comment('Verify:'),
      cmd('kimi mcp list'),
      blank(),
      comment('─── Option 2: Config File ───'),
      comment('Edit ~/.kimi/mcp.json and add:'),
      code(JSON.stringify({ mcpServers: { agnt: { url: MCP_HTTP_WITH_CONNECTOR } } }, null, 2)),
      blank(),
      comment('Inside Kimi CLI, check with:'),
      cmd('/mcp'),
    ],
  },
  {
    id: 'minimax', label: 'MiniMax', color: '#FFD700', logo: '/minimax.svg',
    blocks: [
      comment('─── Add to MiniMax Agent ───'),
      comment('1. Click the ☰ (sliders) toggle button on the chat bar'),
      comment('2. Click "MCP"'),
      comment('3. Click "Manage MCP"'),
      comment('4. Click "+ Custom"'),
      comment('5. Name: agnt'),
      comment('6. Paste URL:'),
      cmd(MCP_SSE_WITH_CONNECTOR),
      comment('7. Click Confirm'),
      blank(),
      comment('─── Start Using ───'),
      comment('"Create a wallet called Alpha"'),
      comment('"Swap 50 USDC to wETH on Base"'),
    ],
  },
  {
    id: 'selfhost', label: 'Self Host', color: '#22D3EE',
    blocks: [
      comment('─── Self-Host Your Own MCP Server ───'),
      blank(),
      comment('1. Clone the repository'),
      cmd('git clone https://github.com/user/agnt.git && cd agnt'),
      blank(),
      comment('2. Install dependencies'),
      cmd('npm install'),
      blank(),
      comment('3. Create .env and set your keys'),
      cmd('cp .env.example .env'),
      comment('   Edit .env with your RPC URLs, private keys, etc.'),
      blank(),
      comment('4. Start the MCP server'),
      cmd('npm run mcp:serve'),
      blank(),
      comment('Server runs at http://localhost:3001/sse'),
      comment('Point your agent config to this local URL instead:'),
      code(JSON.stringify({ mcpServers: { agnt: { url: 'http://localhost:3001/sse' } } }, null, 2)),
      blank(),
      comment('Your keys never leave your machine.'),
    ],
  },
  {
    id: 'other', label: 'Other', color: '#FFFFFF',
    blocks: [
      comment('─── Any MCP-Compatible Agent ───'),
      blank(),
      comment('CLI-based agents:'),
      cmd(`<agent> mcp add agnt --transport sse "${MCP_SSE_WITH_CONNECTOR}"`),
      blank(),
      comment('Config-based agents — add to your MCP config:'),
      code(JSON_CONFIG),
      blank(),
      comment('Self-host:'),
      cmd('npx @agnt/mcp'),
    ],
  },
]

/* ─── Icons ─── */
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 1v10M4 7l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CopyIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* ─── Inline copy button ─── */
function InlineCopy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [value])

  return (
    <button
      className={`inline-copy-btn${copied ? ' inline-copy-btn--done' : ''}`}
      onClick={handleCopy}
      title="Copy"
    >
      {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
    </button>
  )
}

/* ─── Block renderer ─── */
function CodeBlock({ block }: { block: CopyableBlock }) {
  if (block.type === 'blank') return <div className="term-blank" />

  if (block.type === 'comment') {
    return <div className="term-comment"><span># {block.text}</span></div>
  }

  if (block.type === 'command') {
    return (
      <div className="term-command">
        <code>{block.text}</code>
        <InlineCopy value={block.copyValue!} />
      </div>
    )
  }

  return (
    <div className="term-code">
      <pre><code>{block.text}</code></pre>
      <InlineCopy value={block.copyValue!} />
    </div>
  )
}

/* ─── Main Component ─── */
export default function Terminal() {
  const [tab, setTab] = useState('claude')
  const [quickCopied, setQuickCopied] = useState(false)
  const data = AGENT_TABS.find((t) => t.id === tab)!

  const quickCopy = useCallback(() => {
    if (data.quickAction) {
      navigator.clipboard.writeText(data.quickAction.text)
      setQuickCopied(true)
      setTimeout(() => setQuickCopied(false), 2000)
    }
  }, [data])

  const hasAction = data.deepLink || data.quickAction

  return (
    <div className="agent-terminal">
      <div className="agent-terminal-header">
        <h3>Connect Your Agent</h3>
        <p>Create an AGNT account, generate an API key or Claude connector URL, then add the hosted MCP server to your agent.</p>
      </div>

      {/* ── Capsule tab strip ── */}
      <div className="at-capsule-strip">
        {AGENT_TABS.map((t) => (
          <button
            key={t.id}
            className={`at-capsule${tab === t.id ? ' at-capsule--active' : ''}`}
            style={{ '--brand': t.color } as React.CSSProperties}
            onClick={() => { setTab(t.id); setQuickCopied(false) }}
          >
            {t.logo
              ? <img src={t.logo} alt="" className="at-capsule-logo" />
              : <span className="at-capsule-dot" style={{ background: t.color }} />
            }
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* ── Terminal window ── */}
      <div className="at-window">
        <div className="at-chrome">
          <div className="at-chrome-dots">
            <span style={{ background: '#FF5F57' }} />
            <span style={{ background: '#FEBC2E' }} />
            <span style={{ background: '#28C840' }} />
          </div>
          <span className="at-chrome-title">
            {data.logo && <img src={data.logo} alt="" className="at-chrome-logo" />}
            {data.label} — setup
          </span>
          {hasAction && (
            <div className="at-chrome-action">
              {data.deepLink ? (
                <a href={data.deepLink} className="at-action-btn">
                  <DownloadIcon />
                  Add to {data.label}
                </a>
              ) : data.quickAction ? (
                <button
                  className={`at-action-btn at-action-btn--outline${quickCopied ? ' at-action-btn--done' : ''}`}
                  onClick={quickCopy}
                >
                  {quickCopied ? <CheckIcon /> : <CopyIcon />}
                  {quickCopied ? 'Copied!' : data.quickAction.label}
                </button>
              ) : null}
            </div>
          )}
        </div>

        <div className="at-body">
          {data.blocks.map((block, i) => (
            <CodeBlock key={`${tab}-${i}`} block={block} />
          ))}
        </div>
      </div>
    </div>
  )
}
