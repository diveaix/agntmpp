import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { encodeFunctionData, parseAbi } from 'viem'
import Footer from '../components/Footer'
import Nav from '../components/Nav'

type PaidPlan = 'pro' | 'max'
type PaymentNetworkId = 'base' | 'tempo' | 'optimism' | 'arbitrum' | 'polygon' | 'ethereum' | 'solana'

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

type QuoteResponse = {
  quoteId: string
  plan: PaidPlan
  amount: number
  amountUnits: string
  currency: string
  tokenDecimals: number
  network: string
  chainId?: number
  chainName: string
  rpcUrl: string
  blockExplorerUrls: string[]
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  recipient: string
  expiresAt: string
  instructions: string
  error?: string
  error_description?: string
}

type ConfirmResponse = {
  applied: boolean
  reason: string
  plan?: PaidPlan
  currentPeriodEnd?: string
  apiKey?: string
  apiKeyId?: string
  warning?: string
  error?: string
  error_description?: string
}

type EmailStartResponse = {
  email: string
  expiresAt: string
  devCode?: string
  error?: string
  error_description?: string
}

type EmailVerifyResponse = {
  user?: { id: string; email?: string }
  plan?: string
  error?: string
  error_description?: string
}

const paidPlans: Record<PaidPlan, { name: string; price: string; note: string }> = {
  pro: {
    name: 'Pro',
    price: '$49',
    note: '5 data automations, auto-execute, and 25 custom Twitter/X sources.',
  },
  max: {
    name: 'Ultra',
    price: '$199',
    note: 'Highest priority queue, more automation capacity, and 100 custom Twitter/X sources.',
  },
}

const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

const VERIFY_RETRY_MS = 5_000
const VERIFY_MAX_ATTEMPTS = 36

const paymentNetworkOptions: Array<{ id: PaymentNetworkId; label: string; note: string; disabled?: boolean }> = [
  { id: 'base', label: 'Base', note: 'Recommended' },
  { id: 'tempo', label: 'Tempo', note: 'MPP native' },
  { id: 'optimism', label: 'Optimism', note: 'Low gas' },
  { id: 'arbitrum', label: 'Arbitrum', note: 'Low gas' },
  { id: 'polygon', label: 'Polygon', note: 'USDC' },
  { id: 'ethereum', label: 'Ethereum', note: 'High gas' },
  { id: 'solana', label: 'Solana', note: 'Soon', disabled: true },
]

function normalizePlan(value: string | null): PaidPlan {
  return value === 'max' ? 'max' : 'pro'
}

function planLabel(plan: PaidPlan) {
  return plan === 'max' ? 'Ultra' : 'Pro'
}

function shortAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

function chainIdHex(chainId: number) {
  return `0x${chainId.toString(16)}`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function verificationMayStillSettle(reason: string) {
  return /confirmation|receipt not found/i.test(reason)
}

async function readCheckoutJson<T extends { error?: string; error_description?: string }>(response: Response): Promise<T> {
  const raw = await response.text()
  if (!raw.trim()) {
    throw new Error(`Checkout server returned an empty ${response.status} response. Make sure the AGNT MCP server is running and reachable.`)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Checkout server returned a non-JSON ${response.status} response. Make sure checkout requests are routed to the AGNT MCP server.`)
  }
}

/* ── Step helpers ── */
function currentStep(emailVerified: boolean, quote: QuoteResponse | null, apiKey: string) {
  if (apiKey) return 4
  if (quote) return 3
  if (emailVerified) return 2
  return 1
}

const STEPS = ['Verify Email', 'Choose Network', 'Pay & Confirm', 'API Key']

export default function CheckoutPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedPlan, setSelectedPlanState] = useState<PaidPlan>(() => normalizePlan(searchParams.get('plan')))
  const [paymentNetwork, setPaymentNetwork] = useState<PaymentNetworkId>('base')
  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailVerified, setEmailVerified] = useState(false)
  const [devEmailCode, setDevEmailCode] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [connectedWallet, setConnectedWallet] = useState('')
  const [quote, setQuote] = useState<QuoteResponse | null>(null)
  const [txHash, setTxHash] = useState('')
  const [payer, setPayer] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState<'connect' | 'email_start' | 'email_verify' | 'quote' | 'pay' | 'confirm' | null>(null)

  const selected = useMemo(() => paidPlans[selectedPlan], [selectedPlan])
  const step = currentStep(emailVerified, quote, apiKey)

  function setSelectedPlan(plan: PaidPlan) {
    setSelectedPlanState(plan)
    setSearchParams({ plan })
    setQuote(null)
    setTxHash('')
    setApiKey('')
  }

  function resetQuoteForNetwork(nextNetwork: PaymentNetworkId) {
    setPaymentNetwork(nextNetwork)
    setQuote(null)
    setTxHash('')
    setApiKey('')
    setStatus(nextNetwork === 'solana' ? 'Solana checkout needs SPL token support. Use Base or another EVM chain for now.' : '')
  }

  function updateEmail(value: string) {
    setEmail(value)
    setEmailVerified(false)
    setEmailCode('')
    setDevEmailCode('')
    setQuote(null)
    setApiKey('')
  }

  async function sendEmailCode() {
    setBusy('email_start')
    setStatus('')
    setEmailVerified(false)
    setDevEmailCode('')
    try {
      const response = await fetch('/auth/email/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const json = await readCheckoutJson<EmailStartResponse>(response)
      if (!response.ok) throw new Error(json.error_description || json.error || 'Could not send confirmation code.')
      setStatus(`Confirmation code sent to ${json.email}.`)
      setDevEmailCode(json.devCode || '')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function verifyEmailCode() {
    setBusy('email_verify')
    setStatus('')
    try {
      const response = await fetch('/auth/email/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: emailCode }),
      })
      const json = await readCheckoutJson<EmailVerifyResponse>(response)
      if (!response.ok) throw new Error(json.error_description || json.error || 'Could not verify email.')
      setEmailVerified(true)
      setStatus(`Email confirmed. Choose a network and create your payment quote.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function connectWallet() {
    setBusy('connect')
    setStatus('')
    try {
      if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask, Rabby, or Coinbase Wallet, then try again.')
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      const address = accounts[0]
      if (!address) throw new Error('Wallet did not return an address.')
      setConnectedWallet(address)
      setWalletAddress(address)
      setPayer(address)
      setStatus(`Wallet connected: ${shortAddress(address)}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function createQuote() {
    setBusy('quote')
    setStatus('')
    setApiKey('')
    try {
      if (!emailVerified) throw new Error('Confirm your email before creating a payment quote.')
      const response = await fetch('/public/checkout/crypto/quote', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          walletAddress: walletAddress || undefined,
          plan: selectedPlan,
          provider: 'mpp',
          months: 1,
          paymentNetwork,
        }),
      })
      const json = await readCheckoutJson<QuoteResponse>(response)
      if (!response.ok) throw new Error(json.error_description || json.error || 'Could not create payment quote.')
      setQuote(json)
      setStatus(connectedWallet ? `Quote ready on ${json.chainName}. Pay with your connected wallet.` : `Quote ready on ${json.chainName}. Connect a wallet to pay.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function confirmPayment(hash = txHash, payerAddress = payer, retry = false) {
    if (!quote) return
    setBusy('confirm')
    setStatus('')
    try {
      for (let attempt = 1; attempt <= (retry ? VERIFY_MAX_ATTEMPTS : 1); attempt++) {
        const response = await fetch('/public/checkout/crypto/confirm', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            quoteId: quote.quoteId,
            provider: 'mpp',
            txHash: hash,
            payer: payerAddress || undefined,
          }),
        })
        const json = await readCheckoutJson<ConfirmResponse>(response)
        if (response.ok && json.applied) {
          setApiKey(json.apiKey || '')
          setStatus(`${planLabel(json.plan || selectedPlan)} access is active${json.currentPeriodEnd ? ` until ${json.currentPeriodEnd.slice(0, 10)}` : ''}.`)
          return
        }

        const reason = json.error_description || json.reason || json.error || 'Payment was not verified.'
        if (!retry || !verificationMayStillSettle(reason) || attempt === VERIFY_MAX_ATTEMPTS) {
          throw new Error(reason)
        }

        setStatus(`${reason} Waiting for confirmations… (${attempt}/${VERIFY_MAX_ATTEMPTS})`)
        await sleep(VERIFY_RETRY_MS)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function payWithWallet() {
    setBusy('pay')
    setStatus('')
    try {
      if (!quote) throw new Error('Create a payment quote first.')
      if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask, Rabby, or Coinbase Wallet, then try again.')
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      const from = accounts[0]
      if (!from) throw new Error('Wallet did not return an address.')
      setConnectedWallet(from)
      setWalletAddress(from)
      setPayer(from)

      if (quote.chainId) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex(quote.chainId) }],
          })
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error ? Number((error as { code: unknown }).code) : undefined
          if (code !== 4902) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Switch your wallet to ${quote.chainName} (chain ${quote.chainId}) and try again. ${message}`)
          }
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: chainIdHex(quote.chainId),
              chainName: quote.chainName,
              rpcUrls: [quote.rpcUrl],
              blockExplorerUrls: quote.blockExplorerUrls,
              nativeCurrency: quote.nativeCurrency,
            }],
          })
        }
      }

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [quote.recipient as `0x${string}`, BigInt(quote.amountUnits)],
      })
      const hash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from,
          to: quote.currency,
          value: '0x0',
          data,
        }],
      }) as string

      setTxHash(hash)
      setStatus(`Payment sent: ${hash}. Verifying now…`)
      await confirmPayment(hash, from, true)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      setBusy(null)
    }
  }

  return (
    <>
      <Nav />
      <main className="co">
        {/* Hero */}
        <section className="co-hero">
          <h1>{selected.name} Access</h1>
          <p>{selected.note}</p>

          {/* Plan toggle */}
          <div className="co-plan-toggle">
            <button type="button" className={`co-plan-btn${selectedPlan === 'pro' ? ' co-plan-btn--active' : ''}`} onClick={() => setSelectedPlan('pro')}>
              Pro <span>{paidPlans.pro.price}/mo</span>
            </button>
            <button type="button" className={`co-plan-btn${selectedPlan === 'max' ? ' co-plan-btn--active' : ''}`} onClick={() => setSelectedPlan('max')}>
              Ultra <span>{paidPlans.max.price}/mo</span>
            </button>
            <Link to="/plans" className="co-back-link">← Compare plans</Link>
          </div>
        </section>

        {/* Steps indicator */}
        <div className="co-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`co-step${step > i + 1 ? ' co-step--done' : ''}${step === i + 1 ? ' co-step--active' : ''}`}>
              <span className="co-step__num">{step > i + 1 ? '✓' : i + 1}</span>
              <span className="co-step__label">{s}</span>
            </div>
          ))}
        </div>

        {/* Form */}
        <section className="co-form-wrap">
          {/* Step 1: Email */}
          <div className="co-section">
            <h3><span className="co-section__num">01</span>Verify your email</h3>
            <div className="co-field-row">
              <div className="co-field">
                <label>Email address</label>
                <input value={email} onChange={(e) => updateEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <button type="button" onClick={sendEmailCode} disabled={busy !== null || !email || emailVerified}>
                {busy === 'email_start' ? 'Sending…' : emailVerified ? '✓ Confirmed' : 'Send code'}
              </button>
            </div>
            {devEmailCode && !emailVerified && <p className="co-hint">Dev code: {devEmailCode}</p>}
            {!emailVerified && (
              <div className="co-field-row">
                <div className="co-field">
                  <label>Confirmation code</label>
                  <input value={emailCode} onChange={(e) => setEmailCode(e.target.value)} placeholder="6-digit code" disabled={emailVerified} />
                </div>
                <button type="button" onClick={verifyEmailCode} disabled={busy !== null || !email || !emailCode || emailVerified}>
                  {busy === 'email_verify' ? 'Checking…' : 'Confirm'}
                </button>
              </div>
            )}
          </div>

          {/* Step 2: Network + wallet */}
          <div className={`co-section${!emailVerified ? ' co-section--disabled' : ''}`}>
            <h3><span className="co-section__num">02</span>Choose network & connect wallet</h3>
            <div className="co-network-grid">
              {paymentNetworkOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`co-network${paymentNetwork === opt.id ? ' co-network--active' : ''}`}
                  disabled={busy !== null || opt.disabled || !emailVerified}
                  onClick={() => resetQuoteForNetwork(opt.id)}
                >
                  <strong>{opt.label}</strong>
                  <span>{opt.note}</span>
                </button>
              ))}
            </div>
            <div className="co-field-row">
              <button type="button" className="co-wallet-btn" onClick={connectWallet} disabled={busy !== null || !emailVerified}>
                {busy === 'connect' ? 'Connecting…' : connectedWallet ? `◆ ${shortAddress(connectedWallet)}` : '◇ Connect Wallet'}
              </button>
              <div className="co-field" style={{ flex: 1 }}>
                <label>Paying wallet (optional)</label>
                <input value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} placeholder="0x..." disabled={!emailVerified} />
              </div>
            </div>
            <button type="button" className="co-quote-btn" onClick={createQuote} disabled={busy !== null || !email || !emailVerified}>
              {busy === 'quote' ? 'Creating quote…' : `Create ${selected.name} Quote →`}
            </button>
          </div>

          {/* Step 3: Quote + pay */}
          {quote && (
            <div className="co-section">
              <h3><span className="co-section__num">03</span>Review & pay</h3>
              <div className="co-quote">
                <div className="co-quote__row"><span>Amount</span><strong>{quote.amount} USDC</strong></div>
                <div className="co-quote__row"><span>Network</span><strong>{quote.chainName}</strong></div>
                <div className="co-quote__row"><span>Token</span><code>{quote.currency}</code></div>
                <div className="co-quote__row"><span>Recipient</span><code>{quote.recipient}</code></div>
                <div className="co-quote__row"><span>Quote ID</span><code>{quote.quoteId}</code></div>
                <div className="co-quote__row"><span>Expires</span><strong>{new Date(quote.expiresAt).toLocaleString()}</strong></div>
              </div>
              <button type="button" className="co-pay-btn" onClick={txHash ? () => confirmPayment(txHash, payer || connectedWallet, true) : payWithWallet} disabled={busy !== null || !quote}>
                {busy === 'pay' || busy === 'confirm'
                  ? '↻ Waiting for confirmations…'
                  : txHash
                    ? 'Continue verifying payment'
                    : `Pay ${quote.amount} USDC with wallet →`}
              </button>
            </div>
          )}

          {/* Step 4: API Key */}
          {apiKey && (
            <div className="co-section co-section--success">
              <h3><span className="co-section__num">04</span>Your API key</h3>
              <div className="co-api-key">
                <span className="co-api-key__label">Shown once — save it now</span>
                <code className="co-api-key__value">{apiKey}</code>
                <div className="co-api-key__actions">
                  <button type="button" onClick={() => navigator.clipboard?.writeText(apiKey)}>Copy Key</button>
                  <Link to="/dashboard" className="plan-button">Open Dashboard →</Link>
                </div>
              </div>
            </div>
          )}

          {/* Status */}
          {status && <p className="co-status">{status}</p>}
        </section>
      </main>
      <Footer />
    </>
  )
}
