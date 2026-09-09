import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MAX_NAME_LEN = 80;

interface BranchRow {
  id: string;
  name: string;
  timezone: string | null;
  archived_at: string | null;
  created_at: string;
}

/**
 * GET /api/account/branches
 *
 * Any member: list branches plus which number (if any) and which
 * agents are assigned. Owner/admin see every branch; agents see
 * only granted branches (RLS `can_access_branch`).
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [{ data: branches, error: bErr }, configsRes, membersRes] =
      await Promise.all([
        ctx.supabase
          .from("branches")
          .select("id, name, timezone, archived_at, created_at")
          .eq("account_id", ctx.accountId)
          .order("created_at", { ascending: true }),
        ctx.supabase
          .from("whatsapp_config")
          .select("id, branch_id")
          .eq("account_id", ctx.accountId),
        ctx.supabase
          .from("branch_memberships")
          .select("branch_id, user_id")
          .eq("account_id", ctx.accountId),
      ]);

    if (bErr) {
      console.error("[GET /api/account/branches]", bErr);
      return NextResponse.json(
        { error: "Failed to load branches" },
        { status: 500 },
      );
    }

    const numberByBranch = new Map<string, string>();
    for (const row of configsRes.data ?? []) {
      if (row.branch_id) numberByBranch.set(row.branch_id, row.id);
    }

    const membersByBranch = new Map<string, string[]>();
    for (const row of membersRes.data ?? []) {
      const list = membersByBranch.get(row.branch_id) ?? [];
      list.push(row.user_id);
      membersByBranch.set(row.branch_id, list);
    }

    const payload = ((branches ?? []) as BranchRow[]).map((b) => ({
      id: b.id,
      name: b.name,
      timezone: b.timezone,
      archived_at: b.archived_at,
      created_at: b.created_at,
      whatsapp_config_id: numberByBranch.get(b.id) ?? null,
      member_user_ids: membersByBranch.get(b.id) ?? [],
    }));

    return NextResponse.json({ branches: payload });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/account/branches
 *
 * Admin+: create a branch. Unique (account_id, name).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const limit = checkRateLimit(
      `admin:branches:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      timezone?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Branch name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 },
      );
    }
    const timezone =
      typeof body?.timezone === "string" && body.timezone.trim()
        ? body.timezone.trim()
        : null;

    const { data, error } = await ctx.supabase
      .from("branches")
      .insert({
        account_id: ctx.accountId,
        name,
        timezone,
      })
      .select("id, name, timezone, archived_at, created_at")
      .single();

    if (error || !data) {
      if (isUniqueViolation(error)) {
        return NextResponse.json(
          { error: "A branch with this name already exists." },
          { status: 409 },
        );
      }
      console.error("[POST /api/account/branches]", error);
      return NextResponse.json(
        { error: "Failed to create branch" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        branch: {
          ...data,
          whatsapp_config_id: null,
          member_user_ids: [],
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
