import { NextResponse } from "next/server"

import { createBunkxSession } from "@/lib/bunkx-session-store"

type CreateSessionBody = {
  bunkdata?: string
  payload?: unknown
  ttlSeconds?: number
}

function toBase64UrlJson(payload: unknown) {
  const json = JSON.stringify(payload)
  const utf8 = Buffer.from(json, "utf-8")
  return utf8
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function resolveBunkdata(body: CreateSessionBody | null) {
  if (!body || typeof body !== "object") {
    return null
  }

  if (typeof body.bunkdata === "string" && body.bunkdata.trim()) {
    return body.bunkdata.trim()
  }

  if (body.payload && typeof body.payload === "object") {
    return toBase64UrlJson(body.payload)
  }

  if (
    (body as Record<string, unknown>).attendance_rows ||
    (body as Record<string, unknown>).ar
  ) {
    return toBase64UrlJson(body)
  }

  return null
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as CreateSessionBody | null
    const bunkdata = resolveBunkdata(body)

    if (!bunkdata) {
      return NextResponse.json(
        {
          detail:
            "Provide bunkdata as a base64 string, payload as JSON object, or attendance payload fields in request body.",
        },
        { status: 400 }
      )
    }

    const ttlSeconds = typeof body?.ttlSeconds === "number" ? body.ttlSeconds : undefined
    const session = createBunkxSession({ bunkdata, ttlSeconds })

    const origin = new URL(request.url).origin
    return NextResponse.json({
      sid: session.sid,
      expiresAt: session.expiresAt,
      launchUrl: `${origin}/bunkialo?sid=${session.sid}`,
    })
  } catch (error) {
    console.error("Failed to create bunkx session", error)
    return NextResponse.json({ detail: "Failed to create session." }, { status: 500 })
  }
}
