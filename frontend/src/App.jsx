import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import './App.css'
import { AuthProvider, useAuth } from './AuthContext.jsx'
import Layout from './components/Layout.jsx'
import Companies from './pages/Companies.jsx'
import LeadDetail from './pages/LeadDetail.jsx'
import Leads from './pages/Leads.jsx'
import Login from './pages/Login.jsx'
import Preferences from './pages/Preferences.jsx'
import Settings from './pages/Settings.jsx'

function RequireAuth() {
  const { user, loading } = useAuth()

  if (loading) {
    return null
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/companies" replace />} />
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/companies" element={<Companies />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/preferences" element={<Preferences />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App