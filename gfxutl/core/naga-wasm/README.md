# GfxUtl Naga WASM bridge

This crate embeds `gfx-rs/wgpu`'s Naga shader translator in the renderer worker.
It accepts a Vulkan-style GLSL fragment function, validates it, and emits WGSL
for the WebGPU backend.

The generated browser package is checked in so `npm run dev` and the ordinary
production build do not require a Rust toolchain. Regenerate it with:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.105 --locked
npm run build:naga
```

Naga's GLSL input follows Vulkan semantics and GLSL 440+ as documented by the
upstream project. GfxUtl deliberately exposes a resource-free function ABI:

```glsl
vec4 gfxPostProcess(vec4 color, vec2 uv, float time)
```
