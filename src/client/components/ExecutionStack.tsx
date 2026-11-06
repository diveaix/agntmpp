import { useId } from 'react'
import { motion, useTransform, type MotionValue } from 'framer-motion'

type Step = 0 | 1 | 2
type ExecutionStackProps = {
  progress: MotionValue<number>
  reducedMotion: boolean
  activeStep: Step
}

const positions = [[218, 355, 512], [180, 355, 550], [203, 355, 527]] as const
const labels = ['YOUR AGENT', './AGENT MCP', 'SUPPORTED NETWORKS']
const face = 'M0-148 256 0 0 148-256 0Z'

function Layer({ id, step, y, active, reducedMotion }: { id: string; step: Step; y: number | MotionValue<number>; active: boolean; reducedMotion: boolean }) {
  return (
    <motion.g className="execution-layer" style={{ y }}>
      <g transform="translate(320 0) scale(1.25)">
        <path d={face} transform="translate(0 62)" fill="#000" opacity=".4" filter={`url(#${id}-shadow)`} />
        <path d="M-256 0 0 148V192L-256 44Z" fill={`url(#${id}-front)`} />
        <path d="M0 148 256 0V44L0 192Z" fill={`url(#${id}-side)`} />
        <path d={face} fill={`url(#${id}-surface)`} stroke="#d5d5d5" strokeOpacity=".35" strokeWidth=".7" />
        {step !== 0 && <path d={face} fill={`url(#${id}-occlusion)`} />}
        <path d="M-256 0 0 148 256 0M0 148V192" fill="none" stroke="#eee" strokeOpacity=".35" strokeWidth=".8" />
        <motion.text transform="matrix(.8660254 .5 0 1 -22 157)" textAnchor="end" fontSize="13" letterSpacing=".7"
          animate={{ fill: active ? '#202020' : '#565656' }} transition={{ duration: reducedMotion ? 0 : .3 }}>{labels[step]}</motion.text>
        {step === 0 && (
          <>
            <path d="M0-99 170 0 0 99-170 0Z" fill="#676767" />
            <path d="M-155-2 0 88V99L-155 10Z" fill="#8c8c8c" />
            <path d="M0 88 155-2V10L0 99Z" fill="#414141" />
            <path d="M0-92 155-2 0 88-155-2Z" fill={`url(#${id}-inset)`} stroke="#c8c8c8" strokeOpacity=".35" strokeWidth=".6" />
            <g fill="#767676" fillOpacity=".2" stroke="#ddd" strokeOpacity=".14" strokeWidth=".7">
              <path d="M0-78 57-45 0-12-57-45Z" />
              <path d="M-68-39-11-6-68 27-125-6Z" />
              <path d="M68-39 125-6 68 27 11-6Z" />
              <path d="M0 0 57 33 0 66-57 33Z" />
            </g>
            <path d="M0-36 59-2 0 32-59-2Z" transform="translate(6 12)" fill="#000" opacity=".4" filter={`url(#${id}-chip-shadow)`} />
            <path d="M-46-13 0 14V29L-46 2Z" fill="#e3e3e3" />
            <path d="M0 14 46-13V2L0 29Z" fill="#747474" />
            <path d="M0-40 46-13 0 14-46-13Z" fill="#dededc" stroke="#fff" strokeOpacity=".5" strokeWidth=".6" />
            <g transform="translate(-13 -30) scale(.25 .19)" fill="#4d4d4d">
              <path d="M92.9 3.8 38.9 127.8H57.8L113.3 3.8Z" />
              <circle cx="16.5" cy="103" r="13" />
            </g>
            <g fill="none" stroke="#ededed" strokeWidth="1" strokeOpacity=".7">
              <path d="M7-24 193-131H251" />
              <path d="M99 0 218-69H273" />
              <circle cx="7" cy="-24" r="2" fill="#ededed" />
              <circle cx="99" cy="0" r="2" fill="#ededed" />
            </g>
            <g fill="#c9c9c9" fontSize="11" letterSpacing="1">
              <text x="195" y="-142">MCP CLIENT</text>
              <text x="200" y="-80">TOOL ACCESS</text>
            </g>
          </>
        )}
      </g>
    </motion.g>
  )
}

export default function ExecutionStack({ progress, reducedMotion, activeStep }: ExecutionStackProps) {
  const id = `execution-${useId().replace(/:/g, '')}`
  // Keep the plates separated throughout the scroll; move them as one assembly.
  const topY = useTransform(progress, [0, .5, 1], [230, 180, 210])
  const bottomY = useTransform(progress, [0, .5, 1], [500, 550, 520])
  const position = positions[activeStep]

  return (
    <svg className="execution-stack" viewBox="0 0 680 820" role="img" aria-labelledby={`${id}-title`}>
      <title id={`${id}-title`}>The ./AGENT architecture: your agent connects through MCP to tools on supported networks.</title>
      <defs>
        <linearGradient id={`${id}-surface`} x1="-256" y1="55" x2="170" y2="-100" gradientUnits="userSpaceOnUse">
          <stop stopColor="#dddddb" /><stop offset=".45" stopColor="#b6b6b4" /><stop offset="1" stopColor="#737373" />
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="-256" y1="0" x2="0" y2="180" gradientUnits="userSpaceOnUse">
          <stop stopColor="#eeeeec" /><stop offset="1" stopColor="#a4a4a3" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="0" y1="180" x2="256" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#565656" /><stop offset="1" stopColor="#292929" />
        </linearGradient>
        <linearGradient id={`${id}-inset`} x1="-155" y1="50" x2="155" y2="-65" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c7c7c5" /><stop offset="1" stopColor="#7b7b7b" />
        </linearGradient>
        <radialGradient id={`${id}-occlusion`} cx="55%" cy="26%" r="65%">
          <stop stopColor="#000" stopOpacity=".5" /><stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-30%" y="-40%" width="160%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
        <filter id={`${id}-chip-shadow`} x="-40%" y="-70%" width="180%" height="240%"><feGaussianBlur stdDeviation="5" /></filter>
      </defs>
      <Layer id={id} step={2} y={reducedMotion ? position[2] : bottomY} active={activeStep === 2} reducedMotion={reducedMotion} />
      <Layer id={id} step={1} y={355} active={activeStep === 1} reducedMotion={reducedMotion} />
      <Layer id={id} step={0} y={reducedMotion ? position[0] : topY} active={activeStep === 0} reducedMotion={reducedMotion} />
    </svg>
  )
}
