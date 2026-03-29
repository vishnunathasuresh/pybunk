import "server-only"

import { load } from "cheerio"

import type { AttendanceFetchResponse, AttendanceRow, CourseCatalogRecord, NotMarkedRow } from "@/lib/types"

const BASE_URL = "https://lmsug24.iiitkottayam.ac.in"
const REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_MAX_DL = 8
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
const AJAX_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/javascript, */*; q=0.01",
}

type RawAttendanceRow = {
  period_date: string | null
  session_time: string
  course_code: string
  subject_name: string
  faculty: string
  faculty_email: string
  course: string
  score: string | null
}

class LmsClient {
  private readonly cookies = new Map<string, string>()
  private readonly profileEmailCache = new Map<number, string>()

  private applyCookies(headers: Headers) {
    if (!this.cookies.size) {
      return
    }

    headers.set(
      "Cookie",
      [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
    )
  }

  private storeCookies(response: Response) {
    const getSetCookie = (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie
    const cookies = getSetCookie ? getSetCookie.call(response.headers) : []

    for (const cookie of cookies) {
      const [pair] = cookie.split(";", 1)
      const equalsIndex = pair.indexOf("=")
      if (equalsIndex <= 0) {
        continue
      }

      const name = pair.slice(0, equalsIndex).trim()
      const value = pair.slice(equalsIndex + 1).trim()
      if (name) {
        this.cookies.set(name, value)
      }
    }
  }

  private async request(url: string, init: RequestInit = {}, context: string) {
    const headers = new Headers(DEFAULT_HEADERS)
    for (const [key, value] of new Headers(init.headers).entries()) {
      headers.set(key, value)
    }
    this.applyCookies(headers)

    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    this.storeCookies(response)

    if (!response.ok) {
      throw new Error(`${context} failed with ${response.status}`)
    }

    return response
  }

  async getLoginToken() {
    const response = await this.request(`${BASE_URL}/login/index.php`, {}, "Fetching login page")
    const html = await response.text()
    const $ = load(html)
    const token = $('input[name="logintoken"]').attr("value")

    if (!token) {
      throw new Error("Login token not found on LMS login page.")
    }

    return token
  }

  async login(username: string, password: string) {
    const token = await this.getLoginToken()
    const body = new URLSearchParams({
      anchor: "",
      logintoken: token,
      username,
      password,
    })

    const response = await this.request(
      `${BASE_URL}/login/index.php`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      "Logging in"
    )

    if (!response.url.includes("/my/") && !response.url.includes("dashboard")) {
      throw new Error("LMS login failed. Check your roll number and password.")
    }
  }

  async getSesskey() {
    const response = await this.request(`${BASE_URL}/my/`, {}, "Loading LMS dashboard")
    const html = await response.text()

    for (const pattern of [
      /"sesskey":"([^"]+)"/,
      /"sesskey"\s*:\s*"([^"]+)"/,
      /M\.cfg\.sesskey\s*=\s*'([^']+)'/,
      /"wwwroot":"[^"]+","sesskey":"([^"]+)"/,
      /name="sesskey"\s+value="([^"]+)"/,
    ]) {
      const match = html.match(pattern)
      if (match) {
        return match[1]
      }
    }

    throw new Error("Sesskey not found in LMS dashboard HTML.")
  }

  async getCourses(sesskey: string) {
    const response = await this.request(
      `${BASE_URL}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_course_get_enrolled_courses_by_timeline_classification`,
      {
        method: "POST",
        headers: AJAX_HEADERS,
        body: JSON.stringify([
          {
            index: 0,
            methodname: "core_course_get_enrolled_courses_by_timeline_classification",
            args: {
              offset: 0,
              limit: 0,
              classification: "inprogress",
              sort: "fullname",
            },
          },
        ]),
      },
      "Fetching enrolled courses"
    )

    const data = (await response.json()) as Array<{ error?: unknown; data?: { courses?: unknown } }>
    const courses = data[0]?.data?.courses
    if (!Array.isArray(courses)) {
      throw new Error("LMS courses response was invalid.")
    }

    return courses as Array<{ id: number | string; fullname?: string; shortname?: string }>
  }

  async getAttendanceModule(courseId: number | string) {
    const response = await this.request(
      `${BASE_URL}/course/view.php?id=${courseId}`,
      {},
      `Loading course page for ${courseId}`
    )
    const html = await response.text()
    const $ = load(html)

    for (const element of $("a[href]").toArray()) {
      const href = new URL($(element).attr("href") || "", BASE_URL).toString()
      if (!href.includes("/mod/attendance/view.php")) {
        continue
      }

      const moduleId = new URL(href).searchParams.get("id")
      if (moduleId) {
        return moduleId
      }
    }

    return null
  }

  private extractUserId(profileUrl: string) {
    const id = new URL(profileUrl).searchParams.get("id")
    return id && /^\d+$/.test(id) ? Number(id) : null
  }

  private cleanParticipantName(value: string) {
    const cleaned = normalizeWhitespace(value).replace(/^Select '(.+)'$/, "$1")
    return normalizeWhitespace(cleaned.replace(/^[A-Z0-9.-]+\s+(?=[A-Za-z])/, ""))
  }

  async getFacultyEmail(profileUrl: string) {
    const userId = this.extractUserId(profileUrl)
    if (!userId) {
      return ""
    }
    if (this.profileEmailCache.has(userId)) {
      return this.profileEmailCache.get(userId) || ""
    }

    const response = await this.request(profileUrl, {}, `Loading faculty profile ${profileUrl}`)
    const html = await response.text()
    const $ = load(html)

    let email = ""
    $("dt").each((_, element) => {
      const label = normalizeWhitespace($(element).text()).toLowerCase()
      if (!label.includes("email address")) {
        return
      }

      const value = $(element).next("dd")
      const mailto = value.find('a[href^="mailto:"]').attr("href")
      email = mailto ? decodeURIComponent(mailto.replace(/^mailto:/, "").trim()) : normalizeWhitespace(value.text())
    })

    this.profileEmailCache.set(userId, email)
    return email
  }

  async getCourseFaculty(courseId: number | string) {
    const response = await this.request(
      `${BASE_URL}/user/index.php?id=${courseId}&perpage=5000`,
      {},
      `Loading participants page for ${courseId}`
    )
    const html = await response.text()
    const $ = load(html)
    const teacherRoles = new Set(["Teacher", "Non-editing teacher"])

    const resolvedEntries: Array<{ name: string; email: string; preferred: boolean }> = []
    for (const row of $("tr").toArray()) {
      const cells = $(row).find("td").toArray().map((cell) => normalizeWhitespace($(cell).text()))
      if (cells.length < 4) {
        continue
      }
      const participantName = cells[0]
      const roleName = cells[1]
      if (!teacherRoles.has(roleName) || !participantName) {
        continue
      }
      const cleanedName = this.cleanParticipantName(participantName)
      if (!cleanedName) {
        continue
      }
      const href = $(row).find('a[href]').first().attr("href")
      const profileUrl = href ? new URL(href, BASE_URL).toString() : ""
      resolvedEntries.push({
        name: cleanedName,
        email: profileUrl ? await this.getFacultyEmail(profileUrl) : "",
        preferred: !/\d/.test(participantName),
      })
    }

    if (!resolvedEntries.length) {
      return { faculty: "Unknown Faculty", faculty_email: "" }
    }

    const unique = new Map<string, { name: string; email: string; preferred: boolean }>()
    for (const entry of resolvedEntries) {
      unique.set(`${entry.name}:::${entry.email}`, entry)
    }

    const deduped = [...unique.values()]
    const preferred = deduped.filter((entry) => entry.preferred)
    const chosen = preferred.length ? preferred : deduped

    return {
      faculty: chosen.map((entry) => entry.name).join(", "),
      faculty_email: chosen.map((entry) => entry.email).filter(Boolean).join(", "),
    }
  }

  async getAttendance(moduleId: number | string) {
    const response = await this.request(
      `${BASE_URL}/mod/attendance/view.php?id=${moduleId}&view=5`,
      {},
      `Loading attendance report for ${moduleId}`
    )
    const html = await response.text()
    const $ = load(html)

    let table = $("table").first()
    $("table").each((_, element) => {
      const headers = $(element)
        .find("th,td")
        .toArray()
        .map((cell) => normalizeWhitespace($(cell).text()).toLowerCase())
      if (headers.some((header) => header.includes("date")) && headers.some((header) => header.includes("status"))) {
        table = $(element)
        return false
      }
    })

    const records: Array<{ period_date: string | null; session_time: string; score: string | null }> = []
    table.find("tr").slice(1).each((_, row) => {
      const values = $(row)
        .find("td")
        .toArray()
        .map((cell) => normalizeWhitespace($(cell).text()))
      if (values.length < 3) {
        return
      }

      const periodText = values[0]
      const status = values.length === 3 ? values[2] : values[3]
      const split = splitPeriodDatetime(periodText)
      records.push({
        period_date: split.period_date,
        session_time: split.session_time,
        score: extractScore(status),
      })
    })

    return records
  }
}

function normalizeWhitespace(value: string | null | undefined) {
  return (value || "").replace(/\s+/g, " ").trim()
}

function splitCourseName(value: string) {
  const normalized = normalizeWhitespace(value)
  const firstSpace = normalized.indexOf(" ")
  return {
    course_code: firstSpace === -1 ? normalized : normalized.slice(0, firstSpace),
    subject_name: firstSpace === -1 ? "" : normalized.slice(firstSpace + 1),
  }
}

function splitPeriodDatetime(value: string) {
  const match = value.match(
    /^(.+?\d{4})\s+(\d{1,2}(?::\d{2})?[AP]M\s*-\s*\d{1,2}(?::\d{2})?[AP]M)$/i
  )
  if (!match) {
    return { period_date: null, session_time: "" }
  }

  const dateText = match[1]
  const sessionTime = normalizeWhitespace(match[2]).toUpperCase()
  const parsed = new Date(`${dateText} UTC`)
  if (Number.isNaN(parsed.getTime())) {
    return { period_date: null, session_time: sessionTime }
  }

  return {
    period_date: parsed.toISOString().slice(0, 10),
    session_time: sessionTime,
  }
}

function extractScore(statusText: string) {
  const match = statusText.match(/(\?|\d+)\s*\/\s*(\d+)/)
  return match ? `${match[1]}/${match[2]}` : null
}

function buildCourseCatalog(attendanceRows: AttendanceRow[]): CourseCatalogRecord[] {
  const seen = new Set<string>()
  const catalog: CourseCatalogRecord[] = []

  for (const row of attendanceRows) {
    const courseCode = normalizeWhitespace(row.course_code)
    if (!courseCode || seen.has(courseCode)) {
      continue
    }
    seen.add(courseCode)
    catalog.push({
      course_code: courseCode,
      subject_name: normalizeWhitespace(row.subject_name) || null,
      faculty: normalizeWhitespace(row.faculty) || null,
      faculty_email: normalizeWhitespace(row.faculty_email) || null,
      course: normalizeWhitespace(row.course) || null,
    })
  }

  return catalog.sort((left, right) => (left.course_code || "").localeCompare(right.course_code || ""))
}

export async function fetchAttendanceResponse(username: string, password: string): Promise<AttendanceFetchResponse> {
  const client = new LmsClient()
  await client.login(username, password)
  const sesskey = await client.getSesskey()
  const courses = await client.getCourses(sesskey)

  const rows: RawAttendanceRow[] = []
  for (const course of courses) {
    const courseId = course.id
    const courseName = normalizeWhitespace(course.fullname || course.shortname || String(courseId))
    const { course_code, subject_name } = splitCourseName(courseName)
    const moduleId = await client.getAttendanceModule(courseId)
    if (!moduleId) {
      continue
    }

    const faculty = await client.getCourseFaculty(courseId)
    const attendance = await client.getAttendance(moduleId)
    for (const record of attendance) {
      rows.push({
        period_date: record.period_date,
        session_time: record.session_time,
        course_code,
        subject_name,
        faculty: faculty.faculty,
        faculty_email: faculty.faculty_email,
        course: courseName,
        score: record.score,
      })
    }
  }

  const attendanceRows: AttendanceRow[] = rows.map((row, index) => ({
    record_id: `rec_${index + 1}`,
    period_date: row.period_date,
    session_time: row.session_time || null,
    course_code: row.course_code || null,
    subject_name: row.subject_name || null,
    faculty: row.faculty || null,
    faculty_email: row.faculty_email || null,
    course: row.course || null,
    score: row.score,
  }))

  const courseCatalog = buildCourseCatalog(attendanceRows)
  const notMarkedRows: NotMarkedRow[] = attendanceRows
    .filter((row) => row.score === "?/1")
    .map((row) => ({
      ...row,
      date: row.period_date ? isoToDisplayDate(row.period_date) : null,
    }))

  return {
    dataset_id: crypto.randomUUID(),
    dataset_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    summary: {
      attendance_rows: attendanceRows.length,
      course_count: new Set(courseCatalog.map((course) => course.course_code)).size,
      leave_rows: attendanceRows.filter((row) => row.score === "0/1").length,
      not_marked_rows: notMarkedRows.length,
    },
    attendance_rows: attendanceRows,
    course_catalog: courseCatalog,
    default_course_limits: courseCatalog
      .filter((course) => course.course_code)
      .map((course) => ({
        course_code: course.course_code as string,
        subject_name: course.subject_name,
        max_dl: DEFAULT_MAX_DL,
      })),
    not_marked_rows: notMarkedRows,
  }
}

function isoToDisplayDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value
}
