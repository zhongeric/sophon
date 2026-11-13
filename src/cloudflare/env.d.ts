declare module '*.md' {
  const text: string
  export default text
}

declare module '*.txt' {
  const text: string
  export default text
}

declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
