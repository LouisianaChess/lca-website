// test/integration/harness.ts
import { env } from 'cloudflare:test'
import type { Env } from '../../functions/types'

// ── Assertion surfaces ───────────────────────────────────────────

export interface SentEmail {
  to: string
  subject: string
  html: string
  text?: string
  from: string
}

export interface CreatedStripeSession {
  id: string
  url: string
  /** Flattened metadata[...] fields exactly as sent to Stripe */
  metadata: Record<string, string>
  amountCents: number
  productName: string
  clientReferenceId: string | null
  /** Whose address Stripe will put its receipt against. */
  customerEmail: string | null
}

/** Every email "sent" via Resend during the current test file. */
export const emailOutbox: SentEmail[] = []

/** Every Stripe Checkout Session "created" during the current test file. */
export const stripeSessions: CreatedStripeSession[] = []

/**
 * Resend behaviour knobs.
 *
 * succeed=false simulates an outage. status picks which kind: 500 is a
 * transient failure the campaign sender will retry, 422 is a rejection of
 * that specific address which it must not retry. failFor narrows the outage
 * to particular recipients, so a test can have one bad address in an
 * otherwise healthy batch.
 */
export const emailBehavior: {
  succeed: boolean
  status: number
  failFor: string[] | null
} = { succeed: true, status: 500, failFor: null }

/**
 * Set succeed=false to simulate Stripe being down (createCheckoutSession
 * throws). sessionPaymentStatus is what a retrieved Checkout Session reports,
 * which is how the success page finds out a payment cleared when the webhook
 * never arrived.
 */
export const stripeBehavior: {
  succeed: boolean
  sessionPaymentStatus: 'paid' | 'unpaid' | 'no_payment_required'
} = { succeed: true, sessionPaymentStatus: 'paid' }

/**
 * Extra user_metadata for the stubbed Supabase user. Real accounts carry a
 * signup snapshot here — 202 of 205 production users have a full_name and a
 * few have a uscf_id — and that snapshot is never updated afterwards, so
 * tests need to be able to reproduce a stale one.
 */
export const authBehavior: { extraMetadata: Record<string, unknown> } = { extraMetadata: {} }

/**
 * The US Chess ratings API, keyed by USCF id.
 *
 * ratings is what /members/{id} returns verbatim, so a member unrated in a
 * system is an entry with no `rating` key — not a null, which is a real
 * distinction the snapshot code has to get right. reachable=false simulates
 * the outage case, where recording nothing is correct and recording a null
 * would be indistinguishable later from a genuine unrating.
 */
export const uscfBehavior: {
  reachable: boolean
  members: Record<string, { ratings: unknown[]; lastChangedDate?: string }>
} = { reachable: true, members: {} }

/**
 * Work an endpoint handed to context.waitUntil during the current test.
 *
 * The context used to discard these. They did not vanish — a floating
 * promise still runs — they just ran at a moment no test controlled, which
 * is how background sends end up interleaved with assertions. Collecting
 * them makes that work awaitable; see flushWaitUntil.
 */
const backgroundWork: Promise<unknown>[] = []

/**
 * Runs the background work scheduled so far, and anything it schedules in
 * turn. Call this after invoking an endpoint whose real behaviour continues
 * past the response.
 */
export async function flushWaitUntil(): Promise<void> {
  while (backgroundWork.length > 0) {
    await Promise.all(backgroundWork.splice(0))
  }
}

export function resetHarness(): void {
  backgroundWork.length = 0
  emailOutbox.length = 0
  stripeSessions.length = 0
  emailBehavior.succeed = true
  emailBehavior.status = 500
  emailBehavior.failFor = null
  stripeBehavior.succeed = true
  stripeBehavior.sessionPaymentStatus = 'paid'
  authBehavior.extraMetadata = {}
  uscfBehavior.reachable = true
  uscfBehavior.members = {}
}

// ── Fetch interceptor ────────────────────────────────────────────
// One interceptor, three services. Everything else about the code under
// test runs for real: supabase-js builds a real /auth/v1/user request,
// createCheckoutSession builds a real Stripe form body, sendEmail builds
// a real Resend JSON body. We answer at the network edge only.

let installed = false
let sessionCounter = 0

// ── Access tokens ────────────────────────────────────────────────
// requireAdmin reads the aal claim straight off the bearer token, so a bare
// member id is no longer enough to reach an admin route — the harness has to
// hand out something JWT-shaped. Only the payload segment is ever read (by
// readTokenAal in functions/utils/auth, and by the interceptor below);
// nothing verifies the signature, so the third segment is a placeholder.

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type Aal = 'aal1' | 'aal2'

/** Builds the access token for a member. aal2 unless a test says otherwise. */
export function accessToken(memberId: string, aal: Aal = 'aal2'): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ sub: memberId, aal, role: 'authenticated' }))
  return `${header}.${payload}.harness-not-a-signature`
}

/** The member id inside a harness token, or the token itself when it is a
 *  bare string — negative tests still pass things like "invalid-token". */
function memberIdFromToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return token
  try {
    const claims = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { sub?: string }
    return claims.sub ?? null
  } catch {
    return null
  }
}

export function installFetchInterceptor(): void {
  if (installed) return
  installed = true

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)

    // Supabase auth: the bearer token carries the member id in its sub
    // claim (see accessToken). Tokens prefixed "invalid" are still rejected,
    // for negative tests.
    if (url.origin === 'https://test-supabase.local') {
      if (url.pathname === '/auth/v1/user') {
        const auth = request.headers.get('Authorization') ?? ''
        const token = auth.replace(/^Bearer\s+/i, '')
        const memberId = token ? memberIdFromToken(token) : null
        if (!memberId || memberId.startsWith('invalid')) {
          return Response.json(
            { message: 'invalid token' },
            { status: 401 },
          )
        }
        return Response.json({
          id: memberId,
          aud: 'authenticated',
          role: 'authenticated',
          email: `${memberId}@test.lca`,
          user_metadata: { full_name: `Test User ${memberId}`, ...authBehavior.extraMetadata },
          app_metadata: {},
          created_at: '2026-01-01T00:00:00Z',
        })
      }
      return Response.json({ message: 'not implemented in harness' }, { status: 500 })
    }

    // US Chess ratings API.
    if (url.hostname === 'ratings-api.uschess.org') {
      if (!uscfBehavior.reachable) {
        return Response.json({ message: 'upstream down' }, { status: 503 })
      }
      const MEMBER_PREFIX = '/api/v1/members/'
      if (url.pathname.startsWith(MEMBER_PREFIX)) {
        const id = url.pathname.slice(MEMBER_PREFIX.length)
        const found = uscfBehavior.members[id]
        if (!found) return Response.json({ message: 'not found' }, { status: 404 })
        return Response.json({
          id,
          firstName: 'Test',
          lastName: 'Player',
          status: 'Active',
          ...found,
        })
      }
      return Response.json({ message: 'not stubbed' }, { status: 500 })
    }

    // Stripe: capture Checkout Session creation.
    if (url.hostname === 'api.stripe.com') {
      if (!stripeBehavior.succeed) {
        return Response.json(
          { error: { message: 'harness: simulated Stripe outage' } },
          { status: 500 },
        )
      }
      // Retrieving one session: GET /v1/checkout/sessions/{id}
      const PREFIX = '/v1/checkout/sessions/'
      if (request.method === 'GET' && url.pathname.startsWith(PREFIX)) {
        return Response.json({
          id: url.pathname.slice(PREFIX.length),
          payment_status: stripeBehavior.sessionPaymentStatus,
          payment_intent: 'pi_from_retrieve',
        })
      }

      if (url.pathname === '/v1/checkout/sessions' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text())
        const metadata: Record<string, string> = {}
        for (const [key, value] of form.entries()) {
          const m = key.match(/^metadata\[(.+)\]$/)
          if (m) metadata[m[1]] = value
        }
        const id = `cs_test_${++sessionCounter}`
        const session: CreatedStripeSession = {
          id,
          url: `https://checkout.stripe.test/${id}`,
          metadata,
          amountCents: Number(
            form.get('line_items[0][price_data][unit_amount]') ?? 0,
          ),
          productName:
            form.get('line_items[0][price_data][product_data][name]') ?? '',
          clientReferenceId: form.get('client_reference_id'),
          customerEmail: form.get('customer_email'),
        }
        stripeSessions.push(session)
        return Response.json({ id: session.id, url: session.url })
      }
      return Response.json({ error: { message: 'not implemented' } }, { status: 400 })
    }

    // Resend: capture the outbox.
    if (url.hostname === 'api.resend.com') {
      const body = (await request.json()) as {
        from: string
        // sendEmail sends an array; the campaign sender sends a bare string.
        to: string[] | string
        subject: string
        html: string
        text?: string
      }
      const recipient = Array.isArray(body.to) ? body.to[0] : body.to

      const targeted = emailBehavior.failFor === null
        || emailBehavior.failFor.includes(recipient)
      if (!emailBehavior.succeed && targeted) {
        return Response.json(
          { message: 'harness: simulated Resend outage' },
          { status: emailBehavior.status },
        )
      }
      emailOutbox.push({
        to: recipient,
        subject: body.subject,
        html: body.html,
        text: body.text,
        from: body.from,
      })
      return Response.json({ id: `email_${emailOutbox.length}` })
    }

    // Anything else (USCF lookups etc.): fail loudly so no test
    // silently depends on the live internet.
    return Promise.reject(
      new Error(`Unmocked external fetch in test: ${request.method} ${request.url}`),
    )
  }) as typeof fetch
}

// ── Handler invocation ───────────────────────────────────────────

type Handler = (context: EventContext<Env, string, unknown>) => Response | Promise<Response>

export interface InvokeOptions {
  method?: string
  /** URL params for [id]-style segments, e.g. { id: 't1' } */
  params?: Record<string, string>
  /** JSON body (objects) or raw string body */
  body?: unknown
  /** member id to act as; omit for anonymous */
  as?: string
  /**
   * Assurance level baked into the token. Defaults to aal2 because that is
   * what a real admin session carries — requireAdmin rejects anything less.
   * Pass aal1 to exercise that rejection.
   */
  aal?: Aal
  path?: string
  headers?: Record<string, string>
  /** raw body string overrides `body` — used for webhook signature tests */
  rawBody?: string
}

export async function invoke(
  handler: Handler,
  options: InvokeOptions = {},
): Promise<{
  status: number
  json: <T = Record<string, unknown>>() => Promise<T>
  response: Response
}> {
  const {
    method = 'GET',
    params = {},
    body,
    as,
    aal = 'aal2',
    path = '/api/test',
    headers = {},
    rawBody,
  } = options

  const requestHeaders = new Headers(headers)
  if (as) requestHeaders.set('Authorization', `Bearer ${accessToken(as, aal)}`)

  let requestBody: string | undefined
  if (rawBody !== undefined) {
    requestBody = rawBody
  } else if (body !== undefined) {
    requestBody = JSON.stringify(body)
    if (!requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json')
    }
  }

  const request = new Request(`https://lca-website.pages.dev${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
  })

  const context = {
    request,
    env: env as unknown as Env,
    params,
    data: {},
    functionPath: path,
    waitUntil: (work: Promise<unknown>) => { backgroundWork.push(work) },
    passThroughOnException: () => {},
    next: async () => new Response(null, { status: 404 }),
  } as unknown as EventContext<Env, string, unknown>

  const response = await handler(context)
  return {
    status: response.status,
    json: () => response.clone().json(),
    response,
  }
}

// ── Stripe webhook signing (REAL HMAC — exercises verifyStripeSignature) ──

/** Signs like Stripe does. The timestamp is injectable so a test can
 *  produce a stale-but-genuine signature — the replay case. */
export async function signStripePayload(
  payload: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode('whsec_test_harness_secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${payload}`),
  )
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${timestamp},v1=${hex}`
}