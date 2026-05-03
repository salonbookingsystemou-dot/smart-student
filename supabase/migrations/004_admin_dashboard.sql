-- ─────────────────────────────────────────────────────────────────────────────
-- Mnesti — Admin Dashboard backend
-- Run in: Supabase Dashboard → SQL Editor
--
-- What this creates:
--   1. admin_emails       — whitelist of admin email addresses
--   2. user_exams         — tracks each exam plan created per user
--   3. is_admin()         — security check function (client-safe)
--   4. get_admin_dashboard_stats() — aggregate KPIs for overview cards
--   5. get_admin_users()  — full user list with joined usage + plan data
--   6. get_daily_new_users(days) — time-series for user growth chart
--   7. get_daily_api_calls(days) — time-series for API usage chart
--
-- All functions use SECURITY DEFINER so they can read auth.users safely
-- without exposing the service_role key to the frontend.
-- They all call is_admin() first and RAISE EXCEPTION if the caller is not admin.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Admin email whitelist ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_emails (
  email      TEXT        PRIMARY KEY,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.admin_emails ENABLE ROW LEVEL SECURITY;

-- No one reads this table directly — access only via SECURITY DEFINER functions
CREATE POLICY "admin_emails_deny_all" ON public.admin_emails
  AS RESTRICTIVE FOR ALL USING (false);

-- ── Seed: add your admin email here ──────────────────────────────────────────
-- Replace 'your@email.com' with the actual admin email before running.
-- You can add more rows as needed.
INSERT INTO public.admin_emails (email) VALUES ('contact@wordpresschef.it')
  ON CONFLICT (email) DO NOTHING;


-- ── 2. User exams tracking ────────────────────────────────────────────────────
-- Updated by the app whenever a study plan is generated/updated.
CREATE TABLE IF NOT EXISTS public.user_exams (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exam_name    TEXT        NOT NULL,
  exam_date    DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, exam_name)
);

ALTER TABLE public.user_exams ENABLE ROW LEVEL SECURITY;

-- Users can upsert/read only their own exams
CREATE POLICY "user_exams_own" ON public.user_exams
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS user_exams_user_id ON public.user_exams (user_id);
CREATE INDEX IF NOT EXISTS user_exams_created_at ON public.user_exams (created_at);


-- ── 3. is_admin() — lightweight check called from the client ─────────────────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_email TEXT;
BEGIN
  -- Unauthenticated requests are never admin
  IF auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT email INTO v_email
  FROM auth.users
  WHERE id = auth.uid();

  RETURN EXISTS (
    SELECT 1 FROM public.admin_emails WHERE email = v_email
  );
END;
$$;


-- ── Internal helper: assert admin or raise ───────────────────────────────────
CREATE OR REPLACE FUNCTION public._assert_admin()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'UNAUTHORIZED: admin access required';
  END IF;
END;
$$;


-- ── 4. get_admin_dashboard_stats() — KPI aggregate ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_result JSONB;
BEGIN
  PERFORM public._assert_admin();

  SELECT jsonb_build_object(
    -- User counts
    'total_users',        (SELECT COUNT(*) FROM auth.users),
    'new_users_today',    (SELECT COUNT(*) FROM auth.users WHERE created_at::date = CURRENT_DATE),
    'new_users_7d',       (SELECT COUNT(*) FROM auth.users WHERE created_at >= NOW() - INTERVAL '7 days'),
    'new_users_30d',      (SELECT COUNT(*) FROM auth.users WHERE created_at >= NOW() - INTERVAL '30 days'),

    -- Active users (had at least one API call in period)
    'active_users_today', (SELECT COUNT(DISTINCT user_id) FROM api_usage WHERE date = CURRENT_DATE),
    'active_users_7d',    (SELECT COUNT(DISTINCT user_id) FROM api_usage WHERE date >= CURRENT_DATE - 6),
    'active_users_30d',   (SELECT COUNT(DISTINCT user_id) FROM api_usage WHERE date >= CURRENT_DATE - 29),

    -- API usage totals
    'calls_today',        COALESCE((SELECT SUM(call_count) FROM api_usage WHERE date = CURRENT_DATE), 0),
    'calls_7d',           COALESCE((SELECT SUM(call_count) FROM api_usage WHERE date >= CURRENT_DATE - 6), 0),
    'calls_all',          COALESCE((SELECT SUM(call_count) FROM api_usage), 0),

    -- Token totals
    'input_tokens_all',   COALESCE((SELECT SUM(input_tokens)  FROM api_usage), 0),
    'output_tokens_all',  COALESCE((SELECT SUM(output_tokens) FROM api_usage), 0),

    -- Estimated cost in USD (Claude Sonnet pricing: $3/M input, $15/M output)
    'estimated_cost_usd', ROUND(
      (COALESCE((SELECT SUM(input_tokens)  FROM api_usage), 0)::numeric * 0.000003 +
       COALESCE((SELECT SUM(output_tokens) FROM api_usage), 0)::numeric * 0.000015), 2
    ),

    -- Plan breakdown
    'plan_free',    (SELECT COUNT(*) FROM user_plans WHERE plan_type = 'free'),
    'plan_exam',    (SELECT COUNT(*) FROM user_plans WHERE plan_type = 'exam'),
    'plan_monthly', (SELECT COUNT(*) FROM user_plans WHERE plan_type = 'monthly'),

    -- Exams created
    'exams_total',  (SELECT COUNT(*) FROM user_exams),
    'exams_30d',    (SELECT COUNT(*) FROM user_exams WHERE created_at >= NOW() - INTERVAL '30 days')
  ) INTO v_result;

  RETURN v_result;
END;
$$;


-- ── 5. get_admin_users() — full user table ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_users()
RETURNS TABLE (
  user_id          UUID,
  email            TEXT,
  registered_at    TIMESTAMPTZ,
  last_sign_in     TIMESTAMPTZ,
  plan_type        TEXT,
  exams_count      BIGINT,
  total_calls      BIGINT,
  total_input_tok  BIGINT,
  total_output_tok BIGINT,
  last_active_date DATE,
  estimated_cost   NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public._assert_admin();

  RETURN QUERY
  SELECT
    u.id                                                      AS user_id,
    u.email::TEXT                                             AS email,
    u.created_at                                              AS registered_at,
    u.last_sign_in_at                                         AS last_sign_in,
    COALESCE(p.plan_type, 'free')::TEXT                       AS plan_type,
    COALESCE((SELECT COUNT(*) FROM user_exams e WHERE e.user_id = u.id), 0) AS exams_count,
    COALESCE(SUM(a.call_count), 0)::BIGINT                    AS total_calls,
    COALESCE(SUM(a.input_tokens), 0)::BIGINT                  AS total_input_tok,
    COALESCE(SUM(a.output_tokens), 0)::BIGINT                 AS total_output_tok,
    MAX(a.date)                                               AS last_active_date,
    ROUND(
      (COALESCE(SUM(a.input_tokens),  0)::numeric * 0.000003 +
       COALESCE(SUM(a.output_tokens), 0)::numeric * 0.000015), 4
    )                                                         AS estimated_cost
  FROM auth.users u
  LEFT JOIN public.user_plans p  ON p.user_id = u.id
  LEFT JOIN public.api_usage  a  ON a.user_id = u.id
  GROUP BY u.id, u.email, u.created_at, u.last_sign_in_at, p.plan_type
  ORDER BY u.created_at DESC;
END;
$$;


-- ── 6. get_daily_new_users(days) — time-series for chart ─────────────────────
CREATE OR REPLACE FUNCTION public.get_daily_new_users(p_days INT DEFAULT 30)
RETURNS TABLE (day DATE, signups BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public._assert_admin();

  RETURN QUERY
  WITH series AS (
    SELECT generate_series(
      CURRENT_DATE - (p_days - 1),
      CURRENT_DATE,
      '1 day'::interval
    )::date AS day
  )
  SELECT
    s.day,
    COUNT(u.id)::BIGINT AS signups
  FROM series s
  LEFT JOIN auth.users u ON u.created_at::date = s.day
  GROUP BY s.day
  ORDER BY s.day;
END;
$$;


-- ── 7. get_daily_api_calls(days) — time-series for chart ─────────────────────
CREATE OR REPLACE FUNCTION public.get_daily_api_calls(p_days INT DEFAULT 30)
RETURNS TABLE (day DATE, calls BIGINT, tokens BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public._assert_admin();

  RETURN QUERY
  WITH series AS (
    SELECT generate_series(
      CURRENT_DATE - (p_days - 1),
      CURRENT_DATE,
      '1 day'::interval
    )::date AS day
  )
  SELECT
    s.day,
    COALESCE(SUM(a.call_count),  0)::BIGINT AS calls,
    COALESCE(SUM(a.input_tokens + a.output_tokens), 0)::BIGINT AS tokens
  FROM series s
  LEFT JOIN public.api_usage a ON a.date = s.day
  GROUP BY s.day
  ORDER BY s.day;
END;
$$;


-- ── Grant EXECUTE to authenticated role ──────────────────────────────────────
-- (RLS + SECURITY DEFINER handle the real authorization)
GRANT EXECUTE ON FUNCTION public.is_admin()                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats()   TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_users()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_new_users(INT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_api_calls(INT)      TO authenticated;
