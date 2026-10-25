export interface HistoricalReadingNode { sourceRecordId: string; displayName: string | null; }
export interface HistoricalParentEdge { claimId: string; parentRecordId: string; childRecordId: string; }
export interface HistoricalSpouseEdge { claimId: string; leftRecordId: string; rightRecordId: string; }

/**
 * A source-record-only reading layout.  Parent-child cycles are grouped rather
 * than broken: source claims stay visible and no canonical relationship is read.
 */
export function layoutHistoricalReading(nodes: readonly HistoricalReadingNode[], parentEdges: readonly HistoricalParentEdge[], spouseEdges: readonly HistoricalSpouseEdge[]) {
  const ids = new Set(nodes.map((node) => node.sourceRecordId));
  const edges = parentEdges.filter((edge) => ids.has(edge.parentRecordId) && ids.has(edge.childRecordId));
  const components = stronglyConnectedComponents([...ids].sort(), edges);
  const componentById = new Map<string, number>();
  components.forEach((component, index) => component.forEach((id) => componentById.set(id, index)));
  const componentEdges = new Map<number, Set<number>>();
  for (const edge of edges) {
    const from = componentById.get(edge.parentRecordId)!, to = componentById.get(edge.childRecordId)!;
    if (from !== to) (componentEdges.get(from) ?? componentEdges.set(from, new Set()).get(from)!).add(to);
  }
  const ranks = componentRanks(components, componentEdges);
  const connected = new Set(edges.flatMap((edge) => [edge.parentRecordId, edge.childRecordId]));
  const grouped = components.map((members, componentId) => ({ componentId, members, rank: connected.has(members[0]!) ? ranks.get(componentId)! : -1 }));
  const positions = new Map<string, { x: number; y: number; conflict: boolean }>();
  const rowByRank = new Map<number, number>();
  for (const group of grouped.sort((a, b) => a.rank - b.rank || a.members[0]!.localeCompare(b.members[0]!))) {
    const row = rowByRank.get(group.rank) ?? 0; rowByRank.set(group.rank, row + group.members.length + 1);
    const x = group.rank < 0 ? 0 : (group.rank + 1) * 250;
    const conflict = group.members.length > 1 || edges.some((edge) => componentById.get(edge.parentRecordId) === group.componentId && componentById.get(edge.childRecordId) === group.componentId);
    group.members.forEach((id, index) => positions.set(id, { x, y: 36 + (row + index) * 82, conflict }));
  }
  const laidOut = nodes.map((node) => ({ ...node, ...positions.get(node.sourceRecordId)! }));
  const byId = new Map(laidOut.map((node) => [node.sourceRecordId, node]));
  const connector = <T extends HistoricalParentEdge | HistoricalSpouseEdge>(edge: T, leftId: string, rightId: string) => {
    const left = byId.get(leftId), right = byId.get(rightId);
    return left && right ? [{ ...edge, x1: left.x + 85, y1: left.y + 24, x2: right.x + 85, y2: right.y + 24 }] : [];
  };
  return {
    width: Math.max(720, ...laidOut.map((node) => node.x + 210)),
    height: Math.max(240, ...laidOut.map((node) => node.y + 92)),
    nodes: laidOut,
    parentConnectors: edges.flatMap((edge) => connector(edge, edge.parentRecordId, edge.childRecordId)),
    spouseConnectors: spouseEdges.flatMap((edge) => connector(edge, edge.leftRecordId, edge.rightRecordId)),
    unconnectedRecordIds: laidOut.filter((node) => !connected.has(node.sourceRecordId)).map((node) => node.sourceRecordId),
  };
}

function stronglyConnectedComponents(ids: string[], edges: readonly HistoricalParentEdge[]) {
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  edges.forEach((edge) => adjacency.get(edge.parentRecordId)?.push(edge.childRecordId));
  const indexById = new Map<string, number>(), lowlink = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>(), result: string[][] = [];
  let index = 0;
  const visit = (id: string) => {
    indexById.set(id, index); lowlink.set(id, index); index += 1; stack.push(id); onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!indexById.has(next)) { visit(next); lowlink.set(id, Math.min(lowlink.get(id)!, lowlink.get(next)!)); }
      else if (onStack.has(next)) lowlink.set(id, Math.min(lowlink.get(id)!, indexById.get(next)!));
    }
    if (lowlink.get(id) === indexById.get(id)) { const component: string[] = []; let next: string | undefined; do { next = stack.pop(); if (next) { onStack.delete(next); component.push(next); } } while (next !== id); result.push(component.sort()); }
  };
  ids.forEach((id) => { if (!indexById.has(id)) visit(id); });
  return result;
}

function componentRanks(components: readonly string[][], edges: ReadonlyMap<number, ReadonlySet<number>>) {
  const incoming = new Map(components.map((_, index) => [index, 0]));
  edges.forEach((targets) => targets.forEach((target) => incoming.set(target, (incoming.get(target) ?? 0) + 1)));
  const queue = components.map((_, index) => index).filter((index) => incoming.get(index) === 0).sort((left, right) => components[left]![0]!.localeCompare(components[right]![0]!));
  const ranks = new Map(components.map((_, index) => [index, 0]));
  for (let cursor = 0; cursor < queue.length; cursor += 1) { const current = queue[cursor]!; for (const target of edges.get(current) ?? []) { ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(current) ?? 0) + 1)); incoming.set(target, incoming.get(target)! - 1); if (incoming.get(target) === 0) queue.push(target); } }
  return ranks;
}
