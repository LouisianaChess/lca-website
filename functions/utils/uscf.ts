// functions/utils/uscf.ts
//
// Player lookup against the US Chess ratings API.
//
// This used to scrape HTML out of www.uschess.org/msa — regex-matching
// <font> tags for names and ratings. That stopped working when US Chess put
// Cloudflare bot protection in front of the domain: every request now gets
// `Cf-Mitigated: challenge` and a "Just a moment..." interstitial instead of
// the page, which no amount of header tweaking gets past.
//
// US Chess has since moved ratings to ratings.uschess.org, backed by a public
// JSON API that needs no key and answers plain server-side requests. That is
// what this now uses. Besides being far less brittle, it is better data:
// first and last name come through as separate fields rather than being
// guessed by splitting on spaces, and membership expiry and status are
// included, which the scraper never had.

const RATING_CACHE_MS = 7 * 24 * 60 * 60 * 1000
const API_BASE = 'https://ratings-api.uschess.org/api/v1'

/** US Chess member IDs are 8 digits. */
export const USCF_ID_PATTERN = /^\d{8}$/

export function isValidUscfId(value: string | null | undefined): boolean {
  return !!value && USCF_ID_PATTERN.test(value.trim())
}

export interface UscfPlayer {
  uscfId: string
  firstName: string
  lastName: string
  fullName: string
  rating: number | null
  ratingType: string | null
  isProvisional: boolean
  expirationDate: string | null
  state: string | null
  status: string | null
}

export interface UscfSearchResult {
  players: UscfPlayer[]
  /** Upstream was unreachable — distinct from "searched fine, found nobody". */
  upstreamUnavailable?: boolean
}

/**
 * One rating system's reading, kept as the API gives it.
 *
 * UscfPlayer flattens to a single Regular rating, which is the right shape
 * for the search box but throws away games played, the floor, and the other
 * systems entirely — all of which a rating history wants to record, because
 * once a day has passed that reading cannot be fetched again.
 */
export interface UscfSystemRating {
  system: string
  rating: number | null
  isProvisional: boolean
  gamesPlayed: number | null
  floor: number | null
}

export interface UscfMemberDetail {
  uscfId: string
  fullName: string
  /** Every rating system the API returned, including the unrated ones. */
  ratings: UscfSystemRating[]
  /** When US Chess says any rating last moved — the date a reading belongs to. */
  lastChangedDate: string | null
  expirationDate: string | null
  status: string | null
}

export interface UscfLookupResult {
  uscfId: string
  rating: number | null
  name: string | null
}

// ── API response shapes ──────────────────────────────────────────────────
// Only the fields we actually consume. A rating entry omits `rating`
// entirely when the player is unrated in that system, so it is optional.

interface ApiRating {
  ratingSystem: string
  rating?: number
  isProvisional?: boolean
  gamesPlayed?: number
  floor?: number
}

interface ApiMember {
  id: string
  firstName?: string
  lastName?: string
  stateRep?: string
  jurisdiction?: string
  expirationDate?: string
  status?: string
  ratings?: ApiRating[]
}

export function isRatingCacheStale(updatedAt: string | null): boolean {
  if (!updatedAt) return true
  const updated = Date.parse(updatedAt)
  if (Number.isNaN(updated)) return true
  return Date.now() - updated > RATING_CACHE_MS
}

/**
 * The API returns names inconsistently — some records are stored properly
 * cased ("Kobi"), others shout ("MAGNUS"). Title-case only the shouted ones
 * so deliberately cased names like "McBride" or "van Wely" survive intact.
 */
function normalizeName(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  if (raw !== raw.toUpperCase()) return raw // already mixed case — leave alone
  return raw
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Regular ('R') is the rating that matters for our sections and reports. */
function regularRating(ratings: ApiRating[] | undefined) {
  const r = ratings?.find((x) => x.ratingSystem === 'R')
  return {
    rating: typeof r?.rating === 'number' ? r.rating : null,
    isProvisional: r?.isProvisional === true,
  }
}

function toPlayer(m: ApiMember): UscfPlayer {
  const firstName = normalizeName(m.firstName)
  const lastName = normalizeName(m.lastName)
  const { rating, isProvisional } = regularRating(m.ratings)

  return {
    uscfId: m.id,
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    rating,
    ratingType: rating === null ? null : 'Regular',
    isProvisional,
    expirationDate: m.expirationDate ?? null,
    state: m.stateRep ?? m.jurisdiction ?? null,
    status: m.status ?? null,
  }
}

async function getJson<T>(url: string, timeoutMs: number): Promise<
  { ok: true; data: T } | { ok: false; notFound: boolean }
> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    // 404 is a real answer ("no such member"), not an outage.
    if (res.status === 404) return { ok: false, notFound: true }
    if (!res.ok) return { ok: false, notFound: false }
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false, notFound: false }
  }
}

export async function fetchUscfById(
  uscfId: string,
): Promise<{ player: UscfPlayer | null; upstreamUnavailable: boolean }> {
  const id = uscfId.trim()
  // Reject malformed ids before spending a network call on them.
  if (!isValidUscfId(id)) return { player: null, upstreamUnavailable: false }

  const result = await getJson<ApiMember>(`${API_BASE}/members/${id}`, 8000)

  if (!result.ok) {
    // Not found → a definite "this id doesn't exist", so report it as such.
    return { player: null, upstreamUnavailable: !result.notFound }
  }
  if (!result.data?.id) {
    return { player: null, upstreamUnavailable: false }
  }

  return { player: toPlayer(result.data), upstreamUnavailable: false }
}

/**
 * The full member record, not the flattened one.
 *
 * Same call as fetchUscfById — this exists so the nightly snapshot does not
 * have to re-fetch or reverse-engineer what toPlayer discarded.
 */
export async function fetchUscfMemberDetail(
  uscfId: string,
): Promise<{ detail: UscfMemberDetail | null; upstreamUnavailable: boolean }> {
  const id = uscfId.trim()
  if (!isValidUscfId(id)) return { detail: null, upstreamUnavailable: false }

  const result = await getJson<ApiMember & { lastChangedDate?: string }>(
    `${API_BASE}/members/${id}`,
    8000,
  )
  if (!result.ok) return { detail: null, upstreamUnavailable: !result.notFound }
  if (!result.data?.id) return { detail: null, upstreamUnavailable: false }

  const m = result.data
  const firstName = normalizeName(m.firstName)
  const lastName = normalizeName(m.lastName)

  return {
    detail: {
      uscfId: m.id,
      fullName: [firstName, lastName].filter(Boolean).join(' '),
      ratings: (m.ratings ?? []).map((r) => ({
        system: r.ratingSystem,
        // A player unrated in a system comes back with no `rating` key at
        // all, which is different from a rating of zero.
        rating: typeof r.rating === 'number' ? r.rating : null,
        isProvisional: r.isProvisional === true,
        gamesPlayed: typeof r.gamesPlayed === 'number' ? r.gamesPlayed : null,
        floor: typeof r.floor === 'number' ? r.floor : null,
      })),
      lastChangedDate: m.lastChangedDate ?? null,
      expirationDate: m.expirationDate ?? null,
      status: m.status ?? null,
    },
    upstreamUnavailable: false,
  }
}

export async function searchUscfByName(
  lastName: string,
  firstName?: string,
): Promise<UscfSearchResult> {
  // The API takes one fuzzy string rather than separate name fields.
  const query = [lastName.trim(), firstName?.trim()].filter(Boolean).join(' ')
  if (!query) return { players: [] }

  const result = await getJson<{ items?: ApiMember[] }>(
    `${API_BASE}/members?Fuzzy=${encodeURIComponent(query)}&Offset=0&Size=20`,
    10000,
  )

  // A search that legitimately matches nobody comes back 404 from this
  // endpoint; that is an empty result, not an outage.
  if (!result.ok) {
    return result.notFound
      ? { players: [] }
      : { players: [], upstreamUnavailable: true }
  }

  const items = Array.isArray(result.data?.items) ? result.data.items : []
  return { players: items.filter((m) => m?.id).map(toPlayer) }
}

/** Legacy-compatible wrapper — keeps existing callers working unchanged. */
export async function fetchUscfRatingFromWeb(
  uscfId: string,
): Promise<UscfLookupResult> {
  const { player } = await fetchUscfById(uscfId)
  return {
    uscfId,
    rating: player?.rating ?? null,
    name: player?.fullName ?? null,
  }
}

export async function refreshMemberUscfRating(
  db: D1Database,
  memberId: string,
  uscfId: string,
): Promise<number | null> {
  const { player, upstreamUnavailable } = await fetchUscfById(uscfId)

  // Don't overwrite a good stored rating with null just because US Chess was
  // briefly unreachable — leave the cached value and retry on the next pass.
  if (upstreamUnavailable) return null

  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE members SET uscf_rating = ?, uscf_rating_updated_at = ? WHERE id = ?`,
    )
    .bind(player?.rating ?? null, now, memberId)
    .run()
  return player?.rating ?? null
}
