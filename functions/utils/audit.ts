// functions/utils/audit.ts
import type { MemberRow } from '../types'

/**
 * Privileged actions worth being able to reconstruct afterwards.
 *
 * Deliberately a closed union rather than free-form strings: the admin log
 * view filters on these, and a typo'd action name would silently create a
 * category nobody is looking at.
 */
export type AdminAction =
  | 'role_change'
  | 'membership_override'
  | 'club_change'
  | 'name_change'
  | 'impersonation_start'
  | 'impersonation_end'
  | 'ticket_delete'

export interface AuditEntry {
  action: AdminAction
  targetMemberId?: string | null
  /** Who the action was aimed at, as they were named at the time. */
  targetLabel?: string | null
  /** Anything needed to make sense of the entry later, e.g. { from, to }. */
  detail?: Record<string, unknown> | null
}

/**
 * Writes one row to the admin audit log.
 *
 * Never throws. An audit write failing should not turn a successful role
 * change into a 500 the admin retries — that would risk applying the action
 * twice while still recording nothing. A failure is logged for the Worker
 * tail and swallowed; the gap is visible as a missing row rather than as a
 * broken feature.
 */
export async function recordAdminAction(
  db: D1Database,
  actor: MemberRow,
  entry: AuditEntry,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO admin_audit_log
           (id, actor_id, actor_email, action, target_member_id, target_label, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        actor.id,
        actor.email,
        entry.action,
        entry.targetMemberId ?? null,
        entry.targetLabel ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      )
      .run()
  } catch (err) {
    console.warn(
      `admin audit write failed (${entry.action}):`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
