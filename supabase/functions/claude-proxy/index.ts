// Mnesti — Claude API Proxy
// Verifies user JWT, enforces rate limiting, forwards to Anthropic.
// The ANTHROPIC_API_KEY is stored as a Supabase secret — never exposed to clients.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Daily call limit per user (free tier). Increase or make plan-based later.
const FREE_DAILY_CALLS = 150

serve(async (req) => {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    // ── 1. Authenticate ───────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Non autenticato', code: 'UNAUTHORIZED' }, 401)
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authErr } = await sb.auth.getUser()
    if (authErr || !user) {
      return json({ error: 'Non autenticato', code: 'UNAUTHORIZED' }, 401)
    }

    // ── 2. Rate limiting ──────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0]

    const { data: usageRow } = await sb
      .from('api_usage')
      .select('call_count')
      .eq('user_id', user.id)
      .eq('date', today)
      .maybeSingle()

    const callsToday = usageRow?.call_count ?? 0

    // Check user plan for higher limits (future Stripe integration)
    const { data: planRow } = await sb
      .from('user_plans')
      .select('plan_type, valid_until')
      .eq('user_id', user.id)
      .maybeSingle()

    const isPaid = planRow && planRow.plan_type !== 'free' &&
      (!planRow.valid_until || new Date(planRow.valid_until) > new Date())
    const dailyLimit = isPaid ? 500 : FREE_DAILY_CALLS

    if (callsToday >= dailyLimit) {
      return json({
        error: 'Limite giornaliero raggiunto. Riprova domani.',
        code: 'RATE_LIMIT',
        calls_today: callsToday,
        limit: dailyLimit
      }, 429)
    }

    // ── 3. Forward to Anthropic ───────────────────────────────────
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      return json({ error: 'Chiave API non configurata lato server', code: 'SERVER_ERROR' }, 500)
    }

    const payload = await req.json()

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    })

    const data = await anthropicRes.json()

    // ── 4. Log usage (upsert) ─────────────────────────────────────
    const inputTokens  = data.usage?.input_tokens  ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0

    // Fire-and-forget — don't block the response
    sb.rpc('increment_api_usage', {
      p_user_id:       user.id,
      p_date:          today,
      p_calls:         1,
      p_input_tokens:  inputTokens,
      p_output_tokens: outputTokens,
    }).catch(() => { /* non-critical */ })

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[claude-proxy]', err)
    return json({ error: 'Errore interno del server', code: 'SERVER_ERROR' }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
