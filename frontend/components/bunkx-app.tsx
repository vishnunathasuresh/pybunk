"use client"

import { useDeferredValue, useEffect, useState } from "react"
import { format, isValid, parseISO } from "date-fns"
import {
  AlertCircle,
  CalendarIcon,
  Check,
  Clipboard,
  Copy,
  Download,
  GraduationCap,
  LogOut,
  Plus,
  RefreshCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  ApiErrorResponse,
  AttendanceRow,
  AttendanceFetchResponse,
  CourseLimitInput,
  PlannerGenerateRequest,
  PlannerGenerateResponse,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "bunkx-session-v1"
const ROLL_NUMBER_PATTERN = /^\d{4}(BCS|BCD|BCY|ECE)\d{4}$/

type ManualEntryDraft = {
  id: string
  date: string
  course_code: string
  session_time: string
}

type PersistedState = {
  fetchData: AttendanceFetchResponse | null
  plannerResult: PlannerGenerateResponse | null
  eventDates: string[]
  manualEntries: ManualEntryDraft[]
  selectedNotMarkedIds: string[]
  courseLimits: CourseLimitInput[]
  cutoffDate: string
  lookbackDays: number
  defaultMaxDl: number
}

function todayIso() {
  const now = new Date()
  const offset = now.getTimezoneOffset()
  const local = new Date(now.getTime() - offset * 60_000)
  return local.toISOString().slice(0, 10)
}

function parseJsonDate(value: string | null | undefined) {
  if (!value) {
    return undefined
  }

  const parsed = parseISO(value)
  return isValid(parsed) ? parsed : undefined
}

function displayDate(value: string | null | undefined) {
  const parsed = parseJsonDate(value)
  return parsed ? format(parsed, "dd MMM yyyy") : "No date"
}

function displayDateTime(value: string | null | undefined) {
  if (!value) {
    return "Session cache active"
  }

  const parsed = parseJsonDate(value)
  return parsed ? format(parsed, "dd MMM yyyy, hh:mm a") : value
}

function uniqueSortedDates(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  )
}

function isValidRollNumber(value: string) {
  return ROLL_NUMBER_PATTERN.test(value)
}

function makeManualEntry() {
  return {
    id: `manual-${Math.random().toString(36).slice(2, 10)}`,
    date: "",
    course_code: "",
    session_time: "",
  }
}

function mergeCourseLimits(
  defaults: AttendanceFetchResponse["default_course_limits"],
  existing: CourseLimitInput[]
) {
  return defaults.map((course) => {
    const prior = existing.find((item) => item.course_code === course.course_code)
    return {
      course_code: course.course_code,
      max_dl: prior?.max_dl ?? course.max_dl,
    }
  })
}

function toOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeBunkRows(value: unknown): AttendanceRow[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((row, index) => {
      if (!row || typeof row !== "object") {
        return null
      }

      const source = row as Record<string, unknown>
      const courseCode = toOptionalString(source.course_code)
      const subjectName = toOptionalString(source.subject_name)
      const mergedCourse = [courseCode, subjectName].filter(Boolean).join(" ").trim()

      return {
        record_id: toOptionalString(source.record_id) || `rec_${index + 1}`,
        period_date: toOptionalString(source.period_date),
        session_time: toOptionalString(source.session_time),
        course_code: courseCode,
        subject_name: subjectName,
        faculty: toOptionalString(source.faculty),
        faculty_email: toOptionalString(source.faculty_email),
        course: toOptionalString(source.course) || (mergedCourse || null),
        score: toOptionalString(source.score),
      }
    })
    .filter((row): row is AttendanceRow => Boolean(row))
}

function deriveCourseCatalog(rows: AttendanceRow[]) {
  const byKey = new Map<string, AttendanceFetchResponse["course_catalog"][number]>()

  for (const row of rows) {
    const key = [row.course_code ?? "", row.subject_name ?? "", row.faculty_email ?? ""].join("::")
    if (!key.replace(/:/g, "")) {
      continue
    }

    if (!byKey.has(key)) {
      byKey.set(key, {
        course_code: row.course_code,
        subject_name: row.subject_name,
        faculty: row.faculty,
        faculty_email: row.faculty_email,
        course: row.course,
      })
    }
  }

  return [...byKey.values()].sort((left, right) =>
    (left.course_code ?? "").localeCompare(right.course_code ?? "")
  )
}

function buildFetchDataFromBunkData(value: unknown): AttendanceFetchResponse | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const payload = value as Record<string, unknown>
  const attendanceRows = normalizeBunkRows(payload.attendance_rows)
  if (!attendanceRows.length) {
    return null
  }

  const courseCatalog = deriveCourseCatalog(attendanceRows)
  const notMarkedRows = attendanceRows
    .filter((row) => row.score === "?/1")
    .map((row) => ({
      ...row,
      date: (() => {
        const parsed = parseJsonDate(row.period_date)
        return parsed ? format(parsed, "dd-MM-yyyy") : null
      })(),
    }))
  const defaultCourseLimits = courseCatalog
    .filter((course) => course.course_code)
    .map((course) => ({
      course_code: course.course_code as string,
      subject_name: course.subject_name,
      max_dl: 8,
    }))

  return {
    dataset_id: toOptionalString(payload.dataset_id) || "external-bunkdata",
    dataset_expires_at:
      toOptionalString(payload.dataset_expires_at) ||
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    summary: {
      attendance_rows: attendanceRows.length,
      course_count: new Set(
        attendanceRows.map((row) => row.course_code).filter(Boolean)
      ).size,
      leave_rows: attendanceRows.filter((row) => row.score === "0/1").length,
      not_marked_rows: notMarkedRows.length,
    },
    attendance_rows: attendanceRows,
    course_catalog: courseCatalog,
    default_course_limits: defaultCourseLimits,
    not_marked_rows: notMarkedRows,
  }
}

function decodeBunkDataFromQuery(value: string) {
  const normalized = decodeURIComponent(value).replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const decoded = atob(padded)
  return JSON.parse(decoded) as unknown
}

function downloadFile(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function parseResponse<T>(response: Response) {
  const text = await response.text()
  if (!text) {
    return null as T | null
  }

  return JSON.parse(text) as T
}

async function parseError(response: Response) {
  const payload = await parseResponse<ApiErrorResponse>(response)
  return payload?.detail || "Something went wrong."
}

function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
        >
          <AlertCircle className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

function MetricCard({
  label,
  value,
  helper,
}: {
  label: string
  value: number | string
  helper: string
}) {
  const compactValue =
    typeof value === "string" && value.length <= 8 && !value.includes(" ")

  return (
    <Card className="glass-panel glass-border bg-card/80">
      <CardContent className="space-y-3 p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="min-w-0 space-y-3">
          <p
            className={cn(
              "max-w-[10ch] text-4xl leading-[0.95] font-semibold tracking-tight text-pretty",
              compactValue && "whitespace-nowrap"
            )}
          >
            {value}
          </p>
          <p className="max-w-[18ch] text-sm leading-6 text-muted-foreground">
            {helper}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function DatePickerButton({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between border-white/10 bg-white/5 text-left text-sm text-foreground hover:bg-white/8"
        >
          <span className={cn(!value && "text-muted-foreground")}>
            {value ? displayDate(value) : placeholder}
          </span>
          <CalendarIcon className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto border-white/10 bg-popover/95 p-0">
        <PopoverHeader className="p-3 pb-0">
          <PopoverTitle>Select date</PopoverTitle>
        </PopoverHeader>
        <Calendar
          mode="single"
          selected={parseJsonDate(value)}
          onSelect={(date) => onChange(date ? format(date, "yyyy-MM-dd") : "")}
          className="rounded-lg"
        />
      </PopoverContent>
    </Popover>
  )
}

function LoadingOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-md">
      <div className="glass-panel subtle-grid flex w-[min(92vw,28rem)] flex-col items-center gap-4 rounded-3xl border border-white/10 px-8 py-12 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Spinner className="size-8" />
        </div>
        <div className="space-y-2">
          <p className="font-medium tracking-wide text-primary">Fetching Attendance</p>
          <h2 className="text-2xl font-semibold tracking-tight">
            Pulling the latest data from LMS
          </h2>
          <p className="text-sm text-muted-foreground">
            BunkX is syncing attendance rows, course details, and planning defaults.
          </p>
        </div>
      </div>
    </div>
  )
}

export function BunkxApp() {
  const [credentials, setCredentials] = useState({ username: "", password: "" })
  const [fetchData, setFetchData] = useState<AttendanceFetchResponse | null>(null)
  const [plannerResult, setPlannerResult] = useState<PlannerGenerateResponse | null>(
    null
  )
  const [eventDates, setEventDates] = useState<string[]>([])
  const [eventDraft, setEventDraft] = useState("")
  const [manualEntries, setManualEntries] = useState<ManualEntryDraft[]>([
    makeManualEntry(),
  ])
  const [selectedNotMarkedIds, setSelectedNotMarkedIds] = useState<string[]>([])
  const [courseLimits, setCourseLimits] = useState<CourseLimitInput[]>([])
  const [cutoffDate, setCutoffDate] = useState(todayIso())
  const [lookbackDays, setLookbackDays] = useState([4])
  const [defaultMaxDl, setDefaultMaxDl] = useState(8)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [plannerError, setPlannerError] = useState<string | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [hasHydrated, setHasHydrated] = useState(false)
  const [mobileConfigSection, setMobileConfigSection] = useState("basics")
  const [mobileResultSection, setMobileResultSection] = useState("overview")

  const deferredRows = useDeferredValue(plannerResult?.planner_rows ?? [])
  const deferredText = useDeferredValue(plannerResult?.planner_text ?? "")

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const encodedBunkData = params.get("bunkdata")
      if (encodedBunkData) {
        try {
          const decodedPayload = decodeBunkDataFromQuery(encodedBunkData)
          const parsedFetchData = buildFetchDataFromBunkData(decodedPayload)

          if (!parsedFetchData) {
            throw new Error("Invalid bunkdata payload.")
          }

          setFetchData(parsedFetchData)
          setPlannerResult(null)
          setEventDates([])
          setEventDraft("")
          setManualEntries([makeManualEntry()])
          setSelectedNotMarkedIds([])
          setCourseLimits(mergeCourseLimits(parsedFetchData.default_course_limits, []))
          setCutoffDate(todayIso())
          setLookbackDays([4])
          setDefaultMaxDl(8)
          setFetchError(null)
          setPlannerError(null)

          const cleanedUrl = `${window.location.pathname}${window.location.hash}`
          window.history.replaceState({}, "", cleanedUrl)
          toast.success("Loaded bunk data from app link.")
          setHasHydrated(true)
          return
        } catch (error) {
          console.error("Unable to parse bunkdata. Falling back to normal flow.", error)
          setFetchError("Invalid bunkdata link. Use normal login or a valid app link.")
        }
      }

      const raw = window.sessionStorage.getItem(STORAGE_KEY)
      if (!raw) {
        setHasHydrated(true)
        return
      }

      const persisted = JSON.parse(raw) as PersistedState
      setFetchData(persisted.fetchData)
      setPlannerResult(persisted.plannerResult)
      setEventDates(persisted.eventDates || [])
      setManualEntries(
        persisted.manualEntries?.length ? persisted.manualEntries : [makeManualEntry()]
      )
      setSelectedNotMarkedIds(persisted.selectedNotMarkedIds || [])
      setCourseLimits(persisted.courseLimits || [])
      setCutoffDate(persisted.cutoffDate || todayIso())
      setLookbackDays([persisted.lookbackDays ?? 4])
      setDefaultMaxDl(persisted.defaultMaxDl ?? 8)
    } catch (error) {
      console.error("Unable to restore session", error)
    } finally {
      setHasHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (!hasHydrated) {
      return
    }

    const payload: PersistedState = {
      fetchData,
      plannerResult,
      eventDates,
      manualEntries,
      selectedNotMarkedIds,
      courseLimits,
      cutoffDate,
      lookbackDays: lookbackDays[0] ?? 4,
      defaultMaxDl,
    }

    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [
    courseLimits,
    cutoffDate,
    defaultMaxDl,
    eventDates,
    fetchData,
    hasHydrated,
    lookbackDays,
    manualEntries,
    plannerResult,
    selectedNotMarkedIds,
  ])

  async function handleFetchAttendance() {
    const normalizedUsername = credentials.username.trim().toUpperCase()

    if (!normalizedUsername || !credentials.password.trim()) {
      setFetchError("Enter both your roll number and password.")
      return
    }

    if (!isValidRollNumber(normalizedUsername)) {
      setFetchError(
        "Roll number must match 4 digits + BCS/BCD/BCY/ECE + 4 digits."
      )
      return
    }

    setFetchError(null)
    setPlannerError(null)
    setIsFetching(true)

    try {
      const basicToken = btoa(`${normalizedUsername}:${credentials.password}`)
      const response = await fetch("/api/attendance/fetch", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicToken}`,
        },
      })

      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const payload = await parseResponse<AttendanceFetchResponse>(response)
      if (!payload) {
        throw new Error("No attendance data was returned.")
      }

      setFetchData(payload)
      setCourseLimits((current) =>
        mergeCourseLimits(payload.default_course_limits, current)
      )
      setCredentials((current) => ({ ...current, username: normalizedUsername }))
      setSelectedNotMarkedIds([])
      setPlannerResult(null)
      toast.success("LMS attendance fetched successfully.")
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Attendance fetch failed. Please try again."
      setFetchError(message)
      toast.error(message)
    } finally {
      setIsFetching(false)
    }
  }

  async function generatePlannerWithFallback() {
    if (!fetchData) {
      return
    }

    setPlannerError(null)
    setIsGenerating(true)

    const manual_entries = manualEntries
      .filter((entry) => entry.date && entry.course_code)
      .map((entry) => ({
        date: entry.date,
        course_code: entry.course_code,
        session_time: entry.session_time || "",
      }))

    const payload: PlannerGenerateRequest = {
      attendance_rows: fetchData.attendance_rows,
      event_dates: eventDates,
      manual_entries,
      not_marked_record_ids: selectedNotMarkedIds,
      course_limits: courseLimits,
      cutoff_date: cutoffDate || null,
      lookback_days: lookbackDays[0] ?? 4,
    }

    try {
      const response = await fetch("/api/planner/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const result = await parseResponse<PlannerGenerateResponse>(response)
      if (!result) {
        throw new Error("Planner response was empty.")
      }

      setPlannerResult(result)
      setIsConfigOpen(false)
      toast.success("Duty leave plan generated.")
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to generate the planner output."
      setPlannerError(message)
      toast.error(message)
    } finally {
      setIsGenerating(false)
    }
  }

  function resetPlannerWorkspace() {
    if (!fetchData) {
      return
    }

    setEventDates([])
    setEventDraft("")
    setManualEntries([makeManualEntry()])
    setSelectedNotMarkedIds([])
    setCourseLimits(mergeCourseLimits(fetchData.default_course_limits, []))
    setCutoffDate(todayIso())
    setLookbackDays([4])
    setDefaultMaxDl(8)
    setPlannerResult(null)
    setPlannerError(null)
  }

  function resetSession() {
    setFetchData(null)
    setPlannerResult(null)
    setEventDates([])
    setEventDraft("")
    setManualEntries([makeManualEntry()])
    setSelectedNotMarkedIds([])
    setCourseLimits([])
    setCutoffDate(todayIso())
    setLookbackDays([4])
    setDefaultMaxDl(8)
    setFetchError(null)
    setPlannerError(null)
    window.sessionStorage.removeItem(STORAGE_KEY)
  }

  function addEventDate() {
    if (!eventDraft) {
      return
    }

    setEventDates((current) => uniqueSortedDates([...current, eventDraft]))
    setEventDraft("")
  }

  function removeEventDate(date: string) {
    setEventDates((current) => current.filter((item) => item !== date))
  }

  function updateManualEntry(
    id: string,
    field: keyof Omit<ManualEntryDraft, "id">,
    value: string
  ) {
    setManualEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry))
    )
  }

  function removeManualEntry(id: string) {
    setManualEntries((current) => {
      const next = current.filter((entry) => entry.id !== id)
      return next.length ? next : [makeManualEntry()]
    })
  }

  function toggleNotMarkedRow(recordId: string, checked: boolean) {
    setSelectedNotMarkedIds((current) => {
      if (checked) {
        return [...new Set([...current, recordId])]
      }
      return current.filter((item) => item !== recordId)
    })
  }

  function applyDefaultLimitToAll() {
    setCourseLimits((current) =>
      current.map((item) => ({
        ...item,
        max_dl: defaultMaxDl,
      }))
    )
  }

  const courseCatalog = fetchData?.course_catalog ?? []
  const courseLookup = new Map(
    courseCatalog
      .filter((course) => course.course_code)
      .map((course) => [course.course_code as string, course])
  )

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-7xl items-center justify-center px-6 py-16">
        <div className="grid w-full gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Skeleton className="h-112 rounded-[2rem]" />
          <Skeleton className="h-112 rounded-[2rem]" />
        </div>
      </main>
    )
  }

  return (
    <main className="relative overflow-hidden">
      {isFetching ? <LoadingOverlay /> : null}

      <div className="mx-auto flex min-h-svh w-full max-w-7xl flex-col px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
        {!fetchData ? (
          <section className="grid min-h-[calc(100svh-2rem)] items-stretch gap-4 sm:gap-6 lg:min-h-[calc(100svh-3rem)] lg:grid-cols-[1.15fr_0.85fr]">
            <Card className="order-2 glass-panel subtle-grid relative overflow-hidden rounded-[2rem] border-white/10 bg-card/70 lg:order-1">
              <CardContent className="flex h-full flex-col justify-between p-6 sm:p-8 lg:p-10">
                <div className="space-y-6">
                  <Badge
                    variant="outline"
                    className="w-fit border-primary/35 bg-primary/10 px-3 py-1 text-primary"
                  >
                    made by bfrovrflw
                  </Badge>
                  <div className="space-y-4">
                    <p className="text-sm uppercase tracking-[0.22em] text-muted-foreground">
                      attendance planning workspace
                    </p>
                    <div className="space-y-3">
                      <h1 className="max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                        BunkX
                      </h1>
                      <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                        Pull live attendance, model duty-leave scenarios, and export
                        the final recommendation as text or CSV without leaving the
                        browser.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="hidden gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-3">
                  <MetricCard
                    label="Flow"
                    value="2-step"
                    helper="Fetch first, then plan"
                  />
                  <MetricCard
                    label="Exports"
                    value="TXT + CSV"
                    helper="Download and copy ready"
                  />
                  <MetricCard
                    label="Planner"
                    value="All controls"
                    helper="Same planning features, cleaner layout"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="order-1 glass-panel rounded-[2rem] border-white/10 bg-card/78 lg:order-2">
              <CardHeader className="space-y-4 p-6 pb-4 sm:p-8">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                    <Sparkles className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-2xl tracking-tight">
                      Sign in with your LMS account
                    </CardTitle>
                    <CardDescription>
                      Your credentials are forwarded to the existing pybunk backend
                      through the Next proxy.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6 p-6 pt-2 sm:p-8 sm:pt-2">
                <div className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="username">Roll number</Label>
                    <Input
                      id="username"
                      value={credentials.username}
                      onChange={(event) =>
                        setCredentials((current) => ({
                          ...current,
                          username: event.target.value.toUpperCase().replace(/\s+/g, ""),
                        }))
                      }
                      placeholder="2024BCS0315"
                      maxLength={11}
                      className="h-11 border-white/10 bg-white/5"
                    />
                    <p className="text-xs text-muted-foreground">
                      Format: `2024BCS0315`, `2024BCD0001`, `2024BCY0123`, or
                      `2024ECE0042`.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={credentials.password}
                      onChange={(event) =>
                        setCredentials((current) => ({
                          ...current,
                          password: event.target.value,
                        }))
                      }
                      placeholder="Enter your LMS password"
                      className="h-11 border-white/10 bg-white/5"
                    />
                  </div>
                </div>

                {fetchError ? (
                  <div className="rounded-2xl border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-red-100">
                    {fetchError}
                  </div>
                ) : null}

                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full rounded-xl"
                  onClick={handleFetchAttendance}
                  disabled={isFetching}
                >
                  {isFetching ? (
                    <>
                      <Spinner className="size-4" />
                      Fetching attendance
                    </>
                  ) : (
                    <>
                      <GraduationCap className="size-4" />
                      Fetch Latest Attendance
                    </>
                  )}
                </Button>

                <div className="rounded-2xl border border-white/10 bg-white/4 p-4 text-sm text-muted-foreground">
                  The next screen includes event dates, manual bunks, not-marked
                  selections, per-course DL caps, exports, and formatted copy-ready
                  output.
                </div>
              </CardContent>
            </Card>
          </section>
        ) : (
          <section className="space-y-6 pb-10">
            <Card className="glass-panel overflow-hidden rounded-[2rem] border-white/10 bg-card/75">
              <CardContent className="p-5 sm:p-8">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                        BunkX
                      </h1>
                      <Badge
                        variant="outline"
                        className="border-primary/30 bg-primary/10 px-3 text-primary"
                      >
                        made by bfrovrflw
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5">
                        cache until {displayDateTime(fetchData.dataset_expires_at)}
                      </Badge>
                    </div>
                    <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                      Attendance is loaded. Tune the planner, select not-marked rows,
                      and export the final duty-leave set when the preview looks right.
                    </p>
                  </div>

                  <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full border-white/10 bg-white/5 sm:w-auto"
                      onClick={handleFetchAttendance}
                      disabled={isFetching}
                    >
                      <RefreshCcw className="size-4" />
                      Refresh attendance
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full border-white/10 bg-white/5 sm:w-auto"
                      onClick={resetPlannerWorkspace}
                    >
                      <Trash2 className="size-4" />
                      Reset planner
                    </Button>
                    <Button type="button" variant="ghost" className="w-full sm:w-auto" onClick={resetSession}>
                      <LogOut className="size-4" />
                      Switch account
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="hidden gap-4 sm:grid sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Courses"
                value={fetchData.summary.course_count}
                helper="Unique active classes found"
              />
              <MetricCard
                label="Attendance Rows"
                value={fetchData.summary.attendance_rows}
                helper="Rows fetched for planning"
              />
              <MetricCard
                label="Current Leaves"
                value={fetchData.summary.leave_rows}
                helper="Rows with 0/1 in LMS"
              />
              <MetricCard
                label="Not Marked"
                value={fetchData.summary.not_marked_rows}
                helper="Optional rows you can promote"
              />
            </div>

            <div className="space-y-6 pt-2">
              <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                <CardContent className="flex flex-col gap-4 p-4 sm:p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold tracking-tight">
                      Plan configuration
                    </h2>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="border-white/10 bg-white/5">
                        {eventDates.length} event dates
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5">
                        {manualEntries.filter((entry) => entry.date && entry.course_code).length} manual rows
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5">
                        {selectedNotMarkedIds.length} not marked selected
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5">
                        lookback {lookbackDays[0]} days
                      </Badge>
                    </div>
                  </div>
                  <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full border-white/10 bg-white/5 sm:w-auto"
                      onClick={() => setIsConfigOpen(true)}
                    >
                      <SlidersHorizontal className="size-4" />
                      Configure plan
                    </Button>
                    <Button
                      type="button"
                      className="w-full rounded-xl sm:w-auto"
                      onClick={generatePlannerWithFallback}
                      disabled={isGenerating}
                    >
                      {isGenerating ? (
                        <>
                          <Spinner className="size-4" />
                          Generating plan
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-4" />
                          Generate plan
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Dialog open={isConfigOpen} onOpenChange={setIsConfigOpen}>
                <DialogContent className="glass-panel max-h-svh w-[calc(100vw-1rem)] max-w-6xl overflow-hidden border-white/10 bg-card/95 p-0 sm:max-h-[88svh] sm:w-full sm:max-w-6xl">
                  <DialogHeader className="border-b border-white/10 px-4 py-4 sm:px-6 sm:py-5">
                    <DialogTitle className="text-xl">Plan configuration</DialogTitle>
                    <DialogDescription>
                      All planning options are here, without crowding the main workspace.
                    </DialogDescription>
                  </DialogHeader>
                  <ScrollArea className="max-h-[calc(100svh-5rem)] px-4 py-4 sm:max-h-[calc(88svh-6rem)] sm:px-6 sm:py-6">
                    <div className="space-y-4 pr-0 sm:space-y-6 sm:pr-2">
                <Tabs
                  value={mobileConfigSection}
                  onValueChange={setMobileConfigSection}
                  className="sm:hidden"
                >
                  <TabsList className="grid w-full grid-cols-3 bg-background/60">
                    <TabsTrigger value="basics">Basics</TabsTrigger>
                    <TabsTrigger value="manual">Manual</TabsTrigger>
                    <TabsTrigger value="review">Review</TabsTrigger>
                  </TabsList>
                </Tabs>

                <div
                  className={cn(
                    "grid gap-4 sm:gap-6 xl:grid-cols-[1.1fr_0.9fr]",
                    mobileConfigSection !== "basics" && "hidden sm:grid"
                  )}
                >
                  <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <CardTitle className="text-xl">Event dates</CardTitle>
                          <CardDescription>
                            Leave this empty to let the planner use all current bunk
                            candidates.
                          </CardDescription>
                        </div>
                        <InfoHint text="Matches are generated from the selected event dates and the lookback window." />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <div className="flex-1">
                          <DatePickerButton
                            value={eventDraft}
                            onChange={setEventDraft}
                            placeholder="Pick an event date"
                          />
                        </div>
                        <Button type="button" onClick={addEventDate} className="w-full sm:min-w-40 sm:w-auto">
                          <Plus className="size-4" />
                          Add event
                        </Button>
                      </div>
                      <div className="flex min-h-16 flex-wrap gap-2 rounded-2xl border border-dashed border-white/10 bg-white/3 p-3">
                        {eventDates.length ? (
                          eventDates.map((date) => (
                            <Badge
                              key={date}
                              variant="outline"
                              className="gap-2 border-primary/30 bg-primary/10 px-3 py-1 text-primary"
                            >
                              {displayDate(date)}
                              <button
                                type="button"
                                onClick={() => removeEventDate(date)}
                                className="rounded-full text-primary/80 transition hover:text-primary"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </Badge>
                          ))
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Fallback mode is active. No event dates selected yet.
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                    <CardHeader>
                      <CardTitle className="text-xl">Planner settings</CardTitle>
                      <CardDescription>
                        Control the cutoff date, lookback window, and default course cap.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Label>Cutoff date</Label>
                          <InfoHint text="Only attendance records on or before this date are considered." />
                        </div>
                        <DatePickerButton
                          value={cutoffDate}
                          onChange={setCutoffDate}
                          placeholder="Pick a cutoff date"
                        />
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Label>Days before event</Label>
                            <InfoHint text="A leave counts if it falls on the event day or within this many days before it." />
                          </div>
                          <Badge variant="outline" className="border-white/10 bg-white/5">
                            {lookbackDays[0]} days
                          </Badge>
                        </div>
                        <Slider
                          min={0}
                          max={14}
                          step={1}
                          value={lookbackDays}
                          onValueChange={setLookbackDays}
                        />
                      </div>

                      <Separator className="bg-white/10" />

                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Label htmlFor="default-max-dl">Default max DL per course</Label>
                          <InfoHint text="Use this to seed new course limits or reapply a common cap across all courses." />
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row">
                          <Input
                            id="default-max-dl"
                            type="number"
                            min={0}
                            max={50}
                            value={defaultMaxDl}
                            onChange={(event) =>
                              setDefaultMaxDl(Number(event.target.value) || 0)
                            }
                            className="h-10 border-white/10 bg-white/5 sm:max-w-36"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="border-white/10 bg-white/5"
                            onClick={applyDefaultLimitToAll}
                          >
                            Apply to all courses
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div
                  className={cn(
                    "grid gap-4 sm:gap-6 xl:grid-cols-[1.15fr_0.85fr]",
                    mobileConfigSection !== "manual" && "hidden sm:grid"
                  )}
                >
                  <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                    <CardHeader>
                      <CardTitle className="text-xl">Manual bunks</CardTitle>
                      <CardDescription>
                        Add dates that are not reflected on LMS yet.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <ScrollArea className="w-full rounded-2xl border border-white/10">
                        <div className="min-w-136 sm:min-w-2xl">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-white/10">
                                <TableHead>Date</TableHead>
                                <TableHead>Course</TableHead>
                                <TableHead>Session time / note</TableHead>
                                <TableHead className="w-14 text-right"> </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {manualEntries.map((entry) => (
                                <TableRow key={entry.id} className="border-white/10">
                                  <TableCell className="min-w-32 sm:min-w-40">
                                    <Input
                                      type="date"
                                      value={entry.date}
                                      onChange={(event) =>
                                        updateManualEntry(
                                          entry.id,
                                          "date",
                                          event.target.value
                                        )
                                      }
                                      className="border-white/10 bg-white/5"
                                    />
                                  </TableCell>
                                  <TableCell className="min-w-40 sm:min-w-52">
                                    <Select
                                      value={entry.course_code}
                                      onValueChange={(value) =>
                                        updateManualEntry(entry.id, "course_code", value)
                                      }
                                    >
                                      <SelectTrigger className="w-full border-white/10 bg-white/5">
                                        <SelectValue placeholder="Select course" />
                                      </SelectTrigger>
                                      <SelectContent className="border-white/10 bg-popover/95">
                                        {courseCatalog
                                          .filter((course) => course.course_code)
                                          .map((course) => (
                                            <SelectItem
                                              key={course.course_code}
                                              value={course.course_code as string}
                                            >
                                              {course.course_code}{" "}
                                              {course.subject_name
                                                ? `- ${course.subject_name}`
                                                : ""}
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                  </TableCell>
                                  <TableCell>
                                    <Input
                                      value={entry.session_time}
                                      onChange={(event) =>
                                        updateManualEntry(
                                          entry.id,
                                          "session_time",
                                          event.target.value
                                        )
                                      }
                                      placeholder="2PM - 3PM or MANUAL BUNK"
                                      className="border-white/10 bg-white/5"
                                    />
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      onClick={() => removeManualEntry(entry.id)}
                                    >
                                      <Trash2 className="size-4" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </ScrollArea>

                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/10 bg-white/5"
                        onClick={() =>
                          setManualEntries((current) => [...current, makeManualEntry()])
                        }
                      >
                        <Plus className="size-4" />
                        Add manual bunk row
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                    <CardHeader>
                      <CardTitle className="text-xl">Per-course DL limits</CardTitle>
                      <CardDescription>
                        Courses with a max DL of zero will be excluded from the plan.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-80 rounded-2xl border border-white/10 sm:h-96">
                        <Table>
                          <TableHeader>
                            <TableRow className="border-white/10">
                              <TableHead>Course</TableHead>
                              <TableHead>Subject</TableHead>
                              <TableHead className="w-28">Max DL</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {courseLimits.map((limit) => {
                              const course = courseLookup.get(limit.course_code)
                              return (
                                <TableRow
                                  key={limit.course_code}
                                  className="border-white/10"
                                >
                                  <TableCell className="font-medium">
                                    {limit.course_code}
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {course?.subject_name || "Unknown subject"}
                                  </TableCell>
                                  <TableCell>
                                    <Input
                                      type="number"
                                      min={0}
                                      max={50}
                                      value={limit.max_dl}
                                      onChange={(event) =>
                                        setCourseLimits((current) =>
                                          current.map((item) =>
                                            item.course_code === limit.course_code
                                              ? {
                                                  ...item,
                                                  max_dl: Math.max(
                                                    0,
                                                    Number(event.target.value) || 0
                                                  ),
                                                }
                                              : item
                                          )
                                        )
                                      }
                                      className="border-white/10 bg-white/5"
                                    />
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </div>

                <Card
                  className={cn(
                    "glass-panel rounded-[1.75rem] border-white/10 bg-card/75",
                    mobileConfigSection !== "review" && "hidden sm:block"
                  )}
                >
                  <CardHeader>
                    <CardTitle className="text-xl">Not marked leaves</CardTitle>
                    <CardDescription>
                      Promote selected `?/1` rows into planner candidates.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {fetchData.not_marked_rows.length ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <Badge variant="outline" className="border-white/10 bg-white/5">
                            {selectedNotMarkedIds.length} selected
                          </Badge>
                          <div className="grid w-full gap-2 sm:flex sm:w-auto">
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full border-white/10 bg-white/5 sm:w-auto"
                              onClick={() =>
                                setSelectedNotMarkedIds(
                                  fetchData.not_marked_rows.map((row) => row.record_id)
                                )
                              }
                            >
                              <Check className="size-4" />
                              Select all
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => setSelectedNotMarkedIds([])}
                            >
                              Clear
                            </Button>
                          </div>
                        </div>
                        <ScrollArea className="h-72 rounded-2xl border border-white/10 sm:h-88">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-white/10">
                                <TableHead className="w-16">Use</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead>Session</TableHead>
                                <TableHead>Course</TableHead>
                                <TableHead>Faculty</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {fetchData.not_marked_rows.map((row) => (
                                <TableRow key={row.record_id} className="border-white/10">
                                  <TableCell>
                                    <Checkbox
                                      checked={selectedNotMarkedIds.includes(row.record_id)}
                                      onCheckedChange={(checked) =>
                                        toggleNotMarkedRow(
                                          row.record_id,
                                          Boolean(checked)
                                        )
                                      }
                                    />
                                  </TableCell>
                                  <TableCell>{row.date || displayDate(row.period_date)}</TableCell>
                                  <TableCell>{row.session_time || "-"}</TableCell>
                                  <TableCell>
                                    <div className="space-y-1">
                                      <p className="font-medium">
                                        {row.course_code || "Unknown"}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {row.subject_name || "Unknown subject"}
                                      </p>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="space-y-1">
                                      <p>{row.faculty || "Unknown faculty"}</p>
                                      <p className="text-xs text-muted-foreground">
                                        {row.faculty_email || "No email"}
                                      </p>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/3 p-6 text-sm text-muted-foreground">
                        No `?/1` rows are available in this dataset.
                      </div>
                    )}
                  </CardContent>
                </Card>

                    </div>
                  </ScrollArea>
                </DialogContent>
              </Dialog>

              {plannerError ? (
                <div className="rounded-2xl border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-red-100">
                  {plannerError}
                </div>
              ) : null}

              <div className="space-y-6">
                {isGenerating ? (
                  <div className="grid gap-4 md:grid-cols-3">
                    <Skeleton className="h-28 rounded-[1.75rem]" />
                    <Skeleton className="h-28 rounded-[1.75rem]" />
                    <Skeleton className="h-28 rounded-[1.75rem]" />
                  </div>
                ) : null}

                {plannerResult ? (
                  <>
                    <Tabs
                      value={mobileResultSection}
                      onValueChange={setMobileResultSection}
                      className="sm:hidden"
                    >
                      <TabsList className="grid w-full grid-cols-3 bg-background/60">
                        <TabsTrigger value="overview">Overview</TabsTrigger>
                        <TabsTrigger value="preview">Preview</TabsTrigger>
                        <TabsTrigger value="export">Export</TabsTrigger>
                      </TabsList>
                    </Tabs>

                    <div
                      className={cn(
                        "grid gap-4 sm:grid-cols-2 xl:grid-cols-3",
                        mobileResultSection !== "overview" && "hidden sm:grid"
                      )}
                    >
                      <MetricCard
                        label="Recommended Rows"
                        value={plannerResult.summary.recommended_rows}
                        helper="Rows in the final DL list"
                      />
                      <MetricCard
                        label="Courses Covered"
                        value={plannerResult.summary.courses_covered}
                        helper="Unique courses represented"
                      />
                      <MetricCard
                        label="Manual / Not Marked"
                        value={plannerResult.summary.manual_or_not_marked_used}
                        helper="Extra rows promoted into plan"
                      />
                    </div>

                    <div
                      className={cn(
                        "grid gap-4 sm:gap-6 xl:grid-cols-[1.08fr_0.92fr]",
                        !["preview", "export"].includes(mobileResultSection) &&
                          "hidden sm:grid"
                      )}
                    >
                      <Card
                        className={cn(
                          "glass-panel rounded-[1.75rem] border-white/10 bg-card/75",
                          mobileResultSection !== "preview" && "hidden sm:block"
                        )}
                      >
                        <CardHeader>
                          <CardTitle className="text-xl">Plan preview</CardTitle>
                          <CardDescription>
                            Final rows that will be exported in CSV and TXT form.
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="h-80 overflow-auto rounded-2xl border border-white/10 sm:h-120">
                            <div className="min-w-208">
                              <Table>
                                <TableHeader>
                                  <TableRow className="border-white/10">
                                    <TableHead>Date</TableHead>
                                    <TableHead>Session</TableHead>
                                    <TableHead>Course</TableHead>
                                    <TableHead>Source</TableHead>
                                    <TableHead>Matched Event</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {deferredRows.map((row, index) => (
                                    <TableRow
                                      key={`${row.date}-${row.course}-${index}`}
                                      className="border-white/10"
                                    >
                                      <TableCell>{row.date || "-"}</TableCell>
                                      <TableCell>{row.session_time || "-"}</TableCell>
                                      <TableCell>
                                        <div className="space-y-1">
                                          <p className="font-medium">
                                            {row.course || "Unknown course"}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {row.faculty || "Unknown faculty"}
                                          </p>
                                        </div>
                                      </TableCell>
                                      <TableCell>
                                        <Badge variant="outline" className="border-white/10 bg-white/5">
                                          {row.source || "lms"}
                                        </Badge>
                                      </TableCell>
                                      <TableCell>
                                        <div className="space-y-1">
                                          <p>{row.matched_event_date || "Fallback mode"}</p>
                                          <p className="text-xs text-muted-foreground">
                                            {row.days_before_event ?? "-"}
                                          </p>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      <div
                        className={cn(
                          "space-y-6",
                          mobileResultSection !== "export" && "hidden sm:block"
                        )}
                      >
                        <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                          <CardHeader>
                            <CardTitle className="text-xl">Export actions</CardTitle>
                            <CardDescription>
                              Download the final list or copy the formatted planner text.
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <Button
                              type="button"
                              className="h-11 w-full justify-start rounded-xl"
                              onClick={() =>
                                downloadFile(
                                  "bunkx-duty-leaves.csv",
                                  plannerResult.planner_csv,
                                  "text/csv;charset=utf-8"
                                )
                              }
                            >
                              <Download className="size-4" />
                              Download CSV
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-11 w-full justify-start rounded-xl border-white/10 bg-white/5"
                              onClick={() =>
                                downloadFile(
                                  "bunkx-duty-leaves.txt",
                                  plannerResult.planner_text,
                                  "text/plain;charset=utf-8"
                                )
                              }
                            >
                              <Clipboard className="size-4" />
                              Download TXT
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-11 w-full justify-start rounded-xl"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(
                                    plannerResult.planner_text
                                  )
                                  toast.success("Formatted planner text copied.")
                                } catch (error) {
                                  console.error("Clipboard copy failed", error)
                                  toast.error("Clipboard copy failed.")
                                }
                              }}
                            >
                              <Copy className="size-4" />
                              Copy formatted text
                            </Button>
                          </CardContent>
                        </Card>

                      </div>
                    </div>

                    <Card
                      className={cn(
                        "glass-panel rounded-[1.75rem] border-white/10 bg-card/75",
                        mobileResultSection !== "preview" && "hidden sm:block"
                      )}
                    >
                      <CardHeader>
                        <CardTitle className="text-xl">Course counts</CardTitle>
                        <CardDescription>
                          How many selected rows each course contributes.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ScrollArea className="h-48 rounded-2xl border border-white/10 sm:h-56">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-white/10">
                                <TableHead>Course</TableHead>
                                <TableHead>Subject</TableHead>
                                <TableHead className="text-right">Count</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {plannerResult.course_counts.map((count) => (
                                <TableRow
                                  key={`${count.course_code}-${count.subject_name}`}
                                  className="border-white/10"
                                >
                                  <TableCell className="font-medium">
                                    {count.course_code || "Unknown"}
                                  </TableCell>
                                  <TableCell>
                                    {count.subject_name || "Unknown subject"}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {count.count}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </CardContent>
                    </Card>

                    <Card
                      className={cn(
                        "glass-panel rounded-[1.75rem] border-white/10 bg-card/75",
                        mobileResultSection !== "export" && "hidden sm:block"
                      )}
                    >
                      <CardHeader>
                        <CardTitle className="text-xl">Formatted planner output</CardTitle>
                        <CardDescription>
                          Copy-ready text matching the backend planner export format.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Textarea
                          value={deferredText}
                          readOnly
                          className="min-h-64 resize-none border-white/10 bg-black/20 font-mono text-xs leading-6 sm:min-h-80"
                        />
                      </CardContent>
                    </Card>
                  </>
                ) : (
                  <Card className="glass-panel rounded-[1.75rem] border-white/10 bg-card/75">
                    <CardContent className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center sm:min-h-72 sm:p-10">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                        <Sparkles className="size-6" />
                      </div>
                      <div className="space-y-2">
                        <h2 className="text-2xl font-semibold tracking-tight">
                          No planner output yet
                        </h2>
                        <p className="max-w-lg text-sm text-muted-foreground">
                          Configure the planner controls and generate a plan to unlock
                          preview, exports, and copy-ready formatted text.
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
