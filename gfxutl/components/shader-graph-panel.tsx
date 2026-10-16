import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Add16Regular as Plus, Code16Regular as Code, Save16Regular as Save } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEditor } from "../core/interface";
import type { ShaderGraphEdge, ShaderGraphNode, ShaderGraphNodeKind } from "../core/interface";
import { useI18n } from "../core/i18n";
import { Button } from "./ui/button";

type FlowData = { label: string; kind: ShaderGraphNodeKind; value?: number; color?: string; update?: (patch: Partial<ShaderGraphNode["data"]>) => void };
type FlowNode = Node<FlowData, "shader">;

const INPUTS: Partial<Record<ShaderGraphNodeKind, string[]>> = {
  add: ["a", "b"], multiply: ["a", "b"], sine: ["value"], mix: ["a", "b", "factor"], output: ["color"],
};

const NODE_LABELS: Record<ShaderGraphNodeKind, string> = {
  inputColor: "Input color", uv: "UV", time: "Time", float: "Float", color: "Color",
  add: "Add", multiply: "Multiply", sine: "Sine", mix: "Mix", output: "Output",
};

function ShaderNode({ data, selected }: NodeProps<FlowNode>) {
  const inputs = INPUTS[data.kind] ?? [];
  return <div className={`shader-node shader-node-${data.kind}${selected ? " selected" : ""}`}>
    <header><Code /><strong>{data.label}</strong><small>{data.kind}</small></header>
    <div className="shader-node-body">
      {inputs.map((input, index) => <div className="shader-socket-row" key={input}>
        <Handle type="target" position={Position.Left} id={input} style={{ top: 39 + index * 22 }} />
        <span>{input}</span>
      </div>)}
      {data.kind === "float" && <input className="nodrag" type="number" step="0.05" value={data.value ?? 1} onChange={(event) => data.update?.({ value: Number(event.target.value) })} />}
      {data.kind === "color" && <input className="nodrag" type="color" value={data.color ?? "#ffffff"} onChange={(event) => data.update?.({ color: event.target.value })} />}
    </div>
    {data.kind !== "output" && <Handle type="source" position={Position.Right} id="value" />}
  </div>;
}

const nodeTypes = { shader: ShaderNode };

export function ShaderGraphPanel() {
  const { state, controller } = useEditor();
  const { t } = useI18n();
  const graph = state.shaderGraphs.find((item) => item.id === state.activeShaderGraphId) ?? null;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  const commit = useCallback((nodes: FlowNode[], edges: Edge[]) => {
    if (!graph) return;
    controller.updateShaderGraph(graph.id, nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      position: node.position,
      data: { label: node.data.label, value: node.data.value, color: node.data.color },
    })), edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle })));
  }, [controller, graph]);

  const nodes = useMemo<FlowNode[]>(() => (graph?.nodes ?? []).map((node) => ({
    id: node.id, type: "shader", position: node.position,
    data: { ...node.data, kind: node.kind, update: (patch) => {
      if (!graph) return;
      controller.updateShaderGraph(graph.id, graph.nodes.map((item) => item.id === node.id ? { ...item, data: { ...item.data, ...patch } } : item), graph.edges);
    } },
  })), [controller, graph]);
  const edges = useMemo<Edge[]>(() => (graph?.edges ?? []).map((edge) => ({ ...edge, animated: true })), [graph]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => commit(applyNodeChanges(changes, nodes), edges), [commit, edges, nodes]);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => commit(nodes, applyEdgeChanges(changes, edges)), [commit, edges, nodes]);
  const onConnect = useCallback((connection: Connection) => commit(nodes, addEdge({ ...connection, id: crypto.randomUUID(), animated: true }, edges)), [commit, edges, nodes]);

  const addNode = (kind: ShaderGraphNodeKind) => {
    if (!graph) return;
    const node: ShaderGraphNode = {
      id: crypto.randomUUID(), kind,
      position: { x: 100 + (graph.nodes.length % 4) * 180, y: 80 + (graph.nodes.length % 3) * 115 },
      data: { label: NODE_LABELS[kind], ...(kind === "float" ? { value: 1 } : {}), ...(kind === "color" ? { color: "#ffffff" } : {}) },
    };
    controller.updateShaderGraph(graph.id, [...graph.nodes, node], graph.edges);
    setPaletteOpen(false);
  };

  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!graph || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void controller.saveShaderGraph(graph.id);
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [controller, graph]);

  return <section className="shader-graph-panel panel" aria-label={t("シェーダーグラフ")}>
    {!graph ? <div className="shader-graph-empty"><Code /><strong>{t("シェーダーグラフがありません")}</strong><span>{t("メディア欄を右クリックして「新規 → シェーダー」を選択してください")}</span></div> : <>
      <div className="shader-graph-toolbar">
        <div className="shader-add-menu">
          <Button size="sm" onClick={() => setPaletteOpen((open) => !open)}><Plus />{t("ノードを追加")}</Button>
          {paletteOpen && <div className="shader-node-palette">{(Object.keys(NODE_LABELS) as ShaderGraphNodeKind[]).filter((kind) => kind !== "output").map((kind) => <button key={kind} onClick={() => addNode(kind)}>{NODE_LABELS[kind]}<small>{kind}</small></button>)}</div>}
        </div>
        <strong>{graph.name}{graph.dirty ? " •" : ""}</strong>
        <span className="spacer" />
        <Button size="sm" variant="outline" disabled={!state.selectedClipIds.some((id) => state.clips.find((clip) => clip.id === id)?.kind === "video")} onClick={() => void controller.applyShaderGraphToSelection(graph.id)}><Code />{t("選択へ適用")}</Button>
        <Button size="sm" variant={sourceOpen ? "outline" : "ghost"} onClick={() => setSourceOpen((open) => !open)}><Code />TSL</Button>
        <Button size="sm" onClick={() => void controller.saveShaderGraph(graph.id)}><Save />{t("保存")}</Button>
      </div>
      <div className={`shader-graph-workspace${sourceOpen ? " source-open" : ""}`}>
        <ReactFlow<FlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} fitView colorMode="dark" deleteKeyCode={["Backspace", "Delete"]}>
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#343a40" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(node) => node.data.kind === "output" ? "#d98b55" : "#698cad"} />
        </ReactFlow>
        {sourceOpen && <pre className="shader-source"><code>{graph.source}</code></pre>}
      </div>
    </>}
  </section>;
}
