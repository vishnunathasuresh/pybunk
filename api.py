from __future__ import annotations

from datetime import date, datetime
from threading import Lock
from typing import Any
from uuid import uuid4

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import main
import planner


app = FastAPI(title="pybunk API", version="0.1.0")

FETCH_LOCK = Lock()
DATASETS: dict[str, pd.DataFrame] = {}


class AttendanceFetchRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ManualBunkInput(BaseModel):
    date: date
    course_code: str
    session_time: str | None = None


class CourseLimitInput(BaseModel):
    course_code: str
    max_dl: int = Field(ge=0, le=50)


class PlannerRequest(BaseModel):
    dataset_id: str
    event_dates: list[date] = Field(default_factory=list)
    manual_entries: list[ManualBunkInput] = Field(default_factory=list)
    not_marked_record_ids: list[str] = Field(default_factory=list)
    course_limits: list[CourseLimitInput] = Field(default_factory=list)
    cutoff_date: date | None = None
    lookback_days: int = Field(default=4, ge=0, le=14)


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


def _dataset_or_404(dataset_id: str) -> pd.DataFrame:
    dataset = DATASETS.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Unknown dataset_id. Fetch attendance first.")
    return dataset.copy()


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


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/attendance/fetch")
def fetch_attendance(request: AttendanceFetchRequest) -> dict[str, Any]:
    try:
        with FETCH_LOCK:
            attendance_df = main.fetch_attendance_dataframe(
                username=request.username,
                password=request.password,
            )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    attendance_df = attendance_df.reset_index(drop=True).copy()
    attendance_df["record_id"] = [f"rec_{index + 1}" for index in attendance_df.index]

    dataset_id = str(uuid4())
    DATASETS[dataset_id] = attendance_df

    course_catalog = planner.build_course_catalog(attendance_df)
    not_marked_rows = attendance_df.loc[attendance_df["score"] == "?/1"].copy()
    if not not_marked_rows.empty:
        not_marked_rows["date"] = pd.to_datetime(not_marked_rows["period_date"], errors="coerce").dt.strftime("%d-%m-%Y")

    return {
        "dataset_id": dataset_id,
        "summary": {
            "attendance_rows": int(len(attendance_df)),
            "course_count": int(course_catalog["course_code"].nunique()),
            "leave_rows": int((attendance_df["score"] == "0/1").sum()),
            "not_marked_rows": int((attendance_df["score"] == "?/1").sum()),
        },
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


@app.post("/api/planner/generate")
def generate_planner_plan(request: PlannerRequest) -> dict[str, Any]:
    attendance_df = _dataset_or_404(request.dataset_id)

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

    preview_df = planner.recommendation_preview(plan_df)
    plan_text = planner.format_daywise_text(plan_df)

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
    }
