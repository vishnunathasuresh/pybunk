import type {
  AttendanceRow,
  CourseLimitInput,
  ManualBunkInput,
  PlannerCourseCount,
  PlannerGenerateRequest,
  PlannerGenerateResponse,
  PlannerRow,
} from "@/lib/types"

type CourseCatalogEntry = {
  course_code: string
  subject_name: string
  faculty: string
  faculty_email: string
  course: string
}

type PlannerCandidate = {
  period_date: string
  session_time: string
  course_code: string
  subject_name: string
  faculty: string
  faculty_email: string
  course: string
  score: string
  source: "lms" | "manual" | "not_marked"
  session_start: number | null
  course_limit: number
  matched_event_date: string | null
  days_before_event: number | null
}

const MANUAL_SESSION_LABEL = "MANUAL BUNK"

function normalizeWhitespace(value: string | null | undefined) {
  return (value || "").split(/\s+/).filter(Boolean).join(" ").trim()
}

function formatSessionTimeText(value: string | null | undefined) {
  return normalizeWhitespace(value).toUpperCase()
}

function isoToDisplayDate(value: string | null | undefined) {
  if (!value) {
    return ""
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return value
  }

  return `${match[3]}-${match[2]}-${match[1]}`
}

function parseIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return null
  }

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function daysBetween(eventDate: string, candidateDate: string) {
  const eventTime = parseIsoDate(eventDate)
  const candidateTime = parseIsoDate(candidateDate)
  if (eventTime === null || candidateTime === null) {
    return null
  }

  return Math.round((eventTime - candidateTime) / 86_400_000)
}

function extractSessionStart(sessionTime: string | null | undefined) {
  const text = normalizeWhitespace(sessionTime).split("-", 1)[0]?.toUpperCase() || ""
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(text)
  if (!match) {
    return null
  }

  let hours = Number(match[1]) % 12
  const minutes = Number(match[2] || "0")
  if (match[3] === "PM") {
    hours += 12
  }

  return hours * 60 + minutes
}

function buildCourseCatalog(attendanceRows: AttendanceRow[]) {
  const seen = new Set<string>()
  const catalog: CourseCatalogEntry[] = []

  for (const row of attendanceRows) {
    const courseCode = normalizeWhitespace(row.course_code)
    if (!courseCode || seen.has(courseCode)) {
      continue
    }

    seen.add(courseCode)
    catalog.push({
      course_code: courseCode,
      subject_name: normalizeWhitespace(row.subject_name),
      faculty: normalizeWhitespace(row.faculty),
      faculty_email: normalizeWhitespace(row.faculty_email),
      course: normalizeWhitespace(row.course),
    })
  }

  return catalog.sort((left, right) => left.course_code.localeCompare(right.course_code))
}

function buildManualCandidates(
  manualEntries: ManualBunkInput[],
  catalogByCourse: Map<string, CourseCatalogEntry>
) {
  return manualEntries
    .map((entry) => {
      const courseCode = normalizeWhitespace(entry.course_code)
      const periodDate = normalizeWhitespace(entry.date)
      if (!courseCode || !periodDate) {
        return null
      }

      const course = catalogByCourse.get(courseCode)
      const sessionTime = normalizeWhitespace(entry.session_time) || MANUAL_SESSION_LABEL

      return {
        period_date: periodDate,
        session_time: sessionTime,
        course_code: courseCode,
        subject_name: course?.subject_name || "",
        faculty: course?.faculty || "",
        faculty_email: course?.faculty_email || "",
        course: course?.course || "",
        score: "manual",
        source: "manual" as const,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
}

function buildNotMarkedCandidates(
  attendanceRows: AttendanceRow[],
  selectedRecordIds: string[]
) {
  const selected = new Set(selectedRecordIds)

  return attendanceRows
    .filter((row) => selected.has(row.record_id))
    .map((row) => ({
      period_date: normalizeWhitespace(row.period_date),
      session_time: normalizeWhitespace(row.session_time),
      course_code: normalizeWhitespace(row.course_code),
      subject_name: normalizeWhitespace(row.subject_name),
      faculty: normalizeWhitespace(row.faculty),
      faculty_email: normalizeWhitespace(row.faculty_email),
      course: normalizeWhitespace(row.course),
      score: "not_marked",
      source: "not_marked" as const,
    }))
    .filter((row) => row.period_date)
}

function compareNullableNumbers(left: number | null, right: number | null) {
  if (left === right) {
    return 0
  }
  if (left === null) {
    return 1
  }
  if (right === null) {
    return -1
  }
  return left - right
}

function compareNullableStrings(left: string | null, right: string | null) {
  if (left === right) {
    return 0
  }
  if (!left) {
    return 1
  }
  if (!right) {
    return -1
  }
  return left.localeCompare(right)
}

function compareCandidates(left: PlannerCandidate, right: PlannerCandidate) {
  return (
    left.period_date.localeCompare(right.period_date) ||
    compareNullableNumbers(left.session_start, right.session_start) ||
    left.course_code.localeCompare(right.course_code) ||
    left.subject_name.localeCompare(right.subject_name) ||
    left.source.localeCompare(right.source)
  )
}

function buildCourseCounts(selected: PlannerCandidate[]) {
  const counts = new Map<string, PlannerCourseCount>()

  for (const row of selected) {
    const key = `${row.course_code}:::${row.subject_name}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      continue
    }

    counts.set(key, {
      course_code: row.course_code || null,
      subject_name: row.subject_name || null,
      count: 1,
    })
  }

  return [...counts.values()].sort((left, right) => {
    return (
      compareNullableStrings(left.course_code, right.course_code) ||
      compareNullableStrings(left.subject_name, right.subject_name)
    )
  })
}

function buildPlannerRows(selected: PlannerCandidate[]): PlannerRow[] {
  return selected.map((row) => ({
    date: isoToDisplayDate(row.period_date),
    session_time: row.session_time || null,
    course: normalizeWhitespace(`${row.course_code} ${row.subject_name}`) || null,
    faculty: row.faculty || null,
    faculty_email: row.faculty_email || null,
    source: row.source,
    matched_event_date: row.matched_event_date
      ? isoToDisplayDate(row.matched_event_date)
      : "",
    days_before_event: row.days_before_event ?? "",
  }))
}

function formatDaywiseText(selected: PlannerCandidate[], courseCounts: PlannerCourseCount[]) {
  if (!selected.length) {
    return ""
  }

  const lines: string[] = []
  let currentDate = ""

  for (const row of selected) {
    const dateText = isoToDisplayDate(row.period_date)
    if (dateText !== currentDate) {
      if (currentDate) {
        lines.push("----")
      }
      currentDate = dateText
      lines.push(currentDate)
    }

    lines.push(
      `${formatSessionTimeText(row.session_time)} : ${row.course_code} : ${row.subject_name} : ${row.faculty} : ${row.faculty_email}`
    )
  }

  lines.push("----")
  lines.push("DL Count By Course")
  for (const count of courseCounts) {
    lines.push(`${count.course_code} : ${count.subject_name} : ${count.count}`)
  }

  return `${lines.join("\n")}\n`
}

export function generatePlannerResponse(
  request: PlannerGenerateRequest
): PlannerGenerateResponse {
  const attendanceRows = request.attendance_rows || []
  if (!attendanceRows.length) {
    throw new Error("attendance_rows are required for the standalone planner route.")
  }

  const catalog = buildCourseCatalog(attendanceRows)
  const catalogByCourse = new Map(
    catalog.map((entry) => [entry.course_code, entry] as const)
  )

  const lmsCandidates = attendanceRows
    .filter((row) => row.score === "0/1")
    .map((row) => ({
      period_date: normalizeWhitespace(row.period_date),
      session_time: normalizeWhitespace(row.session_time),
      course_code: normalizeWhitespace(row.course_code),
      subject_name: normalizeWhitespace(row.subject_name),
      faculty: normalizeWhitespace(row.faculty),
      faculty_email: normalizeWhitespace(row.faculty_email),
      course: normalizeWhitespace(row.course),
      score: normalizeWhitespace(row.score),
      source: "lms" as const,
    }))
    .filter((row) => row.period_date)

  const manualCandidates = buildManualCandidates(
    request.manual_entries || [],
    catalogByCourse
  )
  const notMarkedCandidates = buildNotMarkedCandidates(
    attendanceRows,
    request.not_marked_record_ids || []
  )

  const courseLimits = new Map(
    (request.course_limits || []).map((item: CourseLimitInput) => [
      item.course_code,
      Number(item.max_dl || 0),
    ])
  )

  let combined: PlannerCandidate[] = [
    ...lmsCandidates,
    ...manualCandidates,
    ...notMarkedCandidates,
  ]
    .filter((row) => row.period_date)
    .map((row) => ({
      ...row,
      session_start: extractSessionStart(row.session_time),
      course_limit: courseLimits.get(row.course_code) ?? 0,
      matched_event_date: null,
      days_before_event: null,
    }))
    .filter((row) => row.course_limit > 0)

  if (request.cutoff_date) {
    combined = combined.filter((row) => row.period_date <= request.cutoff_date!)
  }

  if (request.event_dates.length) {
    const matchedCandidates = combined
      .map((row): (PlannerCandidate & { matched_event_date: string; days_before_event: number }) | null => {
        const matches = request.event_dates
          .map((eventDate) => {
            const daysBefore = daysBetween(eventDate, row.period_date)
            if (daysBefore === null || daysBefore < 0 || daysBefore > request.lookback_days) {
              return null
            }

            return {
              eventDate,
              daysBefore,
            }
          })
          .filter(
            (match): match is { eventDate: string; daysBefore: number } => Boolean(match)
          )
          .sort((left, right) => {
            return left.daysBefore - right.daysBefore || left.eventDate.localeCompare(right.eventDate)
          })

        if (!matches.length) {
          return null
        }

        return {
          ...row,
          matched_event_date: matches[0].eventDate,
          days_before_event: matches[0].daysBefore,
        }
      })
      .filter(
        (
          row
        ): row is PlannerCandidate & {
          matched_event_date: string
          days_before_event: number
        } => row !== null
      )
      .sort((left, right) => {
        return (
          left.course_code.localeCompare(right.course_code) ||
          (left.days_before_event ?? 99) - (right.days_before_event ?? 99) ||
          compareNullableStrings(left.matched_event_date, right.matched_event_date) ||
          left.period_date.localeCompare(right.period_date) ||
          compareNullableNumbers(left.session_start, right.session_start) ||
          left.source.localeCompare(right.source) ||
          left.subject_name.localeCompare(right.subject_name)
        )
      })

    combined = matchedCandidates
  } else {
    combined = combined.sort((left, right) => {
      return (
        left.course_code.localeCompare(right.course_code) ||
        left.period_date.localeCompare(right.period_date) ||
        compareNullableNumbers(left.session_start, right.session_start) ||
        left.source.localeCompare(right.source) ||
        left.subject_name.localeCompare(right.subject_name)
      )
    })
  }

  const selected: PlannerCandidate[] = []
  const takenByCourse = new Map<string, number>()
  for (const row of combined) {
    const taken = takenByCourse.get(row.course_code) ?? 0
    if (taken >= row.course_limit) {
      continue
    }
    takenByCourse.set(row.course_code, taken + 1)
    selected.push(row)
  }

  selected.sort(compareCandidates)

  const plannerRows = buildPlannerRows(selected)
  const courseCounts = buildCourseCounts(selected)
  const plannerText = formatDaywiseText(selected, courseCounts)
  const plannerCsv = plannerRows.length
    ? [
        [
          "date",
          "session_time",
          "course",
          "faculty",
          "faculty_email",
          "source",
          "matched_event_date",
          "days_before_event",
        ].join(","),
        ...plannerRows.map((row) =>
          [
            row.date ?? "",
            row.session_time ?? "",
            row.course ?? "",
            row.faculty ?? "",
            row.faculty_email ?? "",
            row.source ?? "",
            row.matched_event_date ?? "",
            row.days_before_event ?? "",
          ]
            .map((value) => `"${String(value).replaceAll('"', '""')}"`)
            .join(",")
        ),
      ].join("\n")
    : ""

  return {
    summary: {
      recommended_rows: selected.length,
      courses_covered: new Set(selected.map((row) => row.course_code)).size,
      manual_or_not_marked_used: selected.filter((row) =>
        ["manual", "not_marked"].includes(row.source)
      ).length,
    },
    planner_rows: plannerRows,
    course_counts: courseCounts,
    planner_text: plannerText,
    planner_csv: plannerCsv,
  }
}
