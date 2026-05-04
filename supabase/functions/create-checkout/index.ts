// Mnesti — create-checkout Edge Function
// Crea una sessione Stripe Checkout per piano esame o mensile.
// Richiede header Authorization: Bearer <supabase-jwt>
// Body: { plan_type: 'exam' | 'monthly' }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!;
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL           = Deno.env.get('APP_URL') ?? 'https://mnesti.it';

// ── Prezzi ─────────────────────────────────────────────────────
const PRICES = {
  exam:    { amount: 999,  currency: 'eur', mode: 'payment'      as const },
  monthly: { amount: 999,  currency: 'eur', mode: 'subscription' as const },
} as const;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── Auth ─────────────────────────────────────────────────
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Non autenticato' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Sessione non valida' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Body ─────────────────────────────────────────────────
    const { plan_type } = await req.json() as { plan_type: 'exam' | 'monthly' };
    if (!['exam', 'monthly'].includes(plan_type)) {
      return new Response(JSON.stringify({ error: 'Piano non valido' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Stripe Customer ───────────────────────────────────────
    const { data: planRow } = await sb.from('user_plans')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId: string = planRow?.stripe_customer_id ?? '';

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await sb.from('user_plans')
        .update({ stripe_customer_id: customerId })
        .eq('user_id', user.id);
    }

    // ── Checkout Session ──────────────────────────────────────
    const price = PRICES[plan_type];
    const successUrl = `${APP_URL}/app.html?checkout=success&plan=${plan_type}`;
    const cancelUrl  = `${APP_URL}/app.html?checkout=cancelled`;

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      payment_method_types: ['card'],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: { supabase_user_id: user.id, plan_type },
    };

    if (plan_type === 'exam') {
      sessionParams.mode = 'payment';
      sessionParams.line_items = [{
        price_data: {
          currency: price.currency,
          product_data: {
            name: 'Mnesti — Piano per Esame',
            description: '1 esame aggiuntivo · 500 chiamate AI/giorno · 50 MB storage · 90 giorni',
          },
          unit_amount: price.amount,
        },
        quantity: 1,
      }];
    } else {
      sessionParams.mode = 'subscription';
      sessionParams.line_items = [{
        price_data: {
          currency: price.currency,
          product_data: {
            name: 'Mnesti — Piano Mensile',
            description: 'Esami illimitati · 1000 chiamate AI/giorno · 200 MB storage',
          },
          recurring: { interval: 'month' },
          unit_amount: price.amount,
        },
        quantity: 1,
      }];
      sessionParams.subscription_data = {
        metadata: { supabase_user_id: user.id },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[create-checkout] error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
