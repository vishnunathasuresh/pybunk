from __future__ import annotations

import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
FRONTEND_ENV_EXAMPLE = FRONTEND_DIR / ".env.example"
FRONTEND_ENV_LOCAL = FRONTEND_DIR / ".env.local"


def ensure_command(name: str) -> None:
    if shutil.which(name):
        return
    raise SystemExit(f"Missing required command: {name}")


def ensure_frontend_env() -> None:
    if FRONTEND_ENV_LOCAL.exists() or not FRONTEND_ENV_EXAMPLE.exists():
        return

    FRONTEND_ENV_LOCAL.write_text(FRONTEND_ENV_EXAMPLE.read_text(), encoding="utf-8")
    print("[setup] Created frontend/.env.local from .env.example")


def stream_output(prefix: str, process: subprocess.Popen[str]) -> None:
    assert process.stdout is not None
    for line in process.stdout:
        print(f"[{prefix}] {line.rstrip()}")


def start_process(
    prefix: str,
    command: list[str],
    cwd: Path,
) -> tuple[subprocess.Popen[str], threading.Thread]:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    thread = threading.Thread(
        target=stream_output,
        args=(prefix, process),
        daemon=True,
    )
    thread.start()
    return process, thread


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        process.wait(timeout=5)
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    ensure_command("uv")
    ensure_command("bun")
    ensure_frontend_env()

    backend_process, backend_thread = start_process(
        "api",
        ["uv", "run", "uvicorn", "api:app", "--reload"],
        ROOT,
    )
    frontend_process, frontend_thread = start_process(
        "web",
        ["bun", "run", "dev"],
        FRONTEND_DIR,
    )

    print("[info] Backend:  http://127.0.0.1:8000")
    print("[info] Frontend: http://127.0.0.1:3000")
    print("[info] Press Ctrl+C to stop both processes.")

    try:
        while True:
            if backend_process.poll() is not None:
                print("[error] Backend exited unexpectedly.")
                return backend_process.returncode or 1
            if frontend_process.poll() is not None:
                print("[error] Frontend exited unexpectedly.")
                return frontend_process.returncode or 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[info] Stopping development stack...")
    finally:
        stop_process(frontend_process)
        stop_process(backend_process)
        backend_thread.join(timeout=2)
        frontend_thread.join(timeout=2)

    return 0


if __name__ == "__main__":
    if sys.platform == "win32":
        signal.signal(signal.SIGINT, signal.default_int_handler)
    raise SystemExit(main())
