-- Fix security issues on admin_usage_summary view:
-- 1. Use security_invoker so the view runs with the caller's permissions (not owner's)
-- 2. Revoke access from anon and authenticated roles to prevent PostgREST exposure

CREATE OR REPLACE VIEW public.admin_usage_summary
  WITH (security_invoker = true)
AS
SELECT
  u.id                                         AS user_id,
  u.email,
  up.plan_type,
  COALESCE(SUM(au.call_count), 0)              AS total_calls,
  COALESCE(SUM(au.input_tokens), 0)            AS total_input_tokens,
  COALESCE(SUM(au.output_tokens), 0)           AS total_output_tokens,
  ROUND(
    (COALESCE(SUM(au.input_tokens), 0)  * 0.000003  +
     COALESCE(SUM(au.output_tokens), 0) * 0.000015)::numeric, 4
  )                                            AS estimated_cost_usd,
  MAX(au.date)                                 AS last_active
FROM auth.users u
LEFT JOIN user_plans up ON up.user_id = u.id
LEFT JOIN api_usage  au ON au.user_id = u.id
GROUP BY u.id, u.email, up.plan_type;

-- Only service_role (used server-side) may query this view
REVOKE ALL ON public.admin_usage_summary FROM anon, authenticated;
