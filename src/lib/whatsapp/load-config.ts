// ============================================================
// Load a WhatsApp config for a specific number — never "the account's
// one config". After migration 040 an account can own several rows;
// `.single()` / `.maybeSingle()` keyed only on account_id throws
// PGRST116 and, worse, would send on the wrong token.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface WhatsAppConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  phone_number_id: string;
  access_token: string;
  branch_id: string | null;
  status?: string;
  mirror_inbound_media?: boolean;
}

const CONFIG_SELECT =
  "id, account_id, user_id, phone_number_id, access_token, branch_id, status, mirror_inbound_media";

/**
 * Config for an already-identified conversation. Requires
 * `conversations.whatsapp_config_id` (NOT NULL since 040).
 */
export async function loadWhatsAppConfigForConversationId(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<WhatsAppConfigRow | null> {
  const { data: conversation, error: convError } = await db
    .from("conversations")
    .select("id, whatsapp_config_id")
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (convError || !conversation?.whatsapp_config_id) return null;

  return loadWhatsAppConfigById(
    db,
    accountId,
    conversation.whatsapp_config_id as string,
  );
}

/** Config by primary key, still scoped to the caller's account. */
export async function loadWhatsAppConfigById(
  db: SupabaseClient,
  accountId: string,
  configId: string,
): Promise<WhatsAppConfigRow | null> {
  const { data, error } = await db
    .from("whatsapp_config")
    .select(CONFIG_SELECT)
    .eq("id", configId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (error || !data) return null;
  return data as WhatsAppConfigRow;
}

/**
 * Resolve a config when the caller has a phone / contact but not yet a
 * conversation. If `whatsappConfigId` is supplied, that row is used.
 * If omitted, a **sole** connected number on the account is accepted so
 * single-number installs keep working without a new UI. Two or more
 * numbers without an explicit id is an error — guessing would send
 * through the wrong Meta token.
 */
export async function resolveWhatsAppConfigForAccount(
  db: SupabaseClient,
  accountId: string,
  whatsappConfigId?: string | null,
): Promise<
  | { ok: true; config: WhatsAppConfigRow }
  | { ok: false; code: "whatsapp_not_configured" | "whatsapp_config_required" }
> {
  if (whatsappConfigId) {
    const config = await loadWhatsAppConfigById(db, accountId, whatsappConfigId);
    if (!config) return { ok: false, code: "whatsapp_not_configured" };
    return { ok: true, config };
  }

  const { data, error } = await db
    .from("whatsapp_config")
    .select(CONFIG_SELECT)
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) {
    return { ok: false, code: "whatsapp_not_configured" };
  }
  if (data.length > 1) {
    return { ok: false, code: "whatsapp_config_required" };
  }
  return { ok: true, config: data[0] as WhatsAppConfigRow };
}
