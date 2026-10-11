// What the rules need of a database handle: a pg Pool, a client, or the
// workflow transaction. They never open, commit or end one.

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
