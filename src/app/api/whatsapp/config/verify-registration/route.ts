import { NextResponse } from 'next/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/whatsapp/config/verify-registration?id=<uuid>
 *
 * Diagnostic endpoint — confirms a saved phone number is actually
 * reachable on Meta's side. With two or more numbers the caller must
 * name which one (`id`); a sole number is accepted without it.
 */
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const requestedId = new URL(request.url).searchParams.get('id')

    let query = ctx.supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', ctx.accountId)

    if (requestedId) {
      query = query.eq('id', requestedId)
    }

    const { data: rows, error } = await query.order('created_at', {
      ascending: true,
    })

    if (error) {
      console.error('[verify-registration] fetch error:', error)
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: 'Failed to load WhatsApp configuration.',
      })
    }

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: requestedId
          ? 'WhatsApp number not found.'
          : 'No WhatsApp configuration saved yet.',
      })
    }

    if (!requestedId && rows.length > 1) {
      return NextResponse.json(
        {
          live: false,
          checks: { config_exists: true },
          message:
            'id is required when the account has more than one WhatsApp number.',
        },
        { status: 400 }
      )
    }

    const config = requestedId
      ? (rows.find((r: { id: string }) => r.id === requestedId) ?? null)
      : rows[0]

    if (!config) {
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: 'WhatsApp number not found.',
      })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json({
        live: false,
        checks: {
          config_exists: true,
          token_decryptable: false,
        },
        message:
          "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
      })
    }

    const checks: {
      config_exists: boolean
      token_decryptable: boolean
      phone_metadata_ok: boolean
      waba_subscribed_to_app: boolean | null
      locally_marked_registered: boolean
    } = {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: false,
      waba_subscribed_to_app: null,
      locally_marked_registered: config.registered_at != null,
    }
    const errors: string[] = []

    try {
      await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      checks.phone_metadata_ok = true
    } catch (err) {
      errors.push(
        `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        })
        checks.waba_subscribed_to_app = subs.length > 0
        if (!checks.waba_subscribed_to_app) {
          errors.push(
            'WABA has no subscribed apps. Re-save the configuration to subscribe.',
          )
        }
      } catch (err) {
        errors.push(
          `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      errors.push(
        "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save.",
      )
    }

    const live =
      checks.phone_metadata_ok &&
      (checks.waba_subscribed_to_app ?? false) &&
      checks.locally_marked_registered

    return NextResponse.json({
      live,
      checks,
      errors,
      last_registration_error: config.last_registration_error ?? null,
      registered_at: config.registered_at ?? null,
      subscribed_apps_at: config.subscribed_apps_at ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
