import { useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import FloatingLabel from 'react-bootstrap/FloatingLabel'
import Form from 'react-bootstrap/Form'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../AuthContext.jsx'
import BrandMark from '../components/BrandMark.jsx'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // Checked by default: leaving it on is the behaviour this app had before
  // the choice existed, so nobody's session gets shorter without asking.
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password, remember)
      navigate('/', { replace: true })
    } catch {
      setError('Invalid username or password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login">
      {/* Brand half. Purely decorative -- the page's own heading lives in
          the form, so a screen reader meets "Sign in to Altrium" first
          rather than a logo read twice. */}
      <div className="login__brand">
        <div className="login__brand-inner">
          <BrandMark size={72} />
          <p className="login__wordmark">Altrium CRM</p>
        </div>
      </div>

      {/* Form half: near-black, cut in over the brand half by a diagonal. */}
      <div className="login__panel">
        {/* A light-theme island: the card is white in either theme, so
            Bootstrap's own nested theme scoping repaints the controls
            inside it rather than leaving a dark-theme input on white. */}
        <div className="login__card" data-bs-theme="light">
          <h1 className="h4 mb-1">Sign in to Altrium</h1>
          <p className="text-body-secondary mb-4">Use your Altrium account to continue.</p>

          {error && <Alert variant="danger">{error}</Alert>}

          <Form onSubmit={handleSubmit}>
            {/* The label stays "Username": this app authenticates on a
                username (rep1, mgr1, ...), not an email address, and the
                floating label is the same <label for> a plain field has --
                so getByLabel('Username') still finds it. */}
            <FloatingLabel controlId="login-username" label="Username" className="mb-3">
              <Form.Control
                type="text"
                // A floating label needs a placeholder to float against --
                // Bootstrap's rule keys off :placeholder-shown. It is never
                // shown, so a single space is enough.
                placeholder=" "
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </FloatingLabel>

            <FloatingLabel controlId="login-password" label="Password" className="mb-3">
              <Form.Control
                type="password"
                placeholder=" "
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </FloatingLabel>

            <Form.Check
              type="checkbox"
              id="login-remember"
              label="Remember me"
              className="mb-4"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />

            <Button type="submit" variant="accent" className="w-100 py-2" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </Form>
        </div>
      </div>
    </div>
  )
}
