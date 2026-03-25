from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd
import streamlit as st

import main
import planner


OUTPUT_TXT = Path("interactive_duty_leaves.txt")
OUTPUT_CSV = Path("interactive_duty_leaves.csv")


st.set_page_config(
    page_title="pybunk Planner",
    page_icon="P",
    layout="wide",
)


def _init_state() -> None:
    if "attendance_df" not in st.session_state:
        st.session_state.attendance_df = pd.DataFrame()
    if "event_editor" not in st.session_state:
        st.session_state.event_editor = pd.DataFrame({"event_date": pd.Series(dtype="datetime64[ns]")})
    if "manual_editor" not in st.session_state:
        st.session_state.manual_editor = pd.DataFrame(
            {
                "date": pd.Series(dtype="datetime64[ns]"),
                "course_code": pd.Series(dtype="str"),
                "session_time": pd.Series(dtype="str"),
            }
        )
    if "course_limits_editor" not in st.session_state:
        st.session_state.course_limits_editor = pd.DataFrame()
    if "recommended_df" not in st.session_state:
        st.session_state.recommended_df = pd.DataFrame()
    if "not_marked_editor" not in st.session_state:
        st.session_state.not_marked_editor = pd.DataFrame()


def _sync_course_limits(course_catalog: pd.DataFrame, default_limit: int) -> None:
    current = st.session_state.course_limits_editor.copy()
    if current.empty:
        st.session_state.course_limits_editor = pd.DataFrame(
            {
                "course_code": course_catalog["course_code"],
                "subject_name": course_catalog["subject_name"],
                "max_dl": default_limit,
            }
        )
        return

    merged = course_catalog[["course_code", "subject_name"]].merge(
        current[["course_code", "max_dl"]],
        on="course_code",
        how="left",
    )
    merged["max_dl"] = merged["max_dl"].fillna(default_limit).astype(int)
    st.session_state.course_limits_editor = merged


def _event_dates_from_editor(event_editor: pd.DataFrame) -> list[date]:
    if event_editor.empty or "event_date" not in event_editor:
        return []

    parsed = pd.to_datetime(event_editor["event_date"], errors="coerce").dropna()
    return sorted(parsed.dt.date.unique().tolist())


def _manual_entries_from_editor(manual_editor: pd.DataFrame) -> pd.DataFrame:
    if manual_editor.empty:
        return pd.DataFrame(columns=["date", "course_code", "session_time"])

    cleaned = manual_editor.copy()
    cleaned = cleaned.dropna(subset=["date", "course_code"])
    if cleaned.empty:
        return pd.DataFrame(columns=["date", "course_code", "session_time"])

    cleaned["course_code"] = cleaned["course_code"].astype(str).str.strip()
    cleaned["session_time"] = cleaned["session_time"].fillna("").astype(str)
    cleaned = cleaned.loc[cleaned["course_code"] != ""].copy()
    return cleaned[["date", "course_code", "session_time"]]


def _course_limits_from_editor(course_limits_editor: pd.DataFrame) -> dict[str, int]:
    if course_limits_editor.empty:
        return {}

    limits = course_limits_editor.copy()
    limits["max_dl"] = pd.to_numeric(limits["max_dl"], errors="coerce").fillna(0).astype(int)
    return dict(zip(limits["course_code"], limits["max_dl"]))


def _build_not_marked_editor(attendance_df: pd.DataFrame) -> pd.DataFrame:
    if attendance_df.empty:
        return pd.DataFrame()

    unsure = attendance_df.loc[attendance_df["score"] == "?/1"].copy()
    if unsure.empty:
        return pd.DataFrame()

    unsure = unsure.sort_values(by=["period_date", "course_code", "session_time"]).copy()
    unsure["pick"] = False
    unsure["date"] = unsure["period_date"].dt.strftime("%d-%m-%Y")
    return unsure[
        [
            "pick",
            "date",
            "session_time",
            "course_code",
            "subject_name",
            "faculty",
            "faculty_email",
            "period_date",
            "course",
            "score",
        ]
    ].reset_index(drop=True)


def _selected_not_marked_rows(editor_df: pd.DataFrame) -> pd.DataFrame:
    if editor_df.empty or "pick" not in editor_df:
        return pd.DataFrame()

    selected = editor_df.loc[editor_df["pick"] == True].copy()
    if selected.empty:
        return pd.DataFrame()

    return selected[
        [
            "period_date",
            "session_time",
            "course_code",
            "subject_name",
            "faculty",
            "faculty_email",
            "course",
            "score",
        ]
    ].reset_index(drop=True)


_init_state()

st.title("pybunk Duty Leave Planner")
st.caption(
    "Pick event dates on a calendar, add manual bunks for dates not reflected on LMS, "
    "set per-course DL caps, and generate the recommended plan."
)

with st.sidebar:
    st.subheader("Attendance")
    username = st.text_input("Roll number / username", value="")
    password = st.text_input("Password", value="", type="password")
    if st.button("Fetch Latest Attendance", use_container_width=True):
        if not username or not password:
            st.warning("Enter your Moodle username and password first.")
        else:
            with st.spinner("Fetching attendance from Moodle..."):
                st.session_state.attendance_df = main.fetch_attendance_dataframe(
                    username=username,
                    password=password,
                )
                st.session_state.recommended_df = pd.DataFrame()
                st.session_state.not_marked_editor = _build_not_marked_editor(
                    st.session_state.attendance_df
                )

    cutoff_date = st.date_input(
        "Cutoff date",
        value=date(2026, 3, 17),
        help="Only attendance records on or before this date are considered.",
    )
    lookback_days = st.slider(
        "Days before event",
        min_value=0,
        max_value=7,
        value=4,
        help="A leave counts if it falls on the event date or within this many days before it.",
    )
    default_limit = st.number_input(
        "Default max DL per course",
        min_value=0,
        max_value=20,
        value=8,
        step=1,
    )

attendance_df = st.session_state.attendance_df
if attendance_df.empty:
    st.info("Fetch attendance first to unlock course selection, manual bunks, and DL planning.")
    st.stop()

course_catalog = planner.build_course_catalog(attendance_df)
_sync_course_limits(course_catalog, int(default_limit))

metric_col1, metric_col2, metric_col3 = st.columns(3)
metric_col1.metric("Courses", len(course_catalog))
metric_col2.metric("Attendance Rows", len(attendance_df))
metric_col3.metric("Current Leaves", int((attendance_df["score"] == "0/1").sum()))

config_col1, config_col2 = st.columns([1, 1])

with config_col1:
    st.subheader("Event Dates")
    st.caption("Leave this empty if you want the planner to build a plan from all current bunks.")
    event_editor = st.data_editor(
        st.session_state.event_editor,
        hide_index=True,
        num_rows="dynamic",
        use_container_width=True,
        column_config={
            "event_date": st.column_config.DateColumn(
                "Event date",
                format="DD-MM-YYYY",
                required=True,
            )
        },
        key="event_dates_editor_widget",
    )
    st.session_state.event_editor = event_editor

with config_col2:
    st.subheader("Manual Bunks")
    manual_editor = st.data_editor(
        st.session_state.manual_editor,
        hide_index=True,
        num_rows="dynamic",
        use_container_width=True,
        column_config={
            "date": st.column_config.DateColumn(
                "Date",
                format="DD-MM-YYYY",
                required=True,
            ),
            "course_code": st.column_config.SelectboxColumn(
                "Course",
                options=course_catalog["course_code"].tolist(),
                required=True,
            ),
            "session_time": st.column_config.TextColumn(
                "Session time / note",
                help="Optional. Leave blank to mark it as MANUAL BUNK.",
            ),
        },
        key="manual_bunks_editor_widget",
    )
    st.session_state.manual_editor = manual_editor

st.subheader("Not Marked Leaves")
if st.session_state.not_marked_editor.empty:
    st.caption("No `?/1` rows available in the currently loaded attendance.")
else:
    not_marked_editor = st.data_editor(
        st.session_state.not_marked_editor,
        hide_index=True,
        use_container_width=True,
        column_config={
            "pick": st.column_config.CheckboxColumn(
                "Use as bunk",
                help="Tick rows that should count as bunks even though LMS marks them as not marked.",
            ),
            "date": st.column_config.TextColumn("Date", disabled=True),
            "session_time": st.column_config.TextColumn("Session", disabled=True),
            "course_code": st.column_config.TextColumn("Course", disabled=True),
            "subject_name": st.column_config.TextColumn("Subject", disabled=True),
            "faculty": st.column_config.TextColumn("Faculty", disabled=True),
            "faculty_email": st.column_config.TextColumn("Faculty email", disabled=True),
            "period_date": None,
            "course": None,
            "score": None,
        },
        key="not_marked_editor_widget",
    )
    st.session_state.not_marked_editor = not_marked_editor

st.subheader("Per-Course DL Limits")
course_limits_editor = st.data_editor(
    st.session_state.course_limits_editor,
    hide_index=True,
    use_container_width=True,
    column_config={
        "course_code": st.column_config.TextColumn("Course code", disabled=True),
        "subject_name": st.column_config.TextColumn("Subject", disabled=True),
        "max_dl": st.column_config.NumberColumn(
            "Max DL",
            min_value=0,
            max_value=20,
            step=1,
            required=True,
        ),
    },
    key="course_limits_editor_widget",
)
st.session_state.course_limits_editor = course_limits_editor

generate_col1, generate_col2 = st.columns([1, 1])

with generate_col1:
    if st.button("Generate Duty Leave Plan", use_container_width=True, type="primary"):
        selected_event_dates = _event_dates_from_editor(st.session_state.event_editor)
        manual_entries = _manual_entries_from_editor(st.session_state.manual_editor)
        not_marked_entries = _selected_not_marked_rows(st.session_state.not_marked_editor)
        course_limits = _course_limits_from_editor(st.session_state.course_limits_editor)

        recommended_df = planner.generate_duty_leave_plan(
            attendance_df,
            selected_event_dates,
            course_limits,
            cutoff_date=cutoff_date,
            lookback_days=int(lookback_days),
            manual_entries=manual_entries,
            not_marked_entries=not_marked_entries,
        )
        st.session_state.recommended_df = recommended_df

with generate_col2:
    if st.button("Write Planner Outputs Locally", use_container_width=True):
        recommended_df = st.session_state.recommended_df
        if recommended_df.empty:
            st.warning("Generate a plan first.")
        else:
            planner.write_plan_outputs(recommended_df, OUTPUT_TXT, OUTPUT_CSV)
            st.success(f"Wrote {OUTPUT_TXT.name} and {OUTPUT_CSV.name} to the project root.")

recommended_df = st.session_state.recommended_df
if recommended_df.empty:
    st.info("Generate the plan to preview the recommended DL rows and export them.")
    st.stop()

preview_df = planner.recommendation_preview(recommended_df)
plan_text = planner.format_daywise_text(recommended_df)

summary_col1, summary_col2, summary_col3 = st.columns(3)
summary_col1.metric("Recommended Rows", len(recommended_df))
summary_col2.metric("Courses Covered", recommended_df["course_code"].nunique())
summary_col3.metric(
    "Manual / Not Marked Used",
    int((recommended_df["source"].isin(["manual", "not_marked"])).sum()),
)

preview_col1, preview_col2 = st.columns([1.15, 0.85])

with preview_col1:
    st.subheader("Plan Preview")
    st.dataframe(preview_df, use_container_width=True, hide_index=True)

with preview_col2:
    st.subheader("Planner Output")
    st.code(plan_text, language="text")
    st.download_button(
        "Download TXT",
        data=plan_text,
        file_name="interactive_duty_leaves.txt",
        mime="text/plain",
        use_container_width=True,
    )
    st.download_button(
        "Download CSV",
        data=preview_df.to_csv(index=False),
        file_name="interactive_duty_leaves.csv",
        mime="text/csv",
        use_container_width=True,
    )
