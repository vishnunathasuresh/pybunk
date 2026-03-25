# pybunk

`pybunk` logs into the IIIT Kottayam UG-2024 Moodle instance, pulls attendance data for in-progress courses, and generates leave-oriented reports from the attendance module.

## Features

- Logs into Moodle using credentials from `.env`
- Fetches enrolled in-progress courses through Moodle's AJAX API
- Finds each course attendance module automatically
- Pulls the user attendance report (`view=5`) for each course
- Extracts course code, subject name, faculty, date, session time, and attendance score
- Generates CSV and TXT outputs for:
  - `0/1` leave entries
  - `?/1` unsure entries
  - suggested duty leaves

## Setup

Create a `.env` file in the project root:

```env
PYBUNK_USERNAME=your_username
PYBUNK_PASSWORD=your_password
PYBUNK_LOG_LEVEL=INFO
```

Install the dependencies if you are not using the existing virtual environment:

```powershell
.venv\Scripts\python.exe -m pip install requests beautifulsoup4 pandas python-dotenv
```

## Run

```powershell
.venv\Scripts\python.exe main.py
```

## Generated Files

Running `main.py` writes these files to the project root:

- `leaves.csv`
  - Only `0/1` entries
  - Columns: `date,session_time,course`
- `unsure.csv`
  - Only `?/1` entries
  - Columns: `date,session_time,course`
- `leaves.txt`
  - Day-wise text export of `0/1` entries
- `unsure.txt`
  - Day-wise text export of `?/1` entries
- `duty_leaves.txt`
  - Suggested duty-leave entries derived from configured event dates
  - Appends `DL Count By Course` at the end

## Duty Leave Logic

The duty-leave export currently follows these rules:

- Only uses attendance entries with score `0/1`
- Only considers records on or before `17-03-2026`
- Matches only leaves that fall close before configured event dates
- Uses a `0 to 4 days before event` window
- Caps recommendations at `8` duty leaves per course
- Keeps the closest matching dates first when a course exceeds the cap

The event dates are currently hardcoded in `main.py`.

## Faculty Extraction

Faculty names are collected from the Moodle participants page for each course. When multiple teacher accounts exist, the script prefers teacher names without ID-like prefixes when possible.

## Notes

- `IHS222 Principles of Management` currently has no attendance module, so it is skipped.
- The TXT reports are grouped day-wise, with entries like:

```text
11-03-2026
2PM - 3PM : ICS222 : Object-Oriented Analysis and Design : Jisha Mariyam John
----
DL Count By Course
ICS222 : Object-Oriented Analysis and Design : 3
```
