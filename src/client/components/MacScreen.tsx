import { useId } from 'react'

export default function MacScreen() {
  const id = useId()

  return (
    <svg className="mac-svg" viewBox="0 0 520 680" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-case`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eeede6" />
          <stop offset=".45" stopColor="#d2d1ca" />
          <stop offset="1" stopColor="#adaaa3" />
        </linearGradient>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d7d6cf" />
          <stop offset="1" stopColor="#c2c1b9" />
        </linearGradient>
        <linearGradient id={`${id}-base`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#908f87" />
          <stop offset=".25" stopColor="#bcbab2" />
          <stop offset=".85" stopColor="#aaa89f" />
          <stop offset="1" stopColor="#918f86" />
        </linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#282a2a" />
          <stop offset=".35" stopColor="#141616" />
          <stop offset="1" stopColor="#090b0b" />
        </linearGradient>
      </defs>

      {/* The plinth belongs to the cabinet and sits behind its lower lip. */}
      <rect x="52" y="570" width="416" height="60" rx="8" fill={`url(#${id}-base)`} />
      <path d="M64 624H456" fill="none" stroke="#78756e" strokeOpacity=".5" />

      {/* Molded front shell: a broad face framed by soft, substantial bevels. */}
      <rect x="40" y="50" width="440" height="520" rx="18" fill={`url(#${id}-case)`} stroke="#9d9a92" strokeWidth=".8" />
      <path d="M58 51H462Q477 51 479 67" fill="none" stroke="#f8f7f0" strokeOpacity=".8" />
      <rect x="51" y="63" width="418" height="493" rx="10" fill={`url(#${id}-face)`} />
      <path d="M53 548Q53 558 63 558H457" fill="none" stroke="#f0eee6" strokeOpacity=".4" />

      {/* Four sloping surfaces recess the CRT into the face. */}
      <rect x="62" y="80" width="396" height="330" rx="18" fill="#b6b4ac" />
      <path d="M80 80H440Q458 80 458 98L436 115Q430 102 418 102H102Q90 102 84 115L62 98Q62 80 80 80Z" fill="#98958b" />
      <path d="M62 98L84 115V375L62 392Z" fill="#a8a49a" />
      <path d="M458 98L436 115V375L458 392Z" fill="#cdc9c1" />
      <path d="M62 392L84 375Q90 388 102 388H418Q430 388 436 375L458 392Q458 410 440 410H80Q62 410 62 392Z" fill="#e8e5dc" />
      <rect x="82" y="102" width="356" height="286" rx="19" fill="#1e201e" />
      <rect x="85" y="106" width="350" height="277" rx="16" fill="#0b0c0b" />
      <rect x="88" y="112" width="344" height="266" rx="13" fill={`url(#${id}-glass)`} />
      <path d="M103 106Q260 96 418 106" fill="none" stroke="#f5f3ed" strokeOpacity=".1" />

      {/* Asymmetric disk aperture and recessed eject detail. */}
      <path d="M271 453H436V478H271L278 471V460Z" fill="#e4e1d8" />
      <path d="M278 460H429V472H278Z" fill="#848175" />
      <rect x="281" y="463" width="148" height="7" rx=".8" fill="#28271f" />
      <path d="M399 454H434V474H405V465H399Z" fill="#9b9688" />
      <path d="M399 453H434V461H405Z" fill="#dbd7ca" />
      <circle cx="444" cy="470" r="1.5" fill="#5c574a" />

      <text x="83" y="527" fill="#696458" fontFamily="'Space Mono', monospace" fontSize="13" letterSpacing=".7">./AGENT</text>
      <path d="M57 570H463" fill="none" stroke="#6f695e" strokeOpacity=".65" />
    </svg>
  )
}
