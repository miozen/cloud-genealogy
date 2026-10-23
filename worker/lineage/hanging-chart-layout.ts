import type { HangingChartEdge, HangingChartProjection } from "./hanging-chart-projection";

export interface HangingChartLayoutOptions { columnGap: number; rowGap: number; }
export interface HangingChartLayout {
  nodes: Array<{ personId: string; generation: number; x: number; y: number }>;
  connectors: Array<{ parentPersonId: string; childPersonId: string; points: Array<{ x: number; y: number }> }>;
}

/** Returns a root and all of its descendants; authoritative records remain untouched. */
export function expandHangingChart(projection: HangingChartProjection, rootPersonId?: string): HangingChartProjection {
  if (!rootPersonId) return projection;
  const children = new Map<string, string[]>();
  for (const edge of projection.edges) children.set(edge.parentPersonId, [...(children.get(edge.parentPersonId) ?? []), edge.childPersonId]);
  const included = new Set<string>([rootPersonId]);
  for (const id of included) for (const child of children.get(id) ?? []) included.add(child);
  return {
    nodes: projection.nodes.filter((node) => included.has(node.personId)),
    edges: projection.edges.filter((edge) => included.has(edge.parentPersonId) && included.has(edge.childPersonId)),
    generations: projection.generations.map((generation) => ({ ...generation, personIds: generation.personIds.filter((id) => included.has(id)) })).filter((generation) => generation.personIds.length > 0),
  };
}

/** Deterministic layout output for SVG; never persist these coordinates. */
export function layoutHangingChart(projection: HangingChartProjection, options: HangingChartLayoutOptions = { columnGap: 240, rowGap: 96 }): HangingChartLayout {
  const nodes = projection.generations.flatMap((generation) => generation.personIds.map((personId, row) => ({ personId, generation: generation.generation, x: generation.generation * options.columnGap, y: row * options.rowGap })));
  const byId = new Map(nodes.map((node) => [node.personId, node]));
  const connectors = projection.edges.flatMap((edge: HangingChartEdge) => {
    const parent = byId.get(edge.parentPersonId); const child = byId.get(edge.childPersonId);
    if (!parent || !child) return [];
    const middleX = parent.x + (child.x - parent.x) / 2;
    return [{ parentPersonId: edge.parentPersonId, childPersonId: edge.childPersonId, points: [{ x: parent.x, y: parent.y }, { x: middleX, y: parent.y }, { x: middleX, y: child.y }, { x: child.x, y: child.y }] }];
  });
  return { nodes, connectors };
}
