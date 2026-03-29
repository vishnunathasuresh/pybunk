# BunkX Frontend

This folder contains the primary web frontend for `pybunk`, built with Next.js and shadcn/ui.

## Local Development

Start the Python backend from the repo root:

```powershell
uv run uvicorn api:app --reload
```

Then start the frontend:

```powershell
copy .env.example .env.local
bun install
bun run dev
```

## Frontend Environment

- `PYBUNK_API_BASE_URL` points to the FastAPI backend
- `PYBUNK_API_TOKEN` is optional and should match the backend token when enabled

The frontend proxies attendance fetch and planner generation through Next route handlers in `app/api/`.

## One-command Local Testing

From the repo root, run:

```powershell
uv run python dev_stack.py
```

This starts both the FastAPI backend and the Next.js frontend together and stops both on Ctrl+C.
