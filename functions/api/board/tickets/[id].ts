// functions/api/board/tickets/[id].ts
import type { Env } from '../../../types'
import { isResponse, requireSeatAccess } from '../../../utils/auth'
import { recordAdminAction } from '../../../utils/audit'
import {
  errorResponse,
  handleOptions,
  jsonResponse,
  parseJsonBody,
} from '../../../utils/response'
import { trySendEmail, supportReplyNotificationEmail } from '../../../utils/email'
import { siteUrlFromRequest } from '../../../utils/tickets'

export const onRequestOptions: PagesFunction<Env> = async () => handleOptions()

interface TicketRow {
  id: string
  name: string
  email: string
  subject: string
  status: string
  seat_id: string | null
  created_at: string
  updated_at: string
  seat_role: string | null
}

/**
 * Loads a ticket only if the caller can read it. Checking the ticket's seat
 * against the caller's seat list (rather than trusting a seat id from the
 * request) is what stops one board member reading another's inbox by guessing
 * ticket ids.
 *
 * Admins pass on any ticket, including general inquiries with no seat — they
 * can already read everything through /admin/support, and letting them log
 * notes here means one code path for the paste box instead of two.
 */
async function loadAccessibleTicket(
  ctx: Parameters<PagesFunction<Env>>[0],
  seatIds: string[],
  isAdmin: boolean,
): Promise<TicketRow | Response> {
  const { id } = ctx.params as { id: string }

  const ticket = await ctx.env.DB.prepare(
    `SELECT t.id, t.name, t.email, t.subject, t.status, t.seat_id,
            t.created_at, t.updated_at, b.role AS seat_role
       FROM support_tickets t
       LEFT JOIN board_members b ON b.id = t.seat_id
      WHERE t.id = ?`,
  )
    .bind(id)
    .first<TicketRow>()

  if (!ticket) return errorResponse('Not found', 404)
  if (isAdmin) return ticket
  if (!ticket.seat_id || !seatIds.includes(ticket.seat_id)) {
    return errorResponse('Forbidden', 403)
  }

  return ticket
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const access = await requireSeatAccess(ctx.request, ctx.env)
  if (isResponse(access)) return access

  const ticket = await loadAccessibleTicket(ctx, access.seatIds, access.isAdmin)
  if (isResponse(ticket)) return ticket

  // Ordered by when things actually happened, not when they were typed, so a
  // note logged today about a reply sent last week sits in the right place.
  const messages = await ctx.env.DB.prepare(
    `SELECT m.id,
            m.ticket_id,
            m.sender_type,
            m.body,
            m.created_at,
            m.is_note,
            m.occurred_at,
            lb.full_name AS logged_by_name
       FROM support_messages m
       LEFT JOIN members lb ON lb.id = m.logged_by
      WHERE m.ticket_id = ?
      ORDER BY COALESCE(m.occurred_at, m.created_at) ASC`,
  )
    .bind(ticket.id)
    .all()

  return jsonResponse({ ticket, messages: messages.results ?? [] })
}

interface PostBody {
  body?: string
  /** 'reply' sends an email; 'note' only records. Defaults to 'reply'. */
  kind?: 'reply' | 'note'
  /** For notes: when the correspondence actually happened. SQLite datetime. */
  occurredAt?: string | null
}

/**
 * Post a reply, or log correspondence that happened elsewhere.
 *
 * sender_type is 'admin' for both because support_messages carries a CHECK
 * constraint of ('member','admin','guest'). is_note is what separates them.
 *
 * The difference that matters: a reply emails the person, a note does not.
 * Notes exist precisely because the email already went out through someone's
 * Gmail — sending another one would confuse the person on the other end.
 */
export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const access = await requireSeatAccess(ctx.request, ctx.env)
  if (isResponse(access)) return access

  const ticket = await loadAccessibleTicket(ctx, access.seatIds, access.isAdmin)
  if (isResponse(ticket)) return ticket

  const body = await parseJsonBody<PostBody>(ctx.request)
  if (!body?.body?.trim()) return errorResponse('body is required', 400)

  const kind = body.kind === 'note' ? 'note' : 'reply'
  const text = body.body.trim()
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (kind === 'note') {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO support_messages
           (id, ticket_id, sender_id, sender_type, body, is_note, logged_by, occurred_at)
         VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)`,
      ).bind(
        messageId,
        ticket.id,
        access.member.id,
        text,
        access.member.id,
        body.occurredAt || null,
      ),
      // Bumps updated_at so the ticket resurfaces, but deliberately leaves
      // status alone: logging what someone already sent says nothing about
      // whether the matter is handled.
      ctx.env.DB.prepare(
        `UPDATE support_tickets SET updated_at = datetime('now') WHERE id = ?`,
      ).bind(ticket.id),
    ])

    return jsonResponse({ success: true, messageId, kind }, 201)
  }

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO support_messages (id, ticket_id, sender_id, sender_type, body)
       VALUES (?, ?, ?, 'admin', ?)`,
    ).bind(messageId, ticket.id, access.member.id, text),
    ctx.env.DB.prepare(
      `UPDATE support_tickets
          SET updated_at = datetime('now'),
              status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
        WHERE id = ?`,
    ).bind(ticket.id),
  ])

  // reply_to defaults to the association Gmail, so if the person replies to
  // this notification it still reaches a live mailbox.
  await trySendEmail(ctx.env, {
    ...supportReplyNotificationEmail({
      name: ticket.name,
      ticketId: ticket.id,
      subject: ticket.subject,
      replyBody: text,
      siteUrl: siteUrlFromRequest(ctx.request),
    }),
    to: ticket.email,
  })

  return jsonResponse({ success: true, messageId, kind }, 201)
}

export const onRequestPatch: PagesFunction<Env> = async (ctx) => {
  const access = await requireSeatAccess(ctx.request, ctx.env)
  if (isResponse(access)) return access

  const ticket = await loadAccessibleTicket(ctx, access.seatIds, access.isAdmin)
  if (isResponse(ticket)) return ticket

  const body = await parseJsonBody<{ status?: string }>(ctx.request)
  const allowed = ['open', 'in_progress', 'resolved']
  if (!body?.status || !allowed.includes(body.status)) {
    return errorResponse('status must be open, in_progress, or resolved', 400)
  }

  await ctx.env.DB.prepare(
    `UPDATE support_tickets
        SET status = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(body.status, ticket.id)
    .run()

  return jsonResponse({ success: true, status: body.status })
}

/**
 * Removes a ticket and everything said on it.
 *
 * Board members asked for this for two reasons, and both are about the
 * handover: a seat's tickets pass to whoever holds it next, so a test message
 * clutters the next holder's inbox forever, and anything a visitor typed that
 * turned out to be sensitive is disclosed to a person who was never party to
 * it. Neither is fixable by closing the ticket — resolved tickets are still
 * readable.
 *
 * Same access as reading it: the seat holder, or an admin. Deliberately not
 * admin-only, because the person who most needs to remove something sensitive
 * is the one who can see it.
 *
 * The messages go first: support_messages has no ON DELETE CASCADE, so
 * deleting the ticket alone would strand them, invisible and undeletable.
 */
export const onRequestDelete: PagesFunction<Env> = async (ctx) => {
  const access = await requireSeatAccess(ctx.request, ctx.env)
  if (isResponse(access)) return access

  const ticket = await loadAccessibleTicket(ctx, access.seatIds, access.isAdmin)
  if (isResponse(ticket)) return ticket

  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM support_messages WHERE ticket_id = ?').bind(ticket.id),
    ctx.env.DB.prepare('DELETE FROM support_tickets WHERE id = ?').bind(ticket.id),
  ])

  // Who deleted what, since the ticket itself is gone. A deletion nobody can
  // account for afterwards is worse than the clutter it removed.
  await recordAdminAction(ctx.env.DB, access.member, {
    action: 'ticket_delete',
    targetLabel: `${ticket.seat_role ?? 'General'}: "${ticket.subject}"`,
    detail: {
      ticket_id: ticket.id,
      from: `${ticket.name} <${ticket.email}>`,
      seat_id: ticket.seat_id,
    },
  })

  return jsonResponse({ success: true })
}
