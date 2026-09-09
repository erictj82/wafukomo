-- ============================================================
-- 041_inbound_waiting_state
--
-- Phase 1 follow-up to 040: keep conversation waiting-state
-- columns in lockstep with inbound customer messages.
--
-- Migration 040 added last_customer_message_at / last_human_reply_at
-- / awaiting_response_since but left bump_conversation_on_inbound
-- (037) only bumping unread + last_message_*. The webhook is the
-- only caller; human outbound clears waiting in application code.
--
-- Bot / AI sends do NOT call this function, so they cannot close
-- an open wait.
--
-- Idempotent. Does not touch 036, RLS, broadcasts, or KPI jobs.
-- ============================================================

DROP FUNCTION IF EXISTS public.bump_conversation_on_inbound(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT,
  p_inbound_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count             = COALESCE(unread_count, 0) + 1,
      last_message_text        = p_last_message_text,
      last_message_at          = COALESCE(p_inbound_at, NOW()),
      last_customer_message_at = COALESCE(p_inbound_at, NOW()),
      awaiting_response_since  = COALESCE(
        awaiting_response_since,
        COALESCE(p_inbound_at, NOW())
      ),
      updated_at               = NOW()
  WHERE id = p_conversation_id;
$$;

ALTER FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) TO service_role;
