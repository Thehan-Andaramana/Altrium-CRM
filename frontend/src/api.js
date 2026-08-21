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
    let detail = response.statusText
    try {
      const data = await response.json()
      detail = data.detail || JSON.stringify(data)
    } catch {
      // no JSON body to read
    }
    const error = new Error(`${method} ${url} failed: ${response.status} ${detail}`)
    error.status = response.status
    throw error
  }

  if (response.status === 204) {
    return null
  }
  return response.json()
}

export const get = (url) => request('GET', url)
export const post = (url, body) => request('POST', url, body)
export const patch = (url, body) => request('PATCH', url, body)
export const del = (url) => request('DELETE', url)