// test/integration/edges.test.ts — boundaries, regressions, and abuse cases.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  authBehavior,
  emailBehavior,
  emailOutbox,
  stripeBehavior,
  invoke,
  resetHarness,
  signStripePayload,
  stripeSessions,
} from './harness'
import { seedAdmin, seedMember, seedRegistration, seedTournament } from './factories'

import { onRequestPost as registrationsPost } from '../../functions/api/registrations'
import { onRequestPatch as membershipPatch } from '../../functions/api/admin/members/[id]/membership'
import { onRequestPatch as mePatch, onRequestPost as mePost } from '../../functions/api/me'
import { onRequestDelete as memberDelete } from '../../functions/api/admin/members/[id]'
import { onRequestGet as membersGet } from '../../functions/api/admin/members'
import { onRequestGet as boardTicketsGet } from '../../functions/api/board/tickets'
import { expireLapsedMemberships } from '../../functions/utils/membershipExpiry'
import { onRequestDelete as boardTicketDelete } from '../../functions/api/board/tickets/[id]'
import { onRequestPatch as memberRolePatch } from '../../functions/api/admin/members/[id]/role'
import { onRequestGet as contactGet, onRequestPost as contactPost } from '../../functions/api/contact'
import { onRequestPost as donationPost } from '../../functions/api/donations/checkout'
import { onRequestPost as membershipCheckoutPost } from '../../functions/api/membership/checkout'
import { onRequestPost as webhookPost } from '../../functions/api/stripe/webhook'
import { onRequestPost as membershipCheckout } from '../../functions/api/membership/checkout'
import { onRequestPost as membershipConfirm } from '../../functions/api/membership/confirm'
import {
  onRequestDelete as remindDelete,
  onRequestGet as remindGet,
  onRequestPost as remindPost,
} from '../../functions/api/tournaments/[id]/remind'

beforeEach(resetHarness)

describe('registration edge cases', () => {
  it('max_players: registration at capacity is refused', async () => {
    const tournamentId = await seedTournament({
      maxPlayers: 2, sections: [{ name: 'Open', entryFee: 0 }],
    })
    for (let i = 0; i < 2; i++) {
      await seedRegistration({ tournamentId, memberId: await seedMember(), section: 'Open' })
    }
    const late = await invoke(registrationsPost, {
      method: 'POST', as: await seedMember(),
      body: { tournamentId, section: 'Open' },
    })
    expect(late.status).toBe(400)
    expect((await late.json()).error).toMatch(/full/i)
  })

  it('registration_closes_at in the past blocks registration even while status is still open', async () => {
    const tournamentId = await seedTournament({
      registrationStatus: 'open',
      registrationClosesAt: '2026-01-01T00:00:00Z',
      sections: [{ name: 'Open', entryFee: 0 }],
    })
    const res = await invoke(registrationsPost, {
      method: 'POST', as: await seedMember(),
      body: { tournamentId, section: 'Open' },
    })
    expect(res.status).toBe(400)
  })

  it('closed/draft status blocks; invalid section blocks; too many byes blocks', async () => {
    const member = await seedMember()
    const closed = await seedTournament({ registrationStatus: 'closed', sections: [{ name: 'Open', entryFee: 0 }] })
    expect((await invoke(registrationsPost, { method: 'POST', as: member, body: { tournamentId: closed, section: 'Open' } })).status).toBe(400)

    const open = await seedTournament({ rounds: 4, sections: [{ name: 'Open', entryFee: 0 }] })
    expect((await invoke(registrationsPost, { method: 'POST', as: member, body: { tournamentId: open, section: 'Nope' } })).status).toBe(400)
    expect((await invoke(registrationsPost, { method: 'POST', as: member, body: { tournamentId: open, section: 'Open', byeRounds: [1, 2, 3, 4] } })).status).toBe(400)
  })

  it('a withdrawn player re-registering gets the reinstate message, not a new row', async () => {
    const member = await seedMember()
    const tournamentId = await seedTournament({ sections: [{ name: 'Open', entryFee: 0 }] })
    const regId = await seedRegistration({ tournamentId, memberId: member, section: 'Open' })
    await env.DB.prepare('UPDATE registrations SET withdrawn_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), regId).run()

    const res = await invoke(registrationsPost, {
      method: 'POST', as: member, body: { tournamentId, section: 'Open' },
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/reinstate/i)
  })
})

describe('membership PATCH regression (expiry-wipe fix)', () => {
  it('updating status alone preserves the stored expiry', async () => {
    const admin = await seedAdmin()
    const member = await seedMember()
    await env.DB.prepare('UPDATE members SET membership_expiry = ? WHERE id = ?')
      .bind('2027-06-30', member).run()

    const res = await invoke(membershipPatch, {
      method: 'PATCH', as: admin, params: { id: member },
      body: { membershipStatus: 'active' },
    })
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT membership_expiry FROM members WHERE id = ?')
      .bind(member).first<{ membership_expiry: string | null }>()
    expect(row?.membership_expiry).toBe('2027-06-30')
  })
})

describe('donation attribution', () => {
  const donate = (body: unknown, as?: string) =>
    invoke(donationPost, { method: 'POST', body, ...(as ? { as } : {}) })

  const paymentFor = (paymentId: string) =>
    env.DB.prepare('SELECT member_id FROM payments WHERE id = ?')
      .bind(paymentId).first<{ member_id: string | null }>()

  it('ignores a member id supplied in the body', async () => {
    // The endpoint is unauthenticated by design — anyone may donate — so a
    // member id from the request is unverifiable and used to be trusted.
    const victim = await seedMember()
    const res = await donate({ amount: 25, memberId: victim })
    expect(res.status).toBe(200)

    const { paymentId } = await res.json()
    expect((await paymentFor(paymentId))?.member_id).toBeNull()
  })

  it('attributes to the signed-in member when there is a session', async () => {
    const donor = await seedMember()
    const res = await donate({ amount: 25 }, donor)
    expect(res.status).toBe(200)

    const { paymentId } = await res.json()
    expect((await paymentFor(paymentId))?.member_id).toBe(donor)
  })

  it('a session wins over a conflicting body value', async () => {
    const donor = await seedMember()
    const victim = await seedMember()
    const res = await donate({ amount: 25, memberId: victim }, donor)

    const { paymentId } = await res.json()
    expect((await paymentFor(paymentId))?.member_id).toBe(donor)
  })

  it('still accepts an anonymous donation', async () => {
    const res = await donate({ amount: 10 })
    expect(res.status).toBe(200)
    const { paymentId } = await res.json()
    expect((await paymentFor(paymentId))?.member_id).toBeNull()
  })
})

describe('PATCH /api/me input validation', () => {
  const patch = (as: string, body: unknown) =>
    invoke(mePatch, { method: 'PATCH', as, body })

  const nameOf = (id: string) =>
    env.DB.prepare('SELECT full_name, uscf_id FROM members WHERE id = ?')
      .bind(id).first<{ full_name: string; uscf_id: string | null }>()

  it('rejects a blank name instead of storing it', async () => {
    // This is the one that mattered: the admin route validated, and the
    // member-facing route that people actually use validated nothing.
    const id = await seedMember({ fullName: 'Real Name' })
    for (const fullName of ['', '   ']) {
      const res = await patch(id, { fullName })
      expect(res.status).toBe(400)
    }
    expect((await nameOf(id))?.full_name).toBe('Real Name')
  })

  it('rejects a name past the length cap', async () => {
    const id = await seedMember({ fullName: 'Real Name' })
    const res = await patch(id, { fullName: 'x'.repeat(101) })
    expect(res.status).toBe(400)
    expect((await nameOf(id))?.full_name).toBe('Real Name')
  })

  it('accepts a name at the cap, and trims it', async () => {
    const id = await seedMember()
    expect((await patch(id, { fullName: 'x'.repeat(100) })).status).toBe(200)
    await patch(id, { fullName: '  Campbell, Richard  ' })
    expect((await nameOf(id))?.full_name).toBe('Campbell, Richard')
  })

  it('rejects a USCF ID that is not eight digits', async () => {
    const id = await seedMember({ uscfId: '12345678' })
    for (const uscfId of ['123', '1234567890', 'abcdefgh', '1234-567']) {
      expect((await patch(id, { uscfId })).status).toBe(400)
    }
    expect((await nameOf(id))?.uscf_id).toBe('12345678')
  })

  it('accepts a real USCF ID', async () => {
    const id = await seedMember()
    expect((await patch(id, { uscfId: '87654321' })).status).toBe(200)
    expect((await nameOf(id))?.uscf_id).toBe('87654321')
  })

  it('treats null and empty string as clearing the ID', async () => {
    for (const clear of [null, '']) {
      const id = await seedMember({ uscfId: '12345678' })
      expect((await patch(id, { uscfId: clear })).status).toBe(200)
      expect((await nameOf(id))?.uscf_id).toBeNull()
    }
  })

  it('leaves a field alone when it is not sent at all', async () => {
    // The PATCH contract: absent means untouched, which is different from
    // sent-and-empty. Only the latter is an error.
    const id = await seedMember({ fullName: 'Keep Me', uscfId: '12345678' })
    expect((await patch(id, {})).status).toBe(200)
    const row = await nameOf(id)
    expect(row?.full_name).toBe('Keep Me')
    expect(row?.uscf_id).toBe('12345678')
  })
})

describe('Stripe addresses its receipt to the account holder', () => {
  // Checkout asks for an email whether or not we send one, so a receipt was
  // always going to reach somebody. Sending it means Stripe's receipt goes to
  // the address on the LCA account rather than whatever was typed at the till,
  // and the field arrives prefilled.
  it('sends the member email with a membership checkout', async () => {
    const id = await seedMember({ email: 'player@example.org' })
    const res = await invoke(membershipCheckoutPost, {
      method: 'POST', as: id, body: { tier: 'adult' },
    })
    expect(res.status).toBe(200)
    expect(stripeSessions).toHaveLength(1)
    expect(stripeSessions[0].customerEmail).toBe('player@example.org')
  })

  it('sends it with a donation from a signed-in member too', async () => {
    const id = await seedMember({ email: 'donor@example.org' })
    const res = await invoke(donationPost, {
      method: 'POST', as: id, body: { amount: 25 },
    })
    expect(res.status).toBe(200)
    expect(stripeSessions[0].customerEmail).toBe('donor@example.org')
  })

  it('leaves it unset for an anonymous donation', async () => {
    // Nobody is signed in, so there is no account address to pin it to and
    // Checkout collects one itself.
    const res = await invoke(donationPost, { method: 'POST', body: { amount: 25 } })
    expect(res.status).toBe(200)
    expect(stripeSessions[0].customerEmail).toBeNull()
  })
})

describe('the member directory is readable by tournament directors', () => {
  // TDs verify membership at the registration desk, so they need the list —
  // read-only, and without the columns that are none of their business.
  const ADMIN_ONLY = ['role', 'club_id', 'club_name', 'uscf_rating', 'created_at']
  const VISIBLE = ['id', 'full_name', 'email', 'uscf_id', 'membership_status', 'membership_expiry']

  it('gives a tournament director the list, narrowed', async () => {
    await seedMember({ fullName: 'Verified Player', uscfId: '11112222' })
    const td = await seedMember({ role: 'tournament_director' })

    const res = await invoke(membersGet, { as: td })
    expect(res.status).toBe(200)

    const { members } = await res.json<{ members: Record<string, unknown>[] }>()
    expect(members.length).toBeGreaterThan(0)
    for (const key of VISIBLE) expect(Object.keys(members[0])).toContain(key)
    for (const key of ADMIN_ONLY) expect(Object.keys(members[0])).not.toContain(key)
  })

  it('still gives an admin the whole row', async () => {
    await seedMember({ fullName: 'Verified Player' })
    const admin = await seedAdmin()

    const res = await invoke(membersGet, { as: admin })
    expect(res.status).toBe(200)
    const { members } = await res.json<{ members: Record<string, unknown>[] }>()
    for (const key of [...VISIBLE, 'role', 'club_id', 'club_name']) {
      expect(Object.keys(members[0])).toContain(key)
    }
  })

  it('refuses an ordinary member', async () => {
    const id = await seedMember()
    expect((await invoke(membersGet, { as: id })).status).toBe(403)
  })

  it('gives an LCA auditor the same narrowed list', async () => {
    // The role exists for this and nothing else.
    await seedMember({ fullName: 'Verified Player', uscfId: '11112222' })
    const auditor = await seedMember({ role: 'lca_auditor' })

    const res = await invoke(membersGet, { as: auditor })
    expect(res.status).toBe(200)
    const { members } = await res.json<{ members: Record<string, unknown>[] }>()
    for (const key of VISIBLE) expect(Object.keys(members[0])).toContain(key)
    for (const key of ADMIN_ONLY) expect(Object.keys(members[0])).not.toContain(key)
  })

  it('does not let an auditor change anything either', async () => {
    const target = await seedMember({ fullName: 'Leave Me Alone' })
    const auditor = await seedMember({ role: 'lca_auditor' })

    expect((await invoke(memberRolePatch, {
      method: 'PATCH', as: auditor, params: { id: target }, body: { role: 'lca_admin' },
    })).status).toBe(403)
    expect((await invoke(memberDelete, {
      method: 'DELETE', as: auditor, params: { id: target },
    })).status).toBe(403)

    const row = await env.DB.prepare('SELECT role FROM members WHERE id = ?')
      .bind(target).first<{ role: string }>()
    expect(row?.role).toBe('member')
  })

  it('accepts lca_auditor as a role an admin can grant', async () => {
    // The CHECK constraint on members.role had to be widened for this, so a
    // failure here means migration 0033 did not apply.
    const admin = await seedAdmin()
    const target = await seedMember()

    const res = await invoke(memberRolePatch, {
      method: 'PATCH', as: admin, params: { id: target }, body: { role: 'lca_auditor' },
    })
    expect(res.status).toBe(200)

    const row = await env.DB.prepare('SELECT role FROM members WHERE id = ?')
      .bind(target).first<{ role: string }>()
    expect(row?.role).toBe('lca_auditor')
  })

  it('refuses a club rep', async () => {
    // Club reps manage one club's roster through their own screens; the
    // association-wide directory is not part of that.
    const id = await seedMember({ role: 'club_rep' })
    expect((await invoke(membersGet, { as: id })).status).toBe(403)
  })

  it('does not let a tournament director change anything', async () => {
    const target = await seedMember({ fullName: 'Leave Me Alone' })
    const td = await seedMember({ role: 'tournament_director' })

    const promote = await invoke(memberRolePatch, {
      method: 'PATCH', as: td, params: { id: target }, body: { role: 'lca_admin' },
    })
    expect(promote.status).toBe(403)

    const remove = await invoke(memberDelete, {
      method: 'DELETE', as: td, params: { id: target },
    })
    expect(remove.status).toBe(403)

    const row = await env.DB.prepare('SELECT role FROM members WHERE id = ?')
      .bind(target).first<{ role: string }>()
    expect(row?.role).toBe('member')
  })

  it('still requires a second factor from an admin', async () => {
    // Relaxing the guard for TDs must not have relaxed it for admins.
    const admin = await seedAdmin()
    const res = await invoke(membersGet, { as: admin, aal: 'aal1' })
    expect(res.status).toBe(403)
  })
})

describe('a profile edit survives the next sign-in', () => {
  // AuthContext calls POST /api/me on every auth state change, so this runs
  // on a plain page load. upsertMemberFromAuth used to prefer Supabase
  // user_metadata over the D1 row, and nothing ever writes an edit back to
  // that metadata — so the sync quietly restored the signup snapshot and the
  // member's change vanished on refresh.
  const rowOf = (id: string) =>
    env.DB.prepare('SELECT full_name, uscf_id, email FROM members WHERE id = ?')
      .bind(id).first<{ full_name: string; uscf_id: string | null; email: string }>()

  it('keeps a renamed member renamed', async () => {
    const id = await seedMember({ fullName: 'Old Name' })
    // The harness always stubs a full_name, exactly as 202 of the 205 real
    // accounts do.
    expect((await invoke(mePatch, { method: 'PATCH', as: id, body: { fullName: 'New Name' } })).status).toBe(200)
    expect((await rowOf(id))?.full_name).toBe('New Name')

    expect((await invoke(mePost, { method: 'POST', as: id })).status).toBe(201)
    expect((await rowOf(id))?.full_name).toBe('New Name')
  })

  it('keeps an edited USCF ID edited', async () => {
    authBehavior.extraMetadata = { uscf_id: '12345677' }
    const id = await seedMember({ uscfId: '12345677' })

    expect((await invoke(mePatch, { method: 'PATCH', as: id, body: { uscfId: '87654321' } })).status).toBe(200)
    expect((await rowOf(id))?.uscf_id).toBe('87654321')

    expect((await invoke(mePost, { method: 'POST', as: id })).status).toBe(201)
    expect((await rowOf(id))?.uscf_id).toBe('87654321')
  })

  it('keeps a cleared USCF ID cleared', async () => {
    authBehavior.extraMetadata = { uscf_id: '12345677' }
    const id = await seedMember({ uscfId: '12345677' })

    expect((await invoke(mePatch, { method: 'PATCH', as: id, body: { uscfId: null } })).status).toBe(200)
    expect((await invoke(mePost, { method: 'POST', as: id })).status).toBe(201)
    expect((await rowOf(id))?.uscf_id).toBeNull()
  })

  it('still seeds a brand-new row from metadata', async () => {
    // The one case where metadata is all there is: no row exists yet.
    const id = '11111111-2222-4333-8444-555555555555'
    authBehavior.extraMetadata = { uscf_id: '55554444' }
    expect((await invoke(mePost, { method: 'POST', as: id })).status).toBe(201)
    const row = await rowOf(id)
    expect(row?.full_name).toBe(`Test User ${id}`)
    expect(row?.uscf_id).toBe('55554444')
  })

  it('still tracks an email change made through auth', async () => {
    // Email is the field auth genuinely owns, so the sync must keep it.
    const id = await seedMember()
    await invoke(mePost, { method: 'POST', as: id })
    expect((await rowOf(id))?.email).toBe(`${id}@test.lca`)
  })
})

describe('a membership activates even when the webhook never arrives', () => {
  // Members were being left on 'pending' and activated by hand. Activation
  // lived only in the webhook, and confirm only read D1 — so a delivery that
  // never landed meant nothing in the product could tell the difference
  // between "not paid" and "we were never told", forever.
  async function buy(memberId: string, tier = 'adult') {
    const res = await invoke(membershipCheckout, {
      method: 'POST', as: memberId, body: { tier },
    })
    expect(res.status).toBe(200)
    const { paymentId } = await res.json<{ paymentId: string }>()
    return paymentId
  }

  const statusOf = async (memberId: string, paymentId: string) => ({
    member: (await env.DB.prepare(
      'SELECT membership_status, membership_expiry FROM members WHERE id = ?',
    ).bind(memberId).first<{ membership_status: string; membership_expiry: string | null }>()),
    payment: (await env.DB.prepare('SELECT status FROM payments WHERE id = ?')
      .bind(paymentId).first<{ status: string }>()),
  })

  it('activates from the success page when Stripe says the checkout was paid', async () => {
    const id = await seedMember({ membershipStatus: 'pending' })
    const paymentId = await buy(id)

    // No webhook at all — this is the broken case, reproduced.
    const res = await invoke(membershipConfirm, {
      method: 'POST', as: id, body: { paymentId },
    })
    expect(res.status).toBe(200)
    expect((await res.json<{ alreadyConfirmed?: boolean }>()).alreadyConfirmed).toBe(true)

    const after = await statusOf(id, paymentId)
    expect(after.payment?.status).toBe('completed')
    expect(after.member?.membership_status).toBe('active')
    expect(after.member?.membership_expiry).toBeTruthy()
  })

  it('leaves an unpaid checkout alone', async () => {
    stripeBehavior.sessionPaymentStatus = 'unpaid'
    const id = await seedMember({ membershipStatus: 'pending' })
    const paymentId = await buy(id)

    await invoke(membershipConfirm, { method: 'POST', as: id, body: { paymentId } })

    const after = await statusOf(id, paymentId)
    expect(after.payment?.status).toBe('pending')
    expect(after.member?.membership_status).toBe('pending')
  })

  it('does not extend the membership twice when both paths run', async () => {
    // The webhook and the success page can now both activate, in any order.
    // Reading the status and then writing it would let both win, and both
    // would add a year.
    const id = await seedMember({ membershipStatus: 'pending' })
    const paymentId = await buy(id)

    const rawBody = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_intent: 'pi_hook',
          metadata: { type: 'membership', payment_id: paymentId, member_id: id },
        },
      },
    })
    await invoke(webhookPost, {
      method: 'POST', rawBody,
      headers: { 'stripe-signature': await signStripePayload(rawBody) },
    })
    const afterHook = await statusOf(id, paymentId)
    expect(afterHook.member?.membership_status).toBe('active')

    await invoke(membershipConfirm, { method: 'POST', as: id, body: { paymentId } })

    const afterBoth = await statusOf(id, paymentId)
    expect(afterBoth.member?.membership_expiry).toBe(afterHook.member?.membership_expiry)
  })

  it('is still pending when the payment has no Stripe session to check', async () => {
    // A cash walk-in, or a row from before sessions were recorded: there is
    // nothing to ask Stripe about, so nothing is assumed.
    const id = await seedMember({ membershipStatus: 'pending' })
    await env.DB.prepare(
      `INSERT INTO payments (id, member_id, amount, type, reference_id, status)
       VALUES ('p-nosession', ?, 15, 'membership', 'adult', 'pending')`,
    ).bind(id).run()

    const res = await invoke(membershipConfirm, {
      method: 'POST', as: id, body: { paymentId: 'p-nosession' },
    })
    expect((await res.json<{ pending?: boolean }>()).pending).toBe(true)
  })
})

describe('a membership lapses when its term ends', () => {
  // membership_status was written once, at payment, and never again — so a
  // membership went active and stayed active for good, whatever the expiry
  // said. Four real members were active with a date months in the past.
  const TODAY = '2026-09-06'

  const statusOf = async (id: string) =>
    (await env.DB.prepare('SELECT membership_status FROM members WHERE id = ?')
      .bind(id).first<{ membership_status: string }>())?.membership_status

  it('expires a membership whose date has passed', async () => {
    const id = await seedMember({ membershipStatus: 'active' })
    await env.DB.prepare('UPDATE members SET membership_expiry = ? WHERE id = ?')
      .bind('2026-08-31', id).run()

    const { lapsed } = await expireLapsedMemberships(env.DB, TODAY)
    expect(lapsed).toBeGreaterThan(0)
    expect(await statusOf(id)).toBe('expired')
  })

  it('leaves a membership expiring today alone', async () => {
    // The last day is still a day you are a member, which is how paid-through
    // is read everywhere else.
    const id = await seedMember({ membershipStatus: 'active' })
    await env.DB.prepare('UPDATE members SET membership_expiry = ? WHERE id = ?')
      .bind(TODAY, id).run()

    await expireLapsedMemberships(env.DB, TODAY)
    expect(await statusOf(id)).toBe('active')
  })

  it('leaves a future membership alone', async () => {
    const id = await seedMember({ membershipStatus: 'active' })
    await env.DB.prepare('UPDATE members SET membership_expiry = ? WHERE id = ?')
      .bind('2027-09-06', id).run()

    await expireLapsedMemberships(env.DB, TODAY)
    expect(await statusOf(id)).toBe('active')
  })

  it('never turns a pending membership into an expired one', async () => {
    // 'pending' means never paid. It has no term to end, and calling it
    // expired would claim a membership that never existed.
    const id = await seedMember({ membershipStatus: 'pending' })
    await env.DB.prepare('UPDATE members SET membership_expiry = ? WHERE id = ?')
      .bind('2020-01-01', id).run()

    await expireLapsedMemberships(env.DB, TODAY)
    expect(await statusOf(id)).toBe('pending')
  })

  it('leaves an active membership with no expiry alone', async () => {
    // NULL means nobody has set a term, not that the term has passed.
    const id = await seedMember({ membershipStatus: 'active' })
    await expireLapsedMemberships(env.DB, TODAY)
    expect(await statusOf(id)).toBe('active')
  })

  it('is idempotent', async () => {
    const id = await seedMember({ membershipStatus: 'active' })
    await env.DB.prepare('UPDATE members SET membership_expiry = ? WHERE id = ?')
      .bind('2026-08-31', id).run()

    await expireLapsedMemberships(env.DB, TODAY)
    const second = await expireLapsedMemberships(env.DB, TODAY)
    expect(second.lapsed).toBe(0)
    expect(await statusOf(id)).toBe('expired')
  })
})

describe('board tickets can be read and deleted', () => {
  // A seat's tickets pass to whoever holds it next, so a test message clutters
  // the next holder's inbox forever and anything sensitive is disclosed to
  // someone who was never party to it. Closing a ticket does not help —
  // resolved tickets stay readable.
  async function seatWithTicket(holderId?: string) {
    const seat = await env.DB.prepare(
      "SELECT id FROM board_members WHERE is_active = 1 LIMIT 1",
    ).first<{ id: string }>()
    if (!seat) throw new Error('no board seat seeded')

    if (holderId) {
      await env.DB.prepare(
        `INSERT INTO board_seat_assignments (id, seat_id, member_id, started_at)
         VALUES (?, ?, ?, date('now'))`,
      ).bind(`bsa-${holderId}`, seat.id, holderId).run()
    }

    const ticketId = `tkt-${Math.random().toString(36).slice(2, 8)}`
    await env.DB.prepare(
      `INSERT INTO support_tickets (id, name, email, subject, status, seat_id)
       VALUES (?, 'Visitor', 'visitor@example.org', 'Sensitive thing', 'open', ?)`,
    ).bind(ticketId, seat.id).run()
    await env.DB.prepare(
      `INSERT INTO support_messages (id, ticket_id, sender_type, body)
       VALUES (?, ?, 'guest', 'please do not keep this')`,
    ).bind(`msg-${ticketId}`, ticketId).run()

    return { seatId: seat.id, ticketId }
  }

  const counts = async (ticketId: string) => ({
    tickets: (await env.DB.prepare('SELECT COUNT(*) n FROM support_tickets WHERE id = ?')
      .bind(ticketId).first<{ n: number }>())?.n ?? 0,
    messages: (await env.DB.prepare('SELECT COUNT(*) n FROM support_messages WHERE ticket_id = ?')
      .bind(ticketId).first<{ n: number }>())?.n ?? 0,
  })

  it('lists tickets for an admin', async () => {
    // Regression for the board inbox returning 500 because the query selected
    // columns migration 0026 never actually added in production.
    const admin = await seedAdmin()
    await seatWithTicket()
    const res = await invoke(boardTicketsGet, { as: admin })
    expect(res.status).toBe(200)
    const { tickets } = await res.json<{ tickets: unknown[] }>()
    expect(tickets.length).toBeGreaterThan(0)
  })

  it('lets the seat holder delete a ticket, messages and all', async () => {
    const holder = await seedMember()
    const { ticketId } = await seatWithTicket(holder)

    const res = await invoke(boardTicketDelete, {
      method: 'DELETE', as: holder, params: { id: ticketId },
    })
    expect(res.status).toBe(200)
    expect(await counts(ticketId)).toEqual({ tickets: 0, messages: 0 })
  })

  it('lets an admin delete any ticket', async () => {
    const admin = await seedAdmin()
    const { ticketId } = await seatWithTicket()

    expect((await invoke(boardTicketDelete, {
      method: 'DELETE', as: admin, params: { id: ticketId },
    })).status).toBe(200)
    expect(await counts(ticketId)).toEqual({ tickets: 0, messages: 0 })
  })

  it('refuses a member who holds no seat', async () => {
    const nobody = await seedMember()
    const { ticketId } = await seatWithTicket()

    expect((await invoke(boardTicketDelete, {
      method: 'DELETE', as: nobody, params: { id: ticketId },
    })).status).toBe(403)
    expect((await counts(ticketId)).tickets).toBe(1)
  })

  it('records who deleted what, since the ticket itself is gone', async () => {
    const admin = await seedAdmin()
    const { ticketId } = await seatWithTicket()
    await invoke(boardTicketDelete, { method: 'DELETE', as: admin, params: { id: ticketId } })

    const entry = await env.DB.prepare(
      `SELECT action, target_label, detail FROM admin_audit_log
        WHERE action = 'ticket_delete' AND detail LIKE ?`,
    ).bind(`%${ticketId}%`).first<{ action: string; target_label: string; detail: string }>()
    expect(entry?.action).toBe('ticket_delete')
    expect(entry?.target_label).toContain('Sensitive thing')
    expect(entry?.detail).toContain('visitor@example.org')
  })
})

describe('deleting a member clears every reference', () => {
  it('removes the seat assignment and campaign recipient row', async () => {
    const adminId = await seedAdmin()
    const memberId = await seedMember()

    // Two tables the cascade used to miss. A deleted member kept their
    // officer seat and stayed on an in-flight campaign's recipient list.
    const seat = await env.DB.prepare(
      "SELECT id FROM board_members LIMIT 1",
    ).first<{ id: string }>()
    if (seat) {
      await env.DB.prepare(
        `INSERT INTO board_seat_assignments (id, seat_id, member_id, started_at)
         VALUES (?, ?, ?, date('now'))`,
      ).bind(`bsa-${memberId}`, seat.id, memberId).run()
    }

    await env.DB.prepare(
      `INSERT INTO email_campaigns (id, subject, body_html, filter_json, total_recipients)
       VALUES ('camp-del', 's', '<p>b</p>', '{}', 1)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO email_campaign_recipients (id, campaign_id, member_id, email)
       VALUES (?, 'camp-del', ?, 'x@y.z')`,
    ).bind(`rcpt-del-${memberId}`, memberId).run()

    const res = await invoke(memberDelete, {
      method: 'DELETE', as: adminId, params: { id: memberId },
    })
    expect(res.status).toBe(200)

    const count = async (sql: string) =>
      (await env.DB.prepare(sql).bind(memberId).first<{ n: number }>())?.n ?? 0

    expect(await count('SELECT COUNT(*) n FROM members WHERE id = ?')).toBe(0)
    expect(await count('SELECT COUNT(*) n FROM board_seat_assignments WHERE member_id = ?')).toBe(0)
    expect(await count('SELECT COUNT(*) n FROM email_campaign_recipients WHERE member_id = ?')).toBe(0)
  })

  it('reports whether the auth user was removed too', async () => {
    // The response now carries authDeleted, so an admin can tell the
    // difference between a full removal and one that left a login behind.
    const adminId = await seedAdmin()
    const memberId = await seedMember()

    const res = await invoke(memberDelete, {
      method: 'DELETE', as: adminId, params: { id: memberId },
    })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body).toHaveProperty('authDeleted')
  })
})

describe('contact endpoint (PII-leak fix + resilience)', () => {
  it('GET requires admin', async () => {
    expect((await invoke(contactGet)).status).toBe(401)
    expect((await invoke(contactGet, { as: await seedMember() })).status).toBe(403)
    expect((await invoke(contactGet, { as: await seedAdmin() })).status).toBe(200)
  })

  it('POST saves, sends two emails, and escapes injected HTML in the notification', async () => {
    const res = await invoke(contactPost, {
      method: 'POST',
      body: {
        name: '<script>alert(1)</script>', email: 'x@y.z',
        subject: 'Hello', body: 'line1\nline2',
      },
    })
    expect(res.status).toBe(201)
    expect(emailOutbox).toHaveLength(2)
    const notification = emailOutbox.find((e) => e.to === 'contact@louisianachess.org')
    expect(notification?.html).not.toContain('<script>')
    expect(notification?.html).toContain('&lt;script&gt;')
  })

  it('POST still succeeds when the email provider is down (trySendEmail)', async () => {
    emailBehavior.succeed = false
    const res = await invoke(contactPost, {
      method: 'POST',
      body: { name: 'A', email: 'a@b.c', subject: 'S', body: 'B' },
    })
    expect(res.status).toBe(201)

    // The ticket is written before any mail is attempted, which is the whole
    // point: an outage at Resend must not lose someone's message. Asserted on
    // the id this request returned rather than a row count, so a ticket left
    // behind by another test cannot make this pass.
    const { ticketId } = await res.json()
    const saved = await env.DB.prepare(
      'SELECT id FROM support_tickets WHERE id = ?',
    ).bind(ticketId).first<{ id: string }>()
    expect(saved?.id).toBe(ticketId)
  })
})

describe('donations (0019 regression: type + anonymous member)', () => {
  it('anonymous donation inserts a null-member donation payment and the webhook completes it', async () => {
    const res = await invoke(donationPost, {
      method: 'POST', body: { amount: 25 },
    })
    expect(res.status).toBe(200)
    const { paymentId } = await res.json()
    const session = stripeSessions[0]
    expect(session.metadata.type).toBe('donation')

    const rawBody = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { payment_intent: 'pi_d1', metadata: session.metadata } },
    })
    const hook = await invoke(webhookPost, {
      method: 'POST', rawBody,
      headers: { 'stripe-signature': await signStripePayload(rawBody) },
    })
    expect(hook.status).toBe(200)

    const row = await env.DB.prepare('SELECT member_id, type, status FROM payments WHERE id = ?')
      .bind(paymentId).first<{ member_id: string | null; type: string; status: string }>()
    expect(row?.member_id).toBeNull()
    expect(row?.type).toBe('donation')
    expect(row?.status).toBe('completed')
  })

  it('rejects out-of-range amounts', async () => {
    expect((await invoke(donationPost, { method: 'POST', body: { amount: 0 } })).status).toBe(400)
    expect((await invoke(donationPost, { method: 'POST', body: { amount: 20000 } })).status).toBe(400)
  })
})

describe('tournament reminders (dead-route fix)', () => {
  it('opt-in → status true → opt-out → status false', async () => {
    const member = await seedMember()
    const tournamentId = await seedTournament()

    expect((await invoke(remindPost, { method: 'POST', as: member, params: { id: tournamentId } })).status).toBe(200)
    expect((await (await invoke(remindGet, { as: member, params: { id: tournamentId } })).json()).opted_in).toBe(true)
    expect((await invoke(remindDelete, { method: 'DELETE', as: member, params: { id: tournamentId } })).status).toBe(200)
    expect((await (await invoke(remindGet, { as: member, params: { id: tournamentId } })).json()).opted_in).toBe(false)
  })
})