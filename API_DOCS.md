# Moodle Integration API Documentation

This document provides extensive technical documentation on how `pybunk` integrates with the IIIT Kottayam Moodle LMS to fetch attendance data, parse course information, and generate duty-leave recommendations.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Moodle LMS Base URL](#moodle-lms-base-url)
3. [Authentication Flow](#authentication-flow)
4. [Session Management](#session-management)
5. [Course Discovery](#course-discovery)
6. [Attendance Module Detection](#attendance-module-detection)
7. [Attendance Data Extraction](#attendance-data-extraction)
8. [Faculty Information Retrieval](#faculty-information-retrieval)
9. [Data Parsing and Normalization](#data-parsing-and-normalization)
10. [API Endpoints](#api-endpoints)
11. [Request/Response Flow](#requestresponse-flow)
12. [Error Handling](#error-handling)
13. [Security Considerations](#security-considerations)
14. [Implementation Details](#implementation-details)
15. [Frontend Integration](#frontend-integration)

---

## Architecture Overview

`pybunk` uses a multi-layered architecture to interact with Moodle:

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Layer                             │
│  (Next.js Frontend / Streamlit / CLI / cURL)                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   FastAPI Backend (api.py)                   │
│  - Authentication Guard                                      │
│  - Rate Limiting                                             │
│  - CORS/Security Middleware                                  │
│  - Dataset Caching (in-memory)                               │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│               Moodle Scraper (main.py)                       │
│  - Session Management                                        │
│  - HTML Parsing (BeautifulSoup)                             │
│  - AJAX API Calls                                            │
│  - Attendance Data Extraction                                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            IIIT Kottayam Moodle LMS                          │
│     https://lmsug24.iiitkottayam.ac.in                      │
│  - Login Endpoint                                            │
│  - Dashboard                                                 │
│  - Course Enrollment API                                     │
│  - Attendance Module                                         │
│  - User Profiles                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

1. **FastAPI Backend** (`api.py`): REST API layer with security, rate limiting, and dataset management
2. **Moodle Scraper** (`main.py`): Core scraping logic using `requests` and `BeautifulSoup`
3. **Planner Engine** (`planner.py`): Duty-leave recommendation algorithm
4. **Frontend Implementations**:
   - Next.js (`frontend/`) - Primary web UI with server-side Moodle integration
   - Streamlit (`streamlit_app.py`) - Alternative interactive UI
   - CLI (`main.py`) - Direct script execution

---

## Moodle LMS Base URL

**Production URL**: `https://lmsug24.iiitkottayam.ac.in`

This is the base URL for all Moodle API interactions. The `ug24` subdomain indicates this is the undergraduate 2024 batch instance.

### Configuration

**Python Implementation** (`main.py`):
```python
BASE_URL = "https://lmsug24.iiitkottayam.ac.in"
```

**TypeScript Implementation** (`frontend/lib/lms.ts`):
```typescript
const BASE_URL = "https://lmsug24.iiitkottayam.ac.in"
```

---

## Authentication Flow

Moodle uses a multi-step authentication process with CSRF protection via login tokens.

### Step 1: Fetch Login Token

**Endpoint**: `GET /login/index.php`

**Purpose**: Retrieve a CSRF token required for login

**Request**:
```http
GET /login/index.php HTTP/1.1
Host: lmsug24.iiitkottayam.ac.in
User-Agent: Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
```

**Response**: HTML page containing a login form

**Token Extraction**:
The login token is embedded in an HTML input field:
```html
<input type="hidden" name="logintoken" value="AbCdEf123456..." />
```

**Python Implementation**:
```python
def get_login_token() -> str:
    response = session.get(f"{BASE_URL}/login/index.php", timeout=REQUEST_TIMEOUT)
    _ensure_success(response, "Fetching login page")
    
    soup = BeautifulSoup(response.text, "html.parser")
    token_input = soup.find("input", {"name": "logintoken"})
    if not token_input or not token_input.get("value"):
        raise RuntimeError("Login token not found on login page")
    
    return token_input["value"]
```

**TypeScript Implementation**:
```typescript
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
```

### Step 2: Submit Login Credentials

**Endpoint**: `POST /login/index.php`

**Request**:
```http
POST /login/index.php HTTP/1.1
Host: lmsug24.iiitkottayam.ac.in
Content-Type: application/x-www-form-urlencoded
User-Agent: Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36

anchor=&logintoken=AbCdEf123456...&username=B230001CS&password=your_password
```

**Form Parameters**:
- `anchor`: Empty string (Moodle-specific parameter)
- `logintoken`: Token obtained from Step 1
- `username`: Student roll number (e.g., `B230001CS`)
- `password`: Student password

**Success Response**:
- HTTP 302/303 redirect to `/my/` (dashboard)
- Session cookies set in response headers:
  - `MoodleSession`: Primary session identifier
  - Additional cookies for session management

**Failure Response**:
- HTTP 200 with login form redisplayed
- Error message in HTML indicating invalid credentials

**Python Implementation**:
```python
def login(username: str | None = None, password: str | None = None) -> None:
    resolved_username, resolved_password = _resolve_credentials(username, password)
    token = get_login_token()
    payload = {
        "anchor": "",
        "logintoken": token,
        "username": resolved_username,
        "password": resolved_password,
    }
    
    response = session.post(
        f"{BASE_URL}/login/index.php",
        data=payload,
        timeout=REQUEST_TIMEOUT,
    )
    _ensure_success(response, "Logging in")
    
    if "/my/" not in response.url and "dashboard" not in response.url:
        raise RuntimeError("Login failed. Check username/password or login flow.")
    
    logger.info("Logged in successfully")
```

### Authentication Validation

After successful login, verify authentication by:
1. Checking redirect URL contains `/my/` or `dashboard`
2. Verifying presence of `sesskey` in subsequent page HTML
3. Absence of `logintoken` in response (indicates still on login page)

**TypeScript Validation**:
```typescript
const html = await response.text()
if (
  response.url.includes("/login/index.php") &&
  html.includes("logintoken") &&
  !html.includes("sesskey")
) {
  throw new Error("LMS login failed. Check your roll number and password.")
}
```

---

## Session Management

Moodle uses HTTP cookies for session persistence and a `sesskey` for CSRF protection on API calls.

### Cookie Management

**Required Cookies**:
- `MoodleSession`: Primary session identifier
- Additional Moodle-specific cookies set during login

**Python Implementation**:
Uses `requests.Session()` which automatically handles cookies:
```python
session = requests.Session()
session.headers.update(DEFAULT_HEADERS)

# Cookies are automatically stored and sent with subsequent requests
login(username, password)
# All subsequent calls use the authenticated session
```

**TypeScript Implementation**:
Manual cookie management in server-side code:
```typescript
class LmsClient {
  private readonly cookies = new Map<string, string>()
  
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
    const cookies = getSetCookie
      ? getSetCookie.call(response.headers)
      : splitSetCookieHeader(response.headers.get("set-cookie"))
    
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
}
```

### Session Key (sesskey)

The `sesskey` is a CSRF token required for Moodle AJAX API calls.

**Extraction from Dashboard**:
```python
def get_sesskey() -> str:
    response = session.get(f"{BASE_URL}/my/", timeout=REQUEST_TIMEOUT)
    _ensure_success(response, "Loading dashboard")
    return _extract_sesskey(response.text)

def _extract_sesskey(html: str) -> str:
    patterns = [
        r'"sesskey":"([^"]+)"',
        r'"sesskey"\s*:\s*"([^"]+)"',
        r"M\.cfg\.sesskey\s*=\s*'([^']+)'",
        r'"wwwroot":"[^"]+","sesskey":"([^"]+)"',
        r'name="sesskey"\s+value="([^"]+)"',
    ]
    
    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            return match.group(1)
    
    raise RuntimeError("Session key not found in dashboard HTML")
```

**Common sesskey locations in HTML**:
1. JavaScript configuration: `M.cfg.sesskey = 'abc123'`
2. JSON configuration: `{"sesskey":"abc123"}`
3. Hidden form inputs: `<input name="sesskey" value="abc123">`

---

## Course Discovery

Moodle exposes enrolled courses through an AJAX API endpoint.

### Endpoint

**URL**: `POST /lib/ajax/service.php`

**Query Parameters**:
- `sesskey`: CSRF token from dashboard
- `info`: API method name (`core_course_get_enrolled_courses_by_timeline_classification`)

### Request Structure

**Full URL**:
```
POST /lib/ajax/service.php?sesskey=abc123&info=core_course_get_enrolled_courses_by_timeline_classification
```

**Headers**:
```http
Content-Type: application/json
Accept: application/json, text/javascript, */*; q=0.01
Cookie: MoodleSession=...
```

**Request Body** (JSON array):
```json
[
  {
    "index": 0,
    "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
    "args": {
      "offset": 0,
      "limit": 0,
      "classification": "inprogress",
      "sort": "fullname"
    }
  }
]
```

**Parameters Explained**:
- `index`: Request identifier (0 for single request)
- `methodname`: Moodle web service method
- `args.offset`: Pagination offset (0 for all)
- `args.limit`: Maximum results (0 for unlimited)
- `args.classification`: Course status filter
  - `inprogress`: Currently active courses
  - `past`: Completed courses
  - `future`: Upcoming courses
- `args.sort`: Sort order (`fullname`, `shortname`, etc.)

### Response Structure

**Success Response**:
```json
[
  {
    "error": false,
    "data": {
      "courses": [
        {
          "id": 123,
          "fullname": "ICS222 Object-Oriented Analysis and Design",
          "shortname": "ICS222",
          "viewurl": "https://lmsug24.iiitkottayam.ac.in/course/view.php?id=123",
          "courseimage": "...",
          "progress": 45.5,
          "hasprogress": true,
          "isfavourite": false,
          "hidden": false,
          "showshortname": false,
          "coursecategory": "Department of Computer Science"
        }
      ],
      "nextoffset": 10
    }
  }
]
```

**Error Response**:
```json
[
  {
    "error": true,
    "exception": {
      "message": "Invalid sesskey",
      "errorcode": "invalidsesskey"
    }
  }
]
```

### Python Implementation

```python
def get_courses(sesskey: str) -> list[dict[str, Any]]:
    payload = [
        {
            "index": 0,
            "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
            "args": {
                "offset": 0,
                "limit": 0,
                "classification": "inprogress",
                "sort": "fullname",
            },
        }
    ]
    
    response = session.post(
        (
            f"{BASE_URL}/lib/ajax/service.php"
            f"?sesskey={sesskey}"
            f"&info=core_course_get_enrolled_courses_by_timeline_classification"
        ),
        json=payload,
        headers=AJAX_HEADERS,
        timeout=REQUEST_TIMEOUT,
    )
    _ensure_success(response, "Fetching enrolled courses")
    
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("Courses API did not return JSON") from exc
    
    if not isinstance(data, list) or not data:
        raise RuntimeError("Courses API returned an unexpected payload")
    
    first_item = data[0]
    if first_item.get("error"):
        raise RuntimeError(f"Courses API error: {first_item['error']}")
    
    courses = first_item.get("data", {}).get("courses", [])
    if not isinstance(courses, list):
        raise RuntimeError("Courses list missing in API response")
    
    return courses
```

### Course Data Extraction

For each course, extract:
- `id`: Numeric course identifier (used for subsequent API calls)
- `fullname`: Complete course name (e.g., "ICS222 Object-Oriented Analysis and Design")
- `shortname`: Abbreviated course code (e.g., "ICS222")

**Course Name Parsing**:
```python
def _split_course_name(course_name: str) -> tuple[str, str]:
    normalized = _normalize_whitespace(course_name)
    first_space = normalized.find(" ")
    
    if first_space > 0:
        course_code = normalized[:first_space]
        subject_name = normalized[first_space + 1:]
        return course_code, subject_name
    
    return normalized, ""
```

**Example**:
- Input: `"ICS222 Object-Oriented Analysis and Design"`
- Output: `("ICS222", "Object-Oriented Analysis and Design")`

---

## Attendance Module Detection

Each course may have an attendance module. `pybunk` automatically discovers it by parsing the course page.

### Endpoint

**URL**: `GET /course/view.php?id={course_id}`

**Example**:
```
GET /course/view.php?id=123
```

### Request

```http
GET /course/view.php?id=123 HTTP/1.1
Host: lmsug24.iiitkottayam.ac.in
Cookie: MoodleSession=...
User-Agent: Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36
```

### Response

HTML page containing course content, including activity modules.

### Module Detection Logic

**Search for attendance module links**:
```html
<a href="/mod/attendance/view.php?id=456">Attendance</a>
```

**Python Implementation**:
```python
def get_attendance_module(course_id: int | str) -> str | None:
    response = session.get(
        f"{BASE_URL}/course/view.php?id={course_id}",
        timeout=REQUEST_TIMEOUT,
    )
    _ensure_success(response, f"Loading course page for course {course_id}")
    
    soup = BeautifulSoup(response.text, "html.parser")
    
    for link in soup.find_all("a", href=True):
        href = urljoin(BASE_URL, link["href"])
        if "/mod/attendance/view.php" not in href:
            continue
        
        query = parse_qs(urlparse(href).query)
        module_ids = query.get("id")
        if module_ids and module_ids[0]:
            return module_ids[0]
    
    return None
```

**TypeScript Implementation**:
```typescript
async getAttendanceModule(courseId: number | string) {
  const response = await this.request(
    `${BASE_URL}/course/view.php?id=${courseId}`,
    {},
    `Loading course page for course ${courseId}`
  )
  const html = await response.text()
  const $ = load(html)
  
  const href = $('a[href*="/mod/attendance/view.php"]').attr("href")
  if (!href) {
    return null
  }
  
  const url = new URL(href, BASE_URL)
  const moduleId = url.searchParams.get("id")
  return moduleId
}
```

**Behavior**:
- Returns module ID if attendance module exists
- Returns `null` if course has no attendance tracking
- Courses without attendance modules are skipped in data collection

---

## Attendance Data Extraction

Attendance records are fetched from the attendance module's report view.

### Endpoint

**URL**: `GET /mod/attendance/view.php?id={module_id}&view=5`

**Parameters**:
- `id`: Attendance module ID (from previous step)
- `view`: Report view type
  - `5`: Student attendance report (full list view)

**Example**:
```
GET /mod/attendance/view.php?id=456&view=5
```

### Request

```http
GET /mod/attendance/view.php?id=456&view=5 HTTP/1.1
Host: lmsug24.iiitkottayam.ac.in
Cookie: MoodleSession=...
```

### Response

HTML page containing an attendance table.

### Table Structure

**HTML Format**:
```html
<table class="generaltable">
  <thead>
    <tr>
      <th>Date</th>
      <th>Description</th>
      <th>Status</th>
      <th>Points</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Monday, 11 March 2024, 2:00 PM</td>
      <td>Lecture</td>
      <td>Present (1/1)</td>
      <td>1</td>
    </tr>
    <tr>
      <td>Wednesday, 13 March 2024, 2:00 PM - 3:00 PM</td>
      <td>Lab</td>
      <td>Leave (0/1)</td>
      <td>0</td>
    </tr>
    <tr>
      <td>Friday, 15 March 2024, 2:00 PM</td>
      <td></td>
      <td>Not marked (?/1)</td>
      <td>0</td>
    </tr>
  </tbody>
</table>
```

### Table Detection

**Python Implementation**:
```python
def _find_attendance_table(soup: BeautifulSoup) -> Any | None:
    # Try common Moodle table classes
    for class_name in ["generaltable", "flexible", "table"]:
        table = soup.find("table", {"class": class_name})
        if table:
            return table
    
    # Fallback to any table
    return soup.find("table")
```

### Data Parsing

**Python Implementation**:
```python
def get_attendance(module_id: int | str) -> list[dict[str, Any]]:
    response = session.get(
        f"{BASE_URL}/mod/attendance/view.php?id={module_id}&view=5",
        timeout=REQUEST_TIMEOUT,
    )
    _ensure_success(response, f"Loading attendance report for module {module_id}")
    
    soup = BeautifulSoup(response.text, "html.parser")
    table = _find_attendance_table(soup)
    if table is None:
        return []
    
    rows = table.find_all("tr")
    if len(rows) <= 1:  # Header only
        return []
    
    records: list[dict[str, Any]] = []
    
    for row in rows[1:]:  # Skip header
        cells = row.find_all("td")
        if not cells:
            continue
        
        values = [_normalize_text(cell) for cell in cells]
        if len(values) < 3:
            continue
        
        period_date = values[0]
        description = values[1] if len(values) >= 4 else ""
        status = values[2] if len(values) == 3 else values[3]
        
        attendance_date, session_time = _split_period_datetime(period_date)
        score = _extract_score(status)
        points_earned, points_total = _extract_points(status)
        
        records.append({
            "period_date": attendance_date,
            "period_text": period_date,
            "session_time": session_time,
            "description": description,
            "status": status,
            "score": score,
            "points_earned": points_earned,
            "points_total": points_total,
        })
    
    return records
```

### Date/Time Parsing

**Period Date Format Examples**:
- `"Monday, 11 March 2024, 2:00 PM"`
- `"Wednesday, 13 March 2024, 2:00 PM - 3:00 PM"`
- `"15-03-2024 2PM"`

**Python Parsing Function**:
```python
def _split_period_datetime(period_text: str) -> tuple[str, str]:
    # Pattern 1: "Day, DD Month YYYY, HH:MM [AM|PM][ - HH:MM [AM|PM]]"
    match = re.search(
        r"(\d{1,2})\s+(\w+)\s+(\d{4})[,\s]+(.+)",
        period_text,
        re.IGNORECASE,
    )
    if match:
        day, month_name, year, time_text = match.groups()
        date_str = f"{day.zfill(2)} {month_name} {year}"
        parsed = datetime.strptime(date_str, "%d %B %Y")
        return parsed.strftime("%Y-%m-%d"), time_text.strip()
    
    # Pattern 2: "DD-MM-YYYY HH:MM"
    match = re.search(r"(\d{2}-\d{2}-\d{4})\s+(.+)", period_text)
    if match:
        date_str, time_text = match.groups()
        parsed = datetime.strptime(date_str, "%d-%m-%Y")
        return parsed.strftime("%Y-%m-%d"), time_text.strip()
    
    # Fallback: return original text
    return period_text, ""
```

**Session Time Formatting**:
```python
def _format_session_time(time_text: str) -> str:
    # Normalize: "2:00 PM - 3:00 PM" → "2PM - 3PM"
    normalized = re.sub(r":00", "", time_text)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip().upper()
```

### Score Extraction

**Status Field Examples**:
- `"Present (1/1)"` → Score: `1/1`
- `"Leave (0/1)"` → Score: `0/1`
- `"Not marked (?/1)"` → Score: `?/1`
- `"Excused"` → Score: `E/1`

**Python Extraction**:
```python
def _extract_score(status: str) -> str:
    match = re.search(r"([0-9\?E])/([0-9])", status, re.IGNORECASE)
    if match:
        return f"{match.group(1)}/{match.group(2)}"
    return ""
```

**Score Interpretation**:
- `1/1`: Present
- `0/1`: Leave/Absent (candidate for duty leave)
- `?/1`: Not yet marked (can be manually selected)
- `E/1`: Excused

### Points Extraction

```python
def _extract_points(status: str) -> tuple[float, float]:
    match = re.search(r"([0-9.]+)\s*/\s*([0-9.]+)", status)
    if match:
        try:
            earned = float(match.group(1))
            total = float(match.group(2))
            return earned, total
        except ValueError:
            pass
    return 0.0, 1.0
```

---

## Faculty Information Retrieval

For each course, `pybunk` fetches faculty details from the participants page.

### Endpoint

**URL**: `GET /user/index.php?id={course_id}&perpage=5000`

**Parameters**:
- `id`: Course ID
- `perpage`: Number of participants per page (5000 ensures all are fetched)

**Example**:
```
GET /user/index.php?id=123&perpage=5000
```

### Request

```http
GET /user/index.php?id=123&perpage=5000 HTTP/1.1
Host: lmsug24.iiitkottayam.ac.in
Cookie: MoodleSession=...
```

### Response

HTML page with a table of course participants.

### Table Structure

```html
<table class="generaltable">
  <thead>
    <tr>
      <th>Full name</th>
      <th>Roles</th>
      <th>Groups</th>
      <th>Last access</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>
        <a href="/user/view.php?id=789&course=123">Dr. John Doe</a>
      </td>
      <td>Teacher</td>
      <td></td>
      <td>1 hour ago</td>
    </tr>
    <tr>
      <td>
        <a href="/user/view.php?id=790&course=123">Prof. Jane Smith</a>
      </td>
      <td>Non-editing teacher</td>
      <td></td>
      <td>2 days ago</td>
    </tr>
    <tr>
      <td>
        <a href="/user/view.php?id=1001&course=123">Student Name</a>
      </td>
      <td>Student</td>
      <td>Group A</td>
      <td>Just now</td>
    </tr>
  </tbody>
</table>
```

### Faculty Identification

**Target Roles**:
- `"Teacher"`
- `"Non-editing teacher"`

**Python Implementation**:
```python
def get_course_faculty(course_id: int | str) -> tuple[str, str]:
    response = session.get(
        f"{BASE_URL}/user/index.php?id={course_id}&perpage=5000",
        timeout=REQUEST_TIMEOUT,
    )
    _ensure_success(response, f"Loading participants page for course {course_id}")
    
    soup = BeautifulSoup(response.text, "html.parser")
    teacher_roles = {"Teacher", "Non-editing teacher"}
    faculty_entries: list[dict[str, Any]] = []
    
    for row in soup.find_all("tr"):
        values = [_normalize_text(cell) for cell in row.find_all("td")]
        if len(values) < 4:
            continue
        
        participant_name, role_name = values[0], values[1]
        if role_name not in teacher_roles or not participant_name.strip():
            continue
        
        cleaned_name = _clean_participant_name(participant_name)
        if cleaned_name:
            profile_link = row.find("a", href=True)
            profile_url = urljoin(BASE_URL, profile_link["href"]) if profile_link else ""
            faculty_entries.append({
                "name": cleaned_name,
                "email": get_faculty_email(profile_url) if profile_url else "",
                "preferred": not re.search(r"\d", participant_name),
            })
    
    if not faculty_entries:
        return "Unknown Faculty", ""
    
    # Deduplicate
    unique_entries: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for entry in faculty_entries:
        key = (entry["name"], entry["email"])
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        unique_entries.append(entry)
    
    # Prefer entries without numeric IDs in name
    preferred_entries = [entry for entry in unique_entries if entry["preferred"]]
    chosen_entries = preferred_entries or unique_entries
    
    faculty_names = ", ".join(entry["name"] for entry in chosen_entries)
    faculty_emails = ", ".join(
        entry["email"] for entry in chosen_entries if entry["email"]
    )
    
    return faculty_names, faculty_emails
```

### Name Cleaning

**Remove platform IDs from faculty names**:
```python
def _clean_participant_name(raw_name: str) -> str:
    # Remove numeric IDs like "(123456)"
    cleaned = re.sub(r"\s*\(\d+\)\s*", "", raw_name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned if cleaned else raw_name
```

**Example**:
- Input: `"Dr. John Doe (123456)"`
- Output: `"Dr. John Doe"`

### Email Extraction

Faculty email addresses are fetched from individual profile pages.

**Profile URL Format**:
```
/user/view.php?id=789&course=123
```

**Email Extraction Logic**:
```python
def get_faculty_email(profile_url: str) -> str:
    user_id = _extract_user_id_from_url(profile_url)
    if user_id is None or user_id in profile_email_cache:
        return profile_email_cache.get(user_id, "")
    
    response = session.get(profile_url, timeout=REQUEST_TIMEOUT)
    _ensure_success(response, f"Loading profile {profile_url}")
    
    email = _extract_email_from_profile_html(response.text)
    if user_id is not None:
        profile_email_cache[user_id] = email
    
    return email

def _extract_email_from_profile_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    
    # Look for email in profile fields
    for dt_tag in soup.find_all("dt"):
        if "email" in dt_tag.get_text().lower():
            dd_tag = dt_tag.find_next_sibling("dd")
            if dd_tag:
                # Check for mailto link
                mailto = dd_tag.find("a", href=lambda h: h and h.startswith("mailto:"))
                if mailto:
                    return mailto["href"].replace("mailto:", "").strip()
                # Check for plain text email
                text = dd_tag.get_text().strip()
                if "@" in text:
                    return text
    
    return ""
```

**Caching Strategy**:
- Profile emails are cached by user ID to avoid redundant requests
- Cache is cleared when starting a new session

---

## Data Parsing and Normalization

### Text Normalization

**Whitespace Normalization**:
```python
def _normalize_whitespace(value: str) -> str:
    return " ".join(str(value).split()).strip()
```

**Examples**:
- `"ICS222    Object-Oriented"` → `"ICS222 Object-Oriented"`
- `"2PM  -  3PM"` → `"2PM - 3PM"`

**HTML Entity Decoding**:
```python
from html import unescape

def _normalize_text(cell) -> str:
    text = cell.get_text(separator=" ", strip=True)
    text = unescape(text)  # Convert &nbsp; etc.
    return _normalize_whitespace(text)
```

### Date Standardization

All dates are converted to ISO format (`YYYY-MM-DD`) for consistent processing.

**Input Formats**:
- `"11 March 2024"` → `"2024-03-11"`
- `"11-03-2024"` → `"2024-03-11"`
- `"Monday, 11 March 2024"` → `"2024-03-11"`

**Pandas Conversion**:
```python
dataframe["period_date"] = pd.to_datetime(dataframe["period_date"], errors="coerce")
```

### Session Time Normalization

**Format Examples**:
- Input: `"2:00 PM - 3:00 PM"` → Output: `"2PM - 3PM"`
- Input: `"14:00 - 15:00"` → Output: `"14:00 - 15:00"`
- Input: `"Morning Session"` → Output: `"MORNING SESSION"`

```python
def _format_session_time(session_time: str) -> str:
    normalized = re.sub(r":00", "", session_time)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip().upper()
```

---

## API Endpoints

The FastAPI backend (`api.py`) exposes three main endpoints.

### 1. Health Check

**Endpoint**: `GET /api/health`

**Purpose**: Service availability check

**Response**:
```json
{
  "status": "ok"
}
```

**Usage**:
```bash
curl http://127.0.0.1:8000/api/health
```

### 2. Fetch Attendance

**Endpoint**: `POST /api/attendance/fetch`

**Purpose**: Authenticate with Moodle, fetch attendance data, and return structured response

**Request Methods**:

**Method 1: JSON Body**
```json
{
  "username": "B230001CS",
  "password": "your_password"
}
```

**Method 2: Basic Authentication Header**
```http
Authorization: Basic QjIzMDAwMUNTOnlvdXJfcGFzc3dvcmQ=
```

**Method 3: Custom Headers**
```http
X-Pybunk-Username: B230001CS
X-Pybunk-Password: your_password
```

**Response Structure**:
```json
{
  "dataset_id": "uuid-string",
  "dataset_expires_at": "2026-03-25T10:15:00+00:00",
  "summary": {
    "attendance_rows": 48,
    "course_count": 6,
    "leave_rows": 9,
    "not_marked_rows": 2
  },
  "attendance_rows": [...],
  "course_catalog": [...],
  "default_course_limits": [...],
  "not_marked_rows": [...]
}
```

**Implementation Flow**:
1. Extract credentials from request (headers take precedence over body)
2. Acquire `FETCH_LOCK` to prevent concurrent Moodle sessions
3. Call `fetch_attendance_dataframe(username, password)`
4. Assign unique `record_id` to each attendance row
5. Store dataset in memory with TTL
6. Build course catalog and identify not-marked rows
7. Return structured response

**Python Backend Code**:
```python
@app.post("/api/attendance/fetch", dependencies=[Depends(_require_api_guard)])
def fetch_attendance(
    raw_request: Request,
    request: AttendanceFetchRequest | None = None,
) -> dict[str, Any]:
    username, password = _resolve_fetch_credentials(request, raw_request)
    attendance_df = _fetch_attendance_dataframe(
        username=username,
        password=password,
    )
    return _fetch_response(attendance_df)
```

**Security Features**:
- Rate limiting per client IP
- Optional bearer token authentication
- CORS restrictions
- Credential validation

### 3. Generate Planner

**Endpoint**: `POST /api/planner/generate`

**Purpose**: Generate duty-leave recommendations based on attendance data and event dates

**Request Structure**:
```json
{
  "attendance_rows": [...],
  "event_dates": ["2026-03-17", "2026-03-18"],
  "manual_entries": [
    {
      "date": "2026-03-15",
      "course_code": "ICS222",
      "session_time": "2PM - 3PM"
    }
  ],
  "not_marked_record_ids": ["rec_14", "rec_23"],
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

**Input Modes**:

**1. Stateless Mode (Recommended)**:
```json
{
  "attendance_rows": [...],
  "event_dates": [...],
  "course_limits": [...]
}
```

**2. Legacy Mode**:
```json
{
  "dataset_id": "uuid-from-fetch",
  "event_dates": [...],
  "course_limits": [...]
}
```

**Response Structure**:
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
      "faculty": "Dr. John Doe",
      "faculty_email": "john@example.com",
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
  "planner_csv": "...",
  "planner_text": "..."
}
```

**Planner Logic**:

1. **Candidate Collection**:
   - LMS rows with `score == "0/1"` (already bunked)
   - Manual entries (user-provided bunks)
   - Not-marked rows (selected `?/1` entries)

2. **Filtering**:
   - Apply `cutoff_date` (exclude future dates)
   - Filter by `course_limits` (only include courses with `max_dl > 0`)

3. **Event Matching** (if `event_dates` provided):
   - For each candidate, find nearest event within lookback window
   - Match only rows that are 0-N days before an event (N = `lookback_days`)
   - Prioritize rows closer to events

4. **Selection**:
   - Group by course
   - Sort by priority (days before event, date, time)
   - Take top `max_dl` rows per course

5. **Formatting**:
   - Generate day-wise text output
   - Create CSV export
   - Calculate per-course counts

**Implementation**:
```python
@app.post("/api/planner/generate", dependencies=[Depends(_require_api_guard)])
def generate_planner_plan(request: PlannerRequest) -> dict[str, Any]:
    attendance_df = _attendance_df_from_request(request)
    
    manual_entries_df = pd.DataFrame([...])
    not_marked_entries_df = attendance_df.loc[
        attendance_df["record_id"].isin(request.not_marked_record_ids)
    ].copy()
    course_limits = {item.course_code: item.max_dl for item in request.course_limits}
    
    plan_df = planner.generate_duty_leave_plan(
        attendance_df,
        request.event_dates,
        course_limits,
        cutoff_date=request.cutoff_date,
        lookback_days=request.lookback_days,
        manual_entries=manual_entries_df,
        not_marked_entries=not_marked_entries_df,
    )
    return _planner_response(plan_df)
```

---

## Request/Response Flow

### Complete Workflow Diagram

```
┌──────────────┐
│   Client     │
└──────┬───────┘
       │
       │ 1. POST /api/attendance/fetch
       │    Body: {username, password}
       ▼
┌──────────────────────────────────────┐
│  FastAPI Backend                     │
│  ┌────────────────────────────────┐  │
│  │ _require_api_guard()           │  │
│  │  - Check bearer token          │  │
│  │  - Enforce rate limit          │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ _resolve_fetch_credentials()   │  │
│  │  - Extract from headers/body   │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ FETCH_LOCK.acquire()           │  │
│  └────────────┬───────────────────┘  │
└───────────────┼──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  Moodle Scraper (main.py)            │
│  ┌────────────────────────────────┐  │
│  │ login(username, password)      │  │
│  │  1. GET /login/index.php       │  │
│  │  2. Extract logintoken         │  │
│  │  3. POST credentials           │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ get_sesskey()                  │  │
│  │  1. GET /my/                   │  │
│  │  2. Extract sesskey from HTML  │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ get_courses(sesskey)           │  │
│  │  1. POST AJAX endpoint         │  │
│  │  2. Parse course list          │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ For each course:               │  │
│  │  ┌──────────────────────────┐  │  │
│  │  │ get_attendance_module()  │  │  │
│  │  │  GET /course/view.php    │  │  │
│  │  └────────┬─────────────────┘  │  │
│  │           ▼                    │  │
│  │  ┌──────────────────────────┐  │  │
│  │  │ get_course_faculty()     │  │  │
│  │  │  GET /user/index.php     │  │  │
│  │  │  For each teacher:       │  │  │
│  │  │   - get_faculty_email()  │  │  │
│  │  └────────┬─────────────────┘  │  │
│  │           ▼                    │  │
│  │  ┌──────────────────────────┐  │  │
│  │  │ get_attendance()         │  │  │
│  │  │  GET /mod/attendance/... │  │  │
│  │  │  Parse table rows        │  │  │
│  │  └──────────────────────────┘  │  │
│  └────────────────────────────────┘  │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  Data Transformation                 │
│  - Normalize dates                   │
│  - Parse scores                      │
│  - Format session times              │
│  - Assign record_ids                 │
│  - Build pandas DataFrame            │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  FastAPI Backend                     │
│  ┌────────────────────────────────┐  │
│  │ _store_dataset()               │  │
│  │  - Generate UUID               │  │
│  │  - Set expiry timestamp        │  │
│  │  - Cache DataFrame             │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ _fetch_response()              │  │
│  │  - Build course catalog        │  │
│  │  - Extract not_marked_rows     │  │
│  │  - Create default limits       │  │
│  │  - Serialize to JSON           │  │
│  └────────────┬───────────────────┘  │
└───────────────┼──────────────────────┘
                │
                ▼
┌──────────────┐
│   Client     │
│  Receives:   │
│  - dataset_id│
│  - rows      │
│  - catalog   │
└──────────────┘
```

### Planner Generation Flow

```
┌──────────────┐
│   Client     │
└──────┬───────┘
       │
       │ 2. POST /api/planner/generate
       │    Body: {attendance_rows, event_dates, course_limits, ...}
       ▼
┌──────────────────────────────────────┐
│  FastAPI Backend                     │
│  ┌────────────────────────────────┐  │
│  │ _attendance_df_from_request()  │  │
│  │  - Use attendance_rows OR      │  │
│  │  - Retrieve dataset_id         │  │
│  └────────────┬───────────────────┘  │
│               ▼                      │
│  ┌────────────────────────────────┐  │
│  │ Parse manual_entries           │  │
│  │ Parse not_marked_record_ids    │  │
│  │ Build course_limits dict       │  │
│  └────────────┬───────────────────┘  │
└───────────────┼──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  Planner Engine (planner.py)         │
│  ┌────────────────────────────────┐  │
│  │ generate_duty_leave_plan()     │  │
│  │  1. Collect candidates         │  │
│  │     - LMS bunks (0/1)          │  │
│  │     - Manual entries           │  │
│  │     - Not-marked selections    │  │
│  │  2. Apply cutoff_date filter   │  │
│  │  3. Filter by course_limits    │  │
│  │  4. Event matching (optional)  │  │
│  │  5. Sort by priority           │  │
│  │  6. Select top N per course    │  │
│  └────────────┬───────────────────┘  │
└───────────────┼──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  FastAPI Backend                     │
│  ┌────────────────────────────────┐  │
│  │ _planner_response()            │  │
│  │  - recommendation_preview()    │  │
│  │  - format_daywise_text()       │  │
│  │  - Generate CSV                │  │
│  │  - Calculate counts            │  │
│  └────────────┬───────────────────┘  │
└───────────────┼──────────────────────┘
                │
                ▼
┌──────────────┐
│   Client     │
│  Receives:   │
│  - plan rows │
│  - text      │
│  - CSV       │
└──────────────┘
```

---

## Error Handling

### Authentication Errors

**Scenario 1: Invalid Credentials**
```python
# Response: 400 Bad Request
{
  "detail": "Attendance fetch failed. Check credentials or Moodle availability."
}
```

**Scenario 2: Login Token Missing**
```python
# Response: 400 Bad Request
{
  "detail": "Login token not found on login page"
}
```

**Scenario 3: Sesskey Extraction Failed**
```python
# Response: 400 Bad Request
{
  "detail": "Session key not found in dashboard HTML"
}
```

### Rate Limiting

```python
# Response: 429 Too Many Requests
{
  "detail": "Rate limit exceeded. Please try again in a minute."
}
```

**Configuration**:
```python
RATE_LIMIT_PER_MINUTE = _env_int("PYBUNK_RATE_LIMIT_PER_MINUTE", 30, minimum=0)
```

### Bearer Token Authentication

```python
# Response: 401 Unauthorized
{
  "detail": "Missing bearer token."
}

# Response: 401 Unauthorized
{
  "detail": "Invalid bearer token."
}
```

### Dataset Expiry

```python
# Response: 404 Not Found
{
  "detail": "Unknown or expired dataset_id. Fetch attendance again or send attendance_rows."
}
```

**TTL Configuration**:
```python
DATASET_TTL_SECONDS = _env_int("PYBUNK_DATASET_TTL_SECONDS", 900, minimum=60)
# Default: 15 minutes
```

### Network Timeouts

**Configuration**:
```python
REQUEST_TIMEOUT = 60  # seconds
```

**Error Handling**:
```python
try:
    response = session.get(url, timeout=REQUEST_TIMEOUT)
except requests.Timeout:
    raise RuntimeError("Request timed out")
except requests.RequestException as exc:
    raise RuntimeError(f"Network error: {exc}")
```

---

## Security Considerations

### 1. Credential Handling

**Never Log Credentials**:
```python
logger.info("Processing fetch for user: %s", username)
# NEVER: logger.info("Password: %s", password)
```

**Secure Transmission**:
- Use HTTPS in production
- Credentials sent in request body/headers (encrypted in transit)
- No credential storage on server

### 2. Session Isolation

Each API call creates a fresh Moodle session:
```python
def fetch_attendance_dataframe(username, password):
    global session
    session = requests.Session()  # Fresh session
    session.headers.update(DEFAULT_HEADERS)
    profile_email_cache.clear()
    login(username=username, password=password)
    # ... fetch data ...
```

**Benefits**:
- No session cross-contamination
- Automatic cleanup after request
- Thread-safe with `FETCH_LOCK`

### 3. CORS Configuration

```python
ALLOWED_ORIGINS = _env_list(
    "PYBUNK_ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Pybunk-Username",
        "X-Pybunk-Password",
    ],
)
```

### 4. Trusted Hosts

```python
TRUSTED_HOSTS = _env_list("PYBUNK_TRUSTED_HOSTS", "*")

app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)
```

**Production Example**:
```bash
PYBUNK_TRUSTED_HOSTS=bunkx.example.com,api.bunkx.example.com
```

### 5. Rate Limiting

**Per-IP Tracking**:
```python
def _client_identifier(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", maxsplit=1)[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
```

**Sliding Window**:
```python
def _enforce_rate_limit(request: Request) -> None:
    identifier = _client_identifier(request)
    now = time.monotonic()
    window_start = now - 60
    
    with RATE_LIMIT_LOCK:
        bucket = REQUEST_BUCKETS.setdefault(identifier, deque())
        while bucket and bucket[0] < window_start:
            bucket.popleft()
        
        if len(bucket) >= RATE_LIMIT_PER_MINUTE:
            raise HTTPException(status_code=429, detail="Rate limit exceeded.")
        
        bucket.append(now)
```

### 6. Data Sanitization

**HTML Entity Decoding**:
```python
from html import unescape

text = unescape(raw_html_text)
```

**Whitespace Normalization**:
```python
normalized = " ".join(text.split()).strip()
```

**Prevents**:
- XSS via stored data
- Unicode normalization attacks
- SQL injection (not applicable, no database)

---

## Implementation Details

### Python Dependencies

**Core Libraries**:
```toml
[project.dependencies]
fastapi = "^0.115.12"
uvicorn = { extras = ["standard"], version = "^0.34.0" }
requests = "^2.32.3"
beautifulsoup4 = "^4.12.3"
pandas = "^2.2.3"
pydantic = "^2.10.6"
python-dotenv = "^1.0.1"
streamlit = "^1.41.1"
```

**Key Libraries**:
- `requests`: HTTP client with session management
- `beautifulsoup4`: HTML parsing
- `pandas`: Data manipulation
- `fastapi`: REST API framework
- `pydantic`: Request/response validation

### TypeScript Dependencies

**Frontend Libraries**:
```json
{
  "dependencies": {
    "next": "^15.1.7",
    "react": "^19.0.0",
    "cheerio": "^1.0.0",
    "server-only": "^0.0.1"
  }
}
```

**Key Features**:
- `cheerio`: Server-side HTML parsing (jQuery-like API)
- `server-only`: Ensures Moodle scraping stays server-side
- Next.js API routes: Server-side proxy to Moodle

### Concurrency Control

**Fetch Lock**:
```python
FETCH_LOCK = Lock()

with FETCH_LOCK:
    attendance_df = main.fetch_attendance_dataframe(
        username=username,
        password=password,
    )
```

**Purpose**:
- Prevent concurrent Moodle sessions
- Avoid session conflicts
- Serialize authentication flow

**Rate Limit Lock**:
```python
RATE_LIMIT_LOCK = Lock()

with RATE_LIMIT_LOCK:
    bucket = REQUEST_BUCKETS.setdefault(identifier, deque())
    # ... rate limit logic ...
```

**Purpose**:
- Thread-safe bucket access
- Prevent race conditions in counter updates

### In-Memory Dataset Storage

```python
DATASETS: dict[str, tuple[datetime, pd.DataFrame]] = {}

def _store_dataset(attendance_df: pd.DataFrame) -> tuple[str, str]:
    dataset_id = str(uuid4())
    expires_at = _now_utc() + timedelta(seconds=DATASET_TTL_SECONDS)
    with DATASET_LOCK:
        _cleanup_datasets()
        DATASETS[dataset_id] = (expires_at, attendance_df.copy())
    return dataset_id, expires_at.isoformat()
```

**Cleanup**:
```python
def _cleanup_datasets() -> None:
    now = _now_utc()
    expired_ids = [
        dataset_id
        for dataset_id, (expires_at, _) in DATASETS.items()
        if expires_at <= now
    ]
    for dataset_id in expired_ids:
        DATASETS.pop(dataset_id, None)
```

**Limitations**:
- Server restart clears all datasets
- Not suitable for horizontal scaling
- Use stateless mode for production

---

## Frontend Integration

### Next.js Server-Side Integration

The Next.js frontend implements its own Moodle client to avoid storing credentials on the Python backend.

**Architecture**:
```
Browser → Next.js API Route → Moodle LMS
         ↓
         → Python API (planner only)
```

**Attendance Fetch Route** (`app/api/attendance/fetch/route.ts`):
```typescript
export async function POST(request: Request) {
  const credentials = resolveCredentials(request, payload)
  
  // Direct Moodle integration
  const response = await fetchAttendanceResponse(
    credentials.username,
    credentials.password
  )
  
  return NextResponse.json(response)
}
```

**Benefits**:
- Credentials never reach Python backend
- Lower latency (direct Moodle communication)
- Stateless architecture (no server-side sessions)

**Planner Route** (`app/api/planner/generate/route.ts`):
```typescript
export async function POST(request: Request) {
  const payload = await request.json()
  
  // Call Python backend for planner logic
  const response = await fetch(`${PYTHON_API_URL}/api/planner/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify(payload),
  })
  
  return NextResponse.json(await response.json())
}
```

### Streamlit Integration

**Direct Backend Calls**:
```python
import streamlit as st
from main import fetch_attendance_dataframe

username = st.text_input("Roll Number")
password = st.text_input("Password", type="password")

if st.button("Fetch Attendance"):
    with st.spinner("Fetching from Moodle..."):
        df = fetch_attendance_dataframe(username, password)
    st.success("Attendance fetched!")
```

**Advantages**:
- No API layer needed
- Direct function calls
- Simpler for prototyping

**Disadvantages**:
- No rate limiting
- No authentication
- Single-user only

### CLI Usage

**Direct Script Execution**:
```bash
# Set environment variables
export PYBUNK_USERNAME=B230001CS
export PYBUNK_PASSWORD=your_password

# Run script
uv run main.py
```

**Output**:
- `leaves.csv`, `unsure.csv`: CSV exports
- `leaves.txt`, `unsure.txt`: Text exports
- `duty_leaves.txt`: Planner output

---

## Environment Variables

### Backend Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYBUNK_USERNAME` | `""` | Moodle username (CLI mode) |
| `PYBUNK_PASSWORD` | `""` | Moodle password (CLI mode) |
| `PYBUNK_LOG_LEVEL` | `"INFO"` | Logging level |
| `PYBUNK_API_TOKEN` | `""` | Bearer token for API protection |
| `PYBUNK_ALLOWED_ORIGINS` | `"http://localhost:3000,..."` | CORS allowed origins |
| `PYBUNK_TRUSTED_HOSTS` | `"*"` | Trusted host header values |
| `PYBUNK_RATE_LIMIT_PER_MINUTE` | `30` | Max requests per IP per minute |
| `PYBUNK_DATASET_TTL_SECONDS` | `900` | Dataset cache TTL (15 min) |
| `PYBUNK_ENABLE_DOCS` | `true` | Enable Swagger