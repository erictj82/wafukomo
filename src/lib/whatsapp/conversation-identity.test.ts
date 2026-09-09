import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { findOrCreateConversationForConfig } from "./conversation-identity";

interface Script {
  existingByKey: Record<string, { id: string }>;
  inserts: Array<Record<string, unknown>>;
}

function makeDb(script: Script): SupabaseClient {
  const eqs: Record<string, string> = {};
  let mode: "select" | "insert" = "select";
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: string) => {
      eqs[col] = val;
      return builder;
    },
    order: () => builder,
    limit: () => {
      const key = `${eqs.account_id}|${eqs.whatsapp_config_id}|${eqs.contact_id}`;
      const row = script.existingByKey[key];
      return Promise.resolve({ data: row ? [row] : [], error: null });
    },
    insert: (row: Record<string, unknown>) => {
      mode = "insert";
      script.inserts.push(row);
      const key = `${row.account_id}|${row.whatsapp_config_id}|${row.contact_id}`;
      script.existingByKey[key] = { id: `new-${script.inserts.length}` };
      return builder;
    },
    single: () => {
      if (mode === "insert") {
        const last = script.inserts[script.inserts.length - 1];
        return Promise.resolve({
          data: { id: `new-${script.inserts.length}`, ...last },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return {
    from: () => {
      mode = "select";
      for (const key of Object.keys(eqs)) delete eqs[key];
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("findOrCreateConversationForConfig", () => {
  it("keeps two threads for the same contact on two numbers", async () => {
    const script: Script = { existingByKey: {}, inserts: [] };
    const db = makeDb(script);

    const a = await findOrCreateConversationForConfig(db, {
      accountId: "acc",
      contactId: "ct-1",
      ownerUserId: "u-1",
      whatsappConfigId: "cfg-a",
      branchId: "br-a",
    });
    const b = await findOrCreateConversationForConfig(db, {
      accountId: "acc",
      contactId: "ct-1",
      ownerUserId: "u-1",
      whatsappConfigId: "cfg-b",
      branchId: "br-b",
    });
    const aAgain = await findOrCreateConversationForConfig(db, {
      accountId: "acc",
      contactId: "ct-1",
      ownerUserId: "u-1",
      whatsappConfigId: "cfg-a",
      branchId: "br-a",
    });

    expect(a?.created).toBe(true);
    expect(b?.created).toBe(true);
    expect(a?.conversation.id).not.toBe(b?.conversation.id);
    expect(aAgain?.created).toBe(false);
    expect(aAgain?.conversation.id).toBe(a?.conversation.id);
    expect(script.inserts).toHaveLength(2);
  });
});
