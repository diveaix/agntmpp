import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

/* ── Time-sensitive multilingual greetings ── */
function getGreeting(): string {
  const hour = new Date().getHours()
  const greetings: Record<string, string[]> = {
    morning:   ['Good morning', 'おはよう', 'Buenos días', 'Bonjour', 'सुप्रभात', 'Guten Morgen', 'Buongiorno', 'Bom dia', '좋은 아침', 'صبح بخیر'],
    afternoon: ['Good afternoon', 'こんにちは', 'Buenas tardes', 'Bon après-midi', 'नमस्ते', 'Guten Tag', 'Buon pomeriggio', 'Boa tarde', '안녕하세요', 'خوش آمدید'],
    evening:   ['Good evening', 'こんばんは', 'Buenas noches', 'Bonsoir', 'शुभ संध्या', 'Guten Abend', 'Buonasera', 'Boa noite', '좋은 저녁', 'شب بخیر'],
    night:     ['Hey, night owl', 'おつかれさま', 'Buenas noches', 'Bonne nuit', 'शुभ रात्रि', 'Gute Nacht', 'Buonanotte', 'Boa noite', '좋은 밤', 'شب بخیر'],
  }
  let pool: string[]
  if (hour >= 5 && hour < 12) pool = greetings.morning
  else if (hour >= 12 && hour < 17) pool = greetings.afternoon
  else if (hour >= 17 && hour < 21) pool = greetings.evening
  else pool = greetings.night
  return pool[Math.floor(Math.random() * pool.length)]
}
import Footer from '../components/Footer'
import Nav from '../components/Nav'

type Entitlement = {
  dataAutomationSlots: number
  customSourceSlots: number
  eventEvaluationsMonthly: number
  executionsMonthly: number
}

type ApiKey = {
  id: string
  ownerEmail?: string
  prefix: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  canReveal: boolean
}

type ConnectorLink = {
  id: string
  userId: string
  apiKeyId: string
  prefix: string
  label: string
  client: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

type Automation = {
  id: string
  type: string
  name: string
  status: string
  params: Record<string, unknown>
  createdAt: string
  lastRun: string | null
  nextRun: string | null
  runCount: number
}

type HistoryItem = {
  automationId: string
  automationName: string
  kind?: 'automation' | 'tool'
  title?: string
  type: string
  time: string
  result: string
  success: boolean
}

type Source = {
  id: string
  handle: string
  displayName?: string
  topics: string[]
  keywords: string[]
  enabled: boolean
  trustScore: number
}

type WalletBalance = {
  chain: string
  chainLabel: string
  symbol: string
  balance: string
  error?: string
}

type WalletSummary = {
  name: string
  address: string
  createdAt: string
  active: boolean
  balances: WalletBalance[]
}

type WalletsResponse = {
  wallets: WalletSummary[]
  activeIndex: number
  exportAvailable: boolean
  passwordSet: boolean
}

type DashboardMe = {
  user: { id: string; email?: string }
  plan: string
  subscriptionStatus: string
  entitlement: Entitlement
  counts: { automations: number; activeAutomations: number; customSources: number }
  apiKeys: ApiKey[]
  error?: string
  error_description?: string
}

type DashboardSnapshot = {
  me: DashboardMe
  apiKeys: ApiKey[]
  connectorLinks: ConnectorLink[]
  automations: Automation[]
  history: HistoryItem[]
  sources: Source[]
  sourceLimit: number
  wallets: WalletSummary[]
  walletExportAvailable: boolean
  walletPasswordSet: boolean
}

let dashboardSnapshot: DashboardSnapshot | null = null

type JsonError = { error?: string; error_description?: string }

async function readJson<T>(response: Response): Promise<T> {
  const raw = await response.text()
  if (!raw.trim()) throw new Error(`Dashboard server returned an empty ${response.status} response. Make sure the AGNT MCP backend is running.`)
  let json: T
  try {
    json = JSON.parse(raw) as T
  } catch {
    throw new Error('Dashboard server returned HTML instead of JSON. Open the dashboard through the AGNT server or start the MCP backend with npm run mcp:serve.')
  }
  const errorJson = json as JsonError
  if (!response.ok) throw new Error(errorJson.error_description || errorJson.error || `Request failed with ${response.status}.`)
  return json
}

function dateText(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'N/A'
}

function topicFromAutomation(auto: Automation) {
  const trigger = auto.params?.trigger as { topic?: string } | undefined
  return trigger?.topic || auto.type
}

function shortAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

function balanceText(balance: string) {
  const numeric = Number(balance)
  if (!Number.isFinite(numeric)) return balance
  if (numeric === 0) return '0'
  if (Math.abs(numeric) >= 1_000_000_000) return numeric.toExponential(4)
  if (numeric < 0.000001) return '<0.000001'
  return numeric.toLocaleString(undefined, { maximumFractionDigits: numeric < 1 ? 6 : 4 })
}

function visibleBalances(balances: WalletBalance[]) {
  return balances.filter((balance) => {
    if (balance.error) return true
    const numeric = Number(balance.balance)
    return Number.isFinite(numeric) && numeric > 0 && numeric < 1_000_000_000
  })
}

/* ── Tab navigation ── */
const TABS = ['overview', 'wallets', 'keys', 'automations', 'sources', 'history'] as const
type Tab = typeof TABS[number]

export default function DashboardPage() {
  const [email, setEmail] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState('')
  const [me, setMe] = useState<DashboardMe | null>(dashboardSnapshot?.me || null)
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(dashboardSnapshot?.apiKeys || [])
  const [connectorLinks, setConnectorLinks] = useState<ConnectorLink[]>(dashboardSnapshot?.connectorLinks || [])
  const [automations, setAutomations] = useState<Automation[]>(dashboardSnapshot?.automations || [])
  const [history, setHistory] = useState<HistoryItem[]>(dashboardSnapshot?.history || [])
  const [sources, setSources] = useState<Source[]>(dashboardSnapshot?.sources || [])
  const [wallets, setWallets] = useState<WalletSummary[]>(dashboardSnapshot?.wallets || [])
  const [walletExportAvailable, setWalletExportAvailable] = useState(dashboardSnapshot?.walletExportAvailable || false)
  const [walletPasswordSet, setWalletPasswordSet] = useState(dashboardSnapshot?.walletPasswordSet || false)
  const [walletPassword, setWalletPassword] = useState('')
  const [walletPasswordConfirm, setWalletPasswordConfirm] = useState('')
  const [walletPrivateKeys, setWalletPrivateKeys] = useState<Record<string, string>>({})
  const [sourceLimit, setSourceLimit] = useState(dashboardSnapshot?.sourceLimit || 0)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [connectorUrl, setConnectorUrl] = useState('')
  const [newKeyLabel, setNewKeyLabel] = useState('dashboard')
  const [newSourceHandle, setNewSourceHandle] = useState('')
  const [newSourceTopics, setNewSourceTopics] = useState('')
  const [newSourceKeywords, setNewSourceKeywords] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState('')
  const [initializing, setInitializing] = useState(!dashboardSnapshot)
  const [tab, setTab] = useState<Tab>('overview')

  const sourceUsage = useMemo(() => `${sources.length} / ${sourceLimit}`, [sources.length, sourceLimit])
  const runningAutomations = useMemo(
    () => automations.filter((automation) => automation.status === 'active' || automation.status === 'paused'),
    [automations],
  )
  const paidDashboard = me ? (me.plan === 'pro' || me.plan === 'max') && (me.subscriptionStatus === 'active' || me.subscriptionStatus === 'trialing') : false

  async function refreshDashboard() {
    setBusy((current) => current || 'refresh')
    try {
      const meResponse = await fetch('/dashboard/me', { credentials: 'include' })
      if (meResponse.status === 401 || meResponse.status === 403) {
        dashboardSnapshot = null
        setMe(null)
        setApiKeys([])
        setConnectorLinks([])
        setAutomations([])
        setHistory([])
        setSources([])
        setWallets([])
        setStatus('')
        return
      }
      const meJson = await readJson<DashboardMe>(meResponse)
      setMe(meJson)
      setEmail(meJson.user.email || email)
      setApiKeys(meJson.apiKeys || [])
      setInitializing(false)

      const [autosResult, historyResult, sourcesResult, walletsResult, connectorsResult] = await Promise.allSettled([
        fetch('/dashboard/automations', { credentials: 'include' }).then((res) => readJson<{ automations: Automation[] }>(res)),
        fetch('/dashboard/history', { credentials: 'include' }).then((res) => readJson<{ history: HistoryItem[] }>(res)),
        fetch('/dashboard/sources', { credentials: 'include' }).then((res) => readJson<{ sources: Source[]; limit: number }>(res)),
        fetch('/dashboard/wallets', { credentials: 'include' }).then((res) => readJson<WalletsResponse>(res)),
        fetch('/dashboard/connector-links', { credentials: 'include' }).then((res) => readJson<{ connectorLinks: ConnectorLink[] }>(res)),
      ])
      const nextConnectorLinks = connectorsResult.status === 'fulfilled' ? connectorsResult.value.connectorLinks || [] : connectorLinks
      const nextAutomations = autosResult.status === 'fulfilled' ? autosResult.value.automations || [] : automations
      const nextHistory = historyResult.status === 'fulfilled' ? historyResult.value.history || [] : history
      const nextSources = sourcesResult.status === 'fulfilled' ? sourcesResult.value.sources || [] : sources
      const nextSourceLimit = sourcesResult.status === 'fulfilled' ? sourcesResult.value.limit || 0 : sourceLimit
      const nextWallets = walletsResult.status === 'fulfilled' ? walletsResult.value.wallets || [] : wallets
      const nextWalletExportAvailable = walletsResult.status === 'fulfilled' ? walletsResult.value.exportAvailable || false : walletExportAvailable
      const nextWalletPasswordSet = walletsResult.status === 'fulfilled' ? walletsResult.value.passwordSet || false : walletPasswordSet

      setConnectorLinks(nextConnectorLinks)
      setAutomations(nextAutomations)
      setHistory(nextHistory)
      setSources(nextSources)
      setSourceLimit(nextSourceLimit)
      setWallets(nextWallets)
      setWalletExportAvailable(nextWalletExportAvailable)
      setWalletPasswordSet(nextWalletPasswordSet)
      dashboardSnapshot = {
        me: meJson,
        apiKeys: meJson.apiKeys || [],
        connectorLinks: nextConnectorLinks,
        automations: nextAutomations,
        history: nextHistory,
        sources: nextSources,
        sourceLimit: nextSourceLimit,
        wallets: nextWallets,
        walletExportAvailable: nextWalletExportAvailable,
        walletPasswordSet: nextWalletPasswordSet,
      }
      setStatus('')
    } catch (error) {
      dashboardSnapshot = null
      setMe(null)
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
      setInitializing(false)
    }
  }

  useEffect(() => {
    refreshDashboard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function sendCode() {
    setBusy('send')
    setStatus('')
    setDevCode('')
    try {
      const json = await fetch('/auth/email/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }).then((res) => readJson<{ email: string; expiresAt: string; devCode?: string }>(res))
      setDevCode(json.devCode || '')
      setStatus(`Confirmation code sent to ${json.email}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function verifyCode() {
    setBusy('verify')
    setStatus('')
    try {
      await fetch('/auth/email/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      }).then((res) => readJson<{ user: { email?: string } }>(res))
      await refreshDashboard()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function logout() {
    setBusy('logout')
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' }).then((res) => readJson<{ ok: boolean }>(res))
      dashboardSnapshot = null
      setMe(null)
      setApiKeys([])
      setConnectorLinks([])
      setAutomations([])
      setHistory([])
      setSources([])
      setWallets([])
      setWalletPrivateKeys({})
      setRevealed({})
      setConnectorUrl('')
      setStatus('Logged out.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
      setInitializing(false)
    }
  }

  async function revealKey(key: ApiKey) {
    if (revealed[key.id]) {
      setRevealed((current) => ({ ...current, [key.id]: '' }))
      return
    }
    try {
      const json = await fetch(`/dashboard/api-keys/${key.id}/reveal`, { credentials: 'include' }).then((res) => readJson<{ apiKey: string }>(res))
      setRevealed((current) => ({ ...current, [key.id]: json.apiKey }))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  async function createKey() {
    if (!paidDashboard) {
      setStatus('API keys are available on Pro and Ultra plans only.')
      return
    }
    setBusy('key')
    try {
      const json = await fetch('/dashboard/api-keys', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newKeyLabel }),
      }).then((res) => readJson<{ apiKey: string; apiKeys: ApiKey[] }>(res))
      setApiKeys(json.apiKeys)
      setRevealed((current) => ({ ...current, created: json.apiKey }))
      setStatus('New API key created. It is linked to this email account.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function revokeKey(key: ApiKey) {
    setBusy(key.id)
    try {
      const json = await fetch(`/dashboard/api-keys/${key.id}`, {
        method: 'DELETE',
        credentials: 'include',
      }).then((res) => readJson<{ apiKeys: ApiKey[] }>(res))
      setApiKeys(json.apiKeys)
      setStatus('API key revoked.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function createConnectorLink() {
    if (!paidDashboard) {
      setStatus('Claude connector links are available on Pro and Ultra plans only.')
      return
    }
    setBusy('connector')
    try {
      const json = await fetch('/dashboard/connector-links', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Claude connector', client: 'claude' }),
      }).then((res) => readJson<{ connectorUrl: string; connectorLinks: ConnectorLink[] }>(res))
      setConnectorUrl(json.connectorUrl)
      setConnectorLinks(json.connectorLinks)
      setStatus('Claude connector URL created. It is shown once.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function revokeConnectorLink(link: ConnectorLink) {
    setBusy(link.id)
    try {
      const json = await fetch(`/dashboard/connector-links/${link.id}`, {
        method: 'DELETE',
        credentials: 'include',
      }).then((res) => readJson<{ connectorLinks: ConnectorLink[] }>(res))
      setConnectorLinks(json.connectorLinks)
      setConnectorUrl('')
      setStatus('Connector link revoked.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function addSource() {
    setBusy('source')
    try {
      const topics = newSourceTopics.split(',').map((item) => item.trim()).filter(Boolean)
      const keywords = newSourceKeywords.split(',').map((item) => item.trim()).filter(Boolean)
      const json = await fetch('/dashboard/sources', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: newSourceHandle, topics, keywords }),
      }).then((res) => readJson<{ sources: Source[] }>(res))
      setSources(json.sources)
      setNewSourceHandle('')
      setNewSourceTopics('')
      setNewSourceKeywords('')
      setStatus('Custom source added.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function deleteSource(source: Source) {
    setBusy(source.id)
    try {
      const json = await fetch(`/dashboard/sources/${source.id}`, {
        method: 'DELETE',
        credentials: 'include',
      }).then((res) => readJson<{ sources: Source[] }>(res))
      setSources(json.sources)
      setStatus('Custom source removed.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function saveWalletPassword() {
    if (walletPassword !== walletPasswordConfirm) {
      setStatus('Wallet passwords do not match.')
      return
    }
    setBusy('wallet-password')
    try {
      await fetch('/dashboard/wallets/password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: walletPassword }),
      }).then((res) => readJson<{ passwordSet: true }>(res))
      setWalletPassword('')
      setWalletPasswordConfirm('')
      setWalletPasswordSet(true)
      setStatus('Wallet export password saved on this local AGNT server.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function revealWalletPrivateKey(wallet: WalletSummary) {
    if (walletPrivateKeys[wallet.name]) {
      setWalletPrivateKeys((current) => ({ ...current, [wallet.name]: '' }))
      return
    }
    setBusy(`wallet-${wallet.name}`)
    try {
      const json = await fetch(`/dashboard/wallets/${encodeURIComponent(wallet.name)}/reveal`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: walletPassword }),
      }).then((res) => readJson<{ privateKey: string }>(res))
      setWalletPrivateKeys((current) => ({ ...current, [wallet.name]: json.privateKey }))
      setStatus('Private key revealed locally. Hide it again when you are done.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function passwordAuth(action: 'login' | 'signup') {
    if (action === 'signup' && password !== passwordConfirm) {
      setStatus('Passwords do not match.')
      return
    }
    setBusy(action)
    setStatus('')
    try {
      await fetch(`/auth/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then((res) => readJson<{ user: { email?: string } }>(res))
      setPassword('')
      setPasswordConfirm('')
      await refreshDashboard()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function deleteDashboardWallet(wallet: WalletSummary) {
    if (!walletPasswordSet || !walletPassword) {
      setStatus('Enter your wallet export password before deleting a wallet.')
      return
    }
    const confirmed = window.confirm(`Delete wallet "${wallet.name}"? This removes the stored private key from this local AGNT server.`)
    if (!confirmed) return

    setBusy(`delete-wallet-${wallet.name}`)
    try {
      await fetch(`/dashboard/wallets/${encodeURIComponent(wallet.name)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: walletPassword }),
      }).then((res) => readJson<{ deleted: true }>(res))
      setWalletPrivateKeys((current) => {
        const next = { ...current }
        delete next[wallet.name]
        return next
      })
      setWallets((current) => current.filter((candidate) => candidate.address !== wallet.address))
      dashboardSnapshot = dashboardSnapshot
        ? { ...dashboardSnapshot, wallets: dashboardSnapshot.wallets.filter((candidate) => candidate.address !== wallet.address) }
        : null
      setStatus(`Deleted wallet "${wallet.name}".`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function updateAutomation(id: string, action: 'pause' | 'resume' | 'cancel') {
    setBusy(id)
    try {
      await fetch(`/dashboard/automations/${id}/${action}`, {
        method: 'POST',
        credentials: 'include',
      }).then((res) => readJson<{ automation: Automation }>(res))
      await refreshDashboard()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  /* ── Status bar (always visible) ── */
  const statusBar = status && <div className="dash-toast">{status}</div>

  if (initializing) {
    return (
      <>
        <Nav />
        <main className="dash">
          <section className="dash-login-card dash-loading-card">
            <div className="dash-login-icon">AGNT</div>
            <h2>Loading Dashboard</h2>
            <p>Checking your saved session.</p>
            <div className="dash-loading-bar"><span /></div>
          </section>
        </main>
      </>
    )
  }

  /* ── Not logged in ── */
  if (!me) {
    return (
      <>
        <Nav />
        <main className="dash">
          <section className="dash-login-card">
            <div className="dash-login-icon">AGNT</div>
            <h2>{authMode === 'signup' ? 'Create Dashboard Account' : 'Dashboard Login'}</h2>
            <p>{authMode === 'signup' ? 'Set a password for dashboard login. The same password becomes your local wallet export password.' : 'Login with the email and password you used during signup.'}</p>
            <div className="dash-auth-toggle">
              <button type="button" className={authMode === 'login' ? 'dash-auth-toggle__on' : ''} onClick={() => setAuthMode('login')}>Login</button>
              <button type="button" className={authMode === 'signup' ? 'dash-auth-toggle__on' : ''} onClick={() => setAuthMode('signup')}>Signup</button>
            </div>
            <div className="dash-password-fields">
              <div className="dash-field-group">
                <label>Email address</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="dash-field-group">
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="minimum 8 characters" />
              </div>
              {authMode === 'signup' && (
                <div className="dash-field-group">
                  <label>Confirm password</label>
                  <input type="password" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} placeholder="repeat password" />
                </div>
              )}
              <button type="button" onClick={() => passwordAuth(authMode)} disabled={busy !== '' || !email || !password || (authMode === 'signup' && !passwordConfirm)}>
                {busy === authMode ? (authMode === 'signup' ? 'Creating...' : 'Logging in...') : (authMode === 'signup' ? 'Create account' : 'Login')}
              </button>
            </div>
            <div className="dash-login-fields">
              <div className="dash-field-group">
                <label>Email address</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <button type="button" onClick={sendCode} disabled={busy === 'send' || busy === 'verify' || !email}>
                {busy === 'send' ? 'Sending…' : 'Send code'}
              </button>
            </div>
            {devCode && <p className="dash-dev-code">Dev code: {devCode}</p>}
            <div className="dash-login-fields">
              <div className="dash-field-group">
                <label>Confirmation code</label>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
              </div>
              <button type="button" onClick={verifyCode} disabled={busy === 'send' || busy === 'verify' || !code}>
                {busy === 'verify' ? 'Verifying…' : 'Login'}
              </button>
            </div>
            {statusBar}
          </section>
        </main>
        <Footer />
      </>
    )
  }

  /* ── Copy button with icon + checkmark ── */
  function CopyBtn({ value }: { value: string }) {
    const [ok, setOk] = useState(false)
    return (
      <button
        className={`dash-copy${ok ? ' dash-copy--ok' : ''}`}
        onClick={() => { navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1500) }}
        title="Copy"
      >
        {ok ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" /><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" /></svg>
        )}
      </button>
    )
  }

  /* ── Logged in ── */
  const stats = [
    { label: 'Plan', value: me.plan },
    { label: 'Status', value: me.subscriptionStatus },
    { label: 'Wallets', value: `${wallets.length}` },
    { label: 'Automations', value: `${runningAutomations.length} running` },
    { label: 'Sources', value: sourceUsage },
    { label: 'Executions', value: `${me.entitlement.executionsMonthly}/mo` },
  ]

  const greeting = getGreeting()

  return (
    <>
      <Nav />
      <main className="dash">
        {/* Top right actions */}
        <div className="dash-topbar">
          <Link to="/plans" className="dash-btn dash-btn--sm">View Plans</Link>
          <button className="dash-btn dash-btn--sm" onClick={logout} disabled={busy === 'logout'}>{busy === 'logout' ? 'Logging out...' : 'Logout'}</button>
        </div>

        {/* Greeting */}
        <section className="dash-greeting">
          <h1>{greeting}, <span>{me.user.email}</span></h1>
          <span className="dash-plan-pill">{me.plan}</span>
        </section>

        {/* Metrics strip */}
        <div className="dash-metrics">
          {stats.map((s) => (
            <div className="dash-metric" key={s.label}>
              <span className="dash-metric__val">{s.value}</span>
              <span className="dash-metric__lbl">{s.label}</span>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <nav className="dash-tabs">
          {TABS.map((t) => (
            <button key={t} className={`dash-tab${tab === t ? ' dash-tab--on' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
          <button className="dash-tab dash-tab--right" onClick={refreshDashboard} disabled={busy !== ''}>
            {busy === 'refresh' ? 'Syncing...' : 'Refresh'}
          </button>
        </nav>

        {/* Panel content */}
        <div className="dash-panel">

          {tab === 'overview' && (
            <div className="dash-grid">
              {([
                { title: 'Wallets', count: wallets.length, sub: 'local wallets', go: 'wallets' as Tab },
                { title: 'API Keys', count: apiKeys.length, sub: 'keys created', go: 'keys' as Tab },
                { title: 'Automations', count: runningAutomations.length, sub: 'running', go: 'automations' as Tab },
                { title: 'Sources', count: sourceUsage, sub: 'custom sources', go: 'sources' as Tab },
                { title: 'History', count: history.length, sub: 'events logged', go: 'history' as Tab },
              ]).map((c) => (
                <button key={c.title} className="dash-tile" onClick={() => setTab(c.go)}>
                  <span className="dash-tile__num">{c.count}</span>
                  <span className="dash-tile__title">{c.title}</span>
                  <span className="dash-tile__sub">{c.sub}</span>
                </button>
              ))}
            </div>
          )}

          {tab === 'wallets' && (
            <section className="dash-section">
              <div className="dash-section__bar">
                <h2>Wallets <span className="dash-count">{wallets.length}</span></h2>
                <button className="dash-btn" onClick={refreshDashboard} disabled={busy !== ''}>Refresh balances</button>
              </div>
              {walletExportAvailable ? (
                <div className="dash-vault">
                  <div className="dash-field"><label>{walletPasswordSet ? 'Export password' : 'Set export password'}</label><input type="password" value={walletPassword} onChange={(e) => setWalletPassword(e.target.value)} placeholder={walletPasswordSet ? 'password' : 'min 8 characters'} /></div>
                  {!walletPasswordSet && <div className="dash-field"><label>Confirm</label><input type="password" value={walletPasswordConfirm} onChange={(e) => setWalletPasswordConfirm(e.target.value)} placeholder="repeat" /></div>}
                  {!walletPasswordSet && <button className="dash-btn" onClick={saveWalletPassword} disabled={busy !== '' || !walletPassword || !walletPasswordConfirm}>Save</button>}
                </div>
              ) : (
                <div className="dash-note">Private key export is disabled on hosted dashboards.</div>
              )}
              <div className="dash-wallet-grid">
                {wallets.map((w) => (
                  <article className="dash-wallet" key={w.address}>
                    <div className="dash-wallet__top"><div><strong>{w.name}</strong><span>{w.active ? 'Active' : `Created ${dateText(w.createdAt)}`}</span></div><CopyBtn value={w.address} /></div>
                    <code>{w.address}</code>
                    <div className="dash-wallet__bals">
                      {visibleBalances(w.balances).length > 0 ? visibleBalances(w.balances).map((b) => (
                        <div className="dash-bal" key={`${w.address}-${b.chain}-${b.symbol}`}><span>{b.chainLabel}</span><strong>{b.error ? 'RPC error' : `${balanceText(b.balance)} ${b.symbol}`}</strong></div>
                      )) : <p className="dash-empty">No visible balances yet.</p>}
                    </div>
                    {walletExportAvailable && (
                      <div className="dash-wallet__export">
                        <button className="dash-btn dash-btn--sm" onClick={() => revealWalletPrivateKey(w)} disabled={busy !== '' || !walletPassword || !walletPasswordSet}>{walletPrivateKeys[w.name] ? 'Hide key' : 'Reveal key'}</button>
                        {walletPrivateKeys[w.name] && <><code>{walletPrivateKeys[w.name]}</code><CopyBtn value={walletPrivateKeys[w.name]} /></>}
                        <button className="dash-btn dash-btn--sm dash-btn--danger" onClick={() => deleteDashboardWallet(w)} disabled={busy !== '' || !walletPassword || !walletPasswordSet}>Delete wallet</button>
                      </div>
                    )}
                  </article>
                ))}
                {wallets.length === 0 && <div className="dash-empty-box"><p className="dash-empty">No local wallets found.</p><p className="dash-hint">Create one from your agent: create a wallet called Main</p></div>}
              </div>
            </section>
          )}

          {tab === 'keys' && (
            <section className="dash-section">
              <div className="dash-section__bar">
                <h2>API Keys</h2>
                <div className="dash-section__row"><input value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} placeholder="key label" disabled={!paidDashboard} /><button className="dash-btn" onClick={createKey} disabled={busy !== '' || !paidDashboard}>New key</button></div>
              </div>
              {!paidDashboard && <div className="dash-note">Free accounts can view the dashboard. Upgrade to Pro or Ultra to create API keys and connector URLs.</div>}
              {revealed.created && <div className="dash-secret-row"><code className="dash-secret">{revealed.created}</code><CopyBtn value={revealed.created} /></div>}
              <div className="dash-list">
                {apiKeys.map((key) => (
                  <div className="dash-row" key={key.id}>
                    <div className="dash-row__info"><strong>{key.label}</strong><span>{key.ownerEmail} / {key.prefix} / Last used: {dateText(key.lastUsedAt)}</span>{revealed[key.id] && <code>{revealed[key.id]}</code>}</div>
                    <div className="dash-row__act">
                      <button className="dash-btn dash-btn--sm" onClick={() => revealKey(key)} disabled={!key.canReveal || busy !== ''}>{revealed[key.id] ? 'Hide' : 'Reveal'}</button>
                      {revealed[key.id] && <CopyBtn value={revealed[key.id]} />}
                      <button className="dash-btn dash-btn--sm dash-btn--danger" onClick={() => revokeKey(key)} disabled={Boolean(key.revokedAt) || busy !== ''}>Revoke</button>
                    </div>
                  </div>
                ))}
                {apiKeys.length === 0 && <p className="dash-empty">No API keys yet.</p>}
              </div>
              <div className="dash-section__bar dash-section__bar--sub">
                <div><h2>Claude Connectors</h2><p className="dash-hint">Use when Claude has no API-key field.</p></div>
                <button className="dash-btn" onClick={createConnectorLink} disabled={busy !== '' || !paidDashboard || apiKeys.filter((k) => !k.revokedAt).length === 0}>Create URL</button>
              </div>
              {connectorUrl && (
                <div className="dash-row"><div className="dash-row__info"><strong>New connector URL</strong><span>Shown once. Paste into Claude.</span><code>{connectorUrl}</code></div><div className="dash-row__act"><CopyBtn value={connectorUrl} /><button className="dash-btn dash-btn--sm" onClick={() => setConnectorUrl('')}>Hide</button></div></div>
              )}
              <div className="dash-list">
                {connectorLinks.map((link) => (
                  <div className="dash-row" key={link.id}><div className="dash-row__info"><strong>{link.label}</strong><span>{link.client} / {link.prefix} / Last used: {dateText(link.lastUsedAt)}</span></div><div className="dash-row__act"><button className="dash-btn dash-btn--sm dash-btn--danger" onClick={() => revokeConnectorLink(link)} disabled={Boolean(link.revokedAt) || busy !== ''}>Revoke</button></div></div>
                ))}
                {connectorLinks.length === 0 && <p className="dash-empty">No connector links yet.</p>}
              </div>
            </section>
          )}

          {tab === 'automations' && (
            <section className="dash-section">
              <div className="dash-section__bar"><h2>Running Automations</h2></div>
              <div className="dash-list">
                {runningAutomations.map((a) => (
                  <div className="dash-row" key={a.id}>
                    <div className="dash-row__info"><strong>{a.name}</strong><span><span className={`dash-dot dash-dot--${a.status}`} />{a.status} / {topicFromAutomation(a)} / Last run: {dateText(a.lastRun)}</span></div>
                    <div className="dash-row__act">
                      <button className="dash-btn dash-btn--sm" onClick={() => updateAutomation(a.id, a.status === 'active' ? 'pause' : 'resume')} disabled={busy !== ''}>{a.status === 'active' ? 'Pause' : 'Resume'}</button>
                      <button className="dash-btn dash-btn--sm dash-btn--danger" onClick={() => updateAutomation(a.id, 'cancel')} disabled={busy !== ''}>Cancel</button>
                    </div>
                  </div>
                ))}
                {runningAutomations.length === 0 && <div className="dash-empty-box"><p className="dash-empty">No running automations.</p><p className="dash-hint">Completed runs are in History.</p></div>}
              </div>
            </section>
          )}

          {tab === 'sources' && (
            <section className="dash-section">
              <div className="dash-section__bar"><h2>Custom Sources <span className="dash-count">{sourceUsage}</span></h2></div>
              <div className="dash-form">
                <div className="dash-form__row"><input value={newSourceHandle} onChange={(e) => setNewSourceHandle(e.target.value)} placeholder="@handle" /><input value={newSourceTopics} onChange={(e) => setNewSourceTopics(e.target.value)} placeholder="topics (comma sep)" /></div>
                <div className="dash-form__row"><input value={newSourceKeywords} onChange={(e) => setNewSourceKeywords(e.target.value)} placeholder="keywords (optional)" /><button className="dash-btn" onClick={addSource} disabled={busy !== '' || !newSourceHandle || !newSourceTopics}>Add source</button></div>
              </div>
              <div className="dash-list">
                {sources.map((s) => (
                  <div className="dash-row" key={s.id}><div className="dash-row__info"><strong>@{s.handle}</strong><span><span className={`dash-dot dash-dot--${s.enabled ? 'active' : 'paused'}`} />{s.enabled ? 'enabled' : 'disabled'} / {s.topics.join(', ')}</span></div><div className="dash-row__act"><button className="dash-btn dash-btn--sm dash-btn--danger" onClick={() => deleteSource(s)} disabled={busy !== ''}>Remove</button></div></div>
                ))}
                {sources.length === 0 && <p className="dash-empty">No custom sources added yet.</p>}
              </div>
            </section>
          )}

          {tab === 'history' && (
            <section className="dash-section">
              <div className="dash-section__bar"><h2>Execution History</h2></div>
              <div className="dash-list">
                {history.map((item) => (
                  <div className="dash-row" key={`${item.automationId}-${item.time}`}>
                    <div className="dash-row__info">
                      <strong>{item.title || item.automationName}</strong>
                      <span><span className={`dash-dot dash-dot--${item.success ? 'active' : 'cancelled'}`} />{dateText(item.time)} / {item.kind === 'tool' ? item.type.replace(/_/g, ' ') : item.type} / {item.success ? 'success' : 'failed'}</span>
                      <p className="dash-row__result">{item.result}</p>
                    </div>
                  </div>
                ))}
                {history.length === 0 && <p className="dash-empty">No execution history yet.</p>}
              </div>
            </section>
          )}
        </div>

        {statusBar}

        {(!me.plan || me.plan === 'free') && (
          <section className="dash-upgrade">
            <div><strong>Upgrade your plan</strong><span>Unlock automations, auto-execute, and custom sources.</span></div>
            <Link to="/plans" className="dash-btn">View Plans</Link>
          </section>
        )}
      </main>
      <Footer />
    </>
  )
}

