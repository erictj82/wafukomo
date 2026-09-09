import type { SupabaseClient } from "@supabase/supabase-js";

/** Columns the settings UI may read. Never includes tokens. */
export const WHATSAPP_CONFIG_PUBLIC_SELECT =
  "id, account_id, phone_number_id, waba_id, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media, display_name, display_phone_number, branch_id";

export interface WhatsAppConfigPublic {
  id: string;
  account_id: string;
  phone_number_id: string;
  waba_id: string | null;
  status: "connected" | "disconnected";
  connected_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_registration_error: string | null;
  mirror_inbound_media: boolean;
  display_name: string | null;
  display_phone_number: string | null;
  branch_id: string | null;
}

/**
 * Keep denormalised `conversations.branch_id` in lockstep when an
 * admin attaches or moves a number. Inbox RLS (later) reads this
 * column; leaving it stale would show the wrong branch after a move.
 */
export async function syncConversationBranchId(
  db: SupabaseClient,
  accountId: string,
  whatsappConfigId: string,
  branchId: string | null,
): Promise<{ error: { message: string; code?: string } | null }> {
  const { error } = await db
    .from("conversations")
    .update({ branch_id: branchId })
    .eq("whatsapp_config_id", whatsappConfigId)
    .eq("account_id", accountId);
  return { error };
}
