# Header Auth Usage

This document explains how to send LMS credentials to `POST /api/attendance/fetch` using headers from the Next.js side.

## Supported Credential Inputs

The attendance route accepts credentials in this order:

1. `Authorization: Basic <base64(username:password)>`
2. `X-Pybunk-Username` + `X-Pybunk-Password`
3. JSON body: `{ "username": "...", "password": "..." }`

If more than one is provided, the first valid option above is used.

## Next.js Client Example

```ts
const basicToken = btoa(`${username}:${password}`)

const response = await fetch("/api/attendance/fetch", {
  method: "POST",
  headers: {
    Authorization: `Basic ${basicToken}`,
  },
})
```

## External App Calling Your Next Route

If your mobile app or another service calls your Next route directly, send:

```http
POST /api/attendance/fetch HTTP/1.1
Host: your-domain
Authorization: Basic base64(username:password)
```

## Important Security Notes

- Use HTTPS in production. Basic auth is encoded, not encrypted.
- Never place passwords in URL query parameters.
- Do not log full `Authorization` headers.
- Do not store raw passwords in local storage/session storage.

## Link-Based App Launches

A normal URL link cannot carry custom headers safely. For app-to-web launch:

1. App calls backend to mint a one-time launch code (short TTL, one-time use).
2. App opens `https://your-domain/auth/launch?code=...`.
3. Server validates code, sets an HttpOnly secure session cookie, redirects to main page.

This avoids exposing passwords in links while still allowing direct entry.
