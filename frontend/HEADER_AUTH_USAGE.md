# Header Auth Usage

This document explains how to send LMS credentials to `POST /api/attendance/fetch` using headers from the Next.js side.

## Supported Credential Inputs

The attendance route accepts credentials in this order:

1. `Authorization: Basic <base64(username:password)>`
2. `X-Pybunk-Username` + `X-Pybunk-Password`
3. JSON body: `{ "username": "...", "password": "..." }`

If more than one is provided, the first valid option above is used.

## Next.js Client Example

```ts
const basicToken = btoa(`${username}:${password}`)

const response = await fetch("/api/attendance/fetch", {
  method: "POST",
  headers: {
    Authorization: `Basic ${basicToken}`,
  },
})
```

## External App Calling Your Next Route

If your mobile app or another service calls your Next route directly, send:

```http
POST /api/attendance/fetch HTTP/1.1
Host: your-domain
Authorization: Basic base64(username:password)
```

## Important Security Notes

- Use HTTPS in production. Basic auth is encoded, not encrypted.
- Never place passwords in URL query parameters.
- Do not log full `Authorization` headers.
- Do not store raw passwords in local storage/session storage.

## Link-Based App Launches

A normal URL link cannot carry custom headers safely. For app-to-web launch:

1. App calls backend to mint a one-time launch code (short TTL, one-time use).
2. App opens `https://your-domain/auth/launch?code=...`.
3. Server validates code, sets an HttpOnly secure session cookie, redirects to main page.

This avoids exposing passwords in links while still allowing direct entry.

## Direct Bunk Data Link (No Auth Handshake)

If your app already scraped attendance data, you can skip credential auth and open:

`/bunkialo?bunkdata=<base64-json>`

The web app decodes `bunkdata`, hydrates the planner state, and opens directly in the main workspace.

### JSON Shape Expected In `bunkdata`

At minimum, include `attendance_rows`.

Compressed mobile format is also supported.

Field mapping:

- `ar` -> `attendance_rows`
- `pd` -> `period_date`
- `st` -> `session_time`
- `cc` -> `course_code`
- `sn` -> `subject_name`
- `f` -> `faculty`
- `s` -> `score`
- `id` -> `record_id`
- `di` -> `dataset_id`
- `de` -> `dataset_expires_at` (unix milliseconds or ISO string)

```json
{
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
  "dataset_id": "optional-external-id",
  "dataset_expires_at": "2026-03-31T10:15:00.000Z"
}
```

### Scraper Fields To Send

For each attendance row, scrape and send:

- `period_date` as ISO date (`YYYY-MM-DD`)
- `session_time`
- `course_code`
- `subject_name`
- `faculty`
- `faculty_email`
- `course` (optional; can be `course_code + subject_name`)
- `score` (`0/1`, `1/1`, `?/1`, etc.)

Optional but recommended:

- `record_id` (if omitted, web app auto-generates `rec_1`, `rec_2`, ...)

Derived automatically by web app:

- `summary`
- `course_catalog`
- `default_course_limits` (default `max_dl = 8`)
- `not_marked_rows` (from rows where `score = ?/1`)

### Encoding Notes

- Use UTF-8 JSON string -> Base64 encode.
- URL-encode the Base64 string before appending to query parameter.
- URL-safe Base64 (`-` and `_`) is accepted.
