// workers/daily-emails/src/index.ts
//
// The site scheduled-jobs Worker. Two crons, dispatched below:
//
//   0 12 * * *   daily tournament emails
//   */5 * * * *  campaign sweep
//
// The name is historical — it predates the sweep, and see the note in
// wrangler.toml for why renaming it would be worse than living with it.
//
// The daily half was migrated out of functions/cron/ (Pages Functions never
// run scheduled handlers — that logic had never executed in production).
// Changes made in that migration:
//  - sendEmail → trySendEmail: one bad address no longer aborts the loop.
//  - Sent-flags are only written when the send actually succeeded, so a
//    failed send retries on the next daily run instead of being lost.
//  - Each phase is isolated: a D1 error in one phase logs and moves on
//    rather than killing the remaining phases.
// The queries themselves are ported unchanged.

import {
  trySendEmail,
  registrationOpenReminderEmail,
  weekBeforeReminderEmail,
  attendeeReminderEmail,
} from '../../../functions/utils/email'
import { sweepPendingCampaigns } from '../../../functions/utils/campaigns'
import { resolveSiteUrl } from '../../../functions/utils/site'
import { expireLapsedMemberships } from '../../../functions/utils/membershipExpiry'

interface Env {
  DB: D1Database
  RESEND_API_KEY: string
  FROM_EMAIL?: string
  SITE_URL?: string
}

async function phase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`daily-emails phase "${name}" failed:`, err instanceof Error ? err.message : err)
  }
}

/** The cron expression, verbatim from wrangler.toml, that runs the sweep. */
const SWEEP_CRON = '*/5 * * * *'

/**
 * Picks up mass-email campaigns that were left half-sent.
 *
 * A campaign is sent by the admin request that created it, in waitUntil —
 * durable enough most of the time, and not durable at all when the isolate
 * is evicted mid-send. Without this the leftover recipients simply never
 * receive anything and the campaign shows "sending" forever. Claiming makes
 * it safe to run while the original send is still going.
 */
async function sweepCampaigns(env: Env): Promise<void> {
  const result = await sweepPendingCampaigns(env)
  // Silent when there was nothing to do, which is almost every run.
  if (result.campaignsTouched > 0) {
    console.log(
      `campaign sweep: ${result.sent} sent, ${result.failed} failed across ${result.campaignsTouched} campaign(s)`,
    )
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === SWEEP_CRON) {
      await phase('campaign sweep', () => sweepCampaigns(env))
      return
    }

    // No request to derive an origin from out here, so this is config or the
    // built-in default — never a deployment URL that happened to be in scope.
    const SITE_URL = resolveSiteUrl(env)

    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]
    const nowIso = new Date().toISOString()

    // 1. Auto-open tournaments where registration_opens_at <= today
    await phase('auto-open', async () => {
      await env.DB.prepare(
        `UPDATE tournaments
         SET registration_status = 'open'
         WHERE registration_status = 'draft'
           AND registration_opens_at IS NOT NULL
           AND registration_opens_at <= ?`,
      ).bind(todayStr).run()
    })

    // 1b. Auto-close registrations past their closing datetime
    await phase('auto-close', async () => {
      await env.DB.prepare(
        `UPDATE tournaments
         SET registration_status = 'closed'
         WHERE registration_closes_at IS NOT NULL
           AND registration_closes_at <= ?
           AND registration_status = 'open'`,
      ).bind(nowIso).run()
    })

    // 1c. Lapse memberships whose paid term has ended. Semantics and the
    //     reasoning behind them live in functions/utils/membershipExpiry.ts,
    //     where they can be tested — this Worker has no harness of its own.
    await phase('membership expiry', async () => {
      const { lapsed } = await expireLapsedMemberships(env.DB, todayStr)
      // Silent on the usual day, when nobody lapsed.
      if (lapsed > 0) console.log(`membership expiry: ${lapsed} membership(s) lapsed`)
    })

    // 2. Send registration-open reminders
    await phase('registration-open reminders', async () => {
      const newlyOpenedReminders = await env.DB.prepare(
        `SELECT tr.id, tr.email, tr.member_id,
                t.id as tournament_id, t.name, t.date, t.location,
                m.full_name
         FROM tournament_reminders tr
         JOIN tournaments t ON tr.tournament_id = t.id
         JOIN members m ON tr.member_id = m.id
         WHERE t.registration_status = 'open'
           AND tr.sent_registration_open = 0`,
      ).all<{
        id: string; email: string; member_id: string
        tournament_id: string; name: string; date: string
        location: string; full_name: string
      }>()

      for (const row of newlyOpenedReminders.results) {
        const template = registrationOpenReminderEmail({
          memberName: row.full_name,
          tournamentName: row.name,
          tournamentDate: row.date,
          tournamentLocation: row.location,
          registrationUrl: `${SITE_URL}/tournaments/${row.tournament_id}`,
        })
        const ok = await trySendEmail(env, { ...template, to: row.email })
        if (!ok) continue // retry on the next run; don't burn the flag
        await env.DB.prepare(
          'UPDATE tournament_reminders SET sent_registration_open = 1 WHERE id = ?',
        ).bind(row.id).run()
      }
    })

    // 3. Send week-before opt-in reminders (7 days away, not yet registered)
    await phase('week-before reminders', async () => {
      const sevenDaysFromNow = new Date(today)
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
      const sevenDaysStr = sevenDaysFromNow.toISOString().split('T')[0]

      const weekBeforeReminders = await env.DB.prepare(
        `SELECT tr.id, tr.email, tr.member_id,
                t.id as tournament_id, t.name, t.date, t.location,
                m.full_name
         FROM tournament_reminders tr
         JOIN tournaments t ON tr.tournament_id = t.id
         JOIN members m ON tr.member_id = m.id
         WHERE date(t.date) = ?
           AND tr.sent_week_before = 0
           AND NOT EXISTS (
             SELECT 1 FROM registrations r
             WHERE r.tournament_id = t.id AND r.member_id = tr.member_id
           )`,
      ).bind(sevenDaysStr).all<{
        id: string; email: string; member_id: string
        tournament_id: string; name: string; date: string
        location: string; full_name: string
      }>()

      for (const row of weekBeforeReminders.results) {
        const template = weekBeforeReminderEmail({
          memberName: row.full_name,
          tournamentName: row.name,
          tournamentDate: row.date,
          tournamentLocation: row.location,
          registrationUrl: `${SITE_URL}/tournaments/${row.tournament_id}`,
        })
        const ok = await trySendEmail(env, { ...template, to: row.email })
        if (!ok) continue
        await env.DB.prepare(
          'UPDATE tournament_reminders SET sent_week_before = 1 WHERE id = ?',
        ).bind(row.id).run()
      }
    })

    // 4 & 5. Send attendee reminders (reminder 1 and 2)
    for (const reminderNum of [1, 2] as const) {
      await phase(`attendee reminder ${reminderNum}`, async () => {
        const daysCol = `reminder_${reminderNum}_days_before`
        const enabledCol = `reminder_${reminderNum}_enabled`

        const attendees = await env.DB.prepare(
          `SELECT r.member_id, r.tournament_id,
                  t.name, t.date, t.location,
                  t.${daysCol} as days_before,
                  m.email, m.full_name
           FROM registrations r
           JOIN tournaments t ON r.tournament_id = t.id
           JOIN members m ON r.member_id = m.id
           WHERE t.${enabledCol} = 1
             AND date(t.date, '-' || t.${daysCol} || ' days') = ?
             AND NOT EXISTS (
               SELECT 1 FROM tournament_attendee_reminders tar
               WHERE tar.tournament_id = r.tournament_id
                 AND tar.member_id = r.member_id
                 AND tar.reminder_number = ?
             )`,
        ).bind(todayStr, reminderNum).all<{
          member_id: string; tournament_id: string
          name: string; date: string; location: string
          days_before: number; email: string; full_name: string
        }>()

        for (const row of attendees.results) {
          const template = attendeeReminderEmail({
            memberName: row.full_name,
            tournamentName: row.name,
            tournamentDate: row.date,
            tournamentLocation: row.location,
            daysUntil: row.days_before,
          })
          const ok = await trySendEmail(env, { ...template, to: row.email })
          if (!ok) continue

          const remId = `ar-${row.tournament_id}-${row.member_id}-${reminderNum}`
          await env.DB.prepare(
            `INSERT OR IGNORE INTO tournament_attendee_reminders
             (id, tournament_id, member_id, reminder_number)
             VALUES (?, ?, ?, ?)`,
          ).bind(remId, row.tournament_id, row.member_id, reminderNum).run()
        }
      })
    }
  },
}