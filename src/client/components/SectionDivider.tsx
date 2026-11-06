export default function SectionDivider() {
  return <div className="section-divider" aria-hidden="true">
    <span className="section-divider-field" />
    <svg viewBox="0 0 40 32" fill="none">
      <path d="m20 4 12 7-12 7-12-7Z" fill="#c5c5c1" />
      <path d="m8 11 12 7v3L8 14Z" fill="#7d7d79" />
      <path d="m32 11-12 7v3l12-7Z" fill="#4c4c49" />
      <path d="m8 20 12 7 12-7" stroke="#50504d" strokeWidth="1" />
    </svg>
    <span className="section-divider-field" />
  </div>
}
