import { NextResponse } from "next/server"

import { readBunkxSession } from "@/lib/bunkx-session-store"

type Context = {
  params: Promise<{ sid: string }>
}

export async function GET(_request: Request, context: Context) {
  const { sid } = await context.params

  const normalizedSid = sid.trim()
  if (!normalizedSid) {
    return NextResponse.json({ detail: "Session not found." }, { status: 404 })
  }

  const result = readBunkxSession(normalizedSid)
  if (result.status === "missing") {
    return NextResponse.json({ detail: "Session not found." }, { status: 404 })
  }

  if (result.status === "expired") {
    return NextResponse.json({ detail: "Session expired." }, { status: 410 })
  }

  return NextResponse.json({
    sid: result.session.sid,
    expiresAt: result.session.expiresAt,
    bunkdata: result.session.bunkdata,
  })
}
