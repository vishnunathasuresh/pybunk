# pybunk

`pybunk` is a Moodle attendance toolkit for IIIT Kottayam UG-2024 that fetches live attendance data, enriches it with course and faculty details, and helps you build duty-leave plans through a CLI flow, a FastAPI backend, or an interactive Streamlit app.

## Modern Features

- Moodle login and attendance fetch for all in-progress courses
- Automatic attendance-module discovery per course
- Structured attendance parsing with course code, subject name, faculty, faculty email, session time, and score
- FastAPI backend with OpenAPI docs at `/docs`
- Streamlit planner for interactive DL planning
- Manual bunk entry support when LMS is not updated yet
- `?/1` selection support for not-marked classes
- Per-course duty-leave caps
- Configurable cutoff date and event lookback window in the planner
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
- in-memory dataset handoff between fetch and planner calls
- event-based duty-leave planning
- no-event fallback planning from all bunk candidates
- manual bunk entries
- selected `?/1` rows as `not_marked` candidates
- per-course maximum DL limits
- planner text output and course-wise counts

Full API request and response docs live in [API.md](API.md).

### 3. Interactive Streamlit planner

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
