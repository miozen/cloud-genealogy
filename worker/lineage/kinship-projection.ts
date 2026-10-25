export interface KinshipRelation { subjectPersonId: string; relatedPersonId: string; relationKind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse"; }
export function projectKinship(centerPersonId: string, people: readonly { id: string; displayName: string }[], relations: readonly KinshipRelation[]) {
  const incident = relations.filter((relation) => relation.subjectPersonId === centerPersonId || relation.relatedPersonId === centerPersonId);
  const ids = new Set([centerPersonId, ...incident.flatMap((relation) => [relation.subjectPersonId, relation.relatedPersonId])]);
  return { centerPersonId, nodes: people.filter((person) => ids.has(person.id)), relations: incident };
}

export function boundedKinship(centerPersonId: string, people: readonly { id: string; displayName: string }[], relations: readonly KinshipRelation[], radius: 1 | 2, limits = { nodes: 60, relations: 120 }) {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  if (!peopleById.has(centerPersonId)) return { centerPersonId, radius, nodes: [], relations: [], truncated: false };
  const distances = new Map([[centerPersonId, 0]]);
  const selected = new Map<string, KinshipRelation>();
  let frontier = [centerPersonId], truncated = false;
  for (let distance = 0; distance < radius && frontier.length > 0; distance += 1) {
    const current = new Set(frontier); frontier = [];
    for (const relation of relations) {
      if (!current.has(relation.subjectPersonId) && !current.has(relation.relatedPersonId)) continue;
      const key = relationKey(relation);
      if (selected.has(key)) continue;
      if (selected.size >= limits.relations) { truncated = true; continue; }
      const additions = [relation.subjectPersonId, relation.relatedPersonId].filter((id) => !distances.has(id));
      if (distances.size + additions.length > limits.nodes) { truncated = true; continue; }
      selected.set(key, relation);
      for (const id of additions) { distances.set(id, distance + 1); frontier.push(id); }
    }
  }
  return {
    centerPersonId,
    radius,
    nodes: [...distances].map(([id, distance]) => ({ ...peopleById.get(id)!, distance })).sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id)),
    relations: [...selected.values()],
    truncated,
  };
}

function relationKey(relation: KinshipRelation) {
  if (relation.relationKind === "spouse") return [relation.subjectPersonId, relation.relatedPersonId].sort().join("\u0000") + "\u0000spouse";
  return `${relation.subjectPersonId}\u0000${relation.relatedPersonId}\u0000${relation.relationKind}`;
}
