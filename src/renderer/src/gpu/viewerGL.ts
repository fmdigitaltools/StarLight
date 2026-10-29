import type { ImageData32 } from '@shared/types'
import type { FilterParams } from '@core/image/photoFilters'
import { TYPE_CODE, MAX_LAYERS, type LocalLayer, type Layer4 } from '@core/image/masks'
import type { AffineMatrix } from '@core/image/geometry'
import { texturePlane, textureRows, type TexturePlane } from '@core/image/viewerTexture'
import { t } from '@shared/i18n/i18n'
import vertexSource from './vertex.glsl?raw'
import fragmentSource from './fragment.glsl?raw'

/**
 * GPU-accelerated viewer.
 *
 * The image is uploaded once as a floating-point texture, then all the
 * corrections are computed by the GPU on every frame. This keeps sliders
 * responsive even on very large images and leaves the original data intact.
 */

export interface ViewParams {
  shadows: number
  midtones: number
  highlights: number
  brightness: number
  contrast: number
  saturation: number
  redGain: number
  greenGain: number
  blueGain: number
  gamma: number
  noiseReduction: number
  sharpness: number
  backgroundNeutralization: number
  skyBackground: [number, number, number]
  preserveColor: boolean
  /** Photo filter, already scaled by the chosen intensity. */
  filter: FilterParams
  /**
   * Crop box, as fractions of the image: the vignette is centered on it.
   * Absent = the whole image.
   */
  vignetteBox?: { x: number; y: number; width: number; height: number }
  /** Local adjustments (masks), or null if there are none. */
  locals?: ViewLocalParams | null
  /**
   * Paints the clipped pixels (pure black in blue, pure white in magenta).
   * Absent = off: only the live view sets it, never the before/after comparison.
   */
  clipping?: boolean
  /** Zoom factor: 1 means one image pixel per screen pixel. */
  zoom: number
  /** Pan offset in screen pixels. */
  panX: number
  panY: number
}

/** Local adjustments for the viewer; image-based masks are uploaded separately. */
export interface ViewLocalParams {
  /** At most four levels, in the order they are applied. */
  levels: LocalLayer[]
  /** From the pixels of the displayed image to those of the source image. */
  map: AffineMatrix
  start: { width: number; height: number }
  /** Position in `levels` of the level whose mask is shown in red, -1 for none. */
  show: number
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create the shader.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error('Shader compilation failed: ' + log)
  }
  return shader
}

export class ViewerGL {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private texture: WebGLTexture | null = null
  private textureCurves: WebGLTexture | null = null
  private activeCurves = false
  private textureGhs: WebGLTexture | null = null
  private ghsActive = false
  /** Painted masks of the local levels (channel i = level i). */
  private texturePainted: WebGLTexture | null = null
  private paintedSize = { l: 0, a: 0 }
  /** Star masks of the local levels. */
  private textureStars: WebGLTexture | null = null
  private starDimension = { l: 0, a: 0, scale: 1 }
  /** Last parameters drawn, to redraw while painting. */
  private latest: ViewParams | null = null
  private uniform = new Map<string, WebGLUniformLocation | null>()
  private width = 0
  private height = 0
  /** Texture size: smaller than the image if it was downscaled (see viewerTexture.ts). */
  private textureL = 0
  private textureA = 0
  private channels: 1 | 3 = 1
  /**
   * Interpolation usable on floating-point textures. Linear filtering
   * requires an extension: without it the texture would be incomplete and
   * would be sampled as black.
   */
  private interpolation: number

  constructor(private canvas: HTMLCanvasElement) {
    // The requested GPU is the one chosen in Settings, Performance, for this
    // startup (see src/main/performance.ts).
    const choices = window.starlight.startupChoices?.()
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
      powerPreference: choices?.gpu === 'low-power' ? 'low-power' : 'high-performance'
    })
    if (!gl) {
      throw new Error(
        choices && !choices.graphicsAcceleration
          ? t('gpuViewerGL.noContextAccelerationOff')
          : t('gpuViewerGL.noWebgl2')
      )
    }
    this.gl = gl

    // Required to read floating-point textures with interpolation.
    const floatFilter = gl.getExtension('OES_texture_float_linear')
    this.interpolation = floatFilter ? gl.LINEAR : gl.NEAREST

    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource)
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
    const program = gl.createProgram()
    if (!program) throw new Error('Unable to create the graphics program.')
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Linking the graphics program failed: ' + gl.getProgramInfoLog(program))
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    this.program = program

    // Unit rectangle shared by all draws.
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW
    )
    const position = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    gl.useProgram(program)
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.uniform.has(name)) {
      this.uniform.set(name, this.gl.getUniformLocation(this.program, name))
    }
    return this.uniform.get(name) ?? null
  }

  /**
   * Uploads a new image as a floating-point texture.
   *
   * If the image exceeds the maximum texture side of the graphics card, or
   * the card lacks the memory to hold it whole, the viewer receives it
   * downscaled by an integer factor (see viewerTexture.ts): the image looks
   * less sharp at high zoom levels, but it is displayed. The full data stays
   * with the application.
   */
  loadImage(image: ImageData32): void {
    const gl = this.gl
    const { width: w, height: h, channels } = image

    const maxSide = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096
    let plane = texturePlane(w, h, maxSide)
    let error = this.createTexture(image, plane)
    // If the card runs out of memory, retry with a smaller texture while it still makes sense.
    while (error === gl.OUT_OF_MEMORY && Math.max(plane.width, plane.height) > 1024) {
      plane = texturePlane(w, h, maxSide, plane.factor * 2)
      error = this.createTexture(image, plane)
    }
    if (error !== gl.NO_ERROR) {
      throw new Error(
        t('gpuViewerGL.textureRejected', {
          code: error,
          width: plane.width,
          height: plane.height,
          channels
        })
      )
    }

    // No wrapping at the edges and no mipmap levels: the texture has a single
    // level, so the minification filter must not look for others.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.width = w
    this.height = h
    this.textureL = plane.width
    this.textureA = plane.height
    this.channels = channels
  }

  /**
   * Creates the texture and fills it in stripes of rows, without preparing a
   * full copy of the image. Returns the graphics card's error code.
   */
  private createTexture(image: ImageData32, plane: TexturePlane): number {
    const gl = this.gl
    const channels = image.channels === 3 ? 3 : 1
    // Earlier errors must not be mistaken for errors of this upload (a few
    // reads at most: with a lost context the error never clears).
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) continue
    if (this.texture) gl.deleteTexture(this.texture)
    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    const internalFormat = channels === 3 ? gl.RGB32F : gl.R32F
    const format = channels === 3 ? gl.RGB : gl.RED
    const { width: L, height: A } = plane
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, L, A, 0, format, gl.FLOAT, null)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) return error

    // Stripes of about four million pixels: 48 MB in color.
    const rows = Math.max(1, Math.min(A, Math.floor(4194304 / L)))
    const stripe = new Float32Array(L * rows * channels)
    for (let y = 0; y < A; y += rows) {
      const end = Math.min(A, y + rows)
      textureRows(image, plane, y, end, stripe)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, L, end - y, format, gl.FLOAT, stripe.subarray(0, L * (end - y) * channels))
    }
    return gl.getError()
  }

  /**
   * Uploads the four tone curves into a texture as wide as the table and
   * one pixel high: each column holds the output values for that input
   * level. Passing a precomputed table spares the shader from solving the
   * spline for every pixel.
   *
   * @param tables the four curves, or null to disable them
   */
  loadCurves(
    tables: { light: Float32Array; red: Float32Array; green: Float32Array; blue: Float32Array } | null
  ): void {
    const gl = this.gl
    this.activeCurves = tables !== null
    if (!tables) return

    const size = tables.light.length
    const data = new Float32Array(size * 4)
    for (let i = 0; i < size; i++) {
      data[i * 4] = tables.red[i]
      data[i * 4 + 1] = tables.green[i]
      data[i * 4 + 2] = tables.blue[i]
      data[i * 4 + 3] = tables.light[i]
    }

    if (!this.textureCurves) this.textureCurves = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.textureCurves)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, 1, 0, gl.RGBA, gl.FLOAT, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
  }

  /**
   * Uploads the generalized hyperbolic stretch (GHS) table, using the same
   * layout as the curves: a texture as wide as the table and one pixel high.
   *
   * @param table the curve values for inputs from 0 to 1, or null to turn it off
   */
  loadGhs(table: Float32Array | null): void {
    const gl = this.gl
    this.ghsActive = table !== null
    if (!table) return
    const data = new Float32Array(table.length * 4)
    for (let i = 0; i < table.length; i++) data[i * 4] = table[i]
    if (!this.textureGhs) this.textureGhs = gl.createTexture()
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.textureGhs)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, table.length, 1, 0, gl.RGBA, gl.FLOAT, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Uploads a four-channel 8-bit image into a texture unit. */
  private loadLayer(unit: number, existing: WebGLTexture | null, s: Layer4): WebGLTexture | null {
    const gl = this.gl
    const t = existing ?? gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, s.data)
    // Read with texelFetch and interpolated by hand: no filters or mipmap levels.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
    return t
  }

  /** Uploads the painted masks of the local adjustments, or removes them with null. */
  loadPainted(s: Layer4 | null): void {
    if (!s) {
      this.paintedSize = { l: 0, a: 0 }
      return
    }
    this.texturePainted = this.loadLayer(3, this.texturePainted, s)
    this.paintedSize = { l: s.width, a: s.height }
  }

  /**
   * Updates only a rectangle of the painted masks while painting: reuploading
   * them whole on every mouse movement would be wasteful.
   */
  updatePainted(s: Layer4, r: { x0: number; y0: number; x1: number; y1: number }): void {
    const gl = this.gl
    if (!this.texturePainted || this.paintedSize.l !== s.width || this.paintedSize.a !== s.height) {
      this.loadPainted(s)
      return
    }
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.texturePainted)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, s.width)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y0)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1, gl.RGBA, gl.UNSIGNED_BYTE, s.data)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Uploads the star masks of the local adjustments, or removes them with null. */
  loadStars(s: (Layer4 & { scale: number }) | null): void {
    if (!s) {
      this.starDimension = { l: 0, a: 0, scale: 1 }
      return
    }
    this.textureStars = this.loadLayer(4, this.textureStars, s)
    this.starDimension = { l: s.width, a: s.height, scale: s.scale }
  }

  /** Redraws with the latest parameters (for example while painting a mask). */
  redraw(): void {
    if (this.latest) this.draw(this.latest)
  }

  /** Sets the shader uniforms for the local adjustments. */
  private setLocals(l: ViewLocalParams | null | undefined): void {
    const gl = this.gl
    const levels = l ? l.levels.slice(0, MAX_LAYERS) : []
    gl.uniform1i(this.loc('uLocCount'), levels.length)
    // Units 3 and 4 always stay bound to a texture: the shader declares them
    // anyway, even when it does not read them.
    gl.uniform1i(this.loc('uPainted'), 3)
    gl.uniform1i(this.loc('uStarMask'), 4)
    if (!l || levels.length === 0) return
    const type = new Int32Array(4)
    const invert = new Float32Array(4)
    const feather = new Float32Array(4)
    const intensity = new Float32Array(4)
    const parameters = new Float32Array(16)
    const geometry = new Float32Array(16)
    const angle = new Float32Array(4)
    const painted = new Float32Array(4)
    const tones = new Float32Array(16)
    const color = new Float32Array(16)
    levels.forEach((v, i) => {
      const m = v.mask
      const r = v.adjustments
      type[i] = TYPE_CODE[m.type]
      invert[i] = m.invert ? 1 : 0
      feather[i] = m.feather
      intensity[i] = m.intensity
      if (m.type === 'brightness') parameters.set([m.lightFrom, m.lightTo, 0, 0], i * 4)
      else if (m.type === 'color') parameters.set([m.tint, m.hueWidth, 0, 0], i * 4)
      if (m.type === 'linear') geometry.set([m.ax, m.ay, m.bx, m.by], i * 4)
      else geometry.set([m.cx, m.cy, m.rx, m.ry], i * 4)
      angle[i] = m.angle
      painted[i] = m.painted !== null && this.paintedSize.l > 0 ? 1 : 0
      tones.set([r.brightness, r.contrast, r.saturation, r.vibrance], i * 4)
      color.set([r.temperature, r.tint, r.sharpness, r.noiseReduction], i * 4)
    })
    gl.uniform1iv(this.loc('uLocType'), type)
    gl.uniform1fv(this.loc('uLocInvert'), invert)
    gl.uniform1fv(this.loc('uLocFeather'), feather)
    gl.uniform1fv(this.loc('uLocIntensity'), intensity)
    gl.uniform4fv(this.loc('uLocParams'), parameters)
    gl.uniform4fv(this.loc('uLocGeometry'), geometry)
    gl.uniform1fv(this.loc('uLocAngle'), angle)
    gl.uniform1fv(this.loc('uLocPainted'), painted)
    gl.uniform4fv(this.loc('uLocTones'), tones)
    gl.uniform4fv(this.loc('uLocColor'), color)
    const [[a, b, c], [d, e, f]] = l.map
    gl.uniform3f(this.loc('uMapX'), a, b, c)
    gl.uniform3f(this.loc('uMapY'), d, e, f)
    gl.uniform2f(this.loc('uSourceSize'), l.start.width, l.start.height)
    gl.uniform1i(this.loc('uShowMask'), l.show)

    const withPainted = this.paintedSize.l > 0 && this.texturePainted !== null
    gl.uniform1i(this.loc('uPaintedActive'), withPainted ? 1 : 0)
    gl.uniform2i(this.loc('uPaintedSize'), Math.max(1, this.paintedSize.l), Math.max(1, this.paintedSize.a))
    const withStars = this.starDimension.l > 0 && this.textureStars !== null
    gl.uniform1i(this.loc('uStarsActive'), withStars ? 1 : 0)
    gl.uniform2i(this.loc('uStarMaskSize'), Math.max(1, this.starDimension.l), Math.max(1, this.starDimension.a))
    gl.uniform1f(this.loc('uStarScale'), this.starDimension.scale)
    if (this.texturePainted) {
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this.texturePainted)
    }
    if (this.textureStars) {
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_2D, this.textureStars)
    }
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Size of the loaded image. */
  get dimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /**
   * Matches the drawing resolution to the real screen resolution, taking
   * the system scale factor into account.
   */
  fitCanvas(): void {
    const dpr = window.devicePixelRatio || 1
    const l = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const a = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== l || this.canvas.height !== a) {
      this.canvas.width = l
      this.canvas.height = a
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  /** Width of the canvas on screen, in CSS pixels. */
  get screenWidth(): number {
    return this.canvas.clientWidth
  }

  /** Height of the canvas on screen, in CSS pixels. */
  get screenHeight(): number {
    return this.canvas.clientHeight
  }

  /** Zoom factor that makes the whole image fit in the window. */
  fitZoom(): number {
    if (this.width === 0 || this.height === 0) return 1
    const displayWidth = this.canvas.clientWidth
    const displayHeight = this.canvas.clientHeight
    if (displayWidth === 0 || displayHeight === 0) return 1
    return Math.min(displayWidth / this.width, displayHeight / this.height) * 0.96
  }

  /** Draws the image with the requested corrections. */
  draw(p: ViewParams): void {
    const gl = this.gl
    this.latest = p
    this.fitCanvas()

    gl.clearColor(0.027, 0.035, 0.063, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (!this.texture || this.width === 0) return

    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(this.loc('uImage'), 0)
    gl.uniform2i(this.loc('uSize'), this.width, this.height)
    gl.uniform2i(this.loc('uTextureSize'), this.textureL, this.textureA)
    gl.uniform1i(this.loc('uChannels'), this.channels)

    gl.uniform1i(this.loc('uCurvesActive'), this.activeCurves && this.textureCurves ? 1 : 0)
    gl.uniform1i(this.loc('uGhsActive'), this.ghsActive && this.textureGhs ? 1 : 0)
    if (this.textureGhs) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.textureGhs)
      gl.uniform1i(this.loc('uGhs'), 2)
      gl.activeTexture(gl.TEXTURE0)
    }
    if (this.textureCurves) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.textureCurves)
      gl.uniform1i(this.loc('uCurve'), 1)
    }
    gl.activeTexture(gl.TEXTURE0)

    gl.uniform1f(this.loc('uShadows'), p.shadows)
    gl.uniform1f(this.loc('uMidtones'), p.midtones)
    gl.uniform1f(this.loc('uHighlights'), p.highlights)
    gl.uniform1f(this.loc('uBrightness'), p.brightness)
    gl.uniform1f(this.loc('uContrast'), p.contrast)
    gl.uniform1f(this.loc('uSaturation'), p.saturation)
    gl.uniform3f(this.loc('uGain'), p.redGain, p.greenGain, p.blueGain)
    gl.uniform1f(this.loc('uGamma'), p.gamma)
    gl.uniform1f(this.loc('uNoiseReduction'), p.noiseReduction)
    gl.uniform1f(this.loc('uSharpness'), p.sharpness)
    gl.uniform1f(this.loc('uBackgroundNeutralization'), p.backgroundNeutralization)
    gl.uniform1i(this.loc('uPreserveColor'), p.preserveColor ? 1 : 0)
    gl.uniform3f(
      this.loc('uSkyBackground'),
      p.skyBackground[0],
      p.skyBackground[1],
      p.skyBackground[2]
    )

    const filter = p.filter
    gl.uniform1f(this.loc('uTemperature'), filter.temperature)
    gl.uniform1f(this.loc('uTint'), filter.tint)
    gl.uniform3f(
      this.loc('uShadowsToning'),
      filter.shadowsToning[0],
      filter.shadowsToning[1],
      filter.shadowsToning[2]
    )
    gl.uniform3f(
      this.loc('uHighlightsToning'),
      filter.highlightsToning[0],
      filter.highlightsToning[1],
      filter.highlightsToning[2]
    )
    gl.uniform1f(this.loc('uToningStrength'), filter.toningStrength)
    gl.uniform1f(this.loc('uVibrance'), filter.vibrance)
    gl.uniform1f(this.loc('uFilterSaturation'), filter.saturation)
    gl.uniform1f(this.loc('uFilterCurve'), filter.curve)
    gl.uniform1f(this.loc('uFilterBrightness'), filter.brightness)
    gl.uniform1f(this.loc('uVignette'), filter.vignette)
    const r = p.vignetteBox ?? { x: 0, y: 0, width: 1, height: 1 }
    gl.uniform4f(this.loc('uVignetteBox'), r.x, r.y, r.width, r.height)
    gl.uniform1f(this.loc('uMonochrome'), filter.monochrome)

    this.setLocals(p.locals)
    gl.uniform1i(this.loc('uClipping'), p.clipping ? 1 : 0)

    // Size of the image on screen, as a fraction of the window.
    const displayWidth = this.canvas.clientWidth
    const displayHeight = this.canvas.clientHeight
    const scaleX = (this.width * p.zoom) / displayWidth
    const scaleY = (this.height * p.zoom) / displayHeight

    // Position: centered, plus the pan offset chosen by the user.
    const shiftX = (1 - scaleX) / 2 + p.panX / displayWidth
    const shiftY = (1 - scaleY) / 2 - p.panY / displayHeight

    gl.uniform2f(this.loc('uScale'), scaleX, scaleY)
    gl.uniform2f(this.loc('uOffset'), shiftX, shiftY)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Extracts the displayed content as an image, for export. */
  readPixel(): Uint8Array {
    const gl = this.gl
    const pixel = new Uint8Array(this.canvas.width * this.canvas.height * 4)
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return pixel
  }

  /** Releases the graphics resources. */
  release(): void {
    if (this.textureCurves) this.gl.deleteTexture(this.textureCurves)
    if (this.textureGhs) this.gl.deleteTexture(this.textureGhs)
    if (this.texturePainted) this.gl.deleteTexture(this.texturePainted)
    if (this.textureStars) this.gl.deleteTexture(this.textureStars)
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.gl.deleteProgram(this.program)
  }
}
