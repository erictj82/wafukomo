import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { syncConversationBranchId } from "@/lib/whatsapp/config-rows";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MAX_NAME_LEN = 80;

async function loadBranch(
  supabase: Awaited<ReturnType<typeof requireRole>>["supabase"],
  accountId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from("branches")
    .select("id, name, timezone, archived_at")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * PATCH /api/account/branches/[id]
 *
 * Rename, set timezone, or archive. Moving the attached number is
 * done on the WhatsApp config, not here.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const limit = checkRateLimit(
      `admin:branches:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const existing = await loadBranch(ctx.supabase, ctx.accountId, id);
    if (!existing) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const patch: Record<string, unknown> = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json(
          { error: "name cannot be empty" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Branch name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    if (body.timezone === null) {
      patch.timezone = null;
    } else if (typeof body.timezone === "string") {
      patch.timezone = body.timezone.trim() || null;
    }

    if (body.archived === true) {
      patch.archived_at = existing.archived_at ?? new Date().toISOString();
    } else if (body.archived === false) {
      patch.archived_at = null;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from("branches")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      if (isUniqueViolation(error)) {
        return NextResponse.json(
          { error: "A branch with this name already exists." },
          { status: 409 },
        );
      }
      console.error("[PATCH /api/account/branches/:id]", error);
      return NextResponse.json(
        { error: "Failed to update branch" },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/account/branches/[id]
 *
 * Detaches any WhatsApp number (SET NULL) and deletes the branch.
 * Conversations.branch_id also SET NULL.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const existing = await loadBranch(ctx.supabase, ctx.accountId, id);
    if (!existing) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404 });
    }

    const { data: attached } = await ctx.supabase
      .from("whatsapp_config")
      .select("id")
      .eq("account_id", ctx.accountId)
      .eq("branch_id", id);

    for (const row of attached ?? []) {
      await ctx.supabase
        .from("whatsapp_config")
        .update({ branch_id: null })
        .eq("id", row.id)
        .eq("account_id", ctx.accountId);
      await syncConversationBranchId(ctx.supabase, ctx.accountId, row.id, null);
    }

    const { error } = await ctx.supabase
      .from("branches")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[DELETE /api/account/branches/:id]", error);
      return NextResponse.json(
        { error: "Failed to delete branch" },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
