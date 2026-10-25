export function layoutKinship(centerPersonId: string, nodes: readonly { id: string; displayName: string; distance?: number }[], relations: readonly { subjectPersonId: string; relatedPersonId: string; relationKind: string }[]) {
  const ordered = [...nodes.filter((node) => node.id !== centerPersonId)].sort((left, right) => (left.distance ?? 1) - (right.distance ?? 1) || left.id.localeCompare(right.id));
  const rowCount = Math.max(1, Math.ceil(ordered.length / 2));
  const height = Math.max(420, rowCount * 90 + 120);
  const center = { id: centerPersonId, displayName: nodes.find((node) => node.id === centerPersonId)?.displayName ?? centerPersonId, x: 365, y: Math.round(height / 2 - 24) };
  const others = ordered.map((node, index) => {
    const distance = node.distance ?? 1;
    return { ...node, x: index % 2 ? 540 + (distance - 1) * 90 : 20 - (distance - 1) * 10, y: 42 + Math.floor(index / 2) * 90 };
  });
  const positions = new Map([center, ...others].map((node) => [node.id, node]));
  return { width: 820, height, nodes: [center, ...others], relations: relations.flatMap((edge) => positions.has(edge.subjectPersonId) && positions.has(edge.relatedPersonId) ? [{ ...edge, from: positions.get(edge.subjectPersonId)!, to: positions.get(edge.relatedPersonId)! }] : []) };
}
