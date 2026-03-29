# BunkX Frontend

This folder contains the primary web frontend for `pybunk`, built with Next.js and shadcn/ui.

## Local Development

Start the frontend:

```powershell
copy .env.example .env.local
bun install
bun run dev
```

## Frontend Environment

No frontend environment variables are required for the standalone web flow.

The frontend now handles LMS attendance fetch and planner generation through Next route handlers in `app/api/`.

## One-command Local Testing

From the repo root, run:

```powershell
uv run python dev_stack.py
```

This starts both the FastAPI backend and the Next.js frontend together and stops both on Ctrl+C.
