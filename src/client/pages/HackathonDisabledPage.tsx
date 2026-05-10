import { Link } from 'react-router-dom'
import Nav from '../components/Nav'
import Footer from '../components/Footer'
import { HACKATHON_DISABLED_MESSAGE } from '../../hackathon-mode'

export default function HackathonDisabledPage() {
  return (
    <>
      <Nav />
      <main className="hackathon-disabled-page">
        <section className="hackathon-disabled-panel">
          <div className="d-eyebrow">Hackathon Mode</div>
          <h1>Account pages are paused.</h1>
          <p>{HACKATHON_DISABLED_MESSAGE}</p>
          <div className="hackathon-disabled-actions">
            <Link className="plan-button" to="/toolkit">Open Toolkit</Link>
            <Link className="plan-button plan-button-secondary" to="/docs">Read Docs</Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}
