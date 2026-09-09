import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  WHATSAPP_CONFIG_PUBLIC_SELECT,
  syncConversationBranchId,
  type WhatsAppConfigPublic,
} from '@/lib/whatsapp/config-rows'

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* account — under RLS,
// the user's own session can't see other accounts' rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

function isFkViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: string }).code === '23503'
  )
}

/**
 * GET /api/whatsapp/config
 *
 *   no query     — list every number on the account (no Meta ping)
 *   ?id=<uuid>   — decrypt + ping Meta for that row (Test Connection)
 */
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const configId = new URL(request.url).searchParams.get('id')

    if (configId) {
      return healthCheckForConfig(ctx.supabase, ctx.accountId, configId)
    }

    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .select(WHATSAPP_CONFIG_PUBLIC_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Error fetching whatsapp_config list:', error)
      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message: 'Failed to fetch configuration',
          configs: [],
        },
        { status: 200 }
      )
    }

    const configs = (data ?? []) as WhatsAppConfigPublic[]
    if (configs.length === 0) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
          configs: [],
        },
        { status: 200 }
      )
    }

    return NextResponse.json({
      connected: configs.some((c) => c.status === 'connected'),
      configs,
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return toErrorResponse(error)
  }
}

async function healthCheckForConfig(
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'],
  accountId: string,
  configId: string
) {
  const { data: config, error: configError } = await supabase
    .from('whatsapp_config')
    .select('id, phone_number_id, access_token, status')
    .eq('id', configId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (configError) {
    console.error('Error fetching whatsapp_config for health check:', configError)
    return NextResponse.json(
      { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
      { status: 200 }
    )
  }

  if (!config) {
    return NextResponse.json(
      {
        connected: false,
        reason: 'no_config',
        message: 'WhatsApp number not found.',
      },
      { status: 200 }
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch (err) {
    console.error('[whatsapp/config GET] Token decryption failed:', err)
    return NextResponse.json(
      {
        connected: false,
        reason: 'token_corrupted',
        needs_reset: true,
        message:
          'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
      },
      { status: 200 }
    )
  }

  try {
    const phoneInfo = await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    return NextResponse.json({ connected: true, phone_info: phoneInfo })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('[whatsapp/config GET] Meta API verification failed:', message)
    return NextResponse.json(
      {
        connected: false,
        reason: 'meta_api_error',
        message: `Meta API rejected the credentials: ${message}`,
      },
      { status: 200 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates ONE WhatsApp number. Pass `id` to update that row;
 * otherwise the same phone_number_id on this account is updated, or a
 * new row is inserted. Never updates every row for the account.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const { supabase, accountId, userId } = ctx

    const body = await request.json()
    const {
      id: bodyId,
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
      display_name,
      branch_id,
    } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        )
      }
    }

    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      )
    }

    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    let existing: {
      id: string
      registered_at: string | null
      phone_number_id: string
      display_name: string | null
      display_phone_number: string | null
      branch_id: string | null
    } | null = null

    if (typeof bodyId === 'string' && bodyId) {
      const { data } = await supabase
        .from('whatsapp_config')
        .select(
          'id, registered_at, phone_number_id, display_name, display_phone_number, branch_id'
        )
        .eq('id', bodyId)
        .eq('account_id', accountId)
        .maybeSingle()
      existing = data
      if (!existing) {
        return NextResponse.json(
          { error: 'WhatsApp number not found' },
          { status: 404 }
        )
      }
    } else {
      const { data } = await supabase
        .from('whatsapp_config')
        .select(
          'id, registered_at, phone_number_id, display_name, display_phone_number, branch_id'
        )
        .eq('account_id', accountId)
        .eq('phone_number_id', phone_number_id)
        .maybeSingle()
      existing = data
    }

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
        }
      }
    }

    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
      }
    }

    const resolvedDisplayName =
      typeof display_name === 'string' && display_name.trim()
        ? display_name.trim()
        : (existing?.display_name ?? phoneInfo.verified_name ?? null)

    const resolvedBranchId =
      branch_id === undefined
        ? (existing?.branch_id ?? null)
        : branch_id === null || branch_id === ''
          ? null
          : branch_id

    if (resolvedBranchId) {
      const { data: branch } = await supabase
        .from('branches')
        .select('id')
        .eq('id', resolvedBranchId)
        .eq('account_id', accountId)
        .is('archived_at', null)
        .maybeSingle()
      if (!branch) {
        return NextResponse.json(
          { error: 'Branch not found' },
          { status: 400 }
        )
      }
    }

    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      display_name: resolvedDisplayName,
      display_phone_number:
        phoneInfo.display_phone_number ?? existing?.display_phone_number ?? null,
      branch_id: resolvedBranchId,
      updated_at: new Date().toISOString(),
    }

    let savedId = existing?.id ?? null

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('id', existing.id)
        .eq('account_id', accountId)

      if (updateError) {
        if (isUniqueViolation(updateError)) {
          return NextResponse.json(
            { error: 'This branch already has a WhatsApp number.' },
            { status: 409 }
          )
        }
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }

      if (resolvedBranchId !== existing.branch_id) {
        await syncConversationBranchId(
          supabase,
          accountId,
          existing.id,
          resolvedBranchId
        )
      }
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: userId,
          ...baseRow,
        })
        .select('id')
        .single()

      if (insertError || !inserted) {
        if (isUniqueViolation(insertError)) {
          return NextResponse.json(
            { error: 'This WhatsApp number or branch is already connected.' },
            { status: 409 }
          )
        }
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
      savedId = inserted.id
    }

    if (registrationError) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
        id: savedId,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
      id: savedId,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return toErrorResponse(error)
  }
}

/**
 * PATCH /api/whatsapp/config
 *
 * Non-credential edits on one number: display name, branch, media
 * mirror. Does not re-verify with Meta.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const { data: existing, error: loadErr } = await ctx.supabase
      .from('whatsapp_config')
      .select('id, branch_id')
      .eq('id', body.id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (loadErr || !existing) {
      return NextResponse.json(
        { error: 'WhatsApp number not found' },
        { status: 404 }
      )
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (typeof body.display_name === 'string') {
      patch.display_name = body.display_name.trim() || null
    }

    if (typeof body.mirror_inbound_media === 'boolean') {
      patch.mirror_inbound_media = body.mirror_inbound_media
    }

    if ('branch_id' in body) {
      const nextBranch =
        body.branch_id === null || body.branch_id === ''
          ? null
          : typeof body.branch_id === 'string'
            ? body.branch_id
            : null
      if (nextBranch) {
        const { data: branch } = await ctx.supabase
          .from('branches')
          .select('id')
          .eq('id', nextBranch)
          .eq('account_id', ctx.accountId)
          .is('archived_at', null)
          .maybeSingle()
        if (!branch) {
          return NextResponse.json({ error: 'Branch not found' }, { status: 400 })
        }
      }
      patch.branch_id = nextBranch
    }

    const { error: updateError } = await ctx.supabase
      .from('whatsapp_config')
      .update(patch)
      .eq('id', existing.id)
      .eq('account_id', ctx.accountId)

    if (updateError) {
      if (isUniqueViolation(updateError)) {
        return NextResponse.json(
          { error: 'This branch already has a WhatsApp number.' },
          { status: 409 }
        )
      }
      console.error('Error patching whatsapp_config:', updateError)
      return NextResponse.json(
        { error: 'Failed to update configuration' },
        { status: 500 }
      )
    }

    if ('branch_id' in patch && patch.branch_id !== existing.branch_id) {
      await syncConversationBranchId(
        ctx.supabase,
        ctx.accountId,
        existing.id,
        (patch.branch_id as string | null) ?? null
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config PATCH:', error)
    return toErrorResponse(error)
  }
}

/**
 * DELETE /api/whatsapp/config?id=<uuid>
 *
 * Removes one number. Conversations still reference the row
 * (ON DELETE RESTRICT), so a number with threads cannot be deleted.
 */
export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const configId = new URL(request.url).searchParams.get('id')
    if (!configId) {
      return NextResponse.json(
        { error: 'id is required — refusing to delete every number on the account' },
        { status: 400 }
      )
    }

    const { data: existing } = await ctx.supabase
      .from('whatsapp_config')
      .select('id')
      .eq('id', configId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json(
        { error: 'WhatsApp number not found' },
        { status: 404 }
      )
    }

    const { error: deleteError } = await ctx.supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', configId)
      .eq('account_id', ctx.accountId)

    if (deleteError) {
      if (isFkViolation(deleteError)) {
        return NextResponse.json(
          {
            error:
              'This number still has conversations. Disconnect it only after those threads are no longer needed, or leave it connected.',
          },
          { status: 409 }
        )
      }
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return toErrorResponse(error)
  }
}
