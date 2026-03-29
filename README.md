# pybunk

`pybunk` is a Moodle attendance toolkit for IIIT Kottayam UG-2024 that fetches live attendance data, enriches it with course and faculty details, and helps you build duty-leave plans through a CLI flow, a FastAPI backend, a new Next.js frontend, or the existing Streamlit app.

## Modern Features

- Moodle login and attendance fetch for all in-progress courses
- Automatic attendance-module discovery per course
- Structured attendance parsing with course code, subject name, faculty, faculty email, session time, and score
- FastAPI backend with OpenAPI docs at `/docs`
- Next.js + shadcn frontend in `frontend/` for the primary web experience
- Stateless planner generation by sending fetched `attendance_rows` back from the frontend
- Streamlit planner for interactive DL planning
- Manual bunk entry support when LMS is not updated yet
- `?/1` selection support for not-marked classes
- Per-course duty-leave caps
- Configurable cutoff date and event lookback window in the planner
- Bearer-token protection, CORS controls, trusted-host checks, and rate limiting for production
- CSV and TXT exports for leaves, unsure rows, and planner output

## Quick Start

Create a `.env` file in the project root for the CLI flow:

```env
PYBUNK_USERNAME=your_username
PYBUNK_PASSWORD=your_password
PYBUNK_LOG_LEVEL=INFO
```

Install dependencies with `uv`:

```powershell
uv sync
```

Install frontend dependencies with Bun:

```powershell
cd frontend
bun install
```

## Ways to Use pybunk

### 1. CLI export flow

Fetch attendance and generate local report files:

```powershell
uv run main.py
```

This flow is best when you want the classic local exports written directly to the project folder.

### 2. FastAPI backend

Run the API server:

```powershell
uv run uvicorn api:app --reload
```

Available endpoints:

- `GET /api/health`
- `POST /api/attendance/fetch`
- `POST /api/planner/generate`

The API supports:

- attendance fetch with username and password
- legacy in-memory dataset handoff between fetch and planner calls
- stateless planner requests using `attendance_rows`
- event-based duty-leave planning
- no-event fallback planning from all bunk candidates
- manual bunk entries
- selected `?/1` rows as `not_marked` candidates
- per-course maximum DL limits
- planner JSON rows, formatted text, CSV text, and course-wise counts

Full API request and response docs live in [API.md](API.md).

### 3. Next.js frontend

Run the backend first:

```powershell
uv run uvicorn api:app --reload
```

Then in a second terminal run the frontend:

```powershell
cd frontend
copy .env.example .env.local
bun run dev
```

Frontend environment variables:

- `PYBUNK_API_BASE_URL` points to the FastAPI backend, defaulting to `http://127.0.0.1:8000`
- `PYBUNK_API_TOKEN` is optional and should match the backend bearer token when API protection is enabled

The BunkX frontend lets you:

- sign in with roll number and password
- fetch attendance through Next.js proxy routes
- view course, attendance, leave, and not-marked metrics
- pick event dates with a calendar
- add manual bunk rows
- include selected `?/1` rows as not-marked bunks
- tune per-course DL caps
- control planner cutoff date, lookback window, and default DL cap
- export the final planner output as CSV or TXT
- copy the formatted planner text directly from the browser

For local testing with one command, you can also start both the backend and frontend together:

```powershell
uv run python dev_stack.py
```

### 4. Interactive Streamlit planner

Run the UI:

```powershell
uv run streamlit run streamlit_app.py
```

The Streamlit app lets you:

- enter Moodle credentials directly in the UI
- fetch the latest attendance without editing `.env`
- pick event dates with a calendar input
- add manual bunk dates and courses
- include selected `?/1` rows as not-marked bunks
- tune per-course DL caps
- control planner cutoff date and lookback window
- download planner output as text and CSV

If you leave the event-date list empty, the planner switches to fallback mode and selects from all available bunk candidates.

The Streamlit app remains available as a fallback while the Next.js frontend becomes the main web UI.

## What Gets Exported

Running `main.py` writes these files to the project root:

- `leaves.csv` for `0/1` entries
- `unsure.csv` for `?/1` entries
- `leaves.txt` as a day-wise text export of `0/1` entries
- `unsure.txt` as a day-wise text export of `?/1` entries
- `duty_leaves.txt` as the generated duty-leave recommendation export

Running the Streamlit planner can additionally write:

- `interactive_duty_leaves.txt`
- `interactive_duty_leaves.csv`

## Planner Logic

Planner recommendations are built from a combination of LMS bunk rows, manual entries, and selected not-marked rows.

Current planner behavior:

- `0/1` rows are treated as LMS bunk candidates
- selected `?/1` rows can be promoted into planning candidates
- manual entries are tagged separately so you can track their source
- each course is capped by its configured `max_dl`
- when event dates are provided, rows are matched only if they fall within the configured lookback window before an event
- when no event dates are provided, the planner falls back to the full candidate pool

## Production Deployment

For a production Next.js site, the safest setup is:

1. Deploy this FastAPI app on Railway.
2. Call it from Next.js server routes or server actions, not directly from the browser.
3. Protect the Python API with a bearer token stored only in server-side environment variables.

Recommended environment variables:

- `PYBUNK_API_TOKEN` as a strong random secret for server-to-server auth
- `PYBUNK_ALLOWED_ORIGINS` as a comma-separated list of allowed frontend origins
- `PYBUNK_TRUSTED_HOSTS` as a comma-separated list of Railway and custom domains
- `PYBUNK_RATE_LIMIT_PER_MINUTE` to throttle abusive traffic
- `PYBUNK_DATASET_TTL_SECONDS` to limit how long legacy `dataset_id` values stay valid
- `PYBUNK_ENABLE_DOCS=false` if you want to hide Swagger docs in production

Railway can start the app using the included [Procfile](C:\Users\VISHNUNATH\Desktop\pybunk\Procfile).

## Data Enrichment

For each course, `pybunk` also tries to collect:

- normalized course code and subject name
- faculty names from the Moodle participants view
- faculty email addresses from teacher profiles when available

When multiple teacher records exist, the parser prefers cleaner faculty names over ID-like labels where possible.

## Notes

- Some Moodle courses may not expose an attendance module; those courses are skipped.
- The API keeps fetched datasets in memory, so restarting the server clears old `dataset_id` values.
- Swagger UI is available at `http://127.0.0.1:8000/docs` when the API is running.
