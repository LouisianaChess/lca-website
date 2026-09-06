// src/pages/AnnualMeetingPage.tsx
//
// The annual business meeting. Public — anyone may attend.
//
// The join details live here rather than in the announcement banner on
// purpose. A banner is one line: it cannot hold an agenda, and it cannot
// offer the Meeting ID and passcode as text. Those matter, because a raw
// zoom.us link behaves differently on every platform — on a phone without
// Zoom installed it can bounce to the app store and lose the meeting
// entirely. Anyone who hits that can read the ID off this page and type it
// into the app, or dial in. That fallback is the whole reason for the page.
import { useEffect, useState } from 'react'
import { Calendar, Clock, ExternalLink, Phone, Video } from 'lucide-react'
import { PageHero } from '@/components/PageHero'
import { Button } from '@/components/ui/button'
import { GOLD_BUTTON } from '@/lib/brand'
import { usePageTitle } from '@/hooks/usePageTitle'

// ── Meeting details ──────────────────────────────────────────────────────
// Edit these when the next meeting is scheduled. Kept as plain constants
// rather than a database table: one meeting a year does not justify a CMS,
// and a wrong date here is a one-line fix rather than an admin task.

/** Start time, with an explicit offset so it is unambiguous. CDT is UTC-5. */
const MEETING_START = new Date('2026-09-06T16:30:00-05:00')

const ZOOM_URL =
  'https://us06web.zoom.us/j/83758873734?pwd=LKbohMPIWMLKPa3WctbYzb6GgOv70e.1'

/** Displayed for anyone joining from the Zoom app rather than the link. */
const MEETING_ID = '837 5887 3734'

/**
 * Numeric passcode Zoom prompts for when joining by Meeting ID.
 *
 * Not derivable from the join link: the pwd parameter there is an encoded
 * token that satisfies the passcode automatically, which is why clicking
 * the link never asks for one. Typing the ID in by hand does.
 */
const MEETING_PASSCODE = '778091'

/** Zoom's US dial-in. The caller is prompted for the ID, then the passcode. */
const DIAL_IN = { display: '+1 301 715 8592', tel: '+13017158592' }

/**
 * One-tap: dials, then keys in the meeting ID and passcode as DTMF tones.
 *
 * The commas are pauses and the hashes are literal keypresses — so they
 * must be percent-encoded, because a bare # in a URL starts a fragment and
 * everything after it would never reach the dialler.
 */
const ONE_TAP = `tel:${DIAL_IN.tel},,${MEETING_ID.replace(/ /g, '')}%23,,,,*${MEETING_PASSCODE}%23`

/*
 * Agenda items, once published. Empty renders the "coming soon" state.
 *
 * There is no agenda for the 2026 meeting, so the whole section is commented
 * out below rather than left showing a promise that will not be kept. Both
 * this and the block in the page body are kept verbatim for next year: fill
 * AGENDA in, uncomment both, and it works as before.
 *
const AGENDA: string[] = []
 */

// ─────────────────────────────────────────────────────────────────────────


const LONG_DATE = MEETING_START.toLocaleDateString('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

/** Counts down to the meeting, then says it is under way. */
function useCountdown(target: Date) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const ms = target.getTime() - now
  // Treat the two hours after the start as "in progress" rather than past,
  // so the join button stays prominent for latecomers.
  if (ms < -2 * 60 * 60 * 1000) return { state: 'past' as const, label: 'This meeting has ended' }
  if (ms <= 0) return { state: 'live' as const, label: 'Happening now' }

  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  const parts = days > 0
    ? [`${days} day${days === 1 ? '' : 's'}`, `${hours} hour${hours === 1 ? '' : 's'}`]
    : hours > 0
      ? [`${hours} hour${hours === 1 ? '' : 's'}`, `${mins} min`]
      : [`${mins} minute${mins === 1 ? '' : 's'}`]
  return { state: 'upcoming' as const, label: `In ${parts.join(', ')}` }
}

export function AnnualMeetingPage() {
  usePageTitle('Annual Business Meeting')
  const countdown = useCountdown(MEETING_START)

  return (
    <div>
      <PageHero
        eyebrow="Louisiana Chess Association"
        title="Annual business meeting"
        subtitle="Open to all members and anyone interested in chess in Louisiana. Join online from anywhere in the state."
        meta={
          <>
            <span className="flex items-center gap-1.5">
              <Calendar className="size-4 text-lca-gold" />
              {LONG_DATE}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="size-4 text-lca-gold" />
              4:30 PM Central
            </span>
            <span className="flex items-center gap-1.5 font-medium text-lca-gold">
              {countdown.label}
            </span>
          </>
        }
      />

      <section className="mx-auto max-w-3xl px-6 py-8">
        {/* ── Join ── */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Video className="size-5 text-lca-gold" />
            <h2 className="text-lg font-semibold text-lca-navy">Join the meeting</h2>
          </div>

          <p className="mt-2 text-sm text-muted-foreground">
            {countdown.state === 'live'
              ? 'The meeting is under way — join any time.'
              : countdown.state === 'past'
                ? 'This meeting has finished. Minutes will be posted to the governance pages.'
                : 'The room opens a few minutes before the start. No account is needed to join.'}
          </p>

          <Button asChild className={`mt-3 ${GOLD_BUTTON}`} size="lg">
            <a href={ZOOM_URL} target="_blank" rel="noopener noreferrer">
              Join on Zoom
              <ExternalLink className="ml-2 size-4" />
            </a>
          </Button>

          {/*
            Three columns, with the credentials in the middle: both routes
            either side need the same two values, so they sit between rather
            than being repeated in each. Same label treatment throughout —
            uppercase caption over content — so the three read as one row and
            not as three different kinds of block.
          */}
          <div className="mt-4 grid gap-5 border-t pt-4 sm:grid-cols-3 sm:gap-6">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                If the link doesn&apos;t open
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Open the Zoom app and choose{' '}
                <strong className="text-lca-navy">Join a Meeting</strong>.
              </p>
            </div>

            {/* Centred within its column: the two neighbours are prose that
                fills its width, while these are short numbers that would
                otherwise sit hard against the left and leave all the gap on
                one side. Left-aligned once stacked, to match the rest. */}
            <div className="space-y-3 sm:text-center">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Meeting ID
                </h3>
                <p className="mt-1.5 font-mono text-base font-medium tabular-nums text-lca-navy select-all">
                  {MEETING_ID}
                </p>
              </div>
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Passcode
                </h3>
                <p className="mt-1.5 font-mono text-base font-medium tabular-nums text-lca-navy select-all">
                  {MEETING_PASSCODE}
                </p>
              </div>
            </div>

            <div>
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Phone className="size-3.5 text-lca-gold" />
                Join by phone
              </h3>
              <a
                href={`tel:${DIAL_IN.tel}`}
                className="mt-1.5 block font-mono text-base font-medium tabular-nums text-lca-navy hover:underline select-all"
              >
                {DIAL_IN.display}
              </a>
              {/* One tap enters both itself — the reliable route on a phone,
                  where keying eleven digits into a live call is where people
                  give up. Hidden on wider screens, where tel: does little. */}
              <Button asChild variant="outline" size="sm" className="mt-2 sm:hidden">
                <a href={ONE_TAP}>
                  <Phone className="mr-1.5 size-3.5" />
                  Tap to call and join
                </a>
              </Button>
            </div>
          </div>
        </div>


        {/*
          ── Agenda ──
          No agenda for the 2026 meeting. Kept whole so next year is three
          steps: restore the AGENDA constant above, remove these two comment
          wrappers, and put FileText back in the lucide-react import — it is
          used only here, so lint removes it while this is commented out.

        <div className="mt-5 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <FileText className="size-5 text-lca-gold" />
            <h2 className="text-lg font-semibold text-lca-navy">Agenda</h2>
          </div>
          {AGENDA.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Agenda coming this evening. Check back before the meeting — it will be posted here.
            </p>
          ) : (
            <ol className="mt-3 space-y-2 text-sm">
              {AGENDA.map((item, i) => (
                <li key={item} className="flex gap-3">
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-lca-navy">{item}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        */}
      </section>
    </div>
  )
}
