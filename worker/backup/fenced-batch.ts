/** Check the admission in the same transaction as every business statement. */
export async function fencedBatch(database: D1Database, admissionId: string | undefined, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (!admissionId) throw new Error("backup_admission_missing");
  const results = await database.batch([
    database.prepare("INSERT INTO backup_write_fence_check (admission_id) VALUES (?)").bind(admissionId),
    ...statements,
  ]);
  return results.slice(1);
}
