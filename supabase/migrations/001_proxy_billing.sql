-- ─────────────────────────────────────────────────────────────
-- Mnesti — API Usage tracking + User Plans (Stripe-ready)
-- Run this in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────

-- ── 1. API usage table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_usage (
  id              bigserial PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date            date        NOT NULL DEFAULT CURRENT_DATE,
  call_count      integer     NOT NULL DEFAULT 0,
  input_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens   integer     NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);

ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;

-- Users can only read their own usage
CREATE POLICY "Users read own usage" ON api_usage
  FOR SELECT USING (auth.uid() = user_id);

-- Only the Edge Function (service role) can insert/update
CREATE POLICY "Service role manages usage" ON api_usage
  FOR ALL USING (auth.role() = 'service_role');

-- Index for fast daily lookups
CREATE INDEX IF NOT EXISTS api_usage_user_date ON api_usage(user_id, date);


-- ── 2. Atomic upsert function (called by Edge Function) ───────
CREATE OR REPLACE FUNCTION increment_api_usage(
  p_user_id       uuid,
  p_date          date,
  p_calls         integer DEFAULT 1,
  p_input_tokens  integer DEFAULT 0,
  p_output_tokens integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER  -- runs as owner, bypasses RLS
AS $$
BEGIN
  INSERT INTO api_usage (user_id, date, call_count, input_tokens, output_tokens, updated_at)
  VALUES (p_user_id, p_date, p_calls, p_input_tokens, p_output_tokens, now())
  ON CONFLICT (user_id, date) DO UPDATE SET
    call_count    = api_usage.call_count    + EXCLUDED.call_count,
    input_tokens  = api_usage.input_tokens  + EXCLUDED.input_tokens,
    output_tokens = api_usage.output_tokens + EXCLUDED.output_tokens,
    updated_at    = now();
END;
$$;


-- ── 3. User plans table (Stripe-ready) ───────────────────────
-- plan_type: 'free' | 'exam' (€30 one exam) | 'monthly' (€15/mo)
CREATE TABLE IF NOT EXISTS user_plans (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_type             text        NOT NULL DEFAULT 'free'
                                    CHECK (plan_type IN ('free', 'exam', 'monthly')),
  exam_id               text,       -- for 'exam' plan: which exam it unlocks (null = all)
  valid_until           timestamptz,-- null = no expiry (exam plan), set for monthly
  stripe_customer_id    text,
  stripe_subscription_id text,
  stripe_payment_intent  text,
  free_days_used        integer     NOT NULL DEFAULT 0, -- days consumed in free tier
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)      -- one plan row per user (update instead of insert for upgrades)
);

ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own plan" ON user_plans
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role manages plans" ON user_plans
  FOR ALL USING (auth.role() = 'service_role');


-- ── 4. Auto-create free plan for new users ───────────────────
CREATE OR REPLACE FUNCTION create_free_plan_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO user_plans (user_id, plan_type)
  VALUES (NEW.id, 'free')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_user_created_create_plan ON auth.users;
CREATE TRIGGER on_user_created_create_plan
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_free_plan_for_new_user();


-- ── 5. Admin view: usage summary (accessible only to service role) ──
CREATE OR REPLACE VIEW admin_usage_summary AS
SELECT
  u.id                                         AS user_id,
  u.email,
  up.plan_type,
  COALESCE(SUM(au.call_count), 0)              AS total_calls,
  COALESCE(SUM(au.input_tokens), 0)            AS total_input_tokens,
  COALESCE(SUM(au.output_tokens), 0)           AS total_output_tokens,
  -- Estimated cost in USD (claude-sonnet-4 pricing)
  ROUND(
    (COALESCE(SUM(au.input_tokens), 0)  * 0.000003  +
     COALESCE(SUM(au.output_tokens), 0) * 0.000015)::numeric, 4
  )                                            AS estimated_cost_usd,
  MAX(au.date)                                 AS last_active
FROM auth.users u
LEFT JOIN user_plans up ON up.user_id = u.id
LEFT JOIN api_usage  au ON au.user_id = u.id
GROUP BY u.id, u.email, up.plan_type;
