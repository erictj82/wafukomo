import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, "")),
  from: vi.fn(),
  adminFrom: vi.fn(),
  tables: {} as Record<string, unknown[]>,
  updates: [] as Array<{ table: string; row: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  deletes: [] as Array<{ table: string; filters: Record<string, string> }>,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: h.getCurrentAccount,
  requireRole: h.requireRole,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "auth failed" },
      { status: 403 },
    ),
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  verifyPhoneNumber: h.verifyPhoneNumber,
  registerPhoneNumber: h.registerPhoneNumber,
  subscribeWabaToApp: h.subscribeWabaToApp,
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  encrypt: h.encrypt,
  decrypt: h.decrypt,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => h.adminFrom(table),
  }),
}));

function chain(table: string) {
  const filters: Record<string, string> = {};
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: string) => {
      filters[col] = val;
      return builder;
    },
    neq: (col: string, val: string) => {
      filters[`neq:${col}`] = val;
      return builder;
    },
    is: () => builder,
    order: () => Promise.resolve({ data: h.tables[table] ?? [], error: null }),
    maybeSingle: () => {
      const rows = (h.tables[table] ?? []) as Array<Record<string, unknown>>;
      const row = rows.find((r) =>
        Object.entries(filters).every(([k, v]) => {
          if (k.startsWith("neq:")) return r[k.slice(4)] !== v;
          return r[k] === v;
        }),
      );
      return Promise.resolve({ data: row ?? null, error: null });
    },
    single: () => {
      const rows = (h.tables[table] ?? []) as Array<Record<string, unknown>>;
      return Promise.resolve({ data: rows[0] ?? { id: "new-1" }, error: null });
    },
    insert: (row: Record<string, unknown>) => {
      h.inserts.push({ table, row });
      return builder;
    },
    update: (row: Record<string, unknown>) => {
      h.updates.push({ table, row });
      return builder;
    },
    delete: () => {
      h.deletes.push({ table, filters: { ...filters } });
      return builder;
    },
    then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
      resolve({ data: h.tables[table] ?? [], error: null }),
  };
  return builder;
}

const ctx = {
  supabase: { from: (table: string) => chain(table) },
  accountId: "acct-1",
  userId: "user-1",
  role: "admin" as const,
  account: { id: "acct-1", name: "Acme" },
};

import { DELETE, GET, PATCH, POST } from "./route";

beforeEach(() => {
  h.getCurrentAccount.mockReset().mockResolvedValue(ctx);
  h.requireRole.mockReset().mockResolvedValue(ctx);
  h.verifyPhoneNumber.mockReset().mockResolvedValue({
    id: "pn-1",
    display_phone_number: "+62 812 0000 0001",
    verified_name: "Iseo",
  });
  h.registerPhoneNumber.mockReset();
  h.subscribeWabaToApp.mockReset();
  h.adminFrom.mockImplementation((table: string) => chain(table));
  h.tables = {
    whatsapp_config: [
      {
        id: "cfg-a",
        account_id: "acct-1",
        phone_number_id: "pn-a",
        status: "connected",
        registered_at: "2026-01-01T00:00:00Z",
        display_name: "Iseo",
        display_phone_number: "+62812",
        branch_id: null,
        access_token: "enc:tok",
      },
    ],
    branches: [{ id: "br-1", account_id: "acct-1", archived_at: null }],
  };
  h.updates = [];
  h.inserts = [];
  h.deletes = [];
});

describe("GET /api/whatsapp/config", () => {
  it("lists every number without failing when two rows exist", async () => {
    h.tables.whatsapp_config = [
      { id: "cfg-a", account_id: "acct-1", status: "connected" },
      { id: "cfg-b", account_id: "acct-1", status: "disconnected" },
    ];
    const res = await GET(new Request("http://localhost/api/whatsapp/config"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.configs).toHaveLength(2);
    expect(json.connected).toBe(true);
  });
});

describe("POST /api/whatsapp/config", () => {
  it("inserts a second number instead of updating every account row", async () => {
    const res = await POST(
      new Request("http://localhost/api/whatsapp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: "pn-b",
          access_token: "tok-b",
          display_name: "Tumapel",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].row).toMatchObject({
      phone_number_id: "pn-b",
      display_name: "Tumapel",
    });
    expect(h.updates.filter((u) => u.table === "whatsapp_config")).toHaveLength(
      0,
    );
  });

  it("updates only the named row", async () => {
    const res = await POST(
      new Request("http://localhost/api/whatsapp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cfg-a",
          phone_number_id: "pn-a",
          access_token: "tok-a",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.updates.some((u) => u.table === "whatsapp_config")).toBe(true);
  });
});

describe("DELETE /api/whatsapp/config", () => {
  it("refuses to delete every number when id is missing", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/whatsapp/config", { method: "DELETE" }),
    );
    expect(res.status).toBe(400);
    expect(h.deletes).toHaveLength(0);
  });
});

describe("PATCH /api/whatsapp/config", () => {
  it("requires id", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/whatsapp/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "X" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
