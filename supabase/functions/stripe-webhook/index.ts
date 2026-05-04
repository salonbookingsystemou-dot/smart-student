// Mnesti — stripe-webhook Edge Function
// Gestisce gli eventi Stripe e aggiorna user_plans di conseguenza.
//
// Eventi gestiti:
//   checkout.session.completed  → attiva piano exam o monthly
//   invoice.payment_succeeded   → rinnova valid_until abbonamento
//   customer.subscription.deleted → downgrade a free
//   invoice.payment_failed      → nessuna azione (Stripe riprova automaticamente)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

const STRIPE_SECRET_KEY   = Deno.env.get('STRIPE_SECRET_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

Deno.serve(async (req: Request) => {
  const body      = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';

  // ── Verifica firma Stripe ───────────────────────────────────
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] firma non valida:', msg);
    return new Response(`Webhook Error: ${msg}`, { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
    auth: { persistSession: false },
  });

  console.log('[stripe-webhook] evento:', event.type);

  try {
    switch (event.type) {

      // ── Pagamento completato (exam one-time o primo mese subscription) ──
      case 'checkout.session.completed': {
        const session  = event.data.object as Stripe.CheckoutSession;
        const userId   = session.metadata?.supabase_user_id;
        const planType = session.metadata?.plan_type as 'exam' | 'monthly' | undefined;

        if (!userId || !planType) {
          console.warn('[stripe-webhook] metadata mancanti', session.id);
          break;
        }

        if (planType === 'exam') {
          const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
          const { error } = await sb.rpc('activate_paid_plan', {
            p_user_id:        userId,
            p_plan_type:      'exam',
            p_payment_intent: session.payment_intent as string ?? null,
            p_subscription_id: null,
            p_valid_until:    validUntil,
          });
          if (error) console.error('[stripe-webhook] activate exam error:', error);
          else       console.log('[stripe-webhook] piano esame attivato per', userId);

        } else if (planType === 'monthly') {
          // Per subscription, valid_until si aggiorna su invoice.payment_succeeded
          // Qui usiamo +31 giorni come fallback iniziale
          const validUntil = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
          const { error } = await sb.rpc('activate_paid_plan', {
            p_user_id:         userId,
            p_plan_type:       'monthly',
            p_payment_intent:  null,
            p_subscription_id: session.subscription as string ?? null,
            p_valid_until:     validUntil,
          });
          if (error) console.error('[stripe-webhook] activate monthly error:', error);
          else       console.log('[stripe-webhook] piano mensile attivato per', userId);
        }
        break;
      }

      // ── Rinnovo mensile — aggiorna valid_until ────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        if (!invoice.subscription) break;

        const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) { console.warn('[stripe-webhook] sub senza user_id', sub.id); break; }

        const validUntil = new Date(sub.current_period_end * 1000).toISOString();
        const { error } = await sb.from('user_plans')
          .update({ valid_until: validUntil, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        if (error) console.error('[stripe-webhook] rinnovo error:', error);
        else       console.log('[stripe-webhook] abbonamento rinnovato per', userId, 'fino a', validUntil);
        break;
      }

      // ── Abbonamento cancellato → downgrade a free ─────────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) { console.warn('[stripe-webhook] sub cancellata senza user_id', sub.id); break; }

        const { error } = await sb.rpc('downgrade_to_free', { p_user_id: userId });
        if (error) console.error('[stripe-webhook] downgrade error:', error);
        else       console.log('[stripe-webhook] downgrade a free per', userId);
        break;
      }

      // ── Pagamento fallito — log only (Stripe gestisce il retry) ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        console.warn('[stripe-webhook] pagamento fallito per invoice', invoice.id);
        break;
      }

      default:
        console.log('[stripe-webhook] evento ignorato:', event.type);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] errore elaborazione:', msg);
    // Restituiamo 200 comunque per evitare retry Stripe su errori interni
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
