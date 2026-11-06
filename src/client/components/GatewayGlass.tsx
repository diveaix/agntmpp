import { useId } from 'react'
import '../gateway-glass.css'

// Rounded 240 × 240 face, radius 18, projected with rotateX(54deg) rotateZ(34deg).
// The front silhouette is split at its true tangent points, then extruded 34px.
// Sharing this perimeter with the HTML face keeps every rounded corner continuous.
const frontEdge = 'M-159.601 -19.831C-159.601 -16.432 -156.820 -13.094 -151.665 -11.050L17.459 56.001C25.700 59.269 36.888 57.991 42.447 53.146L156.522 -46.262C158.604 -48.076 159.601 -50.133 159.601 -52.169'
const sidewall = `${frontEdge}L159.601 -18.169C159.601 -16.133 158.604 -14.076 156.522 -12.262L42.447 87.146C36.888 91.991 25.700 93.269 17.459 90.001L-151.665 22.950C-156.820 20.906 -159.601 17.568 -159.601 14.169Z`

export default function GatewayGlass() {
  const id = useId().replace(/:/g, '')

  return (
    <>
      <svg className="gateway-glass-shell" viewBox="-180 -148 360 260" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-glass-wall`} x1="-160" y1="0" x2="160" y2="0" gradientUnits="userSpaceOnUse">
            <stop stopColor="#313131" stopOpacity=".96" />
            <stop offset=".36" stopColor="#272727" stopOpacity=".91" />
            <stop offset=".53" stopColor="#393939" stopOpacity=".91" />
            <stop offset=".585" stopColor="#505050" stopOpacity=".93" />
            <stop offset=".65" stopColor="#242424" stopOpacity=".94" />
            <stop offset="1" stopColor="#1c1c1c" stopOpacity=".97" />
          </linearGradient>
          <linearGradient id={`${id}-glass-edge`} x1="-160" y1="0" x2="160" y2="0" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff" stopOpacity=".4" />
            <stop offset=".38" stopColor="#fff" stopOpacity=".08" />
            <stop offset=".6" stopColor="#fff" stopOpacity=".5" />
            <stop offset="1" stopColor="#fff" stopOpacity=".1" />
          </linearGradient>
        </defs>
        <path d={sidewall} fill={`url(#${id}-glass-wall)`} stroke="#fff" strokeOpacity=".1" strokeWidth=".65" />
        <path d={frontEdge} transform="translate(0 31)" fill="none" stroke="#000" strokeOpacity=".3" strokeWidth="1.7" />
        <path d={frontEdge} transform="translate(0 34)" fill="none" stroke={`url(#${id}-glass-edge)`} strokeWidth=".85" />
        <path d={frontEdge} transform="translate(0 2.5)" fill="none" stroke="#fff" strokeOpacity=".14" strokeWidth=".7" />
        <path d={frontEdge} transform="translate(0 27)" fill="none" stroke="#080808" strokeOpacity=".8" strokeWidth="2" />
        <path d={frontEdge} transform="translate(0 29)" fill="none" stroke="#fff" strokeOpacity=".1" strokeWidth=".5" />
        <g transform="matrix(.829037573 .328685342 0 1 -126 16)" stroke="#9a9a96" strokeWidth="1" strokeOpacity=".28">
          {Array.from({ length: 8 }, (_, index) => <path key={index} d={`M${index * 5} 0v5`} />)}
        </g>
      </svg>

      <div className="gateway-glass-face">
        <span className="gateway-glass-circuit" />
        <span className="gateway-glass-fastener gateway-glass-fastener-a" />
        <span className="gateway-glass-fastener gateway-glass-fastener-b" />
        <span className="gateway-glass-fastener gateway-glass-fastener-c" />
        <span className="gateway-glass-fastener gateway-glass-fastener-d" />
        <span className="gateway-glass-brand">./AGENT</span>
        <span className="gateway-glass-inscription">A PRIVATE WAY THROUGH</span>
        <span className="gateway-glass-indicators"><i /><i /><i /></span>
      </div>

      <svg className="gateway-glass-rim" viewBox="-180 -148 360 260" aria-hidden="true">
        <g transform="matrix(.829037573 .328685342 -.559192903 .487296059 0 -36)">
          <rect x="-120" y="-120" width="240" height="240" rx="18" fill="none" stroke="#fff" strokeOpacity=".57" strokeWidth="1.1" />
          <rect x="-116.5" y="-116.5" width="233" height="233" rx="15" fill="none" stroke="#fff" strokeOpacity=".09" strokeWidth=".8" />
        </g>
      </svg>
    </>
  )
}
