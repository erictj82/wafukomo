import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadWhatsAppConfigById,
  resolveWhatsAppConfigForAccount,
} from "./load-config";

function listDb(rows: Array<{ id: string; account_id: string }>): SupabaseClient {
  const eqs: Record<string, string> = {};
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: string) => {
      eqs[col] = val;
      return builder;
    },
    order: () =>
      Promise.resolve({
        data: rows.filter((r) =>
          eqs.account_id ? r.account_id === eqs.account_id : true,
        ),
        error: null,
      }),
    maybeSingle: () => {
      const row = rows.find(
        (r) =>
          (!eqs.id || r.id === eqs.id) &&
          (!eqs.account_id || r.account_id === eqs.account_id),
      );
      return Promise.resolve({ data: row ?? null, error: null });
    },
  };
  return {
    from: () => {
      for (const key of Object.keys(eqs)) delete eqs[key];
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("resolveWhatsAppConfigForAccount", () => {
  it("accepts the sole number when no id is given", async () => {
    const db = listDb([{ id: "cfg-1", account_id: "acc" }]);
    const res = await resolveWhatsAppConfigForAccount(db, "acc");
    expect(res).toMatchObject({ ok: true, config: { id: "cfg-1" } });
  });

  it("refuses to guess when two numbers exist", async () => {
    const db = listDb([
      { id: "cfg-a", account_id: "acc" },
      { id: "cfg-b", account_id: "acc" },
    ]);
    const res = await resolveWhatsAppConfigForAccount(db, "acc");
    expect(res).toEqual({ ok: false, code: "whatsapp_config_required" });
  });

  it("loads an explicit id even when siblings exist", async () => {
    const db = listDb([
      { id: "cfg-a", account_id: "acc" },
      { id: "cfg-b", account_id: "acc" },
    ]);
    const res = await resolveWhatsAppConfigForAccount(db, "acc", "cfg-b");
    expect(res).toMatchObject({ ok: true, config: { id: "cfg-b" } });
  });

  it("returns not configured when the account has none", async () => {
    const db = listDb([]);
    const res = await resolveWhatsAppConfigForAccount(db, "acc");
    expect(res).toEqual({ ok: false, code: "whatsapp_not_configured" });
  });
});

describe("loadWhatsAppConfigById", () => {
  it("does not return another account's row", async () => {
    const db = listDb([{ id: "cfg-1", account_id: "other" }]);
    const row = await loadWhatsAppConfigById(db, "acc", "cfg-1");
    expect(row).toBeNull();
  });
});
