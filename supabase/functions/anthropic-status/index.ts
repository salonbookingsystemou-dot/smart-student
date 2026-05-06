// Mnesti — Anthropic status proxy
// Fetches from status.anthropic.com server-side to avoid browser CORS restrictions.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const SVC_BASE = 'https://status.anthropic.com/api/v2'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const [statusRes, componentsRes, incidentsRes] = await Promise.all([
      fetch(`${SVC_BASE}/status.json`),
      fetch(`${SVC_BASE}/components.json`),
      fetch(`${SVC_BASE}/incidents.json`),
    ])

    if (!statusRes.ok || !componentsRes.ok || !incidentsRes.ok) {
      throw new Error(`status.anthropic.com returned ${statusRes.status}/${componentsRes.status}/${incidentsRes.status}`)
    }

    const [status, components, incidents] = await Promise.all([
      statusRes.json(),
      componentsRes.json(),
      incidentsRes.json(),
    ])

    return new Response(JSON.stringify({ status, components, incidents }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[anthropic-status]', err)
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? 'Errore sconosciuto' }),
      { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
