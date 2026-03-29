import "server-only"

function getBackendBaseUrl() {
  const baseUrl = process.env.PYBUNK_API_BASE_URL?.trim() || "http://127.0.0.1:8000"
  return baseUrl.replace(/\/+$/, "")
}

function buildHeaders() {
  const headers = new Headers({
    "Content-Type": "application/json",
  })
  const token = process.env.PYBUNK_API_TOKEN?.trim()

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  return headers
}

export async function proxyJsonRequest(path: string, payload: unknown) {
  const response = await fetch(`${getBackendBaseUrl()}${path}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
    cache: "no-store",
  })

  const contentType = response.headers.get("content-type") || "application/json"
  const text = await response.text()

  return new Response(text || "{}", {
    status: response.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  })
}
