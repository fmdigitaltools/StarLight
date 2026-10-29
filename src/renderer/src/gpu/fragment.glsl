#version 300 es
precision highp float;

/*
 * Correction chain executed by the GPU on every frame.
 * Running on the GPU lets sliders update the result immediately, even on
 * images of many megapixels, because pixels are processed in parallel and
 * the original image data is never modified.
 */

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uImage;
uniform ivec2 uSize;
// Texture size: equal to uSize, or smaller if the image was downscaled to
// fit the maximum texture side of the graphics card.
uniform ivec2 uTextureSize;
uniform int uChannels;

// Histogram stretch
uniform float uShadows;
uniform float uMidtones;
uniform float uHighlights;

// Tonal adjustments
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uGain;
uniform float uGamma;

// Spatial filters
uniform float uNoiseReduction;
uniform float uSharpness;

// Background neutralization: constant per-channel level to subtract
uniform float uBackgroundNeutralization;
uniform vec3 uSkyBackground;

// Color-preserving stretch
uniform bool uPreserveColor;

/*
 * Tone curves.
 *
 * The four curves (light, red, green, blue) are passed in a texture 256
 * pixels wide and 1 pixel high: each column holds the four output values
 * for that input level. Passing them as a lookup table, instead of
 * evaluating the spline for every pixel, costs a single texture read.
 */
uniform sampler2D uCurve;
uniform bool uCurvesActive;

// Generalized hyperbolic stretch: lookup table used in place of the midtones.
uniform sampler2D uGhs;
uniform bool uGhsActive;

// Photo filter
uniform float uTemperature;
uniform float uTint;
uniform vec3 uShadowsToning;
uniform vec3 uHighlightsToning;
uniform float uToningStrength;
uniform float uVibrance;
uniform float uFilterSaturation;
uniform float uFilterCurve;
uniform float uFilterBrightness;
uniform float uVignette;
// Crop box (x, y, width, height as fractions of the image): the vignette is
// centered on the part that will be exported.
uniform vec4 uVignetteBox;
uniform float uMonochrome;

/*
 * Clipping warning: paints in flat colors the pixels that the display ends
 * up crushing to black or blowing out to white, so the user sees where the
 * stretch or the curves lose detail (the histogram only says how many).
 * Viewer only: exports are computed on the CPU and never pass through here.
 */
uniform bool uClipping;

/*
 * Local adjustments (masks), up to four levels.
 *
 * Twin of src/core/image/masks.ts, which performs the same computation for
 * export: the two versions must be kept identical.
 *
 * Mask types: 0 whole image, 1 brightness, 2 color, 3 stars,
 * 4 linear gradient, 5 radial gradient (also used for the object).
 */
uniform int uLocCount;
uniform int uLocType[4];
uniform float uLocInvert[4];
uniform float uLocFeather[4];
uniform float uLocIntensity[4];
// Brightness: (from, to); color: (hue in degrees, width in degrees).
uniform vec4 uLocParams[4];
// Linear: (ax, ay, bx, by); radial: (cx, cy, rx, ry). In pixels of the source image.
uniform vec4 uLocGeometry[4];
uniform float uLocAngle[4];
uniform float uLocPainted[4];
// Brightness, contrast, saturation, vibrance.
uniform vec4 uLocTones[4];
// Temperature, tint, sharpness, noise reduction.
uniform vec4 uLocColor[4];
// From the pixels of the displayed image to those of the source image.
uniform vec3 uMapX;
uniform vec3 uMapY;
uniform vec2 uSourceSize;
// Painted masks (channel i = level i), at a quarter of the source size.
uniform sampler2D uPainted;
uniform ivec2 uPaintedSize;
uniform bool uPaintedActive;
// Star masks (channel i = level i), downscaled by uStarScale.
uniform sampler2D uStarMask;
uniform ivec2 uStarMaskSize;
uniform float uStarScale;
uniform bool uStarsActive;
// Level whose mask is shown in red, -1 for none.
uniform int uShowMask;

/** Midtones transfer function. */
float mtf(float x, float m) {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  if (m <= 0.0) return 1.0;
  if (m >= 1.0) return 0.0;
  if (abs(m - 0.5) < 1e-6) return x;
  return ((m - 1.0) * x) / ((2.0 * m - 1.0) * x - m);
}

/** Reads a pixel as a color, handling monochrome images. */
vec3 readPixel(vec2 uv) {
  vec4 c = texture(uImage, uv);
  return uChannels == 1 ? vec3(c.r) : c.rgb;
}

/**
 * Soft contrast curve.
 *
 * Instead of multiplying the distance from mid gray, which clips the
 * extremes, an S-curve is used: it gently compresses shadows and highlights
 * and opens up the midtones, like film does.
 */
vec3 sCurve(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  vec3 x = clamp(c, 0.0, 1.0);
  vec3 softened = x * x * (3.0 - 2.0 * x);
  return mix(x, strength > 0.0 ? softened : (x + (x - softened)), abs(strength));
}

/**
 * Filters that look at neighboring pixels, read from the original data:
 * noise reduction and sharpening. Used by both the global and the local
 * adjustments.
 */
vec3 spatialFilter(vec2 uv, float noiseReduction, float sharpness) {
  vec2 texel = 1.0 / vec2(uTextureSize);
  vec3 color = readPixel(uv);

  // --- Noise reduction: weighted mean of the neighbors that resemble the
  // center pixel, so that star edges stay sharp. As the amount grows,
  // neighbors two and three pixels away join in and the blend reaches its
  // maximum at half the slider (see noiseParams in core/image/masks.ts):
  // grain clumps a few pixels wide are smoothed as well. ---
  if (noiseReduction > 0.001) {
    vec3 sum = color;
    float weight = 1.0;
    float threshold = 0.055 + 0.16 * (1.0 - noiseReduction);
    float ring2 = smoothstep(0.25, 0.7, noiseReduction);
    float ring3 = smoothstep(0.5, 1.0, noiseReduction);
    int radius = ring3 > 0.001 ? 3 : (ring2 > 0.001 ? 2 : 1);
    for (int dy = -3; dy <= 3; dy++) {
      for (int dx = -3; dx <= 3; dx++) {
        if (dx == 0 && dy == 0) continue;
        int pixelDistance = max(abs(dx), abs(dy));
        if (pixelDistance > radius) continue;
        vec3 neighbor = readPixel(uv + vec2(float(dx), float(dy)) * texel);
        float colorDistance = length(neighbor - color);
        float ringWeight = pixelDistance == 3 ? ring3 : (pixelDistance == 2 ? ring2 : 1.0);
        float w = ringWeight * exp(-(colorDistance * colorDistance) / (threshold * threshold));
        sum += neighbor * w;
        weight += w;
      }
    }
    color = mix(color, sum / weight, min(1.0, 2.0 * noiseReduction));
  }

  // --- Sharpness: unsharp mask. A blurred copy is subtracted to bring
  // out fine detail. ---
  if (sharpness > 0.001) {
    vec3 blurred = vec3(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        blurred += readPixel(uv + vec2(float(dx), float(dy)) * texel);
      }
    }
    blurred /= 9.0;
    color = color + (color - blurred) * sharpness * 2.2;
  }
  return color;
}

/**
 * Chain of global adjustments for one pixel: from the linear, already
 * filtered value to the displayed color.
 */
vec3 adjustmentChain(vec3 color, vec2 uv) {
  color = max(color, vec3(0.0));

  // --- Background neutralization: subtracts the sky background level
  // measured on the image, reducing light pollution.
  //
  // The black point is lowered by the same average amount that is
  // subtracted, so the image does not get darker: the part common to the
  // three channels cancels out and only the correction of the color cast
  // remains, which is the useful effect. The compensation is applied here,
  // at draw time, and not in the application state: the value chosen with
  // the black point slider stays untouched, and bringing the removal back
  // to zero restores the image exactly. ---
  float shadows = uShadows;
  if (uBackgroundNeutralization > 0.001) {
    color -= uSkyBackground * uBackgroundNeutralization;
    shadows -= dot(uSkyBackground, vec3(1.0 / 3.0)) * uBackgroundNeutralization;
  }

  // --- Histogram stretch ---
  float range = max(1e-6, uHighlights - shadows);
  if (uPreserveColor) {
    /*
     * The brightness is stretched and the three channels follow it in
     * proportion, so the color of each pixel stays the measured one.
     * Stretching the channels one by one would make one channel reach
     * white before the others on the edge of a bright star, leaving a
     * ring of pure color. The shared curve also acts on the brightness.
     *
     * If a channel exceeds white, the color is pulled toward gray at the
     * same brightness, just enough to fit. Scaling the three channels down
     * instead kept the hue but darkened the core of bright stars below
     * their edge: blue stars became rings and saturated nebula cores a flat
     * pure red. The brightest tones also fade toward white, as in a
     * photograph: a star core is white, its color shows on the edge.
     */
    color = max((color - shadows) / range, 0.0);
    float l = (color.r + color.g + color.b) / 3.0;
    float ld = uGhsActive
      ? texture(uGhs, vec2(min(l, 1.0), 0.5)).r
      : mtf(min(l, 1.0), uMidtones);
    if (uCurvesActive) ld = texture(uCurve, vec2(ld, 0.5)).a;
    color = l > 1e-6 ? color * (ld / l) : vec3(0.0);
    float maxValue = max(max(color.r, color.g), color.b);
    float lm = min(ld, 1.0);
    float fit = maxValue > 1.0 ? max(0.0, (1.0 - lm) / max(1e-6, maxValue - lm)) : 1.0;
    // Brightness mask: in dark areas the color is almost pure noise and
    // fades toward gray; the brightest fade toward white.
    color = mix(vec3(lm), color, smoothstep(0.02, 0.06, ld) * fit * (1.0 - smoothstep(0.9, 1.0, ld)));
  } else {
    color = clamp((color - shadows) / range, 0.0, 1.0);
    if (uGhsActive) {
      color = vec3(
        texture(uGhs, vec2(color.r, 0.5)).r,
        texture(uGhs, vec2(color.g, 0.5)).r,
        texture(uGhs, vec2(color.b, 0.5)).r
      );
    } else {
      color = vec3(mtf(color.r, uMidtones), mtf(color.g, uMidtones), mtf(color.b, uMidtones));
    }
  }

  // --- Tone curves ---
  if (uCurvesActive && !uPreserveColor) {
    // The per-channel curves first, then the shared one.
    color.r = texture(uCurve, vec2(color.r, 0.5)).r;
    color.g = texture(uCurve, vec2(color.g, 0.5)).g;
    color.b = texture(uCurve, vec2(color.b, 0.5)).b;
    color.r = texture(uCurve, vec2(color.r, 0.5)).a;
    color.g = texture(uCurve, vec2(color.g, 0.5)).a;
    color.b = texture(uCurve, vec2(color.b, 0.5)).a;
  }

  // --- Channel balance ---
  color *= uGain;

  // --- Contrast around mid gray ---
  color = clamp((color - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);

  // --- Brightness ---
  color = clamp(color + uBrightness, 0.0, 1.0);

  // --- Saturation relative to luminance ---
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = clamp(mix(vec3(luminance), color, 1.0 + uSaturation), 0.0, 1.0);

  // --- Gamma ---
  if (abs(uGamma - 1.0) > 0.001) {
    color = pow(color, vec3(1.0 / uGamma));
  }

  /* ----------------------------------------------------------------
   * Photo filter.
   *
   * Applied last, once the image is already legible, and leaves the
   * original data untouched: it is a way of presenting the photograph,
   * not a correction of the signal.
   * ---------------------------------------------------------------- */

  // Temperature and tint: shift the white balance.
  if (abs(uTemperature) > 0.001 || abs(uTint) > 0.001) {
    color.r *= 1.0 + uTemperature * 0.28;
    color.b *= 1.0 - uTemperature * 0.28;
    color.g *= 1.0 - uTint * 0.18;
    color.r *= 1.0 + uTint * 0.07;
    color.b *= 1.0 + uTint * 0.07;
  }

  // Monochrome: moves the image toward black and white.
  if (uMonochrome > 0.001) {
    float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(color, vec3(gray), uMonochrome);
  }

  // Split toning: one color in the shadows, another in the highlights.
  if (uToningStrength > 0.001) {
    float weight = dot(color, vec3(0.2126, 0.7152, 0.0722));
    vec3 toning = mix(uShadowsToning, uHighlightsToning, smoothstep(0.15, 0.85, weight));
    color += toning * uToningStrength;
  }

  // Vibrance: mostly saturates colors that are already muted, leaving
  // vivid ones alone, which would otherwise lose all their gradation.
  if (abs(uVibrance) > 0.001) {
    float light = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float maxValue = max(color.r, max(color.g, color.b));
    float minValue = min(color.r, min(color.g, color.b));
    float currentSaturation = maxValue - minValue;
    float push = uVibrance * (1.0 - smoothstep(0.0, 0.6, currentSaturation));
    color = mix(vec3(light), color, 1.0 + push);
  }

  // Overall filter saturation.
  if (abs(uFilterSaturation) > 0.001) {
    float light = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(light), color, 1.0 + uFilterSaturation);
  }

  color = sCurve(color, uFilterCurve);
  color = clamp(color + uFilterBrightness, 0.0, 1.0);

  // Vignette: progressively darkens toward the edges of the crop.
  if (uVignette > 0.001) {
    vec2 inBox = (uv - uVignetteBox.xy) / max(uVignetteBox.zw, vec2(1e-6));
    vec2 fromCenter = inBox - vec2(0.5);
    float edgeDistance = length(fromCenter) * 1.414;
    float factor = 1.0 - uVignette * smoothstep(0.45, 1.0, edgeDistance);
    color *= factor;
  }
  return color;
}

/* ------------------------------------------------------------------
 * Local adjustments
 * ------------------------------------------------------------------ */

/** Bilinear read done by hand, identical to the one used for export. */
vec4 bilinear(sampler2D t, ivec2 dim, vec2 q) {
  vec2 maxCoord = vec2(dim - 1);
  q = clamp(q, vec2(0.0), maxCoord);
  vec2 f = floor(q);
  ivec2 i0 = ivec2(f);
  ivec2 i1 = min(i0 + 1, dim - 1);
  vec2 w = q - f;
  vec4 a = texelFetch(t, i0, 0);
  vec4 b = texelFetch(t, ivec2(i1.x, i0.y), 0);
  vec4 c = texelFetch(t, ivec2(i0.x, i1.y), 0);
  vec4 d = texelFetch(t, i1, 0);
  vec4 upper = a + (b - a) * w.x;
  vec4 lower = c + (d - c) * w.x;
  return upper + (lower - upper) * w.y;
}

/** Hue in degrees, from 0 to 360; 0 for grays. */
float hueOf(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float k = mx - mn;
  if (k < 1e-6) return 0.0;
  if (mx == c.r) {
    float t = (c.g - c.b) / k;
    return 60.0 * (t - 6.0 * floor(t / 6.0));
  }
  if (mx == c.g) return 60.0 * ((c.b - c.r) / k + 2.0);
  return 60.0 * ((c.r - c.g) / k + 4.0);
}

/**
 * Mean of the original data over nine points two pixels apart (a 5x5
 * area): the brightness and color masks look at this "smooth" color, so
 * that background noise does not fill them with specks.
 */
vec3 neighborMean(vec2 uv) {
  vec2 texel = 2.0 / vec2(uTextureSize);
  vec3 sum = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      sum += readPixel(uv + vec2(float(dx), float(dy)) * texel);
    }
  }
  return sum / 9.0;
}

/**
 * Automatic mask of level i, without the painted part. `base` is the
 * smooth color after the global adjustments; `backgroundLight` is the
 * luminance of the sky background after the same adjustments.
 */
float automaticMask(int i, vec3 base, vec2 q, float stars, float backgroundLight) {
  int type = uLocType[i];
  float feather = uLocFeather[i];
  vec4 params = uLocParams[i];
  vec4 geometry = uLocGeometry[i];
  if (type == 1) {
    float f = 0.005 + 0.25 * feather;
    float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
    float above = params.x <= 0.0005 ? 1.0 : smoothstep(params.x - f, params.x + f, l);
    float below = params.y >= 0.9995 ? 1.0 : 1.0 - smoothstep(params.y - f, params.y + f, l);
    return above * below;
  }
  if (type == 2) {
    float mx = max(base.r, max(base.g, base.b));
    float mn = min(base.r, min(base.g, base.b));
    float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;
    float d = abs(hueOf(base) - params.x);
    d = min(d, 360.0 - d);
    float hueFeather = 4.0 + 60.0 * feather;
    float hueMatch = 1.0 - smoothstep(params.y, params.y + hueFeather, d);
    float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
    float aboveBackground = smoothstep(backgroundLight + 0.015, backgroundLight + 0.06, l);
    return hueMatch * smoothstep(0.02, 0.07, mx - mn) * smoothstep(0.06, 0.2, sat) * aboveBackground;
  }
  if (type == 3) return stars;
  if (type == 4) {
    vec2 ab = geometry.zw - geometry.xy;
    float t = clamp(dot(q - geometry.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    return 1.0 - t * t * (3.0 - 2.0 * t);
  }
  if (type == 5) {
    vec2 d = q - geometry.xy;
    float ca = cos(uLocAngle[i]);
    float sa = sin(uLocAngle[i]);
    float u = (d.x * ca + d.y * sa) / max(geometry.z, 1e-3);
    float v = (-d.x * sa + d.y * ca) / max(geometry.w, 1e-3);
    float r = sqrt(u * u + v * v);
    float f = 0.02 + 0.98 * feather;
    return 1.0 - smoothstep(1.0 - f, 1.0, r);
  }
  return 1.0;
}

/** Applies the adjustments of one level to an already corrected color. */
vec3 applyLocal(vec3 c, vec4 tones, vec4 col) {
  if (abs(col.x) > 0.001 || abs(col.y) > 0.001) {
    c.r *= 1.0 + col.x * 0.28;
    c.b *= 1.0 - col.x * 0.28;
    c.g *= 1.0 - col.y * 0.18;
    c.r *= 1.0 + col.y * 0.07;
    c.b *= 1.0 + col.y * 0.07;
    c = clamp(c, 0.0, 1.0);
  }
  // Brightness: lightening moves toward white, darkening toward zero, so
  // blacks are not lifted and whites are not blown out.
  if (tones.x > 0.001) c = c + (1.0 - c) * tones.x;
  else if (tones.x < -0.001) c = c * (1.0 + tones.x);
  c = sCurve(c, tones.y);
  if (abs(tones.z) > 0.001) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = clamp(mix(vec3(l), c, 1.0 + tones.z), 0.0, 1.0);
  }
  if (abs(tones.w) > 0.001) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float push = tones.w * (1.0 - smoothstep(0.0, 0.6, mx - mn));
    c = clamp(mix(vec3(l), c, 1.0 + push), 0.0, 1.0);
  }
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 raw = readPixel(vUV);
  vec3 linearColor = spatialFilter(vUV, uNoiseReduction, uSharpness);
  vec3 color = adjustmentChain(linearColor, vUV);
  // Strength of the mask overlay shown for the selected level, 0 for none.
  float maskShown = 0.0;

  if (uLocCount > 0) {
    // Pixel position: in the displayed image and in the source image.
    vec2 p = vUV * vec2(uSize) - 0.5;
    vec2 q = vec2(dot(uMapX, vec3(p, 1.0)), dot(uMapY, vec3(p, 1.0)));
    vec4 paintedMask = vec4(1.0);
    if (uPaintedActive) {
      vec2 qp = (q + 0.5) * vec2(uPaintedSize) / uSourceSize - 0.5;
      paintedMask = bilinear(uPainted, uPaintedSize, qp);
    }
    vec4 starMask = vec4(0.0);
    if (uStarsActive) starMask = bilinear(uStarMask, uStarMaskSize, (p + 0.5) / uStarScale - 0.5);

    // Smooth color and background light, only if a level looks at brightness or color.
    vec3 smoothed = color;
    float backgroundLight = 0.0;
    bool needsSmooth = false;
    for (int i = 0; i < 4; i++) {
      if (i < uLocCount && (uLocType[i] == 1 || uLocType[i] == 2)) needsSmooth = true;
    }
    if (needsSmooth) {
      smoothed = adjustmentChain(neighborMean(vUV), vUV);
      backgroundLight = dot(adjustmentChain(uSkyBackground, vec2(0.5)), vec3(0.2126, 0.7152, 0.0722));
    }

    float m[4];
    vec3 delta = vec3(0.0);
    bool spatial = false;
    for (int i = 0; i < 4; i++) {
      m[i] = 0.0;
      if (i >= uLocCount) continue;
      float A = automaticMask(i, smoothed, q, starMask[i], backgroundLight);
      float P = uLocPainted[i] > 0.5 ? paintedMask[i] : 1.0;
      if (uLocInvert[i] > 0.5) {
        if (uLocType[i] != 0) A = 1.0 - A;
        else P = 1.0 - P;
      }
      m[i] = clamp(A * P, 0.0, 1.0) * uLocIntensity[i];
      vec4 cl = uLocColor[i];
      if (m[i] > 0.0 && (cl.z > 0.001 || cl.w > 0.001)) {
        delta += m[i] * (spatialFilter(vUV, cl.w, cl.z) - raw);
        spatial = true;
      }
    }
    if (spatial) color = adjustmentChain(linearColor + delta, vUV);
    for (int i = 0; i < 4; i++) {
      if (i >= uLocCount) break;
      if (m[i] > 0.0) color = mix(color, applyLocal(color, uLocTones[i], uLocColor[i]), m[i]);
    }
    for (int i = 0; i < 4; i++) {
      if (i == uShowMask) maskShown = m[i];
    }
  }

  color = clamp(color, 0.0, 1.0);

  // Checked on the final displayed value, before the red mask overlay that
  // would otherwise hide or fake a clip. Black only when all three channels
  // are gone; white as soon as one channel saturates, because a core with a
  // single saturated channel has already lost its color. Blue and magenta
  // stand out on a dark sky and do not mix up with the red mask overlay.
  if (uClipping) {
    if (all(lessThanEqual(color, vec3(1.0 / 255.0)))) color = vec3(0.1, 0.45, 1.0);
    else if (any(greaterThanEqual(color, vec3(254.0 / 255.0)))) color = vec3(1.0, 0.1, 0.85);
  }

  // The mask in semi-transparent red, while it is being adjusted.
  if (maskShown > 0.0) color = mix(color, vec3(1.0, 0.12, 0.12), 0.6 * maskShown);

  fragColor = vec4(color, 1.0);
}
