// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

//
// Truki schema changes deliberately live OUTSIDE upstream's numbered migration
// system. See AGENTS.md: the migration runner skips any version <= user_version,
// so a Truki entry in SCHEMA_VERSIONS would make future upstream migrations
// silently skip on Truki installs. This runs after upstream's loop, adds only
// what is missing, and never touches user_version.
//

import type { WritableDB } from '../Interface.std.ts';
import type { LoggerType } from '../../types/Logging.std.ts';

type ColumnAddition = Readonly<{
  table: string;
  column: string;
  definition: string;
}>;

const TRUKI_COLUMNS: ReadonlyArray<ColumnAddition> = [
  { table: 'chatFolders', column: 'emoji', definition: 'TEXT' },
  { table: 'chatFolders', column: 'color', definition: 'INTEGER' },
  {
    table: 'chatFolders',
    column: 'hideFromAllChats',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
];

function tableExists(db: WritableDB, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $table"
    )
    .get<{ 1: number }>({ table });
  return row != null;
}

function columnExists(db: WritableDB, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .some(row => row.name === column);
}

export function ensureTrukiSchema(db: WritableDB, logger: LoggerType): void {
  for (const { table, column, definition } of TRUKI_COLUMNS) {
    if (!tableExists(db, table)) {
      continue;
    }
    if (columnExists(db, table, column)) {
      continue;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    logger.info(`ensureTrukiSchema: added ${table}.${column}`);
  }
}
