import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js'
import MacScreen from './MacScreen'

function roundedOutline(width: number, height: number, radius: number, y = 0) {
  const shape = new THREE.Shape(), x = -width / 2, bottom = y - height / 2
  shape.moveTo(x + radius, bottom)
  shape.lineTo(x + width - radius, bottom)
  shape.quadraticCurveTo(x + width, bottom, x + width, bottom + radius)
  shape.lineTo(x + width, bottom + height - radius)
  shape.quadraticCurveTo(x + width, bottom + height, x + width - radius, bottom + height)
  shape.lineTo(x + radius, bottom + height)
  shape.quadraticCurveTo(x, bottom + height, x, bottom + height - radius)
  shape.lineTo(x, bottom + radius)
  shape.quadraticCurveTo(x, bottom, x + radius, bottom)
  return shape
}

/** One physical cabinet; the HTML display shares the model's camera and transform. */
export default function MacintoshComputer({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const [screenElement] = useState(() => {
    const element = document.createElement('div')
    element.className = 'wh-screen-plane'
    return element
  })
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const host = hostRef.current!, fallback = fallbackRef.current!
    fallback.appendChild(screenElement)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    } catch {
      return () => { screenElement.remove() }
    }

    renderer.setSize(520, 680)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = .95
    renderer.domElement.className = 'wh-model-canvas'
    renderer.domElement.setAttribute('aria-hidden', 'true')
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(16.5, 520 / 680, 1, 5000)
    camera.position.set(0, 0, 2520)
    camera.lookAt(0, 0, 0)
    const environment = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const environmentMap = pmrem.fromScene(environment, .04)
    scene.environment = environmentMap.texture
    scene.environmentIntensity = .32
    environment.dispose()
    pmrem.dispose()

    scene.add(new THREE.HemisphereLight('#ffffff', '#5d5c55', .8))
    const key = new THREE.DirectionalLight('#fffaf1', 2.4)
    key.position.set(-500, 650, 800); scene.add(key)
    const fill = new THREE.DirectionalLight('#e7ebf0', .55)
    fill.position.set(550, 140, 420); scene.add(fill)
    const rim = new THREE.DirectionalLight('#ffffff', 1.3)
    rim.position.set(-200, 320, -600); scene.add(rim)

    const body = new THREE.Group()
    body.position.set(5, 7, 0)
    scene.add(body)
    const plastic = new THREE.MeshStandardMaterial({ color: '#c7c4b5', roughness: .76, metalness: 0 })
    const sidePlastic = new THREE.MeshStandardMaterial({ color: '#a9a89b', roughness: .8 })
    const bevelPlastic = new THREE.MeshStandardMaterial({ color: '#b5b2a4', roughness: .72 })
    const basePlastic = new THREE.MeshStandardMaterial({ color: '#b4b1a2', roughness: .8 })
    const seam = new THREE.MeshStandardMaterial({ color: '#646458', roughness: .9 })
    const recess = new THREE.MeshStandardMaterial({ color: '#1b1d1c', roughness: .82 })
    const rubber = new THREE.MeshStandardMaterial({ color: '#111313', roughness: .95 })

    // Fine surface relief catches the light without turning the case into metal.
    const grainCanvas = document.createElement('canvas')
    grainCanvas.width = grainCanvas.height = 128
    const grainContext = grainCanvas.getContext('2d')!
    const grainData = grainContext.createImageData(128, 128)
    for (let i = 0; i < grainData.data.length; i += 4) {
      const shade = 115 + ((i * 13 ^ i >>> 3) % 27)
      grainData.data.set([shade, shade, shade, 255], i)
    }
    grainContext.putImageData(grainData, 0, 0)
    const grain = new THREE.CanvasTexture(grainCanvas)
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping
    grain.repeat.set(5, 5)
    for (const material of [plastic, sidePlastic, bevelPlastic, basePlastic]) {
      material.bumpMap = grain; material.bumpScale = .1
    }

    function box(width: number, height: number, depth: number, x: number, y: number, z: number, material: THREE.Material, radius = 2) {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, 4, Math.min(radius, width / 2, height / 2, depth / 2)), material)
      mesh.position.set(x, y, z); body.add(mesh)
      return mesh
    }

    // The rear shell tapers toward the back, with a separate molded front surround.
    const cabinet = box(432, 568, 322, 0, 0, -67, sidePlastic, 16)
    const positions = cabinet.geometry.attributes.position
    for (let i = 0; i < positions.count; i++) {
      const rear = (161 - positions.getZ(i)) / 322
      positions.setX(i, positions.getX(i) * (1 - .065 * rear))
      positions.setY(i, positions.getY(i) * (1 - .035 * rear) + rear * 5)
    }
    cabinet.geometry.computeVertexNormals()
    box(430, 514, 5, 0, 30, 96, seam, 2)

    const front = roundedOutline(428, 508, 14, 30)
    const opening = roundedOutline(386, 316, 24, 95)
    front.holes.push(new THREE.Path(opening.getPoints(16)))
    const surround = new THREE.Mesh(new THREE.ExtrudeGeometry(front, {
      depth: 20, bevelEnabled: true, bevelThickness: 6, bevelSize: 6, bevelSegments: 5, curveSegments: 16,
    }), plastic)
    surround.position.z = 101; body.add(surround)

    // A real sloping reveal between the front fascia and the recessed CRT gasket.
    const outer = roundedOutline(388, 318, 25, 95).getPoints(24)
    const inner = roundedOutline(351, 276, 23, 95).getPoints(24)
    const vertices: number[] = [], indices: number[] = []
    outer.forEach((point, i) => {
      vertices.push(point.x, point.y, 126, inner[i].x, inner[i].y, 95)
      if (i < outer.length - 1) {
        const a = i * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    })
    const revealGeometry = new THREE.BufferGeometry()
    revealGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    revealGeometry.setIndex(indices); revealGeometry.computeVertexNormals()
    const reveal = new THREE.Mesh(revealGeometry, bevelPlastic)
    reveal.material.side = THREE.DoubleSide; body.add(reveal)
    box(357, 282, 18, 0, 95, 83, rubber, 16)
    const glass = new THREE.MeshPhysicalMaterial({ color: '#12181a', roughness: .17, clearcoat: 1, clearcoatRoughness: .18 })
    box(349, 273, 12, 0, 95, 91, glass, 6)

    // The characteristic asymmetric floppy mouth and its finger/eject recess.
    box(167, 23, 3, 91, -133, 128, bevelPlastic, 1)
    box(155, 8, 2, 91, -132, 130, recess, 1)
    box(49, 21, 4, 146, -133, 132, basePlastic, 1.5)
    box(43, 9, 2, 146, -136, 135, rubber, .8)
    box(151, 1.5, 1, 91, -140, 131, plastic, .5)
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 1.5, 16), recess)
    pin.rotation.x = Math.PI / 2; pin.position.set(183, -137, 129); body.add(pin)

    // Integrated foot/plinth, with the narrow ventilation seam of the compact Mac.
    box(416, 62, 301, 0, -261, -51, basePlastic, 8)
    box(407, 3, 2, 0, -231, 102, seam, 1)
    for (let i = 0; i < 31; i++) box(2.8, 8, 1.2, -38 + i * 6, -235, 103.4, recess, .5)
    box(31, 19, 3, 160, -268, 103, bevelPlastic, 2)
    box(12, 14, 2, 165, -268, 105, recess, .7)
    for (const x of [-172, 172]) box(34, 9, 213, x, -295, -46, rubber, 3)

    // Lower side vents follow the tapered side surface, instead of a front grille.
    for (const side of [-1, 1]) {
      for (let row = 0; row < 6; row++) {
        const vent = box(1.1, 3, 203, side * 209.9, -176 - row * 10, -50, recess, .45)
        vent.rotation.y = side * .043
      }
      for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 4; row++) {
          const vent = box(1.1, 3, 3, side * (211.5 - col * .48), -116 - row * 10, -13 - col * 11, seam, .45)
          vent.rotation.y = side * .043
        }
      }
    }

    // Carry-handle well sits within a shallow molded rim on the top of the case.
    box(157, 3, 60, 0, 284, -136, bevelPlastic, 1)
    box(133, 2, 39, 0, 286, -136, recess, 1)
    box(157, 11, 13, 0, 288, -111, sidePlastic, 4)

    const labelCanvas = document.createElement('canvas')
    labelCanvas.width = 768; labelCanvas.height = 128
    const labelContext = labelCanvas.getContext('2d')!
    labelContext.fillStyle = '#47483f'
    labelContext.font = 'bold 66px Arial'; labelContext.fillText('./', 8, 87)
    labelContext.font = '36px Georgia'; labelContext.fillText('AGENT', 126, 81)
    labelContext.font = '18px monospace'; labelContext.fillStyle = '#66675c'; labelContext.fillText('PERSONAL COMPUTER', 355, 78)
    const labelTexture = new THREE.CanvasTexture(labelCanvas)
    labelTexture.colorSpace = THREE.SRGBColorSpace
    const label = new THREE.Mesh(new THREE.PlaneGeometry(313, 52), new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, depthWrite: false }))
    label.position.set(-24, -188, 128); body.add(label)

    const cssRenderer = new CSS3DRenderer()
    cssRenderer.setSize(520, 680)
    cssRenderer.domElement.className = 'wh-model-html'
    host.appendChild(cssRenderer.domElement)
    const htmlScene = new THREE.Scene(), screenGroup = new THREE.Group()
    const display = new CSS3DObject(screenElement)
    display.position.set(0, 95, 98)
    screenGroup.add(display); htmlScene.add(screenGroup)

    let frame = 0, visible = true, disposed = false, contextLost = false
    let screenStyleBeforeLoss = ''
    let yaw = 0, pitch = 0, targetYaw = 0, targetPitch = 0
    const render = () => {
      frame = 0
      if (disposed || contextLost || !visible || document.hidden) return
      yaw += (targetYaw - yaw) * .085
      pitch += (targetPitch - pitch) * .085
      if (Math.abs(yaw - targetYaw) < .0001) yaw = targetYaw
      if (Math.abs(pitch - targetPitch) < .0001) pitch = targetPitch
      body.rotation.set(pitch, yaw, 0)
      screenGroup.position.copy(body.position)
      screenGroup.rotation.copy(body.rotation)
      renderer.render(scene, camera)
      cssRenderer.render(htmlScene, camera)
      host.classList.add('wh-model-ready')
      if (yaw !== targetYaw || pitch !== targetPitch) frame = requestAnimationFrame(render)
    }
    const schedule = () => { if (!frame && visible && !document.hidden) frame = requestAnimationFrame(render) }
    const hero = host.closest<HTMLElement>('.wh-hero')!
    const reset = () => { targetYaw = 0; targetPitch = 0; schedule() }
    const move = (event: PointerEvent) => {
      if (reducedMotion || event.pointerType === 'touch' || screenElement.contains(document.activeElement)) {
        reset()
        return
      }
      const rect = hero.getBoundingClientRect()
      const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right)
      const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom)
      targetYaw = THREE.MathUtils.clamp((event.clientX - left) / Math.max(1, right - left) * 2 - 1, -1, 1) * .3
      targetPitch = THREE.MathUtils.clamp((event.clientY - top) / Math.max(1, bottom - top) * 2 - 1, -1, 1) * .12
      schedule()
    }
    const visibility = () => { cancelAnimationFrame(frame); frame = 0; if (!document.hidden) schedule() }
    const loseContext = (event: Event) => {
      event.preventDefault()
      contextLost = true
      cancelAnimationFrame(frame); frame = 0
      host.classList.remove('wh-model-ready')
      renderer.domElement.style.visibility = 'hidden'
      cssRenderer.domElement.style.visibility = 'hidden'
      screenStyleBeforeLoss = screenElement.style.cssText
      fallback.appendChild(screenElement)
      screenElement.removeAttribute('style')
    }
    const restoreContext = () => {
      contextLost = false
      renderer.domElement.style.visibility = ''
      cssRenderer.domElement.style.visibility = ''
      screenElement.style.cssText = screenStyleBeforeLoss
      schedule()
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; visibility() })
    observer.observe(host)
    hero.addEventListener('pointermove', move)
    hero.addEventListener('pointerdown', move)
    hero.addEventListener('pointerleave', reset)
    hero.addEventListener('pointercancel', reset)
    screenElement.addEventListener('focusin', reset)
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', visibility)
    renderer.domElement.addEventListener('webglcontextlost', loseContext)
    renderer.domElement.addEventListener('webglcontextrestored', restoreContext)
    render()

    return () => {
      disposed = true
      cancelAnimationFrame(frame); observer.disconnect()
      hero.removeEventListener('pointermove', move)
      hero.removeEventListener('pointerdown', move)
      hero.removeEventListener('pointerleave', reset)
      hero.removeEventListener('pointercancel', reset)
      screenElement.removeEventListener('focusin', reset)
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', visibility)
      renderer.domElement.removeEventListener('webglcontextlost', loseContext)
      renderer.domElement.removeEventListener('webglcontextrestored', restoreContext)
      fallback.appendChild(screenElement)
      screenElement.removeAttribute('style')
      host.classList.remove('wh-model-ready')
      renderer.domElement.remove(); cssRenderer.domElement.remove()
      const materials = new Set<THREE.Material>()
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
        }
      })
      materials.forEach(material => material.dispose())
      grain.dispose(); labelTexture.dispose(); environmentMap.dispose(); renderer.dispose()
    }
  }, [reducedMotion, screenElement])

  return <div ref={hostRef} className="wh-computer">
    <div className="wh-fallback-case" aria-hidden="true"><MacScreen /></div>
    <div className="wh-fallback-screen" ref={fallbackRef} />
    {createPortal(children, screenElement)}
  </div>
}
