-- ============================================================
-- 042_branch_rls
--
-- Step 4 of standalone multi-WhatsApp: branch-scoped RLS.
--
-- Owner / admin see every branch. Agents and viewers see only
-- branches they have a `branch_memberships` row for. Unassigned
-- numbers (`branch_id` NULL) stay owner/admin-only so an agent
-- cannot pick up another salon's unattached inbox.
--
-- Child tables that join `conversations` (messages, reactions) are
-- rewritten to call `can_access_branch` so isolation does not
-- depend on nested RLS evaluation order.
--
-- What this migration does NOT do
--   - Assignment dropdown limited to branch agents (later step)
--   - Broadcast / template / KPI job scoping
--   - Inbox UI (application layer)
--
-- Idempotent — safe to re-run. Does not touch migration 036,
-- ENCRYPTION_KEY, or any Fukomo objects.
-- ============================================================

-- ============================================================
-- 1. can_access_branch
--
-- SECURITY DEFINER so policies can read `profiles` and
-- `branch_memberships` without recursive RLS. Mirrors
-- `is_account_member` from 017.
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_branch(
  target_account_id UUID,
  target_branch_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND (
        p.account_role IN ('owner', 'admin')
        OR (
          target_branch_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM branch_memberships bm
            WHERE bm.account_id = target_account_id
              AND bm.branch_id = target_branch_id
              AND bm.user_id = auth.uid()
          )
        )
      )
  );
$$;

ALTER FUNCTION can_access_branch(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_branch(UUID, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION can_access_branch(UUID, UUID) IS
  'True iff auth.uid() is owner/admin of the account, or an agent/viewer '
  'with a branch_memberships row for target_branch_id. NULL branch_id is '
  'owner/admin only.';

-- ============================================================
-- 2. conversations
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_access_branch(account_id, branch_id));

DROP POLICY IF EXISTS conversations_insert ON conversations;
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND can_access_branch(account_id, branch_id)
  );

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_branch(account_id, branch_id)
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND can_access_branch(account_id, branch_id)
  );

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_branch(account_id, branch_id)
  );

-- ============================================================
-- 3. messages
-- ============================================================
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_branch(c.account_id, c.branch_id)
  )
);

DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_branch(c.account_id, c.branch_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_branch(c.account_id, c.branch_id)
  )
);

-- ============================================================
-- 4. message_reactions
-- ============================================================
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_branch(c.account_id, c.branch_id)
  )
);

DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_branch(c.account_id, c.branch_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_branch(c.account_id, c.branch_id)
  )
);

-- ============================================================
-- 5. whatsapp_config SELECT — agents only see numbers on branches
--    they can access. Writes stay admin+.
-- ============================================================
DROP POLICY IF EXISTS whatsapp_config_select ON whatsapp_config;
CREATE POLICY whatsapp_config_select ON whatsapp_config FOR SELECT
  USING (can_access_branch(account_id, branch_id));

-- ============================================================
-- 6. branches SELECT — same visibility as conversations
-- ============================================================
DROP POLICY IF EXISTS branches_select ON branches;
CREATE POLICY branches_select ON branches FOR SELECT
  USING (can_access_branch(account_id, id));

-- ============================================================
-- 7. branch_memberships SELECT
--    Admin+ see every grant (Settings). Agents see their own rows
--    so the inbox filter can list granted branches without a second
--    privilege.
-- ============================================================
DROP POLICY IF EXISTS branch_memberships_select ON branch_memberships;
CREATE POLICY branch_memberships_select ON branch_memberships FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR user_id = auth.uid()
  );

-- ============================================================
-- 8. kpi_response_daily — same scope as the inbox. No KPI UI yet.
-- ============================================================
DROP POLICY IF EXISTS kpi_response_daily_select ON kpi_response_daily;
CREATE POLICY kpi_response_daily_select ON kpi_response_daily FOR SELECT
  USING (can_access_branch(account_id, branch_id));
