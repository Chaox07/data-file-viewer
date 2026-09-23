import assert from 'node:assert/strict';
import test from 'node:test';
import { validateQueryMessage, validateTableFilters } from '../src/queryMessages';

test('message boundary refuses malformed, oversized and invalid enum values', () => {
  for (const message of [null, [], 'runQuery', {}, { command: 'unknown' },
    { command: 'runQuery', sql: {} }, { command: 'runQuery', sql: 'é'.repeat(140000) },
    { command: 'sortQuery', column: 'x', direction: 'desc; drop table t' },
    { command: 'queryTarget', targetId: 'id', generation: NaN },
    { command: 'queryTarget', targetId: 'id', generation: -1 },
    { command: 'queryCatalog', cursor: Infinity },
    { command: 'toggleSafeMode', safeMode: 'false', backupBeforeWrite: true, checkForChanges: true },
    JSON.parse('{"command":"ready","__proto__":{"sql":"secret"}}'),
  ]) assert.throws(() => validateQueryMessage(message));
  validateQueryMessage({ command: 'runQuery', sql: 'select 1' });
  validateQueryMessage({ command: 'queryTarget', targetId: 'opaque', generation: 2 });
});

test('filter handoff refuses overflow rather than changing the predicate', () => {
  const filter = { column: 'Date', operator: 'gte', value: '1990-01-01' };
  validateTableFilters([filter], { column: 'Date', direction: 'desc' }, 100);
  for (const [filters, sort, limit] of [
    [Array(101).fill(filter), undefined, 100],
    [[{ ...filter, value: 'x'.repeat(4001) }], undefined, 100],
    [[filter], { column: 'Date', direction: 'DROP' }, 100],
    [[filter], undefined, 100001], [[filter], undefined, -1], [[filter], undefined, NaN],
  ]) assert.throws(() => validateTableFilters(filters, sort, limit));
});
