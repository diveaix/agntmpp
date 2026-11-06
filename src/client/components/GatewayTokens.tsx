import { useId } from 'react'

// Orthographic projection shared by the belt and glass: 34° turn, 54° elevation.
const a = .829038, b = .328687, c = -.559193, d = .487298
const matrix = `matrix(${a} ${b} ${c} ${d} 0 0)`
export const projectToken = (x: number, y = 0) => ({ x: a * x + c * y, y: b * x + d * y })

const perimeter = Array.from({ length: 36 }, (_, index) => {
  const corner = Math.floor(index / 9)
  const angle = (-90 + corner * 90 + index % 9 * 90 / 8) * Math.PI / 180
  const centers = [[23, -23], [23, 23], [-23, 23], [-23, -23]]
  return projectToken(centers[corner][0] + 7 * Math.cos(angle), centers[corner][1] + 7 * Math.sin(angle))
})
const left = perimeter.reduce((best, p, i) => p.x < perimeter[best].x ? i : best, 0)
const right = perimeter.reduce((best, p, i) => p.x > perimeter[best].x ? i : best, 0)
const front: { x: number; y: number }[] = []
for (let i = right; ; i = (i + 1) % perimeter.length) {
  front.push(perimeter[i])
  if (i === left) break
}
const tileWall = `M${front.map(p => `${p.x},${p.y}`).join(' L')} L${[...front].reverse().map(p => `${p.x},${p.y + 14}`).join(' L')} Z`

export function GatewayTile({ chain }: { chain: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="-50 -50 100 100" className="gateway-solid-tile" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-top`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#62625f" /><stop offset=".38" stopColor="#343432" /><stop offset="1" stopColor="#20201f" /></linearGradient>
        <linearGradient id={`${id}-wall`}><stop stopColor="#444440" /><stop offset=".55" stopColor="#171716" /><stop offset="1" stopColor="#50504c" /></linearGradient>
      </defs>
      <ellipse className="gateway-token-shadow" cx="0" cy="6" rx="40" ry="22" />
      <g className="gateway-token-solid" transform="translate(0 -14)">
        <path d={tileWall} fill={`url(#${id}-wall)`} stroke="#686864" strokeWidth=".55" />
        <path d={`M${front.map(p => `${p.x},${p.y + 10.5}`).join(' L')}`} fill="none" stroke="#080808" strokeWidth="1.5" />
        <path d={`M${front.map(p => `${p.x},${p.y + 12}`).join(' L')}`} fill="none" stroke="#ffffff28" strokeWidth=".45" />
        <g transform={matrix}>
          <rect x="-30" y="-30" width="60" height="60" rx="7" fill={`url(#${id}-top)`} stroke="#aeaeaa" strokeWidth="1.2" />
          <rect x="-27" y="-27" width="54" height="54" rx="4" fill="none" stroke="#ffffff20" strokeWidth=".7" />
          <path d="M-21-24h10M-24-21v10M21 24H11M24 21V11" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth=".65" />
          <image href={`/chains/${chain}.png`} x="-17" y="-17" width="34" height="34" className="gateway-tile-logo" />
        </g>
      </g>
    </svg>
  )
}

export function GatewayCoin() {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="-60 -60 120 120" className="gateway-solid-coin" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-edge`}><stop stopColor="#737373" /><stop offset=".2" stopColor="#c8c8c8" /><stop offset=".5" stopColor="#919191" /><stop offset=".8" stopColor="#e1e1e1" /><stop offset="1" stopColor="#8b8b8b" /></linearGradient>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2=".85" y2="1"><stop stopColor="#f7f7f7" /><stop offset=".32" stopColor="#ededed" /><stop offset=".72" stopColor="#d6d6d6" /><stop offset="1" stopColor="#b7b7b7" /></linearGradient>
        <linearGradient id={`${id}-rim`}><stop stopColor="#ffffff" /><stop offset=".42" stopColor="#8c8c8c" /><stop offset=".72" stopColor="#f4f4f4" /><stop offset="1" stopColor="#999999" /></linearGradient>
      </defs>
      <ellipse className="gateway-token-shadow" cx="1" cy="8" rx="47" ry="23" />
      <g className="gateway-token-solid" transform="translate(0 -16)">
        <path d="M-44 0 A44 25.86 0 0 0 44 0 V16 A44 25.86 0 0 1 -44 16 Z" fill={`url(#${id}-edge)`} stroke="#cccccc" strokeWidth=".7" />
        {Array.from({ length: 39 }, (_, index) => {
          const angle = (index + 1) / 40 * Math.PI
          const x = 44 * Math.cos(angle), y = 25.86 * Math.sin(angle)
          return <path key={index} d={`M${x} ${y + 3}v10`} stroke="#f2f2f2" strokeOpacity=".46" strokeWidth=".55" />
        })}
        <ellipse rx="44" ry="25.86" fill={`url(#${id}-face)`} stroke={`url(#${id}-rim)`} strokeWidth="1.4" />
        <g transform={matrix}>
          <circle r="39.7" fill="none" stroke="#858585" strokeWidth=".85" />
          <circle r="38.3" fill="none" stroke="#f7f7f7" strokeOpacity=".85" strokeWidth=".55" />
          <circle r="35.7" fill="none" stroke="#999999" strokeOpacity=".25" strokeWidth=".45" />
          <path d="m246.92,186.54v11.19l-31.13,42.23h31.13v14.85h-20.07v12.3h-12.34v-12.3h-20.07v-11.19l31.1-42.23h-31.1v-14.85h20.07v-12.34h12.34v12.34h20.07Z" transform="translate(-104.18 -104.19) scale(.472)" fill="#171717" />
        </g>
      </g>
    </svg>
  )
}
