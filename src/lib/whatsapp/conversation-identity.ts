// ============================================================
// Conversation identity for multi-WhatsApp: one thread per
// (account_id, whatsapp_config_id, contact_id). Contacts stay unique
// per (account_id, phone_normalized). Callers must pass the config
// id — never omit it and hope the 040 fill-oldest trigger is right.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";

export interface ConversationIdentity {
  accountId: string;
  contactId: string;
  ownerUserId: string;
  whatsappConfigId: string;
  branchId: string | null;
}

export interface FoundConversation {
  conversation: { id: string; [key: string]: unknown };
  created: boolean;
}

/**
 * Find (oldest-first) or create the conversation for this WhatsApp
 * number + contact. Unique index is
 * `idx_conversations_account_whatsapp_contact` (migration 040).
 */
export async function findOrCreateConversationForConfig(
  db: SupabaseClient,
  identity: ConversationIdentity,
): Promise<FoundConversation | null> {
  const { accountId, contactId, ownerUserId, whatsappConfigId, branchId } =
    identity;

  const { data: existing, error: findErr } = await db
    .from("conversations")
    .select("*")
    .eq("account_id", accountId)
    .eq("whatsapp_config_id", whatsappConfigId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: true })
    .limit(1);

  if (findErr) {
    console.error(
      "[conversation-identity] conversation lookup error:",
      findErr,
    );
    return null;
  }

  if (existing && existing.length > 0) {
    return { conversation: existing[0], created: false };
  }

  const { data: created, error: createErr } = await db
    .from("conversations")
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
      branch_id: branchId,
    })
    .select("*")
    .single();

  if (createErr || !created) {
    if (isUniqueViolation(createErr)) {
      const { data: raced } = await db
        .from("conversations")
        .select("*")
        .eq("account_id", accountId)
        .eq("whatsapp_config_id", whatsappConfigId)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error(
      "[conversation-identity] conversation create error:",
      createErr,
    );
    return null;
  }

  return { conversation: created, created: true };
}
