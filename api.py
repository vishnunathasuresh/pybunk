from __future__ import annotations

import logging
import os
import secrets
import time
from collections import deque
from datetime import date, datetime, timedelta, timezone
from threading import Lock
from typing import Any
from uuid import uuid4

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

import main
import planner


logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def _env_int(name: str, default: int, *, minimum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(value, minimum)


ENABLE_DOCS = _env_flag("PYBUNK_ENABLE_DOCS", True)
ALLOWED_ORIGINS = _env_list(
    "PYBUNK_ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
)
TRUSTED_HOSTS = _env_list("PYBUNK_TRUSTED_HOSTS", "*")
API_TOKEN = os.getenv("PYBUNK_API_TOKEN", "").strip()
RATE_LIMIT_PER_MINUTE = _env_int("PYBUNK_RATE_LIMIT_PER_MINUTE", 30, minimum=0)
DATASET_TTL_SECONDS = _env_int("PYBUNK_DATASET_TTL_SECONDS", 900, minimum=60)

app = FastAPI(
    title="pybunk API",
    version="0.2.0",
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

FETCH_LOCK = Lock()
RATE_LIMIT_LOCK = Lock()
DATASET_LOCK = Lock()
REQUEST_BUCKETS: dict[str, deque[float]] = {}
DATASETS: dict[str, tuple[datetime, pd.DataFrame]] = {}


class AttendanceFetchRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class AttendanceRowInput(BaseModel):
    record_id: str = Field(min_length=1, max_length=64)
    period_date: date | None = None
    session_time: str | None = Field(default=None, max_length=64)
    course_code: str | None = Field(default=None, max_length=64)
    subject_name: str | None = Field(default=None, max_length=256)
    faculty: str | None = Field(default=None, max_length=256)
    faculty_email: str | None = Field(default=None, max_length=256)
    course: str | None = Field(default=None, max_length=256)
    score: str | None = Field(default=None, max_length=16)


class ManualBunkInput(BaseModel):
    date: date
    course_code: str = Field(min_length=1, max_length=64)
    session_time: str | None = Field(default=None, max_length=64)


class CourseLimitInput(BaseModel):
    course_code: str = Field(min_length=1, max_length=64)
    max_dl: int = Field(ge=0, le=50)


class PlannerRequest(BaseModel):
    dataset_id: str | None = Field(default=None, max_length=64)
    attendance_rows: list[AttendanceRowInput] = Field(default_factory=list, max_length=2000)
    event_dates: list[date] = Field(default_factory=list, max_length=64)
    manual_entries: list[ManualBunkInput] = Field(default_factory=list, max_length=256)
    not_marked_record_ids: list[str] = Field(default_factory=list, max_length=512)
    course_limits: list[CourseLimitInput] = Field(default_factory=list, max_length=256)
    cutoff_date: date | None = None
    lookback_days: int = Field(default=4, ge=0, le=14)

    @model_validator(mode="after")
    def validate_input_source(self) -> "PlannerRequest":
        if self.dataset_id or self.attendance_rows:
            return self
        raise ValueError("Provide either dataset_id or attendance_rows.")


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _json_safe(value: Any) -> Any:
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    return value


def _records_from_dataframe(dataframe: pd.DataFrame, columns: list[str]) -> list[dict[str, Any]]:
    if dataframe.empty:
        return []

    records: list[dict[str, Any]] = []
    for row in dataframe[columns].itertuples(index=False, name=None):
        records.append({column: _json_safe(value) for column, value in zip(columns, row)})
    return records


def _client_identifier(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", maxsplit=1)[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _enforce_rate_limit(request: Request) -> None:
    if RATE_LIMIT_PER_MINUTE <= 0:
        return

    identifier = _client_identifier(request)
    now = time.monotonic()
    window_start = now - 60

    with RATE_LIMIT_LOCK:
        bucket = REQUEST_BUCKETS.setdefault(identifier, deque())
        while bucket and bucket[0] < window_start:
            bucket.popleft()

        if len(bucket) >= RATE_LIMIT_PER_MINUTE:
            raise HTTPException(
                status_code=429,
                detail="Rate limit exceeded. Please try again in a minute.",
            )

        bucket.append(now)


def _require_api_guard(request: Request) -> None:
    _enforce_rate_limit(request)

    if not API_TOKEN:
        return

    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Missing bearer token.")
    if not secrets.compare_digest(token, API_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid bearer token.")


def _cleanup_datasets() -> None:
    now = _now_utc()
    expired_ids = [
        dataset_id
        for dataset_id, (expires_at, _) in DATASETS.items()
        if expires_at <= now
    ]
    for dataset_id in expired_ids:
        DATASETS.pop(dataset_id, None)


def _store_dataset(attendance_df: pd.DataFrame) -> tuple[str, str]:
    dataset_id = str(uuid4())
    expires_at = _now_utc() + timedelta(seconds=DATASET_TTL_SECONDS)
    with DATASET_LOCK:
        _cleanup_datasets()
        DATASETS[dataset_id] = (expires_at, attendance_df.copy())
    return dataset_id, expires_at.isoformat()


def _dataset_or_404(dataset_id: str) -> pd.DataFrame:
    with DATASET_LOCK:
        _cleanup_datasets()
        entry = DATASETS.get(dataset_id)
        if entry is None:
            raise HTTPException(
                status_code=404,
                detail="Unknown or expired dataset_id. Fetch attendance again or send attendance_rows.",
            )
        _, dataset = entry
        return dataset.copy()


def _attendance_df_from_request(request: PlannerRequest) -> pd.DataFrame:
    if request.attendance_rows:
        rows = [
            {
                "record_id": item.record_id,
                "period_date": item.period_date,
                "session_time": item.session_time or "",
                "course_code": item.course_code or "",
                "subject_name": item.subject_name or "",
                "faculty": item.faculty or "",
                "faculty_email": item.faculty_email or "",
                "course": item.course or "",
                "score": item.score or "",
            }
            for item in request.attendance_rows
        ]
        attendance_df = pd.DataFrame(
            rows,
            columns=[
                "record_id",
                "period_date",
                "session_time",
                "course_code",
                "subject_name",
                "faculty",
                "faculty_email",
                "course",
                "score",
            ],
        )
        if not attendance_df.empty:
            attendance_df["period_date"] = pd.to_datetime(attendance_df["period_date"], errors="coerce")
        return attendance_df

    if request.dataset_id is None:
        raise HTTPException(status_code=400, detail="Missing planner input.")
    return _dataset_or_404(request.dataset_id)


def _counts_from_plan(plan_df: pd.DataFrame) -> list[dict[str, Any]]:
    if plan_df.empty:
        return []

    counts = (
        plan_df.groupby(["course_code", "subject_name"], sort=True)
        .size()
        .reset_index(name="count")
        .sort_values(by=["course_code", "subject_name"])
    )
    return _records_from_dataframe(counts, ["course_code", "subject_name", "count"])


def _planner_response(plan_df: pd.DataFrame) -> dict[str, Any]:
    preview_df = planner.recommendation_preview(plan_df)
    plan_text = planner.format_daywise_text(plan_df)
    plan_csv = preview_df.to_csv(index=False) if not preview_df.empty else ""

    return {
        "summary": {
            "recommended_rows": int(len(plan_df)),
            "courses_covered": int(plan_df["course_code"].nunique()) if not plan_df.empty else 0,
            "manual_or_not_marked_used": int(
                plan_df["source"].isin(["manual", "not_marked"]).sum()
            )
            if not plan_df.empty
            else 0,
        },
        "planner_rows": _records_from_dataframe(
            preview_df,
            [
                "date",
                "session_time",
                "course",
                "faculty",
                "faculty_email",
                "source",
                "matched_event_date",
                "days_before_event",
            ],
        ),
        "course_counts": _counts_from_plan(plan_df),
        "planner_text": plan_text,
        "planner_csv": plan_csv,
    }


def _fetch_attendance_dataframe(username: str, password: str) -> pd.DataFrame:
    try:
        with FETCH_LOCK:
            attendance_df = main.fetch_attendance_dataframe(
                username=username,
                password=password,
            )
    except Exception as exc:
        logger.exception("Attendance fetch failed")
        raise HTTPException(
            status_code=400,
            detail="Attendance fetch failed. Check credentials or Moodle availability.",
        ) from exc

    attendance_df = attendance_df.reset_index(drop=True).copy()
    attendance_df["record_id"] = [f"rec_{index + 1}" for index in attendance_df.index]
    return attendance_df


def _fetch_response(attendance_df: pd.DataFrame) -> dict[str, Any]:
    dataset_id, expires_at = _store_dataset(attendance_df)
    course_catalog = planner.build_course_catalog(attendance_df)
    not_marked_rows = attendance_df.loc[attendance_df["score"] == "?/1"].copy()
    if not not_marked_rows.empty:
        not_marked_rows["date"] = pd.to_datetime(
            not_marked_rows["period_date"],
            errors="coerce",
        ).dt.strftime("%d-%m-%Y")

    attendance_rows = _records_from_dataframe(
        attendance_df,
        [
            "record_id",
            "period_date",
            "session_time",
            "course_code",
            "subject_name",
            "faculty",
            "faculty_email",
            "course",
            "score",
        ],
    )

    return {
        "dataset_id": dataset_id,
        "dataset_expires_at": expires_at,
        "summary": {
            "attendance_rows": int(len(attendance_df)),
            "course_count": int(course_catalog["course_code"].nunique()),
            "leave_rows": int((attendance_df["score"] == "0/1").sum()),
            "not_marked_rows": int((attendance_df["score"] == "?/1").sum()),
        },
        "attendance_rows": attendance_rows,
        "course_catalog": _records_from_dataframe(
            course_catalog,
            ["course_code", "subject_name", "faculty", "faculty_email", "course"],
        ),
        "default_course_limits": [
            {"course_code": record["course_code"], "subject_name": record["subject_name"], "max_dl": 8}
            for record in _records_from_dataframe(course_catalog, ["course_code", "subject_name"])
        ],
        "not_marked_rows": _records_from_dataframe(
            not_marked_rows,
            [
                "record_id",
                "date",
                "period_date",
                "session_time",
                "course_code",
                "subject_name",
                "faculty",
                "faculty_email",
                "course",
                "score",
            ],
        ),
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/attendance/fetch", dependencies=[Depends(_require_api_guard)])
def fetch_attendance(request: AttendanceFetchRequest) -> dict[str, Any]:
    attendance_df = _fetch_attendance_dataframe(
        username=request.username,
        password=request.password,
    )
    return _fetch_response(attendance_df)


@app.post("/api/planner/generate", dependencies=[Depends(_require_api_guard)])
def generate_planner_plan(request: PlannerRequest) -> dict[str, Any]:
    attendance_df = _attendance_df_from_request(request)

    manual_entries_df = pd.DataFrame(
        [
            {
                "date": item.date,
                "course_code": item.course_code,
                "session_time": item.session_time or "",
            }
            for item in request.manual_entries
        ]
    )
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

