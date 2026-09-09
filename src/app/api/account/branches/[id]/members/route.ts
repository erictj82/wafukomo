import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

/**
 * PUT /api/account/branches/[id]/members
 *
 * Replace the agent (and viewer) membership set for one branch.
 * Owner/admin do not need rows — they already see every branch.
 *
 * Body: { user_ids: string[] }
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id: branchId } = await params;
    const limit = checkRateLimit(
      `admin:branch-members:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { data: branch } = await ctx.supabase
      .from("branches")
      .select("id")
      .eq("id", branchId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!branch) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      user_ids?: unknown;
    } | null;
    if (!body || !Array.isArray(body.user_ids)) {
      return NextResponse.json(
        { error: "user_ids must be an array" },
        { status: 400 },
      );
    }
    const requested = [
      ...new Set(
        body.user_ids.filter((v): v is string => typeof v === "string" && !!v),
      ),
    ];

    const allowed = new Set<string>();
    if (requested.length > 0) {
      const { data: profiles, error: pErr } = await ctx.supabase
        .from("profiles")
        .select("user_id, account_role")
        .eq("account_id", ctx.accountId)
        .in("user_id", requested);

      if (pErr) {
        console.error("[PUT branch members] profiles", pErr);
        return NextResponse.json(
          { error: "Failed to validate members" },
          { status: 500 },
        );
      }

      for (const row of profiles ?? []) {
        if (!isAccountRole(row.account_role)) continue;
        // Owner/admin already see every branch; storing a row would
        // duplicate that. Agents (and viewers, for a later read-only
        // inbox) are the ones who need an explicit grant.
        if (row.account_role === "agent" || row.account_role === "viewer") {
          allowed.add(row.user_id);
        }
      }
    }

    const nextIds = requested.filter((id) => allowed.has(id));

    const { data: existing } = await ctx.supabase
      .from("branch_memberships")
      .select("id, user_id")
      .eq("branch_id", branchId)
      .eq("account_id", ctx.accountId);

    const current = new Set((existing ?? []).map((r) => r.user_id as string));
    const next = new Set(nextIds);
    const toRemove = (existing ?? []).filter((r) => !next.has(r.user_id));
    const toAdd = nextIds.filter((uid) => !current.has(uid));

    if (toRemove.length > 0) {
      const { error: delErr } = await ctx.supabase
        .from("branch_memberships")
        .delete()
        .eq("branch_id", branchId)
        .eq("account_id", ctx.accountId)
        .in(
          "id",
          toRemove.map((r) => r.id),
        );
      if (delErr) {
        console.error("[PUT branch members] delete", delErr);
        return NextResponse.json(
          { error: "Failed to update branch members" },
          { status: 500 },
        );
      }
    }

    if (toAdd.length > 0) {
      const { error: insErr } = await ctx.supabase.from("branch_memberships").insert(
        toAdd.map((user_id) => ({
          account_id: ctx.accountId,
          branch_id: branchId,
          user_id,
        })),
      );
      if (insErr && !isUniqueViolation(insErr)) {
        console.error("[PUT branch members] insert", insErr);
        return NextResponse.json(
          { error: "Failed to update branch members" },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true, user_ids: nextIds });
  } catch (err) {
    return toErrorResponse(err);
  }
}
