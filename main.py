import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

import pandas as pd
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

BASE_URL = "https://lmsug24.iiitkottayam.ac.in"
CUTOFF_DATE = datetime.strptime("17-03-2026", "%d-%m-%Y").date()
LEAVES_CSV = Path("leaves.csv")
UNSURE_CSV = Path("unsure.csv")
REQUEST_TIMEOUT = 60

load_dotenv()

USERNAME = os.getenv("PYBUNK_USERNAME", "")
PASSWORD = os.getenv("PYBUNK_PASSWORD", "")

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 10) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/91.0.4472.120 Mobile Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

AJAX_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/javascript, */*; q=0.01",
}

session = requests.Session()
session.headers.update(DEFAULT_HEADERS)


def _ensure_success(response: requests.Response, context: str) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        raise RuntimeError(f"{context} failed with {response.status_code}") from exc


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

    raise RuntimeError("Sesskey not found in dashboard HTML")


def _normalize_text(cell: Any) -> str:
    return cell.get_text(" ", strip=True) if cell else ""


def _normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _extract_score(status_text: str) -> str | None:
    match = re.search(r"(\?|\d+)\s*/\s*(\d+)", status_text)
    if not match:
        return None

    earned_text, total_text = match.groups()
    return f"{earned_text}/{total_text}"


def _extract_points(status_text: str) -> tuple[int | None, int | None]:
    match = re.search(r"(\?|\d+)\s*/\s*(\d+)", status_text)
    if not match:
        return None, None

    earned_text, total_text = match.groups()
    earned = None if earned_text == "?" else int(earned_text)
    return earned, int(total_text)


def _split_period_datetime(period_text: str) -> tuple[pd.Timestamp | None, str]:
    match = re.search(
        r"^(?P<date_text>.+?\d{4})\s+(?P<session_time>\d{1,2}(?::\d{2})?[AP]M\s*-\s*\d{1,2}(?::\d{2})?[AP]M)$",
        period_text,
        re.IGNORECASE,
    )
    if not match:
        return pd.NaT, ""

    date_text = match.group("date_text")
    session_time = match.group("session_time").upper().strip()
    parsed_date = pd.to_datetime(date_text, format="%a %d %b %Y", errors="coerce")
    return parsed_date, session_time


def _format_session_time(session_time: str) -> str:
    formatted = re.sub(r"\s+", " ", session_time.strip().upper())
    formatted = re.sub(r"(?<=\d)\s*(AM|PM)", lambda match: match.group(1).lower(), formatted)
    return formatted.replace(" - ", " - ").lower()


def _find_attendance_table(soup: BeautifulSoup):
    for table in soup.find_all("table"):
        headers = [
            _normalize_text(header).lower()
            for header in table.find_all(["th", "td"])
        ]
        if any("date" in header for header in headers) and any(
            "status" in header for header in headers
        ):
            return table

    return soup.find("table")


def get_login_token() -> str:
    response = session.get(f"{BASE_URL}/login/index.php", timeout=REQUEST_TIMEOUT)
    _ensure_success(response, "Fetching login page")

    soup = BeautifulSoup(response.text, "html.parser")
    token_input = soup.find("input", {"name": "logintoken"})
    if not token_input or not token_input.get("value"):
        raise RuntimeError("Login token not found on login page")

    return token_input["value"]


def login() -> None:
    token = get_login_token()
    payload = {
        "anchor": "",
        "logintoken": token,
        "username": USERNAME,
        "password": PASSWORD,
    }

    response = session.post(
        f"{BASE_URL}/login/index.php",
        data=payload,
        timeout=REQUEST_TIMEOUT,
    )
    _ensure_success(response, "Logging in")

    if "/my/" not in response.url and "dashboard" not in response.url:
        raise RuntimeError("Login failed. Check username/password or login flow.")

    print("Logged in successfully")


def get_sesskey() -> str:
    response = session.get(f"{BASE_URL}/my/", timeout=REQUEST_TIMEOUT)
    _ensure_success(response, "Loading dashboard")
    return _extract_sesskey(response.text)


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
    if len(rows) <= 1:
        return []

    records: list[dict[str, Any]] = []

    for row in rows[1:]:
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

        records.append(
            {
                "period_date": attendance_date,
                "period_text": period_date,
                "session_time": session_time,
                "description": description,
                "status": status,
                "score": score,
                "points_earned": points_earned,
                "points_total": points_total,
            }
        )

    return records


def _export_score_csvs(dataframe: pd.DataFrame) -> None:
    export_columns = ["date", "session_time", "course"]
    filtered = dataframe.loc[dataframe["period_date"].notna()].copy()
    filtered = filtered.loc[filtered["period_date"].dt.date <= CUTOFF_DATE].copy()

    filtered = filtered.sort_values(by=["course", "period_date", "session_time"])
    filtered["date"] = filtered["period_date"].dt.strftime("%d-%m-%Y")
    filtered["session_time"] = filtered["session_time"].map(_format_session_time)

    leaves = filtered.loc[filtered["score"] == "0/1", export_columns].reset_index(drop=True)
    unsure = filtered.loc[filtered["score"] == "?/1", export_columns].reset_index(drop=True)

    leaves.to_csv(LEAVES_CSV, index=False)
    unsure.to_csv(UNSURE_CSV, index=False)

    print(f"\nWrote {len(leaves)} rows to {LEAVES_CSV.resolve()}")
    print(f"Wrote {len(unsure)} rows to {UNSURE_CSV.resolve()}")


def main() -> pd.DataFrame:
    login()
    sesskey = get_sesskey()
    courses = get_courses(sesskey)

    all_data: list[dict[str, Any]] = []

    for course in courses:
        course_id = course.get("id")
        course_name = _normalize_whitespace(
            course.get("fullname") or course.get("shortname") or str(course_id)
        )

        print(f"Processing: {course_name}")

        module_id = get_attendance_module(course_id)
        if not module_id:
            print("  No attendance module found")
            continue

        for record in get_attendance(module_id):
            record["course"] = course_name
            record["course_id"] = course_id
            record["attendance_module_id"] = module_id
            all_data.append(record)

    columns = [
        "course",
        "course_id",
        "attendance_module_id",
        "period_date",
        "period_text",
        "session_time",
        "description",
        "status",
        "score",
        "points_earned",
        "points_total",
    ]
    dataframe = pd.DataFrame(all_data, columns=columns)

    if not dataframe.empty:
        dataframe["period_date"] = pd.to_datetime(dataframe["period_date"], errors="coerce")

    _export_score_csvs(dataframe)

    print("\nFinal DataFrame:")
    print(dataframe)

    return dataframe


if __name__ == "__main__":
    main()
