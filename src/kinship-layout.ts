export function layoutKinship(centerPersonId: string, nodes: readonly { id: string; displayName: string }[], relations: readonly { subjectPersonId: string; relatedPersonId: string; relationKind: string }[]) {
  const center = { id: centerPersonId, displayName: nodes.find((node) => node.id === centerPersonId)?.displayName ?? centerPersonId, x: 300, y: 180 };
  const others = nodes.filter((node) => node.id !== centerPersonId).map((node, index) => ({ ...node, x: index % 2 ? 520 : 80, y: 60 + Math.floor(index / 2) * 150 }));
  const positions = new Map([center, ...others].map((node) => [node.id, node]));
  return { nodes: [center, ...others], relations: relations.flatMap((edge) => positions.has(edge.subjectPersonId) && positions.has(edge.relatedPersonId) ? [{ ...edge, from: positions.get(edge.subjectPersonId)!, to: positions.get(edge.relatedPersonId)! }] : []) };
}
