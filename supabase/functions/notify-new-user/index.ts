// Mnesti — New User Registration Notifier
// Triggered by a pg_net HTTP call from the auth.users INSERT trigger.
// Sends an admin email via Resend when a new user registers.
//
// Required Supabase secrets:
//   RESEND_API_KEY   — from https://resend.com (free tier: 3000 emails/month)
//   WEBHOOK_SECRET   — shared secret to authenticate calls from pg_net trigger

const RESEND_KEY     = Deno.env.get('RESEND_API_KEY')    ?? ''
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET')    ?? ''
const ADMIN_EMAIL    = 'contact@wordpresschef.it'
const FROM_EMAIL     = 'Mnesti <noreply@mnesti.it>'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, x-webhook-secret',
      },
    })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Verify shared secret — rejects any call that doesn't come from our trigger
  const incomingSecret = req.headers.get('x-webhook-secret') ?? ''
  if (WEBHOOK_SECRET && incomingSecret !== WEBHOOK_SECRET) {
    console.warn('[notify-new-user] Unauthorized call — wrong secret')
    return new Response('Unauthorized', { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const email     = (payload.email     as string) ?? '(email non disponibile)'
  const userId    = (payload.id        as string) ?? '—'
  const createdAt = (payload.created_at as string) ?? new Date().toISOString()

  const dateStr = new Date(createdAt).toLocaleString('it-IT', {
    timeZone:    'Europe/Rome',
    day:         '2-digit',
    month:       '2-digit',
    year:        'numeric',
    hour:        '2-digit',
    minute:      '2-digit',
  })

  const html = `
    <div style="font-family:'Helvetica Neue',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px">
        <span style="font-size:22px">🎓</span>
        <span style="font-size:20px;font-weight:700;color:#d97757">Mnesti</span>
      </div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 16px">Nuovo utente registrato</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#666;width:110px">Email</td>
          <td style="padding:10px 0;font-weight:600">${email}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#666">Data</td>
          <td style="padding:10px 0">${dateStr}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#666">ID utente</td>
          <td style="padding:10px 0;font-size:11px;font-family:monospace;color:#888">${userId}</td>
        </tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:#aaa">
        Notifica automatica da Mnesti — non rispondere a questa email.
      </p>
    </div>
  `

  if (!RESEND_KEY) {
    console.error('[notify-new-user] RESEND_API_KEY secret not set')
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      [ADMIN_EMAIL],
        subject: `🎓 Nuovo utente Mnesti: ${email}`,
        html,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Resend ${res.status}: ${errText}`)
    }

    const data = await res.json()
    console.info('[notify-new-user] Email sent, id:', data.id)

    return new Response(JSON.stringify({ sent: true, id: data.id }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[notify-new-user] Send failed:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
