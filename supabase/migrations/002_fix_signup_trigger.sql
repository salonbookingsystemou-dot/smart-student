-- ─────────────────────────────────────────────────────────────
-- Mnesti — Fix signup trigger + ensure tables exist
-- Run this in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────

-- ── 1. Ensure api_usage table exists ─────────────────────────
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

CREATE INDEX IF NOT EXISTS api_usage_user_date ON api_usage(user_id, date);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_usage' AND policyname = 'Users read own usage'
  ) THEN
    CREATE POLICY "Users read own usage" ON api_usage
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_usage' AND policyname = 'Service role manages usage'
  ) THEN
    CREATE POLICY "Service role manages usage" ON api_usage
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;


-- ── 2. Ensure user_plans table exists ────────────────────────
CREATE TABLE IF NOT EXISTS user_plans (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_type             text        NOT NULL DEFAULT 'free'
                                    CHECK (plan_type IN ('free', 'exam', 'monthly')),
  exam_id               text,
  valid_until           timestamptz,
  stripe_customer_id    text,
  stripe_subscription_id text,
  stripe_payment_intent  text,
  free_days_used        integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_plans' AND policyname = 'Users read own plan'
  ) THEN
    CREATE POLICY "Users read own plan" ON user_plans
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_plans' AND policyname = 'Service role manages plans'
  ) THEN
    CREATE POLICY "Service role manages plans" ON user_plans
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;


-- ── 3. increment_api_usage function ──────────────────────────
CREATE OR REPLACE FUNCTION increment_api_usage(
  p_user_id       uuid,
  p_date          date,
  p_calls         integer DEFAULT 1,
  p_input_tokens  integer DEFAULT 0,
  p_output_tokens integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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


-- ── 4. Signup trigger — EXCEPTION-SAFE (never blocks registration) ──
-- Replaces the previous version that could crash and block signups.
CREATE OR REPLACE FUNCTION create_free_plan_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO user_plans (user_id, plan_type)
  VALUES (NEW.id, 'free')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block user registration due to our table logic
  RAISE WARNING '[mnesti] create_free_plan_for_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_user_created_create_plan ON auth.users;
CREATE TRIGGER on_user_created_create_plan
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_free_plan_for_new_user();


-- ── 5. Back-fill free plan for existing users who have none ──
INSERT INTO user_plans (user_id, plan_type)
SELECT id, 'free'
FROM auth.users
WHERE id NOT IN (SELECT user_id FROM user_plans)
ON CONFLICT (user_id) DO NOTHING;
