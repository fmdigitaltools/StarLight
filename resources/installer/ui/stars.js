/*
 * Animated star field in the brand column, shared by the installer and
 * uninstaller windows.
 */
(function () {
  'use strict'

  const canvas = document.getElementById('stars')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  let stars = []
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  function resize() {
    const r = canvas.getBoundingClientRect()
    canvas.width = r.width * devicePixelRatio
    canvas.height = r.height * devicePixelRatio
    stars = Array.from({ length: 90 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() * 1.2 + 0.3) * devicePixelRatio,
      f: Math.random() * Math.PI * 2,
      v: 0.6 + Math.random() * 1.4,
      c: ['#ffffff', '#9fefff', '#c9b8ff', '#ffb3ec'][Math.floor(Math.random() * 4)]
    }))
  }
  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const s of stars) {
      ctx.globalAlpha = reduced ? 0.6 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((t / 900) * s.v + s.f))
      ctx.fillStyle = s.c
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
      ctx.fill()
    }
    if (!reduced) requestAnimationFrame(draw)
  }
  resize()
  addEventListener('resize', resize)
  requestAnimationFrame(draw)
})()
