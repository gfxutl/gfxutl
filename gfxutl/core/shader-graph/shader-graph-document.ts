import type { ShaderGraphDocument, ShaderGraphEdge, ShaderGraphNode, ShaderGraphNodeKind } from "../interface/types";

const GRAPH_BLOCK = /```gfxutl-shader-graph\s*([\s\S]*?)```/;

export function createShaderGraph(name = "shader.ts", sourcePath?: string, handle?: FileSystemFileHandle): ShaderGraphDocument {
  const graph: ShaderGraphDocument = {
    id: crypto.randomUUID(), name, sourcePath, handle, dirty: false, source: "",
    nodes: [
      { id: "input", kind: "inputColor", position: { x: 20, y: 55 }, data: { label: "Input color" } },
      { id: "tint", kind: "color", position: { x: 20, y: 210 }, data: { label: "Tint", color: "#80b8ff" } },
      { id: "multiply", kind: "multiply", position: { x: 275, y: 120 }, data: { label: "Multiply" } },
      { id: "output", kind: "output", position: { x: 525, y: 120 }, data: { label: "Output" } },
    ],
    edges: [
      { id: "input-multiply", source: "input", target: "multiply", targetHandle: "a" },
      { id: "tint-multiply", source: "tint", target: "multiply", targetHandle: "b" },
      { id: "multiply-output", source: "multiply", target: "output", targetHandle: "color" },
    ],
  };
  graph.source = serializeShaderGraph(graph);
  return graph;
}

export function parseShaderGraph(source: string, name: string, sourcePath?: string, handle?: FileSystemFileHandle): ShaderGraphDocument {
  const match = source.match(GRAPH_BLOCK);
  if (!match) throw new Error("gfxutl-shader-graph TSDoc block was not found");
  const parsed = JSON.parse(match[1].replace(/^\s*\* ?/gm, "").trim()) as { version?: number; nodes?: ShaderGraphNode[]; edges?: ShaderGraphEdge[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error("Unsupported shader graph format");
  return { id: crypto.randomUUID(), name, sourcePath, handle, source, nodes: parsed.nodes, edges: parsed.edges, dirty: false };
}

export function serializeShaderGraph(graph: Pick<ShaderGraphDocument, "name" | "nodes" | "edges">): string {
  const metadata = JSON.stringify({ version: 1, nodes: graph.nodes, edges: graph.edges }, null, 2)
    .split("\n").map((line) => ` * ${line}`).join("\n");
  return `/**
 * @packageDocumentation
 *
 * @remarks
 * Graphical TSL shader created by gfxutl. The fenced JSON block is the
 * editable graph source of truth and is intentionally stored as TSDoc.
 *
 * \`\`\`gfxutl-shader-graph
${metadata}
 * \`\`\`
 */
import { Fn, float, time, uv, vec4 } from "three/tsl";

/** Generated TSL node function. Edit the graph in gfxutl to regenerate it. */
export const shader = Fn(( [ inputColor = vec4(1.0, 1.0, 1.0, 1.0) ] ) => {
  return ${expressionForOutput(graph.nodes, graph.edges)};
});
`;
}

/** Compiles the portable graph subset into the post-process ABI used by the renderer. */
export function compileShaderGraphToGlsl(graph: Pick<ShaderGraphDocument, "nodes" | "edges">): string {
  return `vec4 gfxPostProcess(vec4 color, vec2 uv, float time) {\n  return clamp(${expressionForGlslOutput(graph.nodes, graph.edges)}, 0.0, 1.0);\n}`;
}

function expressionForGlslOutput(nodes: ShaderGraphNode[], edges: ShaderGraphEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgeTo = (nodeId: string, handle?: string) => edges.find((edge) => edge.target === nodeId && (!handle || edge.targetHandle === handle));
  const output = nodes.find((node) => node.kind === "output");
  const visiting = new Set<string>();
  const emit = (id: string): string => {
    if (visiting.has(id)) return "vec4(0.0, 0.0, 0.0, 1.0)";
    const node = byId.get(id);
    if (!node) return "vec4(0.0)";
    visiting.add(id);
    const input = (handle?: string, fallback = "vec4(0.0)") => {
      const edge = edgeTo(id, handle);
      return edge ? emit(edge.source) : fallback;
    };
    let result: string;
    if (node.kind === "inputColor") result = "color";
    else if (node.kind === "uv") result = "vec4(uv, 0.0, 1.0)";
    else if (node.kind === "time") result = "vec4(time)";
    else if (node.kind === "float") result = `vec4(${finite(node.data.value, 1)})`;
    else if (node.kind === "color") {
      const [r, g, b] = hexToRgb(node.data.color ?? "#ffffff");
      result = `vec4(${r}, ${g}, ${b}, 1.0)`;
    } else if (node.kind === "add") result = `(${input("a")}) + (${input("b")})`;
    else if (node.kind === "multiply") result = `(${input("a", "vec4(1.0)")}) * (${input("b", "vec4(1.0)")})`;
    else if (node.kind === "sine") result = `sin(${input("value")})`;
    else if (node.kind === "mix") result = `mix(${input("a")}, ${input("b")}, (${input("factor", "vec4(0.5)")}).x)`;
    else result = input("color", "vec4(0.0, 0.0, 0.0, 1.0)");
    visiting.delete(id);
    return result;
  };
  const incoming = output && edgeTo(output.id, "color");
  return incoming ? emit(incoming.source) : "color";
}

function expressionForOutput(nodes: ShaderGraphNode[], edges: ShaderGraphEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const output = nodes.find((node) => node.kind === "output");
  const edgeTo = (nodeId: string, handle?: string) => edges.find((edge) => edge.target === nodeId && (!handle || edge.targetHandle === handle));
  const visiting = new Set<string>();
  const emit = (id: string): string => {
    if (visiting.has(id)) return "vec4(0.0, 0.0, 0.0, 1.0)";
    const node = byId.get(id);
    if (!node) return "float(0.0)";
    visiting.add(id);
    const input = (handle?: string, fallback = "float(0.0)") => {
      const edge = edgeTo(id, handle);
      return edge ? emit(edge.source) : fallback;
    };
    const result = emitNode(node.kind, node, input);
    visiting.delete(id);
    return result;
  };
  const incoming = output && edgeTo(output.id, "color");
  return incoming ? emit(incoming.source) : "vec4(0.0, 0.0, 0.0, 1.0)";
}

function emitNode(kind: ShaderGraphNodeKind, node: ShaderGraphNode, input: (handle?: string, fallback?: string) => string) {
  if (kind === "inputColor") return "inputColor";
  if (kind === "uv") return "uv()";
  if (kind === "time") return "time";
  if (kind === "float") return `float(${finite(node.data.value, 1)})`;
  if (kind === "color") {
    const [r, g, b] = hexToRgb(node.data.color ?? "#ffffff");
    return `vec4(${r}, ${g}, ${b}, 1.0)`;
  }
  if (kind === "add") return `(${input("a")}).add(${input("b")})`;
  if (kind === "multiply") return `(${input("a", "float(1.0)")}).mul(${input("b", "float(1.0)")})`;
  if (kind === "sine") return `(${input("value")}).sin()`;
  if (kind === "mix") return `(${input("a")}).mix(${input("b")}, ${input("factor", "float(0.5)")})`;
  return input("color", "vec4(0.0, 0.0, 0.0, 1.0)");
}

function finite(value: number | undefined, fallback: number) { return Number.isFinite(value) ? value : fallback; }
function hexToRgb(hex: string) {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "ffffff";
  return [0, 2, 4].map((offset) => (parseInt(normalized.slice(offset, offset + 2), 16) / 255).toFixed(4));
}
