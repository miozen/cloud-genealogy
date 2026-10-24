export interface HistoricalRecord { sourceRecordId: string; displayName: string | null; }
export interface HistoricalEdge { claimId: string; parentRecordId: string; childRecordId: string; }

/** Stable source-record grid; it makes no genealogical inference from disputed claims. */
export function layoutHistoricalRecords(records: readonly HistoricalRecord[], edges: readonly HistoricalEdge[]) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(records.length || 1)));
  const nodes = records.map((record, index) => ({ ...record, x: (index % columns) * 220, y: Math.floor(index / columns) * 104 }));
  const byId = new Map(nodes.map((node) => [node.sourceRecordId, node]));
  return {
    nodes,
    connectors: edges.flatMap((edge) => {
      const parent = byId.get(edge.parentRecordId), child = byId.get(edge.childRecordId);
      return parent && child ? [{ ...edge, x1: parent.x + 85, y1: parent.y + 48, x2: child.x + 85, y2: child.y + 48 }] : [];
    }),
  };
}
