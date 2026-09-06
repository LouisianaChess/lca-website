// functions/utils/ratingSnapshots.ts
//
// Records each member's US Chess rating once a day, so it can be charted.
//
// The history is not fetchable — the ratings API returns today's number and
// nothing else, and the MSA pages that carry event history are behind a bot
// challenge. So a rating curve can only be accumulated from now on, and a
// night this does not run is a reading nobody can get back.
//
// Also refreshes members.uscf_rating, which until now was never written by
// anything: refreshMemberUscfRating() existed in utils/uscf.ts and was called
// from no code path, which is why every member's rating column was empty even
// for those who had supplied an id.

import { fetchUscfMemberDetail, type UscfSystemRating } from './uscf'

/** Systems worth recording. The online variants move rarely and chart badly. */
const TRACKED_SYSTEMS = new Set(['R', 'Q', 'B'])

/** The system shown as "your rating" everywhere in the UI. */
export const PRIMARY_SYSTEM = 'R'

export interface SnapshotResult {
  checked: number
  changed: number
  unreachable: number
}

interface MemberRow {
  id: string
  uscf_id: string
}

interface LastReading {
  member_id: string
  rating_system: string
  rating: number
}

/**
 * One pass over every member with a USCF id.
 *
 * A row is written only when the value differs from that member's last
 * recorded reading for that system. Ratings move a handful of times a year,
 * so storing an identical number nightly would be roughly two hundred times
 * the rows for no additional information, and every chart would have to
 * collapse them again on read.
 *
 * Upstream being unreachable is counted, never recorded: a gap in the data is
 * honest, whereas a null written into the history would be indistinguishable
 * later from a real unrating.
 */
export async function snapshotMemberRatings(
  db: D1Database,
  opts: { limit?: number } = {},
): Promise<SnapshotResult> {
  const { results: members } = await db
    .prepare(
      `SELECT id, uscf_id FROM members
        WHERE uscf_id IS NOT NULL AND uscf_id != ''
        ORDER BY uscf_rating_updated_at IS NOT NULL, uscf_rating_updated_at
        LIMIT ?`,
    )
    .bind(opts.limit ?? 500)
    .all<MemberRow>()

  if (!members?.length) return { checked: 0, changed: 0, unreachable: 0 }

  // The most recent reading per member per system, in one query rather than
  // one per member — this runs against every member with an id, nightly.
  const { results: latest } = await db
    .prepare(
      `SELECT h.member_id, h.rating_system, h.rating
         FROM uscf_rating_history h
         JOIN (
           SELECT member_id, rating_system, MAX(recorded_at) AS newest
             FROM uscf_rating_history
            GROUP BY member_id, rating_system
         ) newest
           ON newest.member_id = h.member_id
          AND newest.rating_system = h.rating_system
          AND newest.newest = h.recorded_at`,
    )
    .all<LastReading>()

  const previous = new Map<string, number>()
  for (const row of latest ?? []) {
    previous.set(`${row.member_id}:${row.rating_system}`, row.rating)
  }

  const result: SnapshotResult = { checked: 0, changed: 0, unreachable: 0 }
  const writes: D1PreparedStatement[] = []
  const now = new Date().toISOString()

  for (const member of members) {
    result.checked++

    const { detail, upstreamUnavailable } = await fetchUscfMemberDetail(member.uscf_id)
    if (upstreamUnavailable) {
      result.unreachable++
      continue
    }
    if (!detail) continue

    for (const reading of detail.ratings) {
      if (!TRACKED_SYSTEMS.has(reading.system)) continue
      if (reading.rating === null) continue

      const key = `${member.id}:${reading.system}`
      if (previous.get(key) === reading.rating) continue

      result.changed++
      writes.push(newHistoryRow(db, member.id, reading, detail.lastChangedDate, now))
    }

    // The denormalised current rating the profile and directory read. Written
    // every pass, not only on change, so uscf_rating_updated_at stays honest
    // about when it was last verified.
    const primary = detail.ratings.find((r) => r.system === PRIMARY_SYSTEM)
    writes.push(
      db
        .prepare(`UPDATE members SET uscf_rating = ?, uscf_rating_updated_at = ? WHERE id = ?`)
        .bind(primary?.rating ?? null, now, member.id),
    )
  }

  if (writes.length) await db.batch(writes)
  return result
}

function newHistoryRow(
  db: D1Database,
  memberId: string,
  reading: UscfSystemRating,
  effectiveDate: string | null,
  recordedAt: string,
): D1PreparedStatement {
  const id = `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return db
    .prepare(
      `INSERT INTO uscf_rating_history
         (id, member_id, rating_system, rating, is_provisional,
          games_played, rating_floor, effective_date, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      memberId,
      reading.system,
      reading.rating,
      reading.isProvisional ? 1 : 0,
      reading.gamesPlayed,
      reading.floor,
      effectiveDate,
      recordedAt,
    )
}
