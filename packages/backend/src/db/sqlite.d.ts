// Type declarations for Node.js built-in node:sqlite module (Node >= 22.5)
declare module 'node:sqlite' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  type SQLiteValue = null | number | bigint | string | Uint8Array;
  type BindParameters = SQLiteValue[] | Record<string, SQLiteValue>;

  interface StatementSync {
    all(...params: SQLiteValue[]): Record<string, SQLiteValue>[];
    all(params: Record<string, SQLiteValue>): Record<string, SQLiteValue>[];
    get(...params: SQLiteValue[]): Record<string, SQLiteValue> | undefined;
    get(params: Record<string, SQLiteValue>): Record<string, SQLiteValue> | undefined;
    run(...params: SQLiteValue[]): RunResult;
    run(params: Record<string, SQLiteValue>): RunResult;
  }

  class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
