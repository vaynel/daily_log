import pg from 'pg';

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 5 });
}
