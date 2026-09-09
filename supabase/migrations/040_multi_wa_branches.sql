-- ============================================================
-- 040_multi_wa_branches
--
-- Step 1 of standalone multi-WhatsApp: schema only.
--
-- Turns the current 1-number-per-account model into:
--   account
--     └── branches
--           └── at most one whatsapp_config (v1)
--                 └── conversations unique per
--                     (account_id, whatsapp_config_id, contact_id)
--
-- What this migration does
--   1. Creates `branches` and `branch_memberships`.
--   2. Drops `whatsapp_config.UNIQUE(account_id)` so one account can
--      own many numbers. Keeps `UNIQUE(phone_number_id)`. Adds
--      `branch_id` / `display_name` / `display_phone_number`, and a
--      partial unique index so a branch has at most one number.
--   3. Adds conversation identity + waiting-state columns; replaces
--      `UNIQUE(account_id, contact_id)` with
--      `UNIQUE(account_id, whatsapp_config_id, contact_id)`.
--   4. Adds `accounts.message_retention_days` (default 120).
--   5. Creates `kpi_response_daily` for later SLA rollups (no job yet).
--   6. Documents `messages.sender_id` as the human agent; adds the
--      requested indexes. Does NOT add a global unique on
--      `messages.message_id` (Meta ids repeat across numbers; the
--      per-conversation unique from 037 stays).
--   7. Backfills a `Default` branch for every account that already has
--      a WhatsApp number, attaches that number, and stamps every
--      existing conversation with that `whatsapp_config_id` /
--      `branch_id`. No customer, conversation, message, or WhatsApp
--      credential rows are deleted.
--   8. A BEFORE INSERT trigger fills `whatsapp_config_id` /
--      `branch_id` when the current app omits them, so webhook and
--      send-message inserts keep working until Step 2.
--
-- What this migration does NOT do (later steps)
--   - Branch-scoped RLS (Step 4). Existing account-wide conversation
--     / message policies are left untouched.
--   - Webhook, send-message, UI, KPI calculation, retention cron.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. branches
-- ============================================================
CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  timezone    TEXT,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_branches_account
  ON branches(account_id);

-- Lets child tables FK (id, account_id) so a membership / number /
-- conversation cannot point at a branch in a different account.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'branches_id_account_id_key'
      AND conrelid = 'branches'::regclass
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_id_account_id_key UNIQUE (id, account_id);
  END IF;
END $$;

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON branches;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Settings-class, same shape as whatsapp_config / webhook_endpoints.
-- Step 4 will narrow SELECT to branch membership; until then every
-- account member can read, admin+ can write. Conversation/message
-- policies are not changed here.
DROP POLICY IF EXISTS branches_select ON branches;
CREATE POLICY branches_select ON branches FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS branches_insert ON branches;
CREATE POLICY branches_insert ON branches FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS branches_update ON branches;
CREATE POLICY branches_update ON branches FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS branches_delete ON branches;
CREATE POLICY branches_delete ON branches FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 2. branch_memberships
--
-- Owner / admin do not need a row (they see every branch). Agents
-- are granted access here in Step 3/4. Unique (branch_id, user_id).
-- ============================================================
CREATE TABLE IF NOT EXISTS branch_memberships (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  branch_id  UUID NOT NULL,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, user_id),
  FOREIGN KEY (branch_id, account_id)
    REFERENCES branches(id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_branch_memberships_account
  ON branch_memberships(account_id);

CREATE INDEX IF NOT EXISTS idx_branch_memberships_user
  ON branch_memberships(user_id);

ALTER TABLE branch_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS branch_memberships_select ON branch_memberships;
CREATE POLICY branch_memberships_select ON branch_memberships FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS branch_memberships_insert ON branch_memberships;
CREATE POLICY branch_memberships_insert ON branch_memberships FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS branch_memberships_update ON branch_memberships;
CREATE POLICY branch_memberships_update ON branch_memberships FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS branch_memberships_delete ON branch_memberships;
CREATE POLICY branch_memberships_delete ON branch_memberships FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 3. accounts.message_retention_days
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS message_retention_days INTEGER NOT NULL DEFAULT 120;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_message_retention_days_positive;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_message_retention_days_positive
  CHECK (message_retention_days >= 1);

COMMENT ON COLUMN accounts.message_retention_days IS
  'Days to keep WhatsApp message rows and chat-media. Contacts, agents, '
  'branches, WhatsApp config, KPI aggregates, and settings are never purged. '
  'Default 120. The retention job lands in a later step.';

-- ============================================================
-- 4. whatsapp_config — many numbers per account
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS branch_id UUID,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_branch_id_fkey'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_branch_id_fkey
      FOREIGN KEY (branch_id)
      REFERENCES branches(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Composite unique so conversations / KPI can FK (id, account_id)
-- and cannot point a thread at another account's number.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_id_account_id_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_id_account_id_key UNIQUE (id, account_id);
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.branch_id IS
  'Optional org unit this number belongs to. v1: at most one number per branch.';
COMMENT ON COLUMN whatsapp_config.display_name IS
  'Operator-facing label (e.g. salon name). Not a Meta field.';
COMMENT ON COLUMN whatsapp_config.display_phone_number IS
  'Human-readable MSISDN from Meta metadata. Distinct from phone_number_id.';

-- Keep UNIQUE(phone_number_id) from migration 013. Drop one-number-
-- per-account so an account can register Iseo + Tumapel + future.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- v1: at most one WhatsApp number per branch. Unassigned numbers
-- (branch_id IS NULL) are allowed and do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_per_branch
  ON whatsapp_config (branch_id)
  WHERE branch_id IS NOT NULL;

-- ============================================================
-- 5. conversations — identity + waiting-state columns
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID,
  ADD COLUMN IF NOT EXISTS branch_id UUID,
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_human_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS awaiting_response_since TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_whatsapp_config_id_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_whatsapp_config_id_fkey
      FOREIGN KEY (whatsapp_config_id)
      REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_branch_id_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_branch_id_fkey
      FOREIGN KEY (branch_id)
      REFERENCES branches(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Number must belong to the same account as the conversation.
-- Branch uses a simple FK (ON DELETE SET NULL) instead of a
-- composite FK: a composite (branch_id, account_id) ON DELETE SET NULL
-- would also null account_id, which we must never do.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_whatsapp_account_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_whatsapp_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES whatsapp_config(id, account_id);
  END IF;
END $$;

COMMENT ON COLUMN conversations.whatsapp_config_id IS
  'WhatsApp number this thread belongs to. Conversation uniqueness is '
  '(account_id, whatsapp_config_id, contact_id) so the same customer can '
  'have one thread per number.';
COMMENT ON COLUMN conversations.branch_id IS
  'Denormalised from whatsapp_config.branch_id for inbox filters and RLS (Step 4).';
COMMENT ON COLUMN conversations.last_customer_message_at IS
  'Timestamp of the latest customer message. Maintained by later write paths.';
COMMENT ON COLUMN conversations.last_human_reply_at IS
  'Timestamp of the latest human-agent reply (sender_type=agent, sender_id set).';
COMMENT ON COLUMN conversations.awaiting_response_since IS
  'Start of the open waiting period. NULL when a human has answered.';

-- ============================================================
-- 6. Backfill — no deletes
--
-- Runs while existing installs still have at most one
-- whatsapp_config per account (the unique we just dropped still
-- described the data even after the constraint itself is gone).
--
--   a. Create a Default branch for every account that has a number
--      and does not yet have any branch.
--   b. Attach unassigned numbers to that account's oldest branch.
--   c. Stamp conversations from the account's (single) number.
-- ============================================================
INSERT INTO branches (account_id, name)
SELECT DISTINCT w.account_id, 'Default'
FROM whatsapp_config w
WHERE NOT EXISTS (
  SELECT 1 FROM branches b WHERE b.account_id = w.account_id
);

UPDATE whatsapp_config w
SET branch_id = b.id
FROM (
  SELECT DISTINCT ON (account_id) id, account_id
  FROM branches
  ORDER BY account_id, created_at ASC, id ASC
) b
WHERE w.account_id = b.account_id
  AND w.branch_id IS NULL;

-- One number per account at backfill time, so this join is 1:1.
-- Only fills rows that are still NULL so a re-run after Step 2
-- (multiple numbers) will not overwrite a conversation's number.
UPDATE conversations c
SET
  whatsapp_config_id = w.id,
  branch_id = w.branch_id
FROM whatsapp_config w
WHERE w.account_id = c.account_id
  AND c.whatsapp_config_id IS NULL;

-- Fail loudly rather than invent a fake WhatsApp config or delete
-- threads. Empty CI databases have zero conversations, so this is a
-- no-op there. A production account with conversations but no
-- whatsapp_config row is unexpected (webhook/send already require a
-- config) and needs an operator decision.
DO $$
DECLARE
  orphan_count INT;
  sample TEXT;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM conversations
  WHERE whatsapp_config_id IS NULL;

  IF orphan_count > 0 THEN
    SELECT string_agg(id::text, ', ')
    INTO sample
    FROM (
      SELECT id FROM conversations
      WHERE whatsapp_config_id IS NULL
      LIMIT 10
    ) s;

    RAISE EXCEPTION
      'Cannot SET NOT NULL on conversations.whatsapp_config_id — % conversation(s) have no matching whatsapp_config (sample ids: %). Connect WhatsApp for those accounts, then re-run. No rows were deleted.',
      orphan_count,
      sample;
  END IF;
END $$;

ALTER TABLE conversations
  ALTER COLUMN whatsapp_config_id SET NOT NULL;

-- ============================================================
-- 7. Conversation uniqueness: include the WhatsApp number
-- ============================================================
DROP INDEX IF EXISTS idx_conversations_account_contact;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_whatsapp_contact
  ON conversations (account_id, whatsapp_config_id, contact_id);

-- Keep merge_duplicate_conversations() from collapsing two numbers'
-- threads for the same contact if it is ever re-run.
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           whatsapp_config_id,
           contact_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id, whatsapp_config_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

-- ============================================================
-- 8. Compatibility trigger for current insert paths
--
-- Webhook / resolve-conversation / send still INSERT conversations
-- without whatsapp_config_id. Until Step 2 sets it explicitly, stamp
-- the account's oldest connected number so NOT NULL does not break
-- inbound. No-op when the caller already supplied the id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.conversations_fill_whatsapp_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_config whatsapp_config%ROWTYPE;
BEGIN
  IF NEW.whatsapp_config_id IS NULL THEN
    SELECT * INTO v_config
    FROM whatsapp_config
    WHERE account_id = NEW.account_id
    ORDER BY created_at ASC, id ASC
    LIMIT 1;

    IF FOUND THEN
      NEW.whatsapp_config_id := v_config.id;
      IF NEW.branch_id IS NULL THEN
        NEW.branch_id := v_config.branch_id;
      END IF;
    END IF;
  ELSIF NEW.branch_id IS NULL THEN
    SELECT branch_id INTO NEW.branch_id
    FROM whatsapp_config
    WHERE id = NEW.whatsapp_config_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_fill_whatsapp_identity ON conversations;
CREATE TRIGGER conversations_fill_whatsapp_identity
  BEFORE INSERT ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION conversations_fill_whatsapp_identity();

-- ============================================================
-- 9. messages.sender_id — human agent identity
--
-- Column already exists (migration 001). Outbound writes do not
-- populate it yet (Step 2). Do not add a global UNIQUE on
-- message_id — 009/037: Meta ids repeat across numbers; idempotency
-- is (conversation_id, message_id).
-- ============================================================
COMMENT ON COLUMN messages.sender_id IS
  'For sender_type=agent: auth.users.id of the human who sent the message. '
  'NULL for customer/bot and for rows written before this column was populated. '
  'Not globally unique. Distinct from conversations.assigned_agent_id.';

-- ============================================================
-- 10. kpi_response_daily
--
-- Grain: one row per (account, branch, number, agent, day).
-- agent_user_id NULL = unattributed / branch-number total that is
-- not attributed to one agent. Two partial unique indexes enforce
-- that grain (Postgres UNIQUE treats NULLs as distinct).
-- Writes come from a later cron via the service role (no INSERT
-- policy for authenticated). SELECT stays account-wide until Step 4.
-- ============================================================
CREATE TABLE IF NOT EXISTS kpi_response_daily (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  branch_id            UUID NOT NULL,
  whatsapp_config_id   UUID NOT NULL,
  agent_user_id        UUID,
  day                  DATE NOT NULL,
  samples_count        INTEGER NOT NULL DEFAULT 0,
  first_response_sum_ms BIGINT NOT NULL DEFAULT 0,
  median_ms            INTEGER,
  within_5min_count    INTEGER NOT NULL DEFAULT 0,
  unanswered_eod_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (branch_id, account_id)
    REFERENCES branches(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (whatsapp_config_id, account_id)
    REFERENCES whatsapp_config(id, account_id) ON DELETE RESTRICT,
  CHECK (samples_count >= 0),
  CHECK (first_response_sum_ms >= 0),
  CHECK (within_5min_count >= 0),
  CHECK (unanswered_eod_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_response_daily_agent_grain
  ON kpi_response_daily (account_id, branch_id, whatsapp_config_id, agent_user_id, day)
  WHERE agent_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_response_daily_unattributed_grain
  ON kpi_response_daily (account_id, branch_id, whatsapp_config_id, day)
  WHERE agent_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_kpi_response_daily_account_day
  ON kpi_response_daily (account_id, day);

ALTER TABLE kpi_response_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kpi_response_daily_select ON kpi_response_daily;
CREATE POLICY kpi_response_daily_select ON kpi_response_daily FOR SELECT
  USING (is_account_member(account_id));

-- ============================================================
-- 11. Requested lookup indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_account_whatsapp_last_message
  ON conversations (account_id, whatsapp_config_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_account_awaiting
  ON conversations (account_id, awaiting_response_since)
  WHERE awaiting_response_since IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_account_assigned_agent
  ON conversations (account_id, assigned_agent_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages (sender_id, created_at)
  WHERE sender_type = 'agent';
