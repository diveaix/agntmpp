type WaitlistBody = {
  firstName?: string
  email?: string
  source?: string
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeText(value: unknown, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength)
}

function json(res: any, status: number, body: Record<string, unknown>) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: any): Promise<WaitlistBody> {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}')

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function saveToSupabase(entry: {
  email: string
  first_name: string | null
  source: string
}) {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('waitlist_not_configured')
  }

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/waitlist?on_conflict=email`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      email: entry.email,
      first_name: entry.first_name,
      source: entry.source,
      updated_at: new Date().toISOString(),
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(details || `supabase_${response.status}`)
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { ok: false, error: 'method_not_allowed' })
  }

  try {
    const body = await readBody(req)
    const email = normalizeText(body.email, 320).toLowerCase()
    const firstName = normalizeText(body.firstName, 80)
    const source = normalizeText(body.source, 120) || 'unknown'

    if (!emailPattern.test(email)) {
      return json(res, 400, { ok: false, error: 'invalid_email' })
    }

    await saveToSupabase({
      email,
      first_name: firstName || null,
      source,
    })

    return json(res, 200, { ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'waitlist_failed'
    const status = message === 'waitlist_not_configured' ? 503 : 500
    return json(res, status, {
      ok: false,
      error: message === 'waitlist_not_configured' ? message : 'waitlist_failed',
    })
  }
}
