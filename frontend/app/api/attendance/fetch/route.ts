import { NextResponse } from "next/server"

import { fetchAttendanceResponse } from "@/lib/lms"

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      username?: string
      password?: string
    }

    if (!payload.username || !payload.password) {
      return NextResponse.json(
        { detail: "Username and password are required." },
        { status: 400 }
      )
    }

    const response = await fetchAttendanceResponse(payload.username, payload.password)
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
