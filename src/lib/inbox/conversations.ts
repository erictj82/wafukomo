import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 *
 * `whatsapp_config` has two FKs from conversations (id, and the composite
 * account pair), so the embed names the id FK explicitly.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*))), whatsapp_config:whatsapp_config!conversations_whatsapp_config_id_fkey(id, display_name, display_phone_number), branch:branches!conversations_branch_id_fkey(id, name)";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type EmbeddedConfig = Conversation["whatsapp_config"];
type EmbeddedBranch = Conversation["branch"];
type RawConversation = Omit<
  Conversation,
  "contact" | "whatsapp_config" | "branch"
> & {
  contact?: RawContact | null;
  whatsapp_config?: EmbeddedConfig | EmbeddedConfig[] | null;
  branch?: EmbeddedBranch | EmbeddedBranch[] | null;
};

function asOne<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const whatsapp_config = asOne(raw.whatsapp_config);
  const branch = asOne(raw.branch);
  const rawContact = raw.contact;
  if (!rawContact) {
    return { ...raw, whatsapp_config, branch } as Conversation;
  }

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    whatsapp_config,
    branch,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

export interface InboxScopeFilters {
  /** Null = every branch the caller can already see (RLS). */
  branchId: string | null;
  /** Null = every visible WhatsApp number. */
  whatsappConfigId: string | null;
  unansweredOnly: boolean;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

/**
 * Client-side branch / number / unanswered chips. RLS already hid
 * other salons; this only narrows the visible list.
 */
export function matchesInboxScope(
  conversation: Conversation,
  { branchId, whatsappConfigId, unansweredOnly }: InboxScopeFilters,
): boolean {
  if (branchId && conversation.branch_id !== branchId) return false;
  if (whatsappConfigId && conversation.whatsapp_config_id !== whatsappConfigId) {
    return false;
  }
  if (unansweredOnly && !conversation.awaiting_response_since) return false;
  return true;
}

/** Labels for inbox badges. Empty strings are treated as missing. */
export function conversationInboxBadge(conversation: Conversation): {
  number: string | null;
  branch: string | null;
} {
  const number =
    conversation.whatsapp_config?.display_name?.trim() ||
    conversation.whatsapp_config?.display_phone_number?.trim() ||
    null;
  const branch = conversation.branch?.name?.trim() || null;
  return { number, branch };
}
