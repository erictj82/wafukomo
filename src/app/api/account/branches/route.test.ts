import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
  tables: {} as Record<string, unknown[]>,
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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

function chain(table: string) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    insert: (row: Record<string, unknown>) => {
      h.inserts.push(row);
      return builder;
    },
    order: () => Promise.resolve({ data: h.tables[table] ?? [], error: null }),
    single: () =>
      Promise.resolve({
        data: { id: "br-new", name: "Iseo", timezone: null, archived_at: null, created_at: "t" },
        error: null,
      }),
    maybeSingle: () =>
      Promise.resolve({
        data: (h.tables[table] ?? [])[0] ?? null,
        error: null,
      }),
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

import { GET, POST } from "./route";

beforeEach(() => {
  h.getCurrentAccount.mockReset().mockResolvedValue(ctx);
  h.requireRole.mockReset().mockResolvedValue(ctx);
  h.inserts = [];
  h.tables = {
    branches: [
      {
        id: "br-1",
        name: "Iseo",
        timezone: null,
        archived_at: null,
        created_at: "t",
      },
    ],
    whatsapp_config: [{ id: "cfg-a", branch_id: "br-1" }],
    branch_memberships: [{ branch_id: "br-1", user_id: "agent-1" }],
  };
});

describe("GET /api/account/branches", () => {
  it("returns numbers and members nested on each branch", async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.branches[0]).toMatchObject({
      id: "br-1",
      whatsapp_config_id: "cfg-a",
      member_user_ids: ["agent-1"],
    });
  });
});

describe("POST /api/account/branches", () => {
  it("creates a branch", async () => {
    const res = await POST(
      new Request("http://localhost/api/account/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Tumapel" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(h.inserts[0]).toMatchObject({ name: "Tumapel", account_id: "acct-1" });
  });

  it("rejects an empty name", async () => {
    const res = await POST(
      new Request("http://localhost/api/account/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
