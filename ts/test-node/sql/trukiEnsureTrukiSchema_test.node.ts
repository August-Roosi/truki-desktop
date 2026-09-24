// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import SQL from '@signalapp/sqlcipher';

import { ensureTrukiSchema } from '../../sql/truki/ensureTrukiSchema.std.ts';
import type { WritableDB } from '../../sql/Interface.std.ts';

function columnNames(db: WritableDB, table: string): Array<string> {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .map(row => row.name);
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => noopLogger,
} as never;

describe('ensureTrukiSchema', () => {
  let db: WritableDB;

  beforeEach(() => {
    db = new SQL(':memory:') as unknown as WritableDB;
    db.exec(`
      CREATE TABLE chatFolders (
        id TEXT NOT NULL PRIMARY KEY,
        folderType INTEGER NOT NULL,
        name TEXT NOT NULL
      ) STRICT;
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('adds the three Truki columns', () => {
    ensureTrukiSchema(db, noopLogger);
    const names = columnNames(db, 'chatFolders');
    assert.include(names, 'emoji');
    assert.include(names, 'color');
    assert.include(names, 'hideFromAllChats');
  });

  it('is idempotent', () => {
    ensureTrukiSchema(db, noopLogger);
    assert.doesNotThrow(() => ensureTrukiSchema(db, noopLogger));
    const names = columnNames(db, 'chatFolders');
    assert.strictEqual(names.filter(n => n === 'emoji').length, 1);
  });

  it('adds only the missing column when one already exists', () => {
    db.exec('ALTER TABLE chatFolders ADD COLUMN emoji TEXT;');
    ensureTrukiSchema(db, noopLogger);
    const names = columnNames(db, 'chatFolders');
    assert.include(names, 'color');
    assert.strictEqual(names.filter(n => n === 'emoji').length, 1);
  });

  it('does nothing when the chatFolders table is absent', () => {
    db.exec('DROP TABLE chatFolders;');
    assert.doesNotThrow(() => ensureTrukiSchema(db, noopLogger));
  });

  it('defaults hideFromAllChats to 0 for existing rows', () => {
    db.prepare(
      "INSERT INTO chatFolders (id, folderType, name) VALUES ('a', 1, '')"
    ).run();
    ensureTrukiSchema(db, noopLogger);
    const row = db
      .prepare('SELECT hideFromAllChats FROM chatFolders WHERE id = $id')
      .get<{ hideFromAllChats: number }>({ id: 'a' });
    assert.strictEqual(row?.hideFromAllChats, 0);
  });
});
