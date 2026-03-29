import { NextResponse } from "next/server"

import { proxyJsonRequest } from "@/lib/backend"

export async function POST(request: Request) {
  try {
    const payload = await request.json()
    return await proxyJsonRequest("/api/planner/generate", payload)
  } catch (error) {
    console.error("Planner proxy failed", error)
    return NextResponse.json(
      { detail: "Unable to reach the pybunk backend." },
      { status: 502 }
    )
  }
}
