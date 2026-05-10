import { Link } from 'react-router-dom'
import Footer from '../components/Footer'
import Nav from '../components/Nav'

const plans = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: 'forever',
    note: 'No account needed. Add the MCP server URL and start using the open tools instantly.',
    points: [
      'Hosted MCP access',
      'Manual DeFi actions',
      'One data automation',
      'Community support',
    ],
    cta: null,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$49',
    period: '/mo',
    note: 'For users who want fast data automations, auto-execute, and priority evaluations.',
    points: [
      'Everything in Free',
      '5 data automations',
      'Auto-execute enabled',
      '25 custom sources',
      'Priority evaluations',
    ],
    cta: 'Get Pro Access',
    popular: true,
  },
  {
    id: 'max',
    name: 'Ultra',
    price: '$199',
    period: '/mo',
    note: 'For power users running many news-driven Hyperliquid and Polymarket automations.',
    points: [
      'Everything in Pro',
      '50 data automations',
      'Highest priority queue',
      '100 custom sources',
      'Dedicated support',
    ],
    cta: 'Get Ultra Access',
  },
] as const

const comparisonRows = [
  { feature: 'MCP server access', free: 'Yes', pro: 'Yes', ultra: 'Yes' },
  { feature: 'Manual DeFi tools', free: 'Yes', pro: 'Yes', ultra: 'Yes' },
  { feature: 'Data automations', free: '1', pro: '5', ultra: '50' },
  { feature: 'Auto-execute', free: '-', pro: 'Yes', ultra: 'Yes' },
  { feature: 'Custom sources', free: '-', pro: '25', ultra: '100' },
  { feature: 'Priority queue', free: '-', pro: 'Yes', ultra: 'Highest' },
  { feature: 'API key', free: '-', pro: 'Yes', ultra: 'Yes' },
] as const

export default function PlansPage() {
  return (
    <>
      <Nav />

      <main className="plans-page">
        {/* Cards */}
        <section className="plans-grid" aria-label="AGNT plans">
          {plans.map((plan) => (
            <article
              key={plan.id}
              className={`plan-card${plan.id === 'pro' ? ' plan-card--popular' : ''}${plan.id === 'free' ? ' plan-card--free' : ''}`}
            >
              {'popular' in plan && plan.popular && (
                <div className="plan-card__badge">Most Popular</div>
              )}
              <div className="plan-card__top">
                <span className="plan-kicker">{plan.id === 'max' ? 'ultra' : plan.id}</span>
                <h2>{plan.name}</h2>
                <div className="plan-card__price">
                  <strong>{plan.price}</strong>
                  <span>{plan.period}</span>
                </div>
                <p>{plan.note}</p>
              </div>
              <div className="plan-card__divider" />
              <ul className="plan-card__features">
                {plan.points.map((point) => (
                  <li key={point}>
                    <span className="plan-check">+</span>
                    {point}
                  </li>
                ))}
              </ul>
              {plan.id === 'free' ? (
                <div className="plan-static">Connect MCP - no signup</div>
              ) : (
                <Link className="plan-button" to={`/checkout?plan=${plan.id}`}>
                  {plan.cta}
                </Link>
              )}
            </article>
          ))}
        </section>

        {/* Comparison table */}
        <section className="plans-compare">
          <h2>Compare Plans</h2>
          <div className="plans-compare__table">
            <div className="plans-compare__head">
              <span>Feature</span>
              <span>Free</span>
              <span>Pro</span>
              <span>Ultra</span>
            </div>
            {comparisonRows.map((row) => (
              <div className="plans-compare__row" key={row.feature}>
                <span>{row.feature}</span>
                <span>{row.free}</span>
                <span>{row.pro}</span>
                <span>{row.ultra}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="plans-bottom-cta">
          <h2>Start Free. Upgrade Anytime.</h2>
          <p>Add the MCP server URL to your agent and go. No account, no credit card.</p>
          <div className="plans-bottom-actions">
            <Link to="/toolkit" className="plan-button">Access Toolkit</Link>
            <Link to="/docs" className="plan-button plan-button--outline">Read Docs</Link>
          </div>
        </section>
      </main>

      <Footer />
    </>
  )
}
