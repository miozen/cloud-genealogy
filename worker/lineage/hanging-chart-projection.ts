export interface HangingChartPerson { id: string; displayName: string; branchIds?: readonly string[]; }
export interface HangingChartEdge { parentPersonId: string; childPersonId: string; orderKey: string; }
export interface HangingChartProjection {
  nodes: Array<{ personId: string; displayName: string; generation: number; branchIds: readonly string[] }>;
  edges: readonly HangingChartEdge[];
  generations: Array<{ generation: number; personIds: string[] }>;
}

/** Pure, coordinate-free input for the later SVG layout engine. */
export function projectHangingChart(
  people: readonly HangingChartPerson[],
  edges: readonly HangingChartEdge[],
): HangingChartProjection {
  const children = new Set(edges.map((edge) => edge.childPersonId));
  const generation = new Map<string, number>();
  for (const person of people) if (!children.has(person.id)) generation.set(person.id, 0);
  const sortedEdges = [...edges].sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.childPersonId.localeCompare(right.childPersonId));
  for (let pass = 0; pass < people.length; pass += 1) {
    for (const edge of sortedEdges) {
      const parentGeneration = generation.get(edge.parentPersonId);
      if (parentGeneration !== undefined) generation.set(edge.childPersonId, parentGeneration + 1);
    }
  }
  const nodesByPerson = new Map(people.map((person) => [person.id, {
    personId: person.id,
    displayName: person.displayName,
    generation: generation.get(person.id) ?? 0,
    branchIds: person.branchIds ?? [],
  }]));
  const generations = [...new Set(Array.from(nodesByPerson.values(), (node) => node.generation))]
    .sort((a, b) => a - b)
    .map((value) => ({
      generation: value,
      personIds: people
        .filter((person) => nodesByPerson.get(person.id)?.generation === value)
        .map((person) => person.id),
    }));
  const nodes = generations.flatMap((group) => group.personIds.map((personId) => nodesByPerson.get(personId)!));
  return { nodes, edges: sortedEdges, generations };
}
