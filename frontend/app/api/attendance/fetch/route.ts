import { NextResponse } from "next/server"

import { fetchAttendanceResponse } from "@/lib/lms"

type CredentialPayload = {
  username?: string
  password?: string
}

function parseBasicAuthHeader(value: string | null): CredentialPayload | null {
  if (!value) {
    return null
  }

  const [scheme, token] = value.split(" ", 2)
  if (scheme?.toLowerCase() !== "basic" || !token) {
    return null
  }

  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8")
    const separatorIndex = decoded.indexOf(":")
    if (separatorIndex <= 0) {
      return null
    }

    const username = decoded.slice(0, separatorIndex).trim()
    const password = decoded.slice(separatorIndex + 1)
    if (!username || !password) {
      return null
    }

    return { username, password }
  } catch {
    return null
  }
}

function resolveCredentials(request: Request, payload: CredentialPayload): CredentialPayload {
  const authCredentials = parseBasicAuthHeader(request.headers.get("authorization"))
  if (authCredentials) {
    return authCredentials
  }

  const headerUsername = request.headers.get("x-pybunk-username")?.trim()
  const headerPassword = request.headers.get("x-pybunk-password")
  if (headerUsername && headerPassword) {
    return { username: headerUsername, password: headerPassword }
  }

  const bodyUsername = payload.username?.trim()
  const bodyPassword = payload.password
  return { username: bodyUsername, password: bodyPassword }
}

export async function POST(request: Request) {
  try {
    let payload: CredentialPayload = {}
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      const parsed = (await request.json().catch(() => null)) as CredentialPayload | null
      if (parsed && typeof parsed === "object") {
        payload = parsed
      }
    }

    const credentials = resolveCredentials(request, payload)

    if (!credentials.username || !credentials.password) {
      return NextResponse.json(
        {
          detail:
            "Username and password are required in JSON body, Authorization header, or x-pybunk-* headers.",
        },
        { status: 400 }
      )
    }

    const response = await fetchAttendanceResponse(
      credentials.username,
      credentials.password
    )
    return NextResponse.json(response)
  } catch (error) {
    console.error("Attendance route failed", error)
    return NextResponse.json(
      {
        detail:
          error instanceof Error
            ? error.message
            : "Attendance fetch failed. Check credentials or LMS availability.",
      },
      { status: 400 }
    )
  }
}
