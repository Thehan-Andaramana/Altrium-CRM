const CSRF_COOKIE_NAME = 'csrftoken'
const CSRF_HEADER_NAME = 'X-CSRFToken'
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

async function request(method, url, body) {
  const isFormData = body instanceof FormData
  const headers = {}
  if (body !== undefined && !isFormData) {
    // Leave Content-Type unset for FormData -- the browser fills in the
    // multipart boundary itself, which it can only do if we don't set it.
    headers['Content-Type'] = 'application/json'
  }
  if (!CSRF_SAFE_METHODS.has(method)) {
    const csrfToken = getCookie(CSRF_COOKIE_NAME)
    if (csrfToken) {
      headers[CSRF_HEADER_NAME] = csrfToken
    }
  }

  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  })

  if (!response.ok) {
    let payload = null
    try {
      payload = await response.json()
    } catch {
      // no JSON body to read
    }
    const detail = payload?.detail || (payload ? JSON.stringify(payload) : response.statusText)
    const error = new Error(`${method} ${url} failed: ${response.status} ${detail}`)
    error.status = response.status
    // The parsed body, kept so callers can show the server's own validation
    // message instead of a generic one -- see errorMessage below.
    error.data = payload
    throw error
  }

  if (response.status === 204) {
    return null
  }
  return response.json()
}

// What to actually show the user when a write fails. DRF answers with either
// {detail: "..."} or {field: ["...", ...]} (nested a level deeper for nested
// serializers), and this app's validators phrase those as whole sentences --
// "Missing required fields: Meeting date.", "A reason is required to
// archive." -- so they're shown as-is rather than behind a generic line.
// Field *names* are deliberately left out: they're API keys ("archive_reason",
// "committed_date"), not labels the user would recognise.
// Falls back for a network failure, an HTML error page, or a bare 500.
export function errorMessage(error, fallback) {
  const data = error?.data
  if (typeof data === 'string') {
    return data.trim() || fallback
  }
  if (!data || typeof data !== 'object') {
    return fallback
  }
  if (typeof data.detail === 'string' && data.detail.trim()) {
    return data.detail
  }

  const messages = []
  const collect = (value) => {
    if (typeof value === 'string') {
      if (value.trim()) messages.push(value.trim())
    } else if (Array.isArray(value)) {
      value.forEach(collect)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collect)
    }
  }
  collect(data)

  return messages.length > 0 ? messages.join(' ') : fallback
}

export const get = (url) => request('GET', url)
export const post = (url, body) => request('POST', url, body)
export const patch = (url, body) => request('PATCH', url, body)
export const del = (url) => request('DELETE', url)