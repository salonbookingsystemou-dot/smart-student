-- ─────────────────────────────────────────────────────────────
-- Mnesti — Stripe billing: limiti piano + funzione upgrade
-- ─────────────────────────────────────────────────────────────

-- ── 1. Aggiungi colonne limite a user_plans ───────────────────
ALTER TABLE user_plans
  ADD COLUMN IF NOT EXISTS calls_limit        integer NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS storage_limit_mb   integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS exams_limit        integer NOT NULL DEFAULT 1;

-- Allinea i valori per i record già esistenti
UPDATE user_plans SET
  calls_limit      = 150,
  storage_limit_mb = 5,
  exams_limit      = 1
WHERE plan_type = 'free';

UPDATE user_plans SET
  calls_limit      = 500,
  storage_limit_mb = 50,
  exams_limit      = 2
WHERE plan_type = 'exam';

UPDATE user_plans SET
  calls_limit      = 1000,
  storage_limit_mb = 200,
  exams_limit      = 999
WHERE plan_type = 'monthly';


-- ── 2. Funzione di attivazione piano (chiamata da stripe-webhook) ──
CREATE OR REPLACE FUNCTION activate_paid_plan(
  p_user_id        uuid,
  p_plan_type      text,           -- 'exam' | 'monthly'
  p_payment_intent text DEFAULT NULL,
  p_subscription_id text DEFAULT NULL,
  p_valid_until    timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_calls_limit      integer;
  v_storage_limit_mb integer;
  v_exams_limit      integer;
BEGIN
  IF p_plan_type = 'exam' THEN
    v_calls_limit      := 500;
    v_storage_limit_mb := 50;
    v_exams_limit      := 2;  -- 1 free + 1 acquistato
  ELSIF p_plan_type = 'monthly' THEN
    v_calls_limit      := 1000;
    v_storage_limit_mb := 200;
    v_exams_limit      := 999;
  ELSE
    RAISE EXCEPTION 'Piano non valido: %', p_plan_type;
  END IF;

  INSERT INTO user_plans (
    user_id, plan_type,
    stripe_payment_intent, stripe_subscription_id,
    valid_until,
    calls_limit, storage_limit_mb, exams_limit,
    updated_at
  ) VALUES (
    p_user_id, p_plan_type,
    p_payment_intent, p_subscription_id,
    p_valid_until,
    v_calls_limit, v_storage_limit_mb, v_exams_limit,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    plan_type              = EXCLUDED.plan_type,
    stripe_payment_intent  = COALESCE(EXCLUDED.stripe_payment_intent,  user_plans.stripe_payment_intent),
    stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, user_plans.stripe_subscription_id),
    valid_until            = EXCLUDED.valid_until,
    calls_limit            = EXCLUDED.calls_limit,
    storage_limit_mb       = EXCLUDED.storage_limit_mb,
    exams_limit            = EXCLUDED.exams_limit,
    updated_at             = now();
END;
$$;

GRANT EXECUTE ON FUNCTION activate_paid_plan TO service_role;


-- ── 3. Funzione downgrade a free (chiamata da stripe-webhook) ────
CREATE OR REPLACE FUNCTION downgrade_to_free(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE user_plans SET
    plan_type              = 'free',
    stripe_subscription_id = NULL,
    valid_until            = NULL,
    calls_limit            = 150,
    storage_limit_mb       = 5,
    exams_limit            = 1,
    updated_at             = now()
  WHERE user_id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION downgrade_to_free TO service_role;


-- ── 4. Funzione pubblica per leggere limiti dell'utente corrente ──
CREATE OR REPLACE FUNCTION get_my_plan()
RETURNS TABLE(
  plan_type        text,
  calls_limit      integer,
  storage_limit_mb integer,
  exams_limit      integer,
  valid_until      timestamptz,
  stripe_customer_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    up.plan_type,
    up.calls_limit,
    up.storage_limit_mb,
    up.exams_limit,
    up.valid_until,
    up.stripe_customer_id
  FROM user_plans up
  WHERE up.user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION get_my_plan TO authenticated;
