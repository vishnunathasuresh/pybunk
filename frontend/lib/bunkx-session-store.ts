import "server-only"

type SessionRecord = {
  sid: string
  bunkdata: string
  expiresAtMs: number
}

const DEFAULT_TTL_SECONDS = 15 * 60
const MIN_TTL_SECONDS = 30
const MAX_TTL_SECONDS = 24 * 60 * 60

const SESSION_STORE = new Map<string, SessionRecord>()

function clampTtlSeconds(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return DEFAULT_TTL_SECONDS
  }

  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.trunc(value as number)))
}

function generateSid() {
  return crypto.randomUUID().replace(/-/g, "")
}

function cleanupExpiredSessions(nowMs: number) {
  for (const [sid, session] of SESSION_STORE.entries()) {
    if (session.expiresAtMs <= nowMs) {
      SESSION_STORE.delete(sid)
    }
  }
}

export function createBunkxSession(input: { bunkdata: string; ttlSeconds?: number }) {
  const nowMs = Date.now()
  cleanupExpiredSessions(nowMs)

  const ttlSeconds = clampTtlSeconds(input.ttlSeconds)
  const expiresAtMs = nowMs + ttlSeconds * 1000

  let sid = generateSid()
  while (SESSION_STORE.has(sid)) {
    sid = generateSid()
  }

  SESSION_STORE.set(sid, {
    sid,
    bunkdata: input.bunkdata,
    expiresAtMs,
  })

  return {
    sid,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
}

export function readBunkxSession(sid: string):
  | { status: "ok"; session: { sid: string; bunkdata: string; expiresAt: string } }
  | { status: "missing" }
  | { status: "expired" } {
  const session = SESSION_STORE.get(sid)
  if (!session) {
    return { status: "missing" }
  }

  if (session.expiresAtMs <= Date.now()) {
    SESSION_STORE.delete(sid)
    return { status: "expired" }
  }

  return {
    status: "ok",
    session: {
      sid: session.sid,
      bunkdata: session.bunkdata,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    },
  }
}
