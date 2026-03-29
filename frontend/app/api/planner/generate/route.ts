import { NextResponse } from "next/server"

import { generatePlannerResponse } from "@/lib/planner"
import type { PlannerGenerateRequest } from "@/lib/types"

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as PlannerGenerateRequest
    const response = generatePlannerResponse(payload)
    return NextResponse.json(response)
  } catch (error) {
    console.error("Planner route failed", error)
    return NextResponse.json(
      {
        detail:
          error instanceof Error
            ? error.message
            : "Unable to generate the planner response.",
      },
      { status: 400 }
    )
  }
}
