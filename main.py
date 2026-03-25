import logging
import os
import re
from datetime import date, datetime
from html import unescape
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import pandas as pd
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

BASE_URL = "https://lmsug24.iiitkottayam.ac.in"
CUTOFF_DATE = datetime.strptime("17-03-2026", "%d-%m-%Y").date()
LEAVES_CSV = Path("leaves.csv")
UNSURE_CSV = Path("unsure.csv")
LEAVES_TXT = Path("leaves.txt")
UNSURE_TXT = Path("unsure.txt")
DUTY_LEAVES_TXT = Path("duty_leaves.txt")
REQUEST_TIMEOUT = 60
MAX_DUTY_LEAVES_PER_COURSE = 8
MAX_DAYS_BEFORE_EVENT = 4
EVENT_DATES = [
    ("Freshers Interviews", date(2026, 1, 14)),
    ("Freshers Interviews", date(2026, 1, 19)),
    ("Freshers Interviews", date(2026, 1, 20)),
    ("ChAi Talks", date(2026, 1, 24)),
    ("ChAi Talks", date(2026, 1, 30)),
    ("Turing Birthday Events", date(2026, 2, 4)),
    ("Turing Birthday Events", date(2026, 2, 5)),
    ("Turing Birthday Events", date(2026, 2, 6)),
    ("Turing Birthday Events", date(2026, 2, 11)),
    ("ChAi Talks", date(2026, 2, 26)),
    ("ChAi Talks", date(2026, 3, 5)),
    ("Apoorv", date(2026, 3, 13)),
    ("Apoorv", date(2026, 3, 14)),
]

load_dotenv()

LOG_LEVEL = os.getenv("PYBUNK_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger(__name__)

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
profile_email_cache: dict[int, str] = {}


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


def _split_course_name(course_name: str) -> tuple[str, str]:
    parts = _normalize_whitespace(course_name).split(maxsplit=1)
    course_code = parts[0] if parts else ""
    subject_name = parts[1] if len(parts) > 1 else ""
    return course_code, subject_name


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


def _format_session_time_text(session_time: str) -> str:
    return re.sub(r"\s+", " ", session_time.strip().upper())


def _extract_session_start(session_time: str) -> pd.Timestamp | None:
    start_time = session_time.split("-", maxsplit=1)[0].strip().upper()
    parsed_time = pd.to_datetime(start_time, format="%I:%M%p", errors="coerce")
    if pd.isna(parsed_time):
        parsed_time = pd.to_datetime(start_time, format="%I%p", errors="coerce")
    if pd.isna(parsed_time):
        return None
    return parsed_time


def _clean_participant_name(raw_name: str) -> str:
    cleaned = _normalize_whitespace(raw_name)
    select_match = re.search(r"Select '(.+)'", cleaned)
    if select_match:
        cleaned = select_match.group(1)

    cleaned = re.sub(r"^[A-Z0-9.-]+\s+(?=[A-Za-z])", "", cleaned)
    return _normalize_whitespace(cleaned)


def _extract_user_id_from_url(url: str) -> int | None:
    query = parse_qs(urlparse(url).query)
    user_ids = query.get("id")
    if not user_ids or not user_ids[0].isdigit():
        return None
    return int(user_ids[0])


def _extract_email_from_profile_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    label = soup.find("dt", string=lambda text: text and "email address" in text.lower())
    if not label:
        return ""

    value = label.find_next("dd")
    if not value:
        return ""

    link = value.find("a", href=True)
    if link and "mailto:" in unescape(link["href"]):
        href = unescape(link["href"])
        return unquote(href.split("mailto:", maxsplit=1)[1].strip())

    return _normalize_whitespace(value.get_text(" ", strip=True))


def get_faculty_email(profile_url: str) -> str:
    user_id = _extract_user_id_from_url(profile_url)
    if user_id is None:
        return ""

    if user_id in profile_email_cache:
        return profile_email_cache[user_id]

    response = session.get(profile_url, timeout=REQUEST_TIMEOUT)
    _ensure_success(response, f"Loading faculty profile {profile_url}")
    email = _extract_email_from_profile_html(response.text)
    profile_email_cache[user_id] = email
    return email


def _match_upcoming_event(leave_date: date) -> tuple[str, date, int] | None:
    matches: list[tuple[str, date, int]] = []

    for event_name, event_date in EVENT_DATES:
        days_before = (event_date - leave_date).days
        if 0 <= days_before <= MAX_DAYS_BEFORE_EVENT:
            matches.append((event_name, event_date, days_before))

    if not matches:
        return None

    return min(matches, key=lambda item: (item[2], item[1], item[0]))


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

    logger.info("Logged in successfully")


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
            faculty_entries.append(
                {
                    "name": cleaned_name,
                    "email": get_faculty_email(profile_url) if profile_url else "",
                    "preferred": not re.search(r"\d", participant_name),
                }
            )

    if not faculty_entries:
        return "Unknown Faculty", ""

    unique_entries: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for entry in faculty_entries:
        key = (entry["name"], entry["email"])
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        unique_entries.append(entry)

    preferred_entries = [entry for entry in unique_entries if entry["preferred"]]
    chosen_entries = preferred_entries or unique_entries

    faculty_names = ", ".join(entry["name"] for entry in chosen_entries)
    faculty_emails = ", ".join(
        entry["email"] for entry in chosen_entries if entry["email"]
    )

    return faculty_names, faculty_emails


def _export_score_csvs(dataframe: pd.DataFrame) -> None:
    export_columns = ["date", "session_time", "course", "faculty", "faculty_email"]
    filtered = dataframe.loc[dataframe["period_date"].notna()].copy()
    filtered = filtered.loc[filtered["period_date"].dt.date <= CUTOFF_DATE].copy()

    filtered["session_start"] = filtered["session_time"].map(_extract_session_start)
    filtered = filtered.sort_values(
        by=["period_date", "session_start", "course"],
        na_position="last",
    )
    filtered["date"] = filtered["period_date"].dt.strftime("%d-%m-%Y")
    filtered["session_time"] = filtered["session_time"].map(_format_session_time)

    leaves = filtered.loc[filtered["score"] == "0/1", export_columns].reset_index(drop=True)
    unsure = filtered.loc[filtered["score"] == "?/1", export_columns].reset_index(drop=True)

    leaves.to_csv(LEAVES_CSV, index=False)
    unsure.to_csv(UNSURE_CSV, index=False)

    logger.info("Wrote %s rows to %s", len(leaves), LEAVES_CSV.resolve())
    logger.info("Wrote %s rows to %s", len(unsure), UNSURE_CSV.resolve())


def _write_daywise_text(path: Path, dataframe: pd.DataFrame) -> None:
    if dataframe.empty:
        path.write_text("", encoding="utf-8")
        logger.info("Wrote 0 rows to %s", path.resolve())
        return

    lines: list[str] = []
    grouped = dataframe.groupby("date", sort=False)

    for index, (date_text, group) in enumerate(grouped):
        if index > 0:
            lines.append("----")
        lines.append(date_text)

        for row in group.itertuples(index=False):
            lines.append(
                f"{_format_session_time_text(row.session_time)} : "
                f"{row.course_code} : {row.subject_name} : {row.faculty} : {row.faculty_email}"
            )

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info("Wrote %s rows to %s", len(dataframe), path.resolve())


def _write_duty_leaves_text(path: Path, dataframe: pd.DataFrame) -> None:
    if dataframe.empty:
        path.write_text("", encoding="utf-8")
        logger.info("Wrote 0 rows to %s", path.resolve())
        return

    lines: list[str] = []
    grouped = dataframe.groupby("date", sort=False)

    for index, (date_text, group) in enumerate(grouped):
        if index > 0:
            lines.append("----")
        lines.append(date_text)

        for row in group.itertuples(index=False):
            lines.append(
                f"{_format_session_time_text(row.session_time)} : "
                f"{row.course_code} : {row.subject_name} : {row.faculty} : {row.faculty_email}"
            )

    lines.append("----")
    lines.append("DL Count By Course")

    counts = (
        dataframe.groupby(["course_code", "subject_name"], sort=True)
        .size()
        .reset_index(name="count")
        .sort_values(by=["course_code", "subject_name"])
    )

    for row in counts.itertuples(index=False):
        lines.append(f"{row.course_code} : {row.subject_name} : {row.count}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info("Wrote %s rows to %s", len(dataframe), path.resolve())


def _export_score_texts(dataframe: pd.DataFrame) -> None:
    filtered = dataframe.loc[dataframe["period_date"].notna()].copy()
    filtered = filtered.loc[filtered["period_date"].dt.date <= CUTOFF_DATE].copy()
    filtered["session_start"] = filtered["session_time"].map(_extract_session_start)
    filtered = filtered.sort_values(
        by=["period_date", "session_start", "course_code", "subject_name"],
        na_position="last",
    )
    filtered["date"] = filtered["period_date"].dt.strftime("%d-%m-%Y")

    leaves = filtered.loc[
        filtered["score"] == "0/1",
        ["date", "session_time", "course_code", "subject_name", "faculty", "faculty_email"],
    ].reset_index(drop=True)
    unsure = filtered.loc[
        filtered["score"] == "?/1",
        ["date", "session_time", "course_code", "subject_name", "faculty", "faculty_email"],
    ].reset_index(drop=True)

    _write_daywise_text(LEAVES_TXT, leaves)
    _write_daywise_text(UNSURE_TXT, unsure)


def _export_duty_leaves_text(dataframe: pd.DataFrame) -> None:
    filtered = dataframe.loc[dataframe["period_date"].notna()].copy()
    filtered = filtered.loc[filtered["period_date"].dt.date <= CUTOFF_DATE].copy()
    filtered = filtered.loc[filtered["score"] == "0/1"].copy()
    filtered["event_match"] = filtered["period_date"].dt.date.map(_match_upcoming_event)
    filtered = filtered.loc[filtered["event_match"].notna()].copy()

    if filtered.empty:
        DUTY_LEAVES_TXT.write_text("", encoding="utf-8")
        logger.info("Wrote 0 rows to %s", DUTY_LEAVES_TXT.resolve())
        return

    filtered["matched_event_name"] = filtered["event_match"].map(lambda item: item[0])
    filtered["matched_event_date"] = filtered["event_match"].map(lambda item: item[1])
    filtered["days_before_event"] = filtered["event_match"].map(lambda item: item[2])
    filtered["session_start"] = filtered["session_time"].map(_extract_session_start)
    filtered = filtered.sort_values(
        by=[
            "course_code",
            "days_before_event",
            "matched_event_date",
            "period_date",
            "session_start",
            "subject_name",
        ],
        na_position="last",
    )
    filtered = filtered.groupby("course_code", group_keys=False).head(MAX_DUTY_LEAVES_PER_COURSE)
    filtered = filtered.sort_values(
        by=["period_date", "session_start", "course_code", "subject_name"],
        na_position="last",
    )
    filtered["date"] = filtered["period_date"].dt.strftime("%d-%m-%Y")

    output = filtered[
        ["date", "session_time", "course_code", "subject_name", "faculty", "faculty_email"]
    ].reset_index(drop=True)
    _write_duty_leaves_text(DUTY_LEAVES_TXT, output)


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
        course_code, subject_name = _split_course_name(course_name)

        logger.info("Processing course: %s", course_name)

        module_id = get_attendance_module(course_id)
        if not module_id:
            logger.warning("No attendance module found for %s", course_name)
            continue

        faculty, faculty_email = get_course_faculty(course_id)

        for record in get_attendance(module_id):
            record["course"] = course_name
            record["course_code"] = course_code
            record["subject_name"] = subject_name
            record["faculty"] = faculty
            record["faculty_email"] = faculty_email
            record["course_id"] = course_id
            record["attendance_module_id"] = module_id
            all_data.append(record)

    columns = [
        "course",
        "course_code",
        "subject_name",
        "faculty",
        "faculty_email",
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
    _export_score_texts(dataframe)
    _export_duty_leaves_text(dataframe)

    logger.info("Final DataFrame:\n%s", dataframe)

    return dataframe


if __name__ == "__main__":
    main()
