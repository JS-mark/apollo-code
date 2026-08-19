<script setup>
// ApolloScene — Three.js 轨道场，hero 右侧视觉层。
// 构图：酸性绿太阳核心（含反向线框壳 = "沙箱包裹"意象）+ 三层倾斜轨道环（环上挂节点）
// + 放射数据射线 + 远景星尘。Three 走动态 import，首帧渲染前由 CSS 光环兜底；
// prefers-reduced-motion / WebGL 不可用时保持静态 CSS 层，不初始化 WebGL。
import { onBeforeUnmount, onMounted, ref } from 'vue'

const host = ref(null)
const canvas = ref(null)
const ready = ref(false)

let teardown = () => {}
let reducedMotion = false

onMounted(async () => {
  if (!canvas.value) return
  // prefers-reduced-motion 下仍渲染一帧静态 3D 画面，只是不起循环动画——
  // 既不打扰前庭敏感用户，又不损失视觉内容（比完全不加载更温和的降级）。
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    teardown = await initScene(host.value, canvas.value, () => {
      ready.value = true
    }, reducedMotion)
  } catch (error) {
    // WebGL 不可用：保留 CSS 光环兜底层
    console.warn('[apollo-scene] WebGL init failed, static fallback stays.', error)
  }
})

onBeforeUnmount(() => teardown())

function makeGlowTexture(THREE) {
  const size = 256
  const offscreen = document.createElement('canvas')
  offscreen.width = size
  offscreen.height = size
  const ctx = offscreen.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.55)')
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.16)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(offscreen)
}

async function initScene(hostEl, canvasEl, markReady, isReducedMotion) {
  const THREE = await import('three')

  const palette = () => {
    const dark = document.documentElement.classList.contains('dark')
    return dark
      ? { core: '#b9f559', shell: '#d0ff85', ring: '#b9f559', node: '#d0ff85', dustA: '#b9f559', dustB: '#e8f5d0', ray: '#9fdf4c', ringOpacity: 0.34, dustOpacity: 0.85, glowOpacity: 0.95 }
      : { core: '#5d850f', shell: '#7ba916', ring: '#5d850f', node: '#456a06', dustA: '#7ba916', dustB: '#9aa694', ray: '#6d9a10', ringOpacity: 0.42, dustOpacity: 0.55, glowOpacity: 0.7 }
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120)
  camera.position.set(0, 1.0, 17.5)

  const disposables = []

  // --- 太阳核心 + 反向线框壳 ---
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.55, 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(palette().core) }),
  )
  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(2.35, 1),
    new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.32 }),
  )
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  glow.scale.setScalar(12)
  scene.add(core, shell, glow)
  disposables.push(core.geometry, core.material, shell.geometry, shell.material, glow.material, glow.material.map)

  // --- 轨道环 + 环上节点 ---
  const orbit = new THREE.Group()
  scene.add(orbit)
  const ringSpecs = [
    { radius: 5.4, tilt: 1.22, spin: 0.10, nodes: 3 },
    { radius: 7.8, tilt: 1.48, spin: -0.065, nodes: 4 },
    { radius: 10.6, tilt: 1.06, spin: 0.045, nodes: 5 },
  ]
  const nodeGlowTexture = makeGlowTexture(THREE)
  const nodeMeshes = []
  for (const spec of ringSpecs) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(spec.radius, 0.012, 8, 220),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: palette().ringOpacity }),
    )
    ring.rotation.x = spec.tilt
    ring.userData.spin = spec.spin
    orbit.add(ring)
    disposables.push(ring.geometry, ring.material)

    for (let i = 0; i < spec.nodes; i += 1) {
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 12, 12),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(palette().node) }),
      )
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: nodeGlowTexture,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          opacity: 0.85,
        }),
      )
      halo.scale.setScalar(0.9)
      const angle = (i / spec.nodes) * Math.PI * 2 + spec.radius
      node.position.set(Math.cos(angle) * spec.radius, Math.sin(angle) * spec.radius, 0)
      node.add(halo)
      ring.add(node)
      nodeMeshes.push(node)
      disposables.push(node.geometry, node.material, halo.material)
    }
  }
  disposables.push(nodeGlowTexture)

  // --- 放射数据射线（扁平圆盘方向） ---
  const rayPositions = []
  for (let i = 0; i < 56; i += 1) {
    const theta = Math.random() * Math.PI * 2
    const phi = (Math.random() - 0.5) * 0.7
    const r0 = 2.9
    const r1 = r0 + 4 + Math.random() * 7
    rayPositions.push(
      Math.cos(theta) * Math.cos(phi) * r0,
      Math.sin(phi) * r0,
      Math.sin(theta) * Math.cos(phi) * r0,
      Math.cos(theta) * Math.cos(phi) * r1,
      Math.sin(phi) * r1,
      Math.sin(theta) * Math.cos(phi) * r1,
    )
  }
  const rayGeometry = new THREE.BufferGeometry()
  rayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rayPositions, 3))
  const rays = new THREE.LineSegments(
    rayGeometry,
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending }),
  )
  scene.add(rays)
  disposables.push(rayGeometry, rays.material)

  // --- 远景星尘 ---
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 640
  const dustCount = smallScreen ? 340 : 720
  const dustPositions = new Float32Array(dustCount * 3)
  const dustColors = new Float32Array(dustCount * 3)
  const colorA = new THREE.Color(palette().dustA)
  const colorB = new THREE.Color(palette().dustB)
  for (let i = 0; i < dustCount; i += 1) {
    const radius = 16 + Math.random() * 30
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    dustPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
    dustPositions[i * 3 + 1] = radius * Math.cos(phi)
    dustPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
    const mix = colorA.clone().lerp(colorB, Math.random())
    dustColors[i * 3] = mix.r
    dustColors[i * 3 + 1] = mix.g
    dustColors[i * 3 + 2] = mix.b
  }
  const dustGeometry = new THREE.BufferGeometry()
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColors, 3))
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      size: 0.09,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: palette().dustOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  scene.add(dust)
  disposables.push(dustGeometry, dust.material)

  // --- 主题切换时换色 ---
  const applyPalette = () => {
    const p = palette()
    core.material.color.set(p.core)
    shell.material.color.set(p.shell)
    glow.material.color.set(p.core)
    glow.material.opacity = p.glowOpacity
    for (const ring of orbit.children) {
      ring.material.color.set(p.ring)
      ring.material.opacity = p.ringOpacity
    }
    for (const node of nodeMeshes) node.material.color.set(p.node)
    rays.material.color.set(p.ray)
    dust.material.opacity = p.dustOpacity
  }
  applyPalette()
  const themeObserver = new MutationObserver(applyPalette)
  themeObserver.observe(document.documentElement, { attributeFilter: ['class'] })

  // --- 尺寸 ---
  const resize = () => {
    const width = hostEl.clientWidth || 1
    const height = hostEl.clientHeight || 1
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(hostEl)
  resize()

  // --- 指针视差（监听 window：场景容器 pointer-events:none 让位终端卡片） ---
  const pointer = { x: 0, y: 0 }
  const onPointerMove = (event) => {
    const rect = hostEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2
    pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2
  }
  window.addEventListener('pointermove', onPointerMove)

  // --- 帧循环 ---
  const clock = new THREE.Clock()
  let rafId = 0
  let smoothed = { x: 0, y: 0 }
  let firstFrame = true

  const renderFrame = (elapsed) => {
    core.rotation.y = elapsed * 0.12
    core.rotation.x = elapsed * 0.05
    shell.rotation.y = -elapsed * 0.08
    glow.material.opacity = palette().glowOpacity * (0.86 + Math.sin(elapsed * 1.4) * 0.14)

    for (const ring of orbit.children) ring.rotation.z += ring.userData.spin * 0.016
    rays.rotation.y = elapsed * 0.02
    dust.rotation.y = elapsed * 0.006

    smoothed.x += (pointer.x - smoothed.x) * 0.045
    smoothed.y += (pointer.y - smoothed.y) * 0.045
    camera.position.x = smoothed.x * 1.4
    camera.position.y = 1.0 - smoothed.y * 0.9
    camera.lookAt(0, 0.6, 0)

    renderer.render(scene, camera)
    if (firstFrame) {
      firstFrame = false
      markReady()
    }
  }

  const tick = () => {
    renderFrame(clock.getElapsedTime())
    rafId = requestAnimationFrame(tick)
  }

  const onVisibility = () => {
    if (isReducedMotion) return
    if (document.hidden) {
      cancelAnimationFrame(rafId)
      rafId = 0
    } else if (!rafId) {
      clock.getDelta()
      rafId = requestAnimationFrame(tick)
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  // 减少动画偏好：渲染单帧静态画面后即停（不进入 requestAnimationFrame 循环），
  // 同时不监听指针视差——画面完全静止。
  if (isReducedMotion) {
    renderFrame(0)
  } else {
    rafId = requestAnimationFrame(tick)
  }

  return () => {
    cancelAnimationFrame(rafId)
    themeObserver.disconnect()
    resizeObserver.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointermove', onPointerMove)
    for (const item of disposables) item.dispose?.()
    renderer.dispose()
    renderer.forceContextLoss()
  }
}
</script>

<template>
  <div ref="host" class="apollo-scene" :class="{ 'scene-ready': ready }" aria-hidden="true">
    <div class="orbital-ring ring-one"></div>
    <div class="orbital-ring ring-two"></div>
    <canvas ref="canvas"></canvas>
  </div>
</template>
