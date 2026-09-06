// functions/utils/membershipExpiry.ts
//
// membership_status was only ever written at the moment of payment, so a
// membership went 'active' and stayed 'active' for good. The admin members
// list showed people as current years after their term ran out, and anything
// gated on the status let them through. membership_expiry held the truth the
// whole time; nothing ever acted on it.
//
// Lives here rather than inline in the scheduled Worker so the semantics can
// be tested — the Worker itself has no test harness.

export interface ExpirySweepResult {
  lapsed: number
}

/**
 * Moves every 'active' membership whose paid term has ended to 'expired'.
 *
 * Three deliberate boundaries:
 *
 *  - Strictly less-than. A membership expiring today is still good today,
 *    which is how paid-through is read everywhere else, including the roster
 *    sheet's own Active/Expired rule.
 *
 *  - Only 'active' rows. 'pending' means never paid and has no term to end;
 *    writing 'expired' over it would claim a membership that never existed.
 *
 *  - Rows with no expiry are left alone. A NULL there means nobody has ever
 *    set a term, not that the term has passed.
 *
 * Idempotent, so running it twice in a day — or running it after someone has
 * renewed — changes nothing the second time.
 */
export async function expireLapsedMemberships(
  db: D1Database,
  today: string,
): Promise<ExpirySweepResult> {
  const result = await db
    .prepare(
      `UPDATE members
          SET membership_status = 'expired'
        WHERE membership_status = 'active'
          AND membership_expiry IS NOT NULL
          AND membership_expiry < ?`,
    )
    .bind(today)
    .run()

  return { lapsed: result.meta.changes ?? 0 }
}
