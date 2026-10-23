-- Interpretive rules are separate from immutable source claims. An unmatched
-- source relation remains visible as pending interpretation rather than being
-- inferred from the canonical lineage.
CREATE TABLE source_relation_semantic_rule (
  id TEXT PRIMARY KEY,
  relation_kind TEXT NOT NULL,
  graph_kind TEXT NOT NULL CHECK (graph_kind IN ('parent_to_child', 'child_to_parent', 'spouse', 'non_graph')),
  parent_kind TEXT CHECK (parent_kind IN ('biological_parent', 'adoptive_parent', 'successor_parent')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    (graph_kind IN ('parent_to_child', 'child_to_parent') AND parent_kind IS NOT NULL)
    OR (graph_kind IN ('spouse', 'non_graph') AND parent_kind IS NULL)
  )
);
CREATE UNIQUE INDEX source_relation_semantic_rule_active_kind
  ON source_relation_semantic_rule(relation_kind) WHERE retired_at IS NULL;
