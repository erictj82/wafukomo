-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Multi-WhatsApp + branches (040). Assert outcomes, not just that
  -- CREATE TABLE IF NOT EXISTS didn't error.
  IF to_regclass('public.branches') IS NULL THEN
    RAISE EXCEPTION 'public.branches is missing — migration 040 did not apply';
  END IF;
  IF to_regclass('public.branch_memberships') IS NULL THEN
    RAISE EXCEPTION 'public.branch_memberships is missing — migration 040 did not apply';
  END IF;
  IF to_regclass('public.kpi_response_daily') IS NULL THEN
    RAISE EXCEPTION 'public.kpi_response_daily is missing — migration 040 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'branches_account_id_name_key'
      AND conrelid = 'branches'::regclass
  ) THEN
    RAISE EXCEPTION 'branches UNIQUE(account_id, name) is missing — migration 040';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name = 'message_retention_days'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'accounts.message_retention_days is missing or nullable — migration 040';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'branch_id'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.branch_id is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'display_name'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.display_name is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'display_phone_number'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.display_phone_number is missing — migration 040';
  END IF;

  -- One number per account must be gone; phone_number_id uniqueness stays.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_account_id_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    RAISE EXCEPTION 'whatsapp_config_account_id_key should have been dropped by migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_phone_number_id_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    RAISE EXCEPTION 'whatsapp_config_phone_number_id_key is missing — a number must stay unique globally';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_whatsapp_config_one_per_branch'
  ) THEN
    RAISE EXCEPTION 'idx_whatsapp_config_one_per_branch is missing — v1 one number per branch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'whatsapp_config_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'conversations.whatsapp_config_id is missing or nullable — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'branch_id'
  ) THEN
    RAISE EXCEPTION 'conversations.branch_id is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'awaiting_response_since'
  ) THEN
    RAISE EXCEPTION 'conversations.awaiting_response_since is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'last_customer_message_at'
  ) THEN
    RAISE EXCEPTION 'conversations.last_customer_message_at is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'last_human_reply_at'
  ) THEN
    RAISE EXCEPTION 'conversations.last_human_reply_at is missing — migration 040';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_conversations_account_contact'
  ) THEN
    RAISE EXCEPTION 'idx_conversations_account_contact should have been dropped by migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_conversations_account_whatsapp_contact'
  ) THEN
    RAISE EXCEPTION 'idx_conversations_account_whatsapp_contact is missing — uniqueness must include the WhatsApp number';
  END IF;

  -- messages.sender_id remains a non-unique UUID (human agent). Meta
  -- message_id must NOT be globally unique; per-conversation unique
  -- from 037 is the idempotency key.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name = 'sender_id'
      AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'messages.sender_id is missing or not uuid — migration 001/040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_messages_conversation_message_id'
  ) THEN
    RAISE EXCEPTION 'idx_messages_conversation_message_id is missing — per-conversation wamid uniqueness from 037';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_conversations_account_whatsapp_last_message'
  ) THEN
    RAISE EXCEPTION 'idx_conversations_account_whatsapp_last_message is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_conversations_account_awaiting'
  ) THEN
    RAISE EXCEPTION 'idx_conversations_account_awaiting is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_conversations_account_assigned_agent'
  ) THEN
    RAISE EXCEPTION 'idx_conversations_account_assigned_agent is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_messages_conversation_created'
  ) THEN
    RAISE EXCEPTION 'idx_messages_conversation_created is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_messages_sender_created'
  ) THEN
    RAISE EXCEPTION 'idx_messages_sender_created is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_kpi_response_daily_account_day'
  ) THEN
    RAISE EXCEPTION 'idx_kpi_response_daily_account_day is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_kpi_response_daily_agent_grain'
  ) THEN
    RAISE EXCEPTION 'idx_kpi_response_daily_agent_grain is missing — migration 040';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_kpi_response_daily_unattributed_grain'
  ) THEN
    RAISE EXCEPTION 'idx_kpi_response_daily_unattributed_grain is missing — migration 040';
  END IF;

  -- 041 replaced the 2-arg inbound bump with a 3-arg version that
  -- also sets last_customer_message_at / awaiting_response_since.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'bump_conversation_on_inbound'
      AND p.pronargs = 3
  ) THEN
    RAISE EXCEPTION 'bump_conversation_on_inbound must have 3 arguments after migration 041';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'bump_conversation_on_inbound'
      AND p.pronargs = 2
  ) THEN
    RAISE EXCEPTION '2-arg bump_conversation_on_inbound should have been dropped by migration 041';
  END IF;

  -- Branch-scoped RLS (042). Isolation is this function, not a UI filter.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'can_access_branch'
      AND p.pronargs = 2
  ) THEN
    RAISE EXCEPTION 'can_access_branch(uuid, uuid) is missing — migration 042';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'conversations'
      AND policyname = 'conversations_select'
  ) THEN
    RAISE EXCEPTION 'conversations_select is missing — migration 042';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
