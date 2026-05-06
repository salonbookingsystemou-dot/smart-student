-- ─────────────────────────────────────────────────────────────────────────────
-- Fix function security warnings:
--   1. Add SET search_path on SECURITY DEFINER functions missing it
--   2. REVOKE EXECUTE from roles that should never call these functions via REST
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Recreate activate_paid_plan with fixed search_path ────────────────────
CREATE OR REPLACE FUNCTION public.activate_paid_plan(
  p_user_id         uuid,
  p_plan_type       text,
  p_payment_intent  text        DEFAULT NULL,
  p_subscription_id text        DEFAULT NULL,
  p_valid_until     timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calls_limit      integer;
  v_storage_limit_mb integer;
  v_exams_limit      integer;
BEGIN
  IF p_plan_type = 'exam' THEN
    v_calls_limit      := 500;
    v_storage_limit_mb := 50;
    v_exams_limit      := 2;
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


-- ── 2. Recreate downgrade_to_free with fixed search_path ─────────────────────
CREATE OR REPLACE FUNCTION public.downgrade_to_free(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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


-- ── 3. Recreate get_my_plan with fixed search_path ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_plan()
RETURNS TABLE(
  plan_type          text,
  calls_limit        integer,
  storage_limit_mb   integer,
  exams_limit        integer,
  valid_until        timestamptz,
  stripe_customer_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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


-- ── 4. REVOKE: functions only callable by service_role (Edge Functions) ───────
-- anon + authenticated must never invoke these via REST
REVOKE EXECUTE ON FUNCTION public.activate_paid_plan(uuid, text, text, text, timestamptz)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.downgrade_to_free(uuid)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.increment_api_usage(uuid, date, integer, integer, integer)
  FROM anon, authenticated;


-- ── 5. REVOKE: trigger-only function ─────────────────────────────────────────
-- create_free_plan_for_new_user is invoked exclusively by a Postgres trigger
REVOKE EXECUTE ON FUNCTION public.create_free_plan_for_new_user()
  FROM anon, authenticated;


-- ── 6. REVOKE: internal helper not meant for direct REST calls ────────────────
REVOKE EXECUTE ON FUNCTION public._assert_admin()
  FROM anon, authenticated;


-- ── 7. REVOKE: admin functions — remove anon access ──────────────────────────
-- authenticated access is intentional (guarded internally by _assert_admin())
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_stats() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_users()           FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_daily_new_users(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_daily_api_calls(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin()                   FROM anon;


-- ── 8. REVOKE: user-facing function — remove anon access only ────────────────
-- authenticated users legitimately call get_my_plan()
REVOKE EXECUTE ON FUNCTION public.get_my_plan() FROM anon;


-- ── 9. REVOKE: setup utility never exposed via REST ──────────────────────────
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()
  FROM anon, authenticated;
