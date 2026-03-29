# pybunk API

`pybunk` exposes a small FastAPI backend for fetching Moodle attendance data and generating a duty-leave plan from that dataset.

## Run the API

```powershell
uv run uvicorn api:app --reload
```

Once the server is running:

- Swagger UI: `http://127.0.0.1:8000/docs`
- ReDoc: `http://127.0.0.1:8000/redoc`

## How the API Flow Works

The API is a two-step flow:

1. Call `POST /api/attendance/fetch` with your Moodle username and password.
2. Use the returned `dataset_id` in `POST /api/planner/generate`.

Important behavior:

- `dataset_id` values are stored only in server memory.
- Restarting the API clears all fetched datasets.
- `dataset_id` values now expire automatically after a short TTL.
- Planner generation only considers courses included in `course_limits` with `max_dl > 0`.
- If `event_dates` is empty, the planner falls back to selecting from all available bunk candidates instead of matching around events.
- For production frontends, you can skip server memory entirely by sending `attendance_rows` back to `/api/planner/generate`.

## Endpoint Summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/attendance/fetch` | Fetch Moodle attendance and build a working dataset |
| `POST` | `/api/planner/generate` | Generate a duty-leave recommendation plan from a fetched dataset |

## `GET /api/health`

Simple health probe.

### Response

```json
{
  "status": "ok"
}
```

## `POST /api/attendance/fetch`

Logs into Moodle, fetches attendance rows for in-progress courses, assigns `record_id` values, and returns planner metadata derived from the fetched dataset.

### Request Body

```json
{
  "username": "your_roll_number",
  "password": "your_password"
}
```

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | `string` | Yes | Moodle username / roll number |
| `password` | `string` | Yes | Moodle password |

### Response Shape

```json
{
  "dataset_id": "0c3d4d15-f27d-4f99-9343-a5ef6c0f48d9",
  "dataset_expires_at": "2026-03-25T10:15:00+00:00",
  "summary": {
    "attendance_rows": 48,
    "course_count": 6,
    "leave_rows": 9,
    "not_marked_rows": 2
  },
  "attendance_rows": [
    {
      "record_id": "rec_1",
      "period_date": "2026-03-11",
      "session_time": "2PM - 3PM",
      "course_code": "ICS222",
      "subject_name": "Object-Oriented Analysis and Design",
      "faculty": "Jisha Mariyam John",
      "faculty_email": "faculty@example.com",
      "course": "ICS222 Object-Oriented Analysis and Design",
      "score": "0/1"
    }
  ],
  "course_catalog": [
    {
      "course_code": "ICS222",
      "subject_name": "Object-Oriented Analysis and Design",
      "faculty": "Jisha Mariyam John",
      "faculty_email": "faculty@example.com",
      "course": "ICS222 Object-Oriented Analysis and Design"
    }
  ],
  "default_course_limits": [
    {
      "course_code": "ICS222",
      "subject_name": "Object-Oriented Analysis and Design",
      "max_dl": 8
    }
  ],
  "not_marked_rows": [
    {
      "record_id": "rec_14",
      "date": "11-03-2026",
      "period_date": "2026-03-11",
      "session_time": "2PM - 3PM",
      "course_code": "ICS222",
      "subject_name": "Object-Oriented Analysis and Design",
      "faculty": "Jisha Mariyam John",
      "faculty_email": "faculty@example.com",
      "course": "ICS222 Object-Oriented Analysis and Design",
      "score": "?/1"
    }
  ]
}
```

### Response Fields

| Field | Type | Notes |
| --- | --- | --- |
| `dataset_id` | `string` | In-memory dataset handle used by the planner endpoint |
| `dataset_expires_at` | `string` | Expiry time for the legacy in-memory dataset handle |
| `summary` | `object` | High-level counts for the fetched attendance data |
| `attendance_rows` | `array` | Stateless planner input you can keep on the frontend and send back later |
| `course_catalog` | `array` | Unique courses discovered in the dataset |
| `default_course_limits` | `array` | Convenience defaults for planner requests |
| `not_marked_rows` | `array` | Rows with score `?/1` that can be explicitly included in a plan |

### `course_catalog` Item

| Field | Type |
| --- | --- |
| `course_code` | `string \| null` |
| `subject_name` | `string \| null` |
| `faculty` | `string \| null` |
| `faculty_email` | `string \| null` |
| `course` | `string \| null` |

### `not_marked_rows` Item

| Field | Type | Notes |
| --- | --- | --- |
| `record_id` | `string` | Use this in `not_marked_record_ids` later |
| `date` | `string` | Display-friendly `DD-MM-YYYY` date |
| `period_date` | `string` | ISO date |
| `session_time` | `string \| null` | Attendance time label |
| `course_code` | `string \| null` | |
| `subject_name` | `string \| null` | |
| `faculty` | `string \| null` | |
| `faculty_email` | `string \| null` | |
| `course` | `string \| null` | |
| `score` | `string` | Always `?/1` in this list |

### Error Behavior

- Returns `400` if login or attendance fetching fails.
- The response body uses FastAPI's standard error shape:

```json
{
  "detail": "error message"
}
```

## `POST /api/planner/generate`

Generates a duty-leave recommendation plan using LMS bunk entries (`0/1`), optional manual bunks, and optionally selected `?/1` rows.

This endpoint supports two input styles:

1. Legacy mode: send `dataset_id`.
2. Production-friendly stateless mode: send `attendance_rows`.

### Request Body

```json
{
  "attendance_rows": [
    {
      "record_id": "rec_1",
      "period_date": "2026-03-15",
      "session_time": "2PM - 3PM",
      "course_code": "ICS222",
      "subject_name": "Object-Oriented Analysis and Design",
      "faculty": "Jisha Mariyam John",
      "faculty_email": "faculty@example.com",
      "course": "ICS222 Object-Oriented Analysis and Design",
      "score": "0/1"
    }
  ],
  "event_dates": ["2026-03-17", "2026-03-18"],
  "manual_entries": [
    {
      "date": "2026-03-15",
      "course_code": "ICS222",
      "session_time": "2PM - 3PM"
    }
  ],
  "not_marked_record_ids": ["rec_14"],
  "course_limits": [
    {
      "course_code": "ICS222",
      "max_dl": 3
    }
  ],
  "cutoff_date": "2026-03-17",
  "lookback_days": 4
}
```

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `dataset_id` | `string` | No | Legacy in-memory input returned by `/api/attendance/fetch` |
| `attendance_rows` | `object[]` | No | Stateless input returned by `/api/attendance/fetch`; recommended for production |
| `event_dates` | `string[]` | No | ISO dates; empty list enables fallback planning without event matching |
| `manual_entries` | `object[]` | No | Extra bunk candidates supplied by the client |
| `not_marked_record_ids` | `string[]` | No | `record_id` values from `not_marked_rows` |
| `course_limits` | `object[]` | No | Per-course caps; only courses with `max_dl > 0` are considered |
| `cutoff_date` | `string \| null` | No | Excludes candidates after this ISO date |
| `lookback_days` | `integer` | No | Event-match window, from `0` to `14`; default `4` |

You must send at least one of `dataset_id` or `attendance_rows`.

### `manual_entries` Item

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `date` | `string` | Yes | ISO date |
| `course_code` | `string` | Yes | Should match a course from `course_catalog` |
| `session_time` | `string \| null` | No | Defaults to `MANUAL BUNK` if omitted or empty |

### `course_limits` Item

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `course_code` | `string` | Yes | |
| `max_dl` | `integer` | Yes | Allowed range is `0` to `50` |

### Selection Rules

- LMS rows with score `0/1` are always eligible candidates.
- Rows from `not_marked_record_ids` are included with source `not_marked`.
- `manual_entries` are included with source `manual`.
- If `event_dates` is provided, a row is only selected when it falls between `0` and `lookback_days` days before an event.
- For each course, rows are sorted and the top `max_dl` rows are kept.

### Response Shape

```json
{
  "summary": {
    "recommended_rows": 4,
    "courses_covered": 2,
    "manual_or_not_marked_used": 1
  },
  "planner_rows": [
    {
      "date": "15-03-2026",
      "session_time": "2PM - 3PM",
      "course": "ICS222 Object-Oriented Analysis and Design",
      "faculty": "Jisha Mariyam John",
      "faculty_email": "faculty@example.com",
      "source": "manual",
      "matched_event_date": "17-03-2026",
      "days_before_event": 2
    }
  ],
  "course_counts": [
    {
      "course_code": "ICS222",
      "subject_name": "Object-Oriented Analysis and Design",
      "count": 3
    }
  ],
  "planner_csv": "date,session_time,course,faculty,faculty_email,source,matched_event_date,days_before_event\n15-03-2026,2PM - 3PM,ICS222 Object-Oriented Analysis and Design,Jisha Mariyam John,faculty@example.com,manual,17-03-2026,2\n",
  "planner_text": "15-03-2026\n2PM - 3PM : ICS222 : Object-Oriented Analysis and Design : Jisha Mariyam John : faculty@example.com\n----\nDL Count By Course\nICS222 : Object-Oriented Analysis and Design : 3\n"
}
```

### Response Fields

| Field | Type | Notes |
| --- | --- | --- |
| `summary` | `object` | Counts for the generated recommendation set |
| `planner_rows` | `array` | Tabular plan preview |
| `course_counts` | `array` | Number of selected rows per course |
| `planner_csv` | `string` | CSV content ready to download or stream from your frontend |
| `planner_text` | `string` | Day-wise text output matching the planner's text export format |

### `planner_rows` Item

| Field | Type | Notes |
| --- | --- | --- |
| `date` | `string` | `DD-MM-YYYY` |
| `session_time` | `string \| null` | |
| `course` | `string \| null` | Combined `course_code + subject_name` label |
| `faculty` | `string \| null` | |
| `faculty_email` | `string \| null` | |
| `source` | `string \| null` | One of `lms`, `manual`, or `not_marked` |
| `matched_event_date` | `string \| null` | `DD-MM-YYYY`, or blank when no event matching is used |
| `days_before_event` | `integer \| string \| null` | Blank when no event matching is used |

### Error Behavior

- Returns `404` when `dataset_id` is unknown, usually because the server was restarted or the ID was never created.

```json
{
  "detail": "Unknown dataset_id. Fetch attendance first."
}
```

## Example cURL Flow

### 1. Fetch attendance

```bash
curl -X POST "http://127.0.0.1:8000/api/attendance/fetch" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"your_roll_number\",\"password\":\"your_password\"}"
```

### 2. Generate a planner response

Recommended production pattern: use the `attendance_rows` returned above and send them back in the planner request from your Next.js server.

```bash
curl -X POST "http://127.0.0.1:8000/api/planner/generate" \
  -H "Content-Type: application/json" \
  -d "{\"attendance_rows\":[{\"record_id\":\"rec_1\",\"period_date\":\"2026-03-15\",\"session_time\":\"2PM - 3PM\",\"course_code\":\"ICS222\",\"subject_name\":\"Object-Oriented Analysis and Design\",\"faculty\":\"Jisha Mariyam John\",\"faculty_email\":\"faculty@example.com\",\"course\":\"ICS222 Object-Oriented Analysis and Design\",\"score\":\"0/1\"}],\"event_dates\":[\"2026-03-17\"],\"course_limits\":[{\"course_code\":\"ICS222\",\"max_dl\":3}]}"
```

## Production Guardrails

This API supports several environment-controlled deployment guardrails:

| Variable | Purpose |
| --- | --- |
| `PYBUNK_API_TOKEN` | Requires `Authorization: Bearer <token>` on protected endpoints |
| `PYBUNK_ALLOWED_ORIGINS` | Comma-separated CORS allowlist |
| `PYBUNK_TRUSTED_HOSTS` | Comma-separated trusted hostnames |
| `PYBUNK_RATE_LIMIT_PER_MINUTE` | Per-IP request cap for protected endpoints |
| `PYBUNK_DATASET_TTL_SECONDS` | Expiry for legacy in-memory `dataset_id` values |
| `PYBUNK_ENABLE_DOCS` | Enables or disables `/docs`, `/redoc`, and `/openapi.json` |

For a public website, the recommended architecture is:

1. Browser -> Next.js
2. Next.js server -> pybunk API with bearer token
3. Moodle credentials travel only between your Next.js server and the pybunk backend
