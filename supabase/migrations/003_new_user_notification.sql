-- ─────────────────────────────────────────────────────────────
-- Mnesti — Admin notification on new user registration
-- Run in: Supabase Dashboard → SQL Editor
--
-- BEFORE running this migration you must:
--   1. Deploy the notify-new-user Edge Function (see deploy instructions)
--   2. Set the WEBHOOK_SECRET Supabase secret (see instructions)
--   3. Store the same secret in the DB config (command below)
--
-- One-time DB config (replace the value with your WEBHOOK_SECRET):
--   ALTER DATABASE postgres SET app.webhook_secret = 'YOUR_WEBHOOK_SECRET_HERE';
-- ─────────────────────────────────────────────────────────────

-- ── 1. Enable pg_net (already bundled with Supabase, idempotent) ──
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;

-- ── 2. Trigger function ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_new_user_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  fn_url      TEXT    := 'https://olagntawajefdjrkkvcc.supabase.co/functions/v1/notify-new-user';
  wh_secret   TEXT    := current_setting('app.webhook_secret', true);
  request_id  BIGINT;
BEGIN
  -- Silently skip if the secret has not been configured yet
  IF wh_secret IS NULL OR wh_secret = '' THEN
    RAISE WARNING '[notify_new_user] app.webhook_secret not set — skipping notification';
    RETURN NEW;
  END IF;

  SELECT INTO request_id extensions.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', wh_secret
    ),
    body    := jsonb_build_object(
      'id',         NEW.id,
      'email',      NEW.email,
      'created_at', NEW.created_at
    )::text,
    timeout_milliseconds := 5000
  );

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Never block the user registration flow if the notification fails
  RAISE WARNING '[notify_new_user] HTTP call failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- ── 3. Attach trigger to auth.users ──────────────────────────────
DROP TRIGGER IF EXISTS on_user_registered_notify ON auth.users;

CREATE TRIGGER on_user_registered_notify
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION notify_new_user_registration();
