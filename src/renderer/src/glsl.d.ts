/** Shaders are imported as text through the ?raw suffix. */
declare module '*.glsl?raw' {
  const source: string
  export default source
}
