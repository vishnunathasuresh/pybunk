from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import pandas as pd


MANUAL_SESSION_LABEL = "MANUAL BUNK"


def _normalize_whitespace(value: str) -> str:
    return " ".join(str(value).split()).strip()


def _format_session_time_text(session_time: str) -> str:
    return _normalize_whitespace(str(session_time).upper())


def _extract_session_start(session_time: str) -> pd.Timestamp | None:
    text = str(session_time).split("-", maxsplit=1)[0].strip().upper()
    if not text:
        return None

    parsed = pd.to_datetime(text, format="%I:%M%p", errors="coerce")
    if pd.isna(parsed):
        parsed = pd.to_datetime(text, format="%I%p", errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed


def _match_event(candidate_date: date, event_dates: list[date], lookback_days: int) -> tuple[date, int] | None:
    matches: list[tuple[date, int]] = []

    for event_date in sorted(set(event_dates)):
        days_before = (event_date - candidate_date).days
        if 0 <= days_before <= lookback_days:
            matches.append((event_date, days_before))

    if not matches:
        return None

    return min(matches, key=lambda item: (item[1], item[0]))


def build_course_catalog(attendance_df: pd.DataFrame) -> pd.DataFrame:
    columns = ["course_code", "subject_name", "faculty", "faculty_email", "course"]
    if attendance_df.empty:
        return pd.DataFrame(columns=columns)

    catalog = (
        attendance_df[columns]
        .dropna(subset=["course_code"])
        .drop_duplicates(subset=["course_code"])
        .sort_values(by=["course_code"])
        .reset_index(drop=True)
    )
    return catalog


def build_manual_bunks(manual_entries: pd.DataFrame, course_catalog: pd.DataFrame) -> pd.DataFrame:
    expected_columns = [
        "period_date",
        "session_time",
        "course_code",
        "subject_name",
        "faculty",
        "faculty_email",
        "course",
        "score",
        "source",
    ]
    if manual_entries.empty:
        return pd.DataFrame(columns=expected_columns)

    merged = manual_entries.copy()
    merged = merged.dropna(subset=["date", "course_code"])
    merged["course_code"] = merged["course_code"].map(_normalize_whitespace)
    merged = merged.loc[merged["course_code"] != ""].copy()
    if merged.empty:
        return pd.DataFrame(columns=expected_columns)

    merged["date"] = pd.to_datetime(merged["date"], errors="coerce")
    merged = merged.loc[merged["date"].notna()].copy()
    if merged.empty:
        return pd.DataFrame(columns=expected_columns)

    catalog_lookup = course_catalog[
        ["course_code", "subject_name", "faculty", "faculty_email", "course"]
    ].drop_duplicates(subset=["course_code"])
    merged = merged.merge(catalog_lookup, on="course_code", how="left")
    merged["session_time"] = merged["session_time"].fillna("").map(_normalize_whitespace)
    merged.loc[merged["session_time"] == "", "session_time"] = MANUAL_SESSION_LABEL
    merged["period_date"] = merged["date"]
    merged["score"] = "manual"
    merged["source"] = "manual"

    return merged[expected_columns].copy()


def build_not_marked_candidates(not_marked_entries: pd.DataFrame) -> pd.DataFrame:
    expected_columns = [
        "period_date",
        "session_time",
        "course_code",
        "subject_name",
        "faculty",
        "faculty_email",
        "course",
        "score",
        "source",
    ]
    if not_marked_entries.empty:
        return pd.DataFrame(columns=expected_columns)

    selected = not_marked_entries.copy()
    selected["period_date"] = pd.to_datetime(selected["period_date"], errors="coerce")
    selected = selected.loc[selected["period_date"].notna()].copy()
    if selected.empty:
        return pd.DataFrame(columns=expected_columns)

    selected["score"] = "not_marked"
    selected["source"] = "not_marked"
    return selected[expected_columns].copy()


def generate_duty_leave_plan(
    attendance_df: pd.DataFrame,
    event_dates: list[date],
    course_limits: dict[str, int],
    *,
    cutoff_date: date | None = None,
    lookback_days: int = 4,
    manual_entries: pd.DataFrame | None = None,
    not_marked_entries: pd.DataFrame | None = None,
) -> pd.DataFrame:
    candidate_columns = [
        "period_date",
        "session_time",
        "course_code",
        "subject_name",
        "faculty",
        "faculty_email",
        "course",
        "score",
        "source",
    ]
    if attendance_df.empty:
        return pd.DataFrame(columns=candidate_columns)

    lms_candidates = attendance_df.loc[attendance_df["score"] == "0/1"].copy()
    lms_candidates["source"] = "lms"
    lms_candidates = lms_candidates[candidate_columns]

    catalog = build_course_catalog(attendance_df)
    manual_candidates = build_manual_bunks(
        manual_entries if manual_entries is not None else pd.DataFrame(),
        catalog,
    )
    not_marked_candidates = build_not_marked_candidates(
        not_marked_entries if not_marked_entries is not None else pd.DataFrame()
    )

    combined = pd.concat(
        [lms_candidates, manual_candidates, not_marked_candidates],
        ignore_index=True,
    )
    combined["period_date"] = pd.to_datetime(combined["period_date"], errors="coerce")
    combined = combined.loc[combined["period_date"].notna()].copy()

    if cutoff_date is not None:
        combined = combined.loc[combined["period_date"].dt.date <= cutoff_date].copy()

    combined["session_start"] = combined["session_time"].map(_extract_session_start)
    combined["course_limit"] = combined["course_code"].map(course_limits).fillna(0).astype(int)
    combined = combined.loc[combined["course_limit"] > 0].copy()
    if combined.empty:
        return combined

    if event_dates:
        combined["event_match"] = combined["period_date"].dt.date.map(
            lambda candidate_date: _match_event(candidate_date, event_dates, lookback_days)
        )
        combined = combined.loc[combined["event_match"].notna()].copy()
        if combined.empty:
            return combined

        combined["matched_event_date"] = combined["event_match"].map(lambda item: item[0])
        combined["days_before_event"] = combined["event_match"].map(lambda item: item[1])
        combined = combined.sort_values(
            by=[
                "course_code",
                "days_before_event",
                "matched_event_date",
                "period_date",
                "session_start",
                "source",
                "subject_name",
            ],
            na_position="last",
        )
    else:
        combined["matched_event_date"] = pd.NaT
        combined["days_before_event"] = pd.NA
        combined = combined.sort_values(
            by=["course_code", "period_date", "session_start", "source", "subject_name"],
            na_position="last",
        )

    selected_groups: list[pd.DataFrame] = []
    for course_code, group in combined.groupby("course_code", sort=False):
        limit = int(group["course_limit"].iloc[0])
        selected_groups.append(group.head(limit))

    selected = pd.concat(selected_groups, ignore_index=True) if selected_groups else combined.iloc[0:0].copy()
    selected = selected.sort_values(
        by=["period_date", "session_start", "course_code", "subject_name", "source"],
        na_position="last",
    ).reset_index(drop=True)
    selected["date"] = selected["period_date"].dt.strftime("%d-%m-%Y")

    return selected


def recommendation_preview(selected_df: pd.DataFrame) -> pd.DataFrame:
    if selected_df.empty:
        return pd.DataFrame(
            columns=[
                "date",
                "session_time",
                "course",
                "faculty",
                "faculty_email",
                "source",
                "matched_event_date",
                "days_before_event",
            ]
        )

    preview = selected_df.copy()
    preview["course"] = preview["course_code"] + " " + preview["subject_name"]
    preview["matched_event_date"] = (
        pd.to_datetime(preview["matched_event_date"], errors="coerce")
        .dt.strftime("%d-%m-%Y")
        .fillna("")
    )
    preview["days_before_event"] = preview["days_before_event"].fillna("")
    return preview[
        [
            "date",
            "session_time",
            "course",
            "faculty",
            "faculty_email",
            "source",
            "matched_event_date",
            "days_before_event",
        ]
    ]


def format_daywise_text(selected_df: pd.DataFrame, *, append_counts: bool = True) -> str:
    if selected_df.empty:
        return ""

    lines: list[str] = []
    grouped = selected_df.groupby("date", sort=False)

    for index, (date_text, group) in enumerate(grouped):
        if index > 0:
            lines.append("----")
        lines.append(date_text)

        for row in group.itertuples(index=False):
            lines.append(
                f"{_format_session_time_text(row.session_time)} : "
                f"{row.course_code} : {row.subject_name} : {row.faculty} : {row.faculty_email}"
            )

    if append_counts:
        lines.append("----")
        lines.append("DL Count By Course")
        counts = (
            selected_df.groupby(["course_code", "subject_name"], sort=True)
            .size()
            .reset_index(name="count")
            .sort_values(by=["course_code", "subject_name"])
        )
        for row in counts.itertuples(index=False):
            lines.append(f"{row.course_code} : {row.subject_name} : {row.count}")

    return "\n".join(lines) + "\n"


def write_plan_outputs(selected_df: pd.DataFrame, text_path: Path, csv_path: Path) -> None:
    preview = recommendation_preview(selected_df)
    preview.to_csv(csv_path, index=False)
    text_path.write_text(format_daywise_text(selected_df), encoding="utf-8")
