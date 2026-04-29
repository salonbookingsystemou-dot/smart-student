// Mnesti — Claude API Proxy
// Verifies user JWT, enforces rate limiting, forwards to Anthropic.
// The ANTHROPIC_API_KEY is stored as a Supabase secret — never exposed to clients.

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const FREE_DAILY_CALLS = 150

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    // ── 1. Authenticate ───────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Non autenticato', code: 'UNAUTHORIZED' }, 401)
    }

    const supabaseUrl  = Deno.env.get('SUPABASE_URL')
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')

    if (!supabaseUrl || !supabaseAnon) {
      console.error('[claude-proxy] SUPABASE_URL or SUPABASE_ANON_KEY not set')
      return json({ error: 'Configurazione server incompleta (Supabase)', code: 'SERVER_ERROR' }, 500)
    }

    const sb = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } }
    })

    const { data: { user }, error: authErr } = await sb.auth.getUser()
    if (authErr || !user) {
      return json({ error: 'Sessione scaduta — effettua il login', code: 'UNAUTHORIZED' }, 401)
    }

    // ── 2. Rate limiting (graceful: skip if tables missing) ───────
    let callsToday = 0
    let isPaid = false

    try {
      const today = new Date().toISOString().split('T')[0]

      const { data: usageRow } = await sb
        .from('api_usage')
        .select('call_count')
        .eq('user_id', user.id)
        .eq('date', today)
        .maybeSingle()

      callsToday = usageRow?.call_count ?? 0

      const { data: planRow } = await sb
        .from('user_plans')
        .select('plan_type, valid_until')
        .eq('user_id', user.id)
        .maybeSingle()

      isPaid = !!(planRow &&
        planRow.plan_type !== 'free' &&
        (!planRow.valid_until || new Date(planRow.valid_until) > new Date()))

      const dailyLimit = isPaid ? 500 : FREE_DAILY_CALLS
      if (callsToday >= dailyLimit) {
        return json({
          error: `Limite giornaliero raggiunto (${dailyLimit} chiamate). Riprova domani.`,
          code: 'RATE_LIMIT',
          calls_today: callsToday,
          limit: dailyLimit
        }, 429)
      }
    } catch (rateErr) {
      // Tables might not exist yet — log and continue
      console.warn('[claude-proxy] Rate limit check skipped:', rateErr?.message)
    }

    // ── 3. Check API key ──────────────────────────────────────────
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      console.error('[claude-proxy] ANTHROPIC_API_KEY secret not set')
      return json({ error: 'Chiave API Anthropic non configurata sul server. Contatta l\'amministratore.', code: 'SERVER_ERROR' }, 500)
    }

    // ── 4. Parse & forward to Anthropic ──────────────────────────
    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return json({ error: 'Richiesta malformata (JSON non valido)', code: 'BAD_REQUEST' }, 400)
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    })

    let data: Record<string, unknown>
    try {
      data = await anthropicRes.json()
    } catch {
      console.error('[claude-proxy] Anthropic returned non-JSON response, status:', anthropicRes.status)
      return json({ error: `Errore Anthropic (${anthropicRes.status}) — risposta non valida`, code: 'ANTHROPIC_ERROR' }, 502)
    }

    // Log Anthropic-level errors for debugging
    if (!anthropicRes.ok) {
      console.error('[claude-proxy] Anthropic error:', anthropicRes.status, JSON.stringify(data))
    }

    // ── 5. Log usage (fire-and-forget) ────────────────────────────
    const today = new Date().toISOString().split('T')[0]
    const inputTokens  = (data as { usage?: { input_tokens?: number } }).usage?.input_tokens  ?? 0
    const outputTokens = (data as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0

    sb.rpc('increment_api_usage', {
      p_user_id:       user.id,
      p_date:          today,
      p_calls:         1,
      p_input_tokens:  inputTokens,
      p_output_tokens: outputTokens,
    }).catch((e: unknown) => console.warn('[claude-proxy] usage log failed:', (e as Error)?.message))

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[claude-proxy] Unhandled error:', err)
    return json({ error: `Errore interno: ${(err as Error)?.message ?? 'sconosciuto'}`, code: 'SERVER_ERROR' }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
