export interface AttendanceSummary {
  attendance_rows: number
  course_count: number
  leave_rows: number
  not_marked_rows: number
}

export interface CourseCatalogRecord {
  course_code: string | null
  subject_name: string | null
  faculty: string | null
  faculty_email: string | null
  course: string | null
}

export interface DefaultCourseLimit {
  course_code: string
  subject_name: string | null
  max_dl: number
}

export interface AttendanceRow {
  record_id: string
  period_date: string | null
  session_time: string | null
  course_code: string | null
  subject_name: string | null
  faculty: string | null
  faculty_email: string | null
  course: string | null
  score: string | null
}

export interface NotMarkedRow extends AttendanceRow {
  date: string | null
}

export interface AttendanceFetchResponse {
  dataset_id: string
  dataset_expires_at: string
  summary: AttendanceSummary
  attendance_rows: AttendanceRow[]
  course_catalog: CourseCatalogRecord[]
  default_course_limits: DefaultCourseLimit[]
  not_marked_rows: NotMarkedRow[]
}

export interface ManualBunkInput {
  date: string
  course_code: string
  session_time?: string | null
}

export interface CourseLimitInput {
  course_code: string
  max_dl: number
}

export interface PlannerRow {
  date: string | null
  session_time: string | null
  course: string | null
  faculty: string | null
  faculty_email: string | null
  source: string | null
  matched_event_date: string | null
  days_before_event: number | string | null
}

export interface PlannerCourseCount {
  course_code: string | null
  subject_name: string | null
  count: number
}

export interface PlannerSummary {
  recommended_rows: number
  courses_covered: number
  manual_or_not_marked_used: number
}

export interface PlannerGenerateResponse {
  summary: PlannerSummary
  planner_rows: PlannerRow[]
  course_counts: PlannerCourseCount[]
  planner_text: string
  planner_csv: string
}

export interface PlannerGenerateRequest {
  dataset_id?: string | null
  attendance_rows?: AttendanceRow[]
  event_dates: string[]
  manual_entries: ManualBunkInput[]
  not_marked_record_ids: string[]
  course_limits: CourseLimitInput[]
  cutoff_date?: string | null
  lookback_days: number
}

export interface ApiErrorResponse {
  detail?: string
}
