import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import LandingPage from './pages/LandingPage'
import ToolkitPage from './pages/ToolkitPage'
import DocsPage from './pages/DocsPage'
import HackathonDisabledPage from './pages/HackathonDisabledPage'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/toolkit" element={<ToolkitPage />} />
        <Route path="/presale" element={<ToolkitPage />} />
        <Route path="/plans" element={<HackathonDisabledPage />} />
        <Route path="/checkout" element={<HackathonDisabledPage />} />
        <Route path="/dashboard" element={<HackathonDisabledPage />} />
        <Route path="/docs" element={<DocsPage />} />
      </Routes>
    </BrowserRouter>
  )
}
