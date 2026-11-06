import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { drawChainSymbol, type Chain } from './capability-icons'

type Kind = 'wallets' | 'routes' | 'results' | 'connection'
type Signal = { mesh: THREE.Mesh; head: THREE.Mesh; curve: THREE.Curve<THREE.Vector3>; progress: { value: number }; start: number; duration: number }
const ease = (a: number, b: number, t: number) => THREE.MathUtils.smoothstep(t, a, b)
const cycle = 8.4
const activation = (t: number, start: number, end: number) => ease(start, start + .55, t) - ease(end, end + .7, t)

function buildScene(kind: Kind, scene: THREE.Scene, anisotropy: number) {
  const root = new THREE.Group()
  scene.add(root)
  const silver = new THREE.MeshStandardMaterial({ color: '#bfc1c0', metalness: .88, roughness: .25 })
  const dark = new THREE.MeshPhysicalMaterial({ color: '#232525', metalness: .76, roughness: .31, clearcoat: .28, clearcoatRoughness: .35 })
  const inset = new THREE.MeshStandardMaterial({ color: '#111111', metalness: .35, roughness: .48 })
  const paper = new THREE.MeshStandardMaterial({ color: '#e6e6e2', metalness: .06, roughness: .68 })
  const edge = new THREE.MeshStandardMaterial({ color: '#747474', metalness: .94, roughness: .2 })
  const gasket = new THREE.MeshStandardMaterial({ color: '#080808', metalness: .05, roughness: .85 })
  const light = new THREE.MeshBasicMaterial({ color: '#efefea', toneMapped: false })
  const signals: Signal[] = []
  const updates: ((time: number) => void)[] = []
  const textures: THREE.Texture[] = []

  function box(w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material = dark, radius = .04, parent: THREE.Object3D = root) {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 5, Math.min(radius, h / 2)), material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }

  // The drawing space follows the face's aspect ratio, so type and symbols are never stretched.
  function decal(draw: (ctx: CanvasRenderingContext2D, height: number) => void, w: number, d: number, x: number, y: number, z: number, parent: THREE.Object3D = root) {
    const canvas = document.createElement('canvas')
    const scale = 1536 / Math.max(w, d)
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(d * scale)
    const ctx = canvas.getContext('2d')!
    ctx.scale(canvas.width / 512, canvas.width / 512)
    ctx.strokeStyle = '#dededb'
    ctx.fillStyle = '#dededb'
    ctx.lineWidth = 8
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    draw(ctx, 512 * d / w)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = anisotropy
    textures.push(texture)
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  function label(text: string, w: number, d: number, x: number, y: number, z: number, color = '#bcbcbc', parent: THREE.Object3D = root) {
    return decal((ctx, h) => {
      let size = h * .7
      ctx.font = `500 ${size}px monospace`
      size *= Math.min(1, 490 / ctx.measureText(text).width)
      ctx.font = `500 ${size}px monospace`
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 256, h / 2)
    }, w, d, x, y, z, parent)
  }

  function mark(w: number, x: number, y: number, z: number, light = true, parent: THREE.Object3D = root) {
    return decal(ctx => {
      ctx.fillStyle = light ? '#eeeeeb' : '#2a2a2a'
      ctx.beginPath()
      ctx.moveTo(354, 76); ctx.lineTo(411, 76); ctx.lineTo(229, 431); ctx.lineTo(172, 431)
      ctx.closePath(); ctx.fill()
      ctx.beginPath(); ctx.arc(125, 357, 31, 0, Math.PI * 2); ctx.fill()
    }, w, w, x, y, z, parent)
  }

  function terminal(w: number, x: number, y: number, z: number, parent: THREE.Object3D = root) {
    return decal(ctx => {
      ctx.lineWidth = 15
      ctx.beginPath(); ctx.moveTo(105, 150); ctx.lineTo(227, 256); ctx.lineTo(105, 362); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(290, 362); ctx.lineTo(401, 362); ctx.stroke()
    }, w, w, x, y, z, parent)
  }

  function screw(x: number, y: number, z: number, parent: THREE.Object3D = root) {
    const head = new THREE.Mesh(new THREE.CylinderGeometry(.031, .031, .009, 24), edge)
    head.position.set(x, y, z)
    parent.add(head)
    box(.028, .002, .004, x, y + .005, z, inset, .001, parent)
  }

  function line(points: number[][], start: number, duration: number, radius = .011, base = true, straightTrack = false) {
    const vertices = points.map(p => new THREE.Vector3(...p as [number, number, number]))
    let curve: THREE.Curve<THREE.Vector3> = new THREE.CatmullRomCurve3(vertices, false, 'centripetal')
    if (straightTrack) {
      const path = new THREE.CurvePath<THREE.Vector3>()
      path.add(new THREE.CatmullRomCurve3(vertices.slice(0, 4), false, 'centripetal'))
      path.add(new THREE.LineCurve3(vertices[3], vertices[4]))
      path.add(new THREE.CatmullRomCurve3(vertices.slice(4), false, 'centripetal'))
      curve = path
    }
    if (base) root.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 120, radius, 8, false), edge))
    const progress = { value: -1 }
    const material = new THREE.ShaderMaterial({
      uniforms: { progress }, transparent: true, depthWrite: false,
      vertexShader: 'varying float along; void main(){ along=uv.x; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying float along; uniform float progress; void main(){float a=smoothstep(progress-.24,progress-.035,along)*(1.-smoothstep(progress,progress+.012,along));gl_FragColor=vec4(vec3(.98),a);}',
    })
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, radius * 1.45, 8, false), material)
    root.add(mesh)
    const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 2.8, 12, 8), light)
    root.add(head)
    signals.push({ mesh, head, curve, progress, start, duration })
  }

  function coin(chain: Chain, x: number, z: number, radius = .46) {
    const group = new THREE.Group()
    group.position.set(x, .19, z)
    root.add(group)
    const profile = [
      [0, -.095], [radius - .045, -.095], [radius - .014, -.084], [radius, -.055],
      [radius, .048], [radius - .009, .069], [radius - .028, .084],
      [radius - .052, .086], [radius - .062, .072], [0, .072],
    ].map(([r, y]) => new THREE.Vector2(r, y))
    const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 128), silver)
    body.castShadow = true; body.receiveShadow = true; group.add(body)
    const face = new THREE.Mesh(new THREE.CylinderGeometry(radius - .063, radius - .063, .008, 128), paper)
    face.position.y = .074; face.receiveShadow = true; group.add(face)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - .036, .008, 12, 128), edge)
    rim.rotation.x = Math.PI / 2; rim.position.y = .086; group.add(rim)
    const milling = new THREE.InstancedMesh(new THREE.BoxGeometry(.006, .064, .004), edge, 96)
    const transform = new THREE.Object3D()
    for (let i = 0; i < 96; i++) {
      const angle = i / 96 * Math.PI * 2
      transform.position.set(Math.sin(angle) * radius, -.003, Math.cos(angle) * radius)
      transform.rotation.y = angle
      transform.updateMatrix()
      milling.setMatrixAt(i, transform.matrix)
    }
    group.add(milling)
    decal(ctx => drawChainSymbol(ctx, chain), (radius - .073) * 2, (radius - .073) * 2, 0, .080, 0, group)
    return group
  }

  if (kind === 'wallets') {
    root.rotation.y = -.10
    box(2.72, .31, 1.66, .15, .28, .65, dark, .055)
    box(2.64, .045, 1.58, .15, .457, .65, edge, .014)
    box(2.52, .042, 1.47, .15, .489, .65, gasket, .012)
    const lid = new THREE.Group()
    lid.position.set(.15, .57, .65); root.add(lid)
    box(2.65, .10, 1.59, 0, 0, 0, silver, .028, lid)
    box(2.56, .03, 1.50, 0, .056, 0, dark, .012, lid)
    mark(.81, -.66, .074, -.02, true, lid)
    label('AGENT WALLET', .93, .18, .45, .074, -.05, '#d0d0ce', lid)
    box(.78, .002, .008, .45, .074, .15, edge, .001, lid)
    for (const x of [-1.18, 1.18]) for (const z of [-.65, .65]) screw(x, .075, z, lid)
    const indicators = Array.from({ length: 3 }, (_, i) => box(.065, .010, .029, .77 + i * .11, .076, .48, edge, .004, lid))
    // Reveal a recessed contact board when the wallet's machined cover opens.
    box(2.25, .018, 1.22, .15, .48, .65, inset, .012)
    for (let i = 0; i < 3; i++) {
      box(.48, .008, .026, -.62 + i * .76, .493, .63, edge, .002)
      box(.025, .008, .54, -.39 + i * .76, .493, .63, edge, .002)
    }
    box(.19, .13, .36, 1.53, .36, .65, gasket, .023)
    box(.14, .058, .25, 1.61, .41, .65, edge, .014)
    const positions = [[-1.88, -.88], [-.15, -1.43], [1.75, -.98]]
    ;(['ethereum', 'near', 'zcash'] as const).forEach((chain, i) => {
      const [x, z] = positions[i]
      const token = coin(chain, x, z)
      const port = -.77 + i * .91
      box(.22, .075, .11, port, .31, -.21, edge, .013)
      const begin = .4 + i * .64
      line([[x, .17, z + .38], [x, .12, z + .55], [port, .15, -.44], [port, .30, -.21]], begin + .45, 1.55, .013)
      const contact = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, 1, 10), edge)
      contact.position.set(x, .17, z + .38); root.add(contact)
      updates.push(t => {
        const connect = activation(t, begin, 5.8 + i * .2)
        token.position.y = .19 + connect * .29
        token.rotation.z = Math.sin(connect * Math.PI) * (i === 1 ? -.09 : .09)
        contact.scale.y = Math.max(.001, connect * .29)
        contact.position.y = .17 + connect * .145
        const lit = activation(t, begin + 1.7, 6.8)
        indicators[i].material = lit > .5 ? light : edge
      })
    })
    updates.push(t => {
      const open = activation(t, 1.8, 6.15)
      lid.position.y = .57 + .31 * open
      lid.rotation.z = -.026 * open
    })
  }

  if (kind === 'routes') {
    box(2.56, .27, 2.04, 0, .24, 0, dark, .055)
    box(2.49, .045, 1.97, 0, .397, 0, edge, .014)
    box(2.41, .025, 1.89, 0, .434, 0, gasket, .01)
    box(2.34, .043, 1.82, 0, .466, 0, dark, .018)
    for (const x of [-1.07, 1.07]) for (const z of [-.80, .80]) screw(x, .493, z)
    for (const [i, z] of [-.32, .52].entries()) {
      box(1.91, .012, .102, 0, .492, z, gasket, .005)
      box(1.72, .01, .021, 0, .5, z, edge, .004)
      for (const x of [-.98, .98]) {
        box(.13, .034, .19, x, .50, z, edge, .013)
        box(.046, .013, .08, x, .522, z, paper, .004)
      }
      label(i === 0 ? '01 / PREPARE' : '02 / EXECUTE', 1.15, .19, -.10, .492, z - .27)
      const begin = .45 + i * 2.9
      line([[-2.21, .18, -.16], [-1.59, .16, -.16], [-1.28, .34, z], [-.98, .527, z], [.98, .527, z], [1.40, .20, z], [2.21, .18, .20]], begin, 2.55, .012, true, true)
      const shuttle = new THREE.Group()
      shuttle.position.set(-.93, .536, z); root.add(shuttle)
      box(.27, .045, .18, 0, 0, 0, silver, .014, shuttle)
      box(.15, .009, .023, 0, .028, 0, light, .004, shuttle)
      updates.push(t => {
        const run = ease(begin + .5, begin + 1.9, t)
        const reset = ease(7, 8.15, t)
        shuttle.position.x = -.93 + 1.86 * run * (1 - reset)
        shuttle.position.y = .536 + .025 * Math.sin(run * Math.PI)
      })
    }
    coin('ethereum', -2.21, -.16, .48)
    const destination = coin('zcash', 2.21, .20, .48)
    box(.37, .014, .035, .61, .492, .76, inset, .006)
    const status = box(.29, .015, .023, .61, .502, .76, silver, .005)
    updates.push(t => {
      const settled = activation(t, 5.55, 7.1)
      status.material = settled > .5 ? light : silver
      destination.position.y = .19 + settled * .25
    })
  }

  if (kind === 'results') {
    const input = new THREE.Group()
    input.position.set(-1.60, 0, .57); root.add(input)
    box(1.46, .26, 1.28, 0, .25, 0, dark, .055, input)
    box(1.40, .045, 1.22, 0, .404, 0, edge, .014, input)
    box(1.31, .038, 1.13, 0, .442, 0, inset, .014, input)
    terminal(.90, 0, .464, -.06, input)
    label('INSTRUCTION', .87, .10, 0, .466, .43, '#999999', input)
    box(1.66, .20, 1.98, 1.14, .19, -.35, dark, .05)
    box(1.59, .035, 1.90, 1.14, .313, -.35, edge, .012)
    box(1.51, .025, 1.82, 1.14, .343, -.35, inset, .010)
    box(1.30, .021, .035, 1.14, .365, .40, edge, .005)
    const printerLight = box(.55, .009, .012, 1.14, .378, .425, light, .003)
    const receipt = new THREE.Group()
    receipt.position.set(1.14, .40, -.35); root.add(receipt)
    const outline = new THREE.Shape()
    outline.moveTo(-.68, -.86)
    for (let i = 1; i <= 16; i++) outline.lineTo(-.68 + i * 1.36 / 16, i % 2 ? -.825 : -.86)
    outline.lineTo(.68, .64); outline.lineTo(.46, .86); outline.lineTo(-.68, .86); outline.closePath()
    const sheet = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: .016, bevelEnabled: true, bevelThickness: .003, bevelSize: .003, bevelSegments: 3, steps: 1 }), paper)
    sheet.rotation.x = -Math.PI / 2; sheet.castShadow = true; sheet.receiveShadow = true; receipt.add(sheet)
    const foldGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([.46, .02, -.86, .46, .047, -.64, .68, .02, -.64], 3))
    foldGeometry.computeVertexNormals()
    receipt.add(new THREE.Mesh(foldGeometry, new THREE.MeshStandardMaterial({ color: '#b6b6b3', roughness: .72, side: THREE.DoubleSide })))
    decal((ctx, h) => {
      ctx.fillStyle = '#353535'; ctx.strokeStyle = '#646464'; ctx.lineWidth = 2
      ctx.font = '600 35px monospace'; ctx.fillText('RECEIPT', 38, 66)
      ctx.font = '22px monospace'; ctx.fillStyle = '#737373'; ctx.fillText('TRANSACTION / 001', 38, 103)
      ctx.beginPath(); ctx.moveTo(38, 129); ctx.lineTo(475, 129); ctx.stroke()
      ctx.strokeStyle = '#333333'; ctx.lineWidth = 6
      ctx.beginPath(); ctx.arc(256, 235, 55, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(228, 234); ctx.lineTo(248, 254); ctx.lineTo(286, 215); ctx.stroke()
      ctx.fillStyle = '#333333'; ctx.textAlign = 'center'; ctx.font = '500 27px monospace'; ctx.fillText('EXECUTED', 256, 329)
      ctx.lineWidth = 2; ctx.strokeStyle = '#9b9b98'
      for (const y of [389, 435, 481]) { ctx.beginPath(); ctx.moveTo(38, y); ctx.lineTo(475, y); ctx.stroke() }
      for (let i = 0; i < 35; i++) { ctx.fillStyle = i % 3 ? '#777775' : '#a6a6a3'; ctx.fillRect(39 + i * 9, h - 90, i % 4 ? 3 : 5, 31) }
    }, 1.25, 1.61, 0, .024, 0, receipt)
    line([[-.88, .24, .57], [-.40, .13, .57], [.06, .13, .10], [.40, .24, -.35]], .65, 1.9, .014)
    box(.11, .08, .22, -.88, .25, .57, edge, .014)
    box(.10, .075, .22, .34, .25, -.35, edge, .012)
    updates.push(t => {
      const press = activation(t, .25, .90)
      input.position.y = -press * .065
      const reveal = ease(2.5, 4.1, t) - ease(6.6, 8.15, t)
      receipt.position.y = .40 + reveal * .52
      receipt.position.z = -.35 - reveal * .24
      receipt.rotation.x = -reveal * .075
      printerLight.scale.x = .3 + reveal * .7
      printerLight.visible = t > 1.8 && t < 7.6
    })
  }

  if (kind === 'connection') {
    root.rotation.y = -.08
    box(3.10, .25, 1.77, .45, .25, -.22, dark, .055)
    box(3.03, .045, 1.70, .45, .402, -.22, edge, .014)
    box(2.94, .023, 1.61, .45, .442, -.22, gasket, .009)
    box(2.87, .025, 1.54, .45, .466, -.22, dark, .01)
    for (const x of [-.87, 1.77]) for (const z of [-.88, .43]) screw(x, .483, z)
    for (let i = 0; i < 3; i++) {
      const x = -.44 + i * .89
      box(.77, .065, 1.03, x, .523, -.29, inset, .026)
      box(.71, .035, .97, x, .572, -.29, edge, .011)
      const top = new THREE.Group()
      top.position.set(x, .62, -.29); root.add(top)
      box(.66, .07, .92, 0, 0, 0, i === 1 ? silver : dark, .022, top)
      box(.60, .014, .86, 0, .041, 0, i === 1 ? paper : inset, .006, top)
      for (let p = 0; p < 4; p++) {
        box(.048, .022, .15, x - .225 + p * .15, .489, .30, silver, .005)
        box(.048, .022, .12, x - .225 + p * .15, .489, -.88, silver, .005)
      }
      if (i === 1) mark(.46, 0, .051, -.06, false, top)
      else decal(ctx => {
        ctx.strokeStyle = '#d4d4d0'; ctx.lineWidth = 15
        ctx.beginPath()
        if (i === 0) { ctx.roundRect(112, 161, 280, 200, 20); ctx.stroke(); ctx.strokeRect(297, 228, 102, 68) }
        else { [125, 212, 299, 386].forEach((px, k) => { ctx.moveTo(px, 369); ctx.lineTo(px, 149 + k * 43) }); ctx.stroke() }
      }, .47, .47, 0, .051, -.06, top)
      label(i === 0 ? 'WALLET' : i === 1 ? './AGENT' : 'TOOLS', .43, .077, 0, .051, .29, i === 1 ? '#555555' : '#949494', top)
      const begin = 1.5 + i * .65
      const socketLight = box(.31, .008, .024, x, .491, .48, edge, .003)
      // Physical contacts remain seated while the three module caps rise in sequence.
      const contacts = [-.21, .21].map(dx => box(.028, 1, .028, x + dx, .60, -.29, edge, .002))
      updates.push(t => {
        const connected = activation(t, begin, 6.3 + i * .2)
        const lift = connected * (i === 1 ? .32 : .22)
        top.position.y = .62 + lift
        contacts.forEach(contact => { contact.scale.y = Math.max(.001, lift); contact.position.y = .60 + lift / 2 })
        socketLight.material = connected > .65 ? light : edge
      })
    }
    line([[-.44, .49, .48], [-.44, .49, .58], [.45, .49, .58], [.45, .49, .48]], 2.1, 1.0, .008)
    line([[.45, .49, .48], [.45, .49, .58], [1.34, .49, .58], [1.34, .49, .48]], 2.8, 1.0, .008)
    box(1.32, .26, 1.10, -1.59, .25, 1.21, dark, .055)
    box(1.26, .040, 1.04, -1.59, .402, 1.21, edge, .012)
    box(1.18, .030, .96, -1.59, .440, 1.21, inset, .012)
    terminal(.80, -1.59, .459, 1.21)
    box(.22, .08, .10, .45, .32, .70, edge, .015)
    const connection = [[-1.03, .22, 1.21], [-.36, .13, 1.21], [.45, .14, .98], [.45, .32, .70]]
    line(connection, .45, 1.55, .014)
    line([...connection].reverse(), 5.35, 1.55, .014, false)
  }

  return {
    update(t: number) {
      signals.forEach(s => {
        s.progress.value = (t - s.start) / s.duration * 1.17
        s.mesh.visible = t > s.start && t < s.start + s.duration
        s.head.visible = s.mesh.visible && s.progress.value <= 1
        if (s.head.visible) s.head.position.copy(s.curve.getPointAt(Math.min(s.progress.value, 1)))
      })
      updates.forEach(fn => fn(t))
    },
    dispose() { textures.forEach(t => t.dispose()) },
  }
}

export default function CapabilityScene({ kind, active }: { kind: Kind; active: boolean }) {
  const mount = useRef<HTMLDivElement>(null)
  const refresh = useRef<(() => void) | null>(null)
  const activeRef = useRef(active)
  const [ready, setReady] = useState(false)
  useEffect(() => { activeRef.current = active; refresh.current?.() }, [active])
  useEffect(() => {
    const host = mount.current!
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }) } catch { return }
    renderer.setClearColor(0x000000, 0)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-3.5, 3.5, 2.3, -2.3, .1, 50)
    camera.position.set(4.3, 9.5, 11)
    camera.lookAt(0, .10, 0)
    const createEnvironment = () => {
      const pmrem = new THREE.PMREMGenerator(renderer)
      const room = new RoomEnvironment()
      const environment = pmrem.fromScene(room, .025)
      room.dispose(); pmrem.dispose()
      return environment
    }
    let environment = createEnvironment()
    scene.environment = environment.texture
    scene.environmentIntensity = .85
    const key = new THREE.DirectionalLight(0xffffff, 3.0)
    key.position.set(-3.5, 7, 5)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    Object.assign(key.shadow.camera, { left: -3.4, right: 3.4, top: 3.4, bottom: -3.4, near: .5, far: 18 })
    key.shadow.normalBias = .009
    key.shadow.bias = -.00008
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xffffff, 2.5)
    rim.position.set(2, 4, -5); scene.add(rim)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x151515, .7))
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.ShadowMaterial({ opacity: .25 }))
    floor.rotation.x = -Math.PI / 2; floor.position.y = -.055; floor.receiveShadow = true; scene.add(floor)
    let disposed = false, contextLost = false
    const model = buildScene(kind, scene, renderer.capabilities.getMaxAnisotropy())
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const stillTime = kind === 'routes' ? 5.6 : 4.1
    let frame = 0, elapsed = 0, previous = 0
    const draw = (time: number) => {
      if (disposed) return
      if (previous) elapsed += Math.min((time - previous) / 1000, .05)
      previous = time
      model.update(elapsed % cycle)
      renderer.render(scene, camera)
      host.dataset.phase = (elapsed % cycle).toFixed(2)
      frame = requestAnimationFrame(draw)
    }
    const renderOnce = () => { model.update(media.matches || (!activeRef.current && elapsed === 0) ? stillTime : elapsed % cycle); renderer.render(scene, camera) }
    const start = () => {
      cancelAnimationFrame(frame); previous = 0
      if (contextLost) return
      if (activeRef.current && !document.hidden && !media.matches) frame = requestAnimationFrame(draw)
      else renderOnce()
    }
    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight
      if (!w || !h || contextLost) return
      // Supersample at normal density; keep each illustration below a 2048px backing width.
      renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio, 2), 2.5, 2048 / w))
      const halfWidth = 2.95
      camera.left = -halfWidth; camera.right = halfWidth
      camera.top = halfWidth * h / w; camera.bottom = -camera.top
      camera.updateProjectionMatrix(); renderer.setSize(w, h); renderOnce()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    refresh.current = start
    document.addEventListener('visibilitychange', start)
    media.addEventListener('change', start)
    const lost = (event: Event) => { event.preventDefault(); contextLost = true; cancelAnimationFrame(frame); setReady(false) }
    const restored = () => {
      environment.dispose(); environment = createEnvironment(); scene.environment = environment.texture
      contextLost = false; resize(); start(); setReady(true)
    }
    renderer.domElement.addEventListener('webglcontextlost', lost)
    renderer.domElement.addEventListener('webglcontextrestored', restored)
    resize(); start(); setReady(true)
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); refresh.current = null
      document.removeEventListener('visibilitychange', start); media.removeEventListener('change', start)
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      renderer.domElement.removeEventListener('webglcontextrestored', restored)
      model.dispose()
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>()
      scene.traverse(o => {
        if (o instanceof THREE.Mesh) {
          geometries.add(o.geometry)
          ;(Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m))
          if (o instanceof THREE.InstancedMesh) o.dispose()
        }
      })
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose())
      environment.dispose(); key.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
    }
  }, [kind])
  return <div className={`capability-render${ready ? ' is-ready' : ''}`}>
    <img className="capability-fallback" src={`/capabilities/${kind}.webp`} alt="" aria-hidden="true" />
    <div className="capability-canvas" ref={mount} aria-hidden="true" />
  </div>
}
