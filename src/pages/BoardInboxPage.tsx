// src/pages/BoardInboxPage.tsx
//
// Routed at /board/inbox behind ProtectedRoute. The API enforces seat access;
// this page renders its own empty state for signed-in members who hold none.
//
// For an admin every seat is readable, which makes the list long and flat —
// hence the filters and the "needs attention" grouping. The point of an admin
// seeing all of it is catching what nobody answered, not reading everything.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ClipboardPaste, Inbox, MailOpen, Send, Trash2, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { usePageTitle } from '@/hooks/usePageTitle'
import { GOLD_BUTTON as GOLD } from '@/lib/brand'
import {
  addBoardTicketNote,
  getBoardTicket,
  deleteBoardTicket,
  getBoardTickets,
  replyToBoardTicket,
  updateBoardTicketStatus,
  type ApiBoardTicket,
  type ApiTicketMessage,
} from '@/lib/api'

const STATUS_LABEL: Record<string, string> = {
  open: 'New',
  in_progress: 'In progress',
  resolved: 'Resolved',
}

function formatWhen(value: string): string {
  const d = new Date(value.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

function daysSince(value: string | null): number {
  if (!value) return 0
  const d = new Date(value.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return 0
  return Math.floor((Date.now() - d.getTime()) / 86_400_000)
}

/** Last real message came from the visitor — nobody has answered yet. */
function awaitingReply(t: ApiBoardTicket): boolean {
  return t.status !== 'resolved' && t.last_sender_type !== 'admin'
}

export function BoardInboxPage() {
  usePageTitle('Board inbox')

  const [tickets, setTickets] = useState<ApiBoardTicket[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [selected, setSelected] = useState<ApiBoardTicket | null>(null)
  const [messages, setMessages] = useState<ApiTicketMessage[]>([])
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [draft, setDraft] = useState('')
  const [occurredAt, setOccurredAt] = useState('')
  const [seatFilter, setSeatFilter] = useState('')
  const [onlyUnanswered, setOnlyUnanswered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function loadList() {
    const data = await getBoardTickets()
    setTickets(data.tickets)
    setIsAdmin(!!data.isAdmin)
  }

  useEffect(() => {
    let cancelled = false
    getBoardTickets()
      .then((data) => {
        if (cancelled) return
        setTickets(data.tickets)
        setIsAdmin(!!data.isAdmin)
      })
      .catch(() => { if (!cancelled) setDenied(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Built from the tickets themselves rather than the seat list: a seat with
  // no messages needs no filter entry.
  const seatOptions = useMemo(() => {
    const map = new Map<string, string>()
    tickets.forEach((t) => map.set(t.seat_id, t.seat_role))
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [tickets])

  const visible = tickets.filter((t) => {
    if (seatFilter && t.seat_id !== seatFilter) return false
    if (onlyUnanswered && !awaitingReply(t)) return false
    return true
  })

  const unansweredCount = tickets.filter(awaitingReply).length
  const vacantCount = tickets.filter((t) => t.seat_holder_count === 0 && awaitingReply(t)).length

  async function openTicket(ticket: ApiBoardTicket) {
    setSelected(ticket)
    setMessages([])
    setDraft('')
    setOccurredAt('')
    setMode('reply')
    setError(null)
    try {
      const data = await getBoardTicket(ticket.id)
      setMessages(data.messages)
    } catch {
      setError('Could not open that message.')
    }
  }

  async function handleSubmit() {
    if (!selected || !draft.trim()) return
    setSending(true)
    setError(null)
    try {
      if (mode === 'note') {
        // datetime-local gives "2026-08-25T14:30"; SQLite wants a space.
        await addBoardTicketNote(
          selected.id,
          draft.trim(),
          occurredAt ? occurredAt.replace('T', ' ') + ':00' : null,
        )
      } else {
        await replyToBoardTicket(selected.id, draft.trim())
      }
      const data = await getBoardTicket(selected.id)
      setMessages(data.messages)
      setDraft('')
      setOccurredAt('')
      await loadList()
    } catch {
      setError(
        mode === 'note'
          ? 'That note didn\u2019t save. Try again.'
          : 'That reply didn\u2019t send. Try again.',
      )
    } finally {
      setSending(false)
    }
  }

  async function handleDelete() {
    if (!selected) return
    // Irreversible and it takes the conversation with it, so the confirm
    // names the ticket rather than asking "are you sure?" about nothing.
    if (!confirm(
      `Permanently delete "${selected.subject}" from ${selected.name}?

` +
      'The message history goes too. This cannot be undone.',
    )) return

    setDeleting(true)
    try {
      await deleteBoardTicket(selected.id)
      setSelected(null)
      setMessages([])
      await loadList()
    } catch {
      setError('Could not delete that ticket.')
    } finally {
      setDeleting(false)
    }
  }

  async function handleResolve() {
    if (!selected) return
    const next = selected.status === 'resolved' ? 'in_progress' : 'resolved'
    try {
      await updateBoardTicketStatus(selected.id, next)
      setSelected({ ...selected, status: next })
      await loadList()
    } catch {
      setError('Could not change the status.')
    }
  }

  if (loading) {
    return <p className="mx-auto max-w-6xl px-6 py-10 text-sm text-muted-foreground">Loading…</p>
  }

  if (denied) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16 text-center">
        <h1 className="text-xl font-bold text-lca-navy">No board inbox</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page is for members currently holding a board seat.
        </p>
      </div>
    )
  }

  return (
    <div>
      <section className="border-b-[3px] border-lca-gold bg-lca-navy">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <h1 className="text-2xl font-bold tracking-tight text-white">Board inbox</h1>
          <p className="mt-1 text-sm text-white/60">
            {isAdmin
              ? 'Every board seat, so nothing goes unanswered.'
              : 'Messages sent to the seats you hold, including any received before you took the seat.'}
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-8">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {isAdmin && vacantCount > 0 && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-lca-gold/50 bg-lca-gold/10 px-4 py-3">
            <UserX className="mt-0.5 size-4 flex-shrink-0 text-[#7a5c00]" />
            <p className="text-sm text-[#7a5c00]">
              {vacantCount} unanswered {vacantCount === 1 ? 'message is' : 'messages are'} on
              {vacantCount === 1 ? ' a seat' : ' seats'} nobody currently holds — only
              admins can see {vacantCount === 1 ? 'it' : 'them'}. Link a member in
              Admin → Board seats, or answer here.
            </p>
          </div>
        )}

        {tickets.length === 0 ? (
          <div className="rounded-xl border bg-card p-10 text-center">
            <Inbox className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-lca-navy">Nothing here yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Messages sent through the board page will appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <select
                value={seatFilter}
                onChange={(e) => setSeatFilter(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All seats ({tickets.length})</option>
                {seatOptions.map(([id, role]) => (
                  <option key={id} value={id}>
                    {role} ({tickets.filter((t) => t.seat_id === id).length})
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setOnlyUnanswered((v) => !v)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  onlyUnanswered
                    ? 'border-lca-navy bg-lca-navy text-white'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Awaiting reply ({unansweredCount})
              </button>
            </div>

            <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
              <div className="space-y-2">
                {visible.length === 0 && (
                  <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
                    Nothing matches that filter.
                  </p>
                )}
                {visible.map((t) => {
                  const waiting = awaitingReply(t)
                  const age = daysSince(t.last_activity_at ?? t.created_at)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => openTicket(t)}
                      className={cn(
                        'w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/40',
                        selected?.id === t.id ? 'border-lca-gold bg-lca-gold/8' : 'bg-card',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-lca-navy">
                          {t.seat_role}
                        </span>
                        <span className="flex-shrink-0 text-[10px] text-muted-foreground">
                          {STATUS_LABEL[t.status] ?? t.status}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium text-lca-navy">{t.subject}</p>
                      <p className="truncate text-xs text-muted-foreground">{t.name}</p>
                      {(waiting || t.seat_holder_count === 0) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {waiting && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              <AlertTriangle className="size-2.5" />
                              No reply{age > 0 ? ` · ${age}d` : ''}
                            </span>
                          )}
                          {t.seat_holder_count === 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              <UserX className="size-2.5" /> Seat unfilled
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>

              <div>
                {selected ? (
                  <div className="rounded-xl border bg-card p-5 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-lca-navy">
                          {selected.seat_role}
                        </p>
                        <h2 className="mt-0.5 font-bold text-lca-navy">{selected.subject}</h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {selected.name} · {selected.email}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={handleResolve}>
                          <MailOpen className="mr-1.5 size-3.5" />
                          {selected.status === 'resolved' ? 'Reopen' : 'Mark resolved'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:bg-red-50"
                          disabled={deleting}
                          onClick={handleDelete}
                          aria-label="Delete this ticket"
                        >
                          <Trash2 className="mr-1.5 size-3.5" />
                          {deleting ? 'Deleting…' : 'Delete'}
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-4 py-4">
                      {messages.map((m) =>
                        m.is_note ? (
                          <div
                            key={m.id}
                            className="rounded-lg border border-dashed border-lca-gold/50 bg-lca-gold/5 p-3"
                          >
                            <p className="text-[11px] font-medium text-[#7a5c00]">
                              Logged by {m.logged_by_name ?? 'a board member'}
                              {' · '}
                              {formatWhen(m.occurred_at ?? m.created_at)}
                            </p>
                            <p className="mt-1 whitespace-pre-line text-sm text-foreground">{m.body}</p>
                          </div>
                        ) : (
                          <div key={m.id} className={m.sender_type === 'admin' ? 'pl-6' : ''}>
                            <p className="text-[11px] text-muted-foreground">
                              {m.sender_type === 'admin' ? 'LCA' : selected.name} · {formatWhen(m.created_at)}
                            </p>
                            <p className="mt-1 whitespace-pre-line text-sm text-foreground">{m.body}</p>
                          </div>
                        ),
                      )}
                    </div>

                    <div className="border-t pt-4">
                      <div className="mb-3 inline-flex rounded-lg border p-0.5">
                        <button
                          type="button"
                          onClick={() => setMode('reply')}
                          className={cn(
                            'rounded-md px-3 py-1 text-xs font-medium',
                            mode === 'reply' ? 'bg-lca-navy text-white' : 'text-muted-foreground',
                          )}
                        >
                          Reply
                        </button>
                        <button
                          type="button"
                          onClick={() => setMode('note')}
                          className={cn(
                            'rounded-md px-3 py-1 text-xs font-medium',
                            mode === 'note' ? 'bg-lca-navy text-white' : 'text-muted-foreground',
                          )}
                        >
                          Log an email
                        </button>
                      </div>

                      {mode === 'note' && (
                        <div className="mb-3">
                          <label className="text-xs text-muted-foreground" htmlFor="occurredAt">
                            When was it sent? (optional)
                          </label>
                          <Input
                            id="occurredAt"
                            type="datetime-local"
                            className="mt-1 h-8 max-w-[240px] text-sm"
                            value={occurredAt}
                            onChange={(e) => setOccurredAt(e.target.value)}
                          />
                        </div>
                      )}

                      <Textarea
                        rows={mode === 'note' ? 6 : 4}
                        placeholder={
                          mode === 'note'
                            ? 'Paste the email exchange here…'
                            : 'Write a reply…'
                        }
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <Button
                        type="button"
                        className={cn('mt-3', GOLD)}
                        disabled={sending || !draft.trim()}
                        onClick={handleSubmit}
                      >
                        {mode === 'note' ? (
                          <ClipboardPaste className="mr-1.5 size-3.5" />
                        ) : (
                          <Send className="mr-1.5 size-3.5" />
                        )}
                        {sending
                          ? 'Saving…'
                          : mode === 'note'
                            ? 'Save to record'
                            : 'Send reply'}
                      </Button>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {mode === 'note'
                          ? 'Nothing is emailed — this only adds to the record, for a conversation that already happened elsewhere.'
                          : 'They\u2019ll get this by email and can reply from there.'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">
                    Pick a message to read it.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}