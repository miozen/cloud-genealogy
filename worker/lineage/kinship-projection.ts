export interface KinshipRelation { subjectPersonId: string; relatedPersonId: string; relationKind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse"; }
export function projectKinship(centerPersonId: string, people: readonly { id: string; displayName: string }[], relations: readonly KinshipRelation[]) {
  const incident = relations.filter((relation) => relation.subjectPersonId === centerPersonId || relation.relatedPersonId === centerPersonId);
  const ids = new Set([centerPersonId, ...incident.flatMap((relation) => [relation.subjectPersonId, relation.relatedPersonId])]);
  return { centerPersonId, nodes: people.filter((person) => ids.has(person.id)), relations: incident };
}
