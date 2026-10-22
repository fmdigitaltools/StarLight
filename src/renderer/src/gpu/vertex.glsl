#version 300 es

// Draws a full-screen rectangle. The position and scale of the image are
// handled by the uniforms, so zooming and panning do not require reloading
// the texture.

in vec2 aPos;

uniform vec2 uScale;
uniform vec2 uOffset;

out vec2 vUV;

void main() {
  // aPos goes from 0 to 1: it is converted to device space.
  vec2 pos = aPos * uScale + uOffset;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  // The vertical axis of FITS images grows upward, while the texture's
  // grows downward.
  vUV = vec2(aPos.x, 1.0 - aPos.y);
}
