export default function MacScreen() {
  return (
    <svg className="mac-svg" viewBox="0 0 520 680" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bodyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d4cbb8" />
          <stop offset="35%" stopColor="#c7bda8" />
          <stop offset="100%" stopColor="#b0a590" />
        </linearGradient>
        <linearGradient id="topHL" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,245,0.2)" />
          <stop offset="100%" stopColor="rgba(255,255,245,0)" />
        </linearGradient>
        <linearGradient id="bezelGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bfb5a0" />
          <stop offset="100%" stopColor="#a89b86" />
        </linearGradient>
        <filter id="screenShadow">
          <feDropShadow dx="0" dy="3" stdDeviation="8" floodColor="#000" floodOpacity=".6" />
        </filter>
        <filter id="macShadow">
          <feDropShadow dx="0" dy="10" stdDeviation="25" floodColor="#000" floodOpacity=".5" />
        </filter>
        <linearGradient id="leftEdge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(255,252,240,0.12)" />
          <stop offset="100%" stopColor="rgba(255,252,240,0)" />
        </linearGradient>
        <linearGradient id="rightEdge" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="rgba(0,0,0,0.08)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
        <linearGradient id="chinGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c2b8a3" />
          <stop offset="100%" stopColor="#b5a993" />
        </linearGradient>
        <linearGradient id="ventGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8a7e6c" />
          <stop offset="100%" stopColor="#7a6f5e" />
        </linearGradient>
      </defs>

      {/* Main body */}
      <rect x="40" y="20" width="440" height="580" rx="16" fill="url(#bodyGrad)" filter="url(#macShadow)" />
      <rect x="40" y="20" width="440" height="40" rx="16" fill="url(#topHL)" />
      <rect x="40" y="20" width="12" height="580" rx="8" fill="url(#leftEdge)" />
      <rect x="468" y="20" width="12" height="580" rx="8" fill="url(#rightEdge)" />
      <rect x="40" y="20" width="440" height="580" rx="16" fill="none" stroke="rgba(180,170,150,0.15)" strokeWidth="1" />

      {/* Screen bezel */}
      <rect x="58" y="40" width="404" height="355" rx="10" fill="url(#bezelGrad)" />
      <rect x="58" y="40" width="404" height="355" rx="10" fill="none" stroke="rgba(160,150,130,0.12)" strokeWidth=".5" />
      <rect x="68" y="50" width="384" height="335" rx="7" fill="#030303" filter="url(#screenShadow)" />
      <rect x="72" y="54" width="376" height="327" rx="5" fill="#060606" />
      <ellipse cx="180" cy="100" rx="80" ry="35" fill="rgba(255,255,255,0.012)" />
      <rect x="90" y="370" width="340" height="8" rx="4" fill="rgba(0,0,0,0.04)" />

      {/* Chin */}
      <rect x="58" y="410" width="404" height="175" rx="10" fill="url(#chinGrad)" />
      <rect x="58" y="410" width="404" height="175" rx="10" fill="none" stroke="rgba(160,150,130,0.1)" strokeWidth=".5" />
      <line x1="78" y1="415" x2="442" y2="415" stroke="rgba(0,0,0,0.1)" strokeWidth=".5" />
      <image href="/AGNT.svg" x="215" y="435" width="24" height="24" opacity="0.35" />
      <text x="272" y="455" textAnchor="middle" fontFamily="'Space Mono',monospace" fontSize="16" fontWeight="700" fill="rgba(0,0,0,0.3)" letterSpacing="4">AGNT</text>

      {/* Floppy */}
      <rect x="170" y="478" width="180" height="8" rx="3" fill="url(#ventGrad)" stroke="rgba(100,90,75,0.2)" strokeWidth=".5" />
      <line x1="178" y1="482" x2="342" y2="482" stroke="rgba(60,55,45,0.15)" strokeWidth=".3" />

      {/* Vents */}
      <g opacity=".6">
        {[510, 518, 526, 534, 542, 550].map((y) => (
          <rect key={y} x="140" y={y} width="240" height="3" rx="1.5" fill="#8a7e6c" stroke="rgba(0,0,0,0.1)" strokeWidth=".3" />
        ))}
      </g>

      {/* LED */}
      <circle cx="420" cy="560" r="4" fill="#a09580" stroke="rgba(0,0,0,0.15)" strokeWidth=".5" />
      <circle cx="420" cy="560" r="2" fill="#4a4" opacity="1">
        <animate attributeName="opacity" values=".4;.9;.4" dur="3s" repeatCount="indefinite" />
      </circle>

      {/* Base */}
      <rect x="30" y="608" width="460" height="14" rx="4" fill="#b0a590" stroke="rgba(0,0,0,0.1)" strokeWidth=".5" />
      <rect x="20" y="622" width="480" height="10" rx="5" fill="#a89b86" />
      <rect x="20" y="622" width="480" height="10" rx="5" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth=".5" />
      <rect x="60" y="640" width="400" height="30" rx="4" fill="rgba(180,170,150,0.04)" />
      <line x1="58" y1="398" x2="462" y2="398" stroke="rgba(0,0,0,0.06)" strokeWidth=".3" />

      {/* Screws */}
      {[[70,32],[450,32],[70,588],[450,588]].map(([cx,cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="2.5" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth=".5" />
      ))}
    </svg>
  )
}
