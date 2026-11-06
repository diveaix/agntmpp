import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { lazy, Suspense, useEffect } from 'react'
import LandingPage from './pages/LandingPage'
import ToolkitPage from './pages/ToolkitPage'
import WaitlistPage from './pages/WaitlistPage'
import PassSalePage from './pages/PassSalePage'

const DocsPage = lazy(() => import('./pages/DocsPage'))

function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    const target = hash ? document.getElementById(hash.slice(1)) : null
    if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' })
    else window.scrollTo({ top: 0, behavior: 'instant' })
  }, [pathname, hash])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/toolkit" element={<ToolkitPage />} />
        <Route path="/presale" element={<PassSalePage />} />
        <Route path="/checkout" element={<Navigate to="/toolkit" replace />} />
        <Route path="/dashboard/*" element={<Navigate to="/toolkit" replace />} />
        <Route path="/waitlist" element={<WaitlistPage />} />
        <Route path="/docs" element={<Suspense fallback={<div role="status" style={{ padding: '150px 32px', color: '#b5b5b0' }}>Loading documentation…</div>}><DocsPage /></Suspense>} />
      </Routes>
    </BrowserRouter>
  )
}
