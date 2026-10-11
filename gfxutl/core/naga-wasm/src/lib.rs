use naga::{
    ShaderStage,
    back::wgsl::{WriterFlags, write_string},
    front::glsl::{Frontend, Options},
    valid::{Capabilities, ValidationFlags, Validator},
};
use wasm_bindgen::prelude::*;

const WRAPPER_PREFIX: &str = r#"#version 450
layout(location = 0) in vec2 gfxInputUv;
layout(location = 0) out vec4 gfxOutputColor;
"#;

const WRAPPER_SUFFIX: &str = r#"
void main() {
    gfxOutputColor = gfxPostProcess(vec4(1.0), gfxInputUv, 0.0);
}
"#;

/// Parses user-authored Vulkan GLSL with Naga, validates its IR, and emits the
/// callable WGSL function consumed by Three.js' WebGPU node renderer.
#[wasm_bindgen]
pub fn compile_glsl_to_wgsl(user_source: &str) -> Result<String, JsValue> {
    let source = format!("{WRAPPER_PREFIX}\n{user_source}\n{WRAPPER_SUFFIX}");
    let mut frontend = Frontend::default();
    let module = frontend
        .parse(&Options::from(ShaderStage::Fragment), &source)
        .map_err(|error| JsValue::from_str(&error.emit_to_string(&source)))?;

    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::empty());
    let info = validator
        .validate(&module)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;

    module
        .functions
        .iter()
        .find(|(_, function)| function.name.as_deref() == Some("gfxPostProcess"))
        .ok_or_else(|| JsValue::from_str("`vec4 gfxPostProcess(vec4 color, vec2 uv, float time)` を定義してください"))?;

    let wgsl = write_string(&module, &info, WriterFlags::EXPLICIT_TYPES)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    extract_function(&wgsl, "gfxPostProcess")
        .map(str::to_owned)
        .ok_or_else(|| JsValue::from_str("Nagaが生成したWGSL関数を抽出できませんでした"))
}

fn extract_function<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    let declaration = format!("fn {name}(");
    let start = source.find(&declaration)?;
    let open = source[start..].find('{')? + start;
    let mut depth = 0usize;
    for (offset, character) in source[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&source[start..=open + offset]);
                }
            }
            _ => {}
        }
    }
    None
}
