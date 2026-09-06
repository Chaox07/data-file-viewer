import assert from 'node:assert/strict';
import test from 'node:test';
import { destructiveReason, hasMultipleStatements } from '../src/sqlSafety';

test('plain reads are allowed', () => {
  for (const sql of [
    'select * from t',
    'SELECT * FROM "t" LIMIT 100;',
    'with x as (select 1) select * from x',
    'describe t',
    'summarize t',
  ]) {
    assert.equal(destructiveReason(sql), null, sql);
  }
});

test('writes are blocked, and named by what actually tripped', () => {
  assert.match(String(destructiveReason('drop table t')), /starts with "drop"/);
  assert.match(String(destructiveReason('update t set a = 1')), /starts with "update"/);
  // The first word is the innocent half here — reporting it would describe the
  // query as a select while blocking it as a write.
  assert.match(String(destructiveReason('select 1; drop table t')), /more than one statement/);
  assert.match(String(destructiveReason('with x as (select 1) delete from t')), /contains "delete"/);
});

test('comments and literals cannot hide or fake a write', () => {
  // A semicolon inside a string is not a statement separator.
  assert.equal(destructiveReason("select * from t where note = 'a;b'"), null);
  // Nor is a keyword inside one a write.
  assert.equal(destructiveReason("select * from t where note = 'drop table x'"), null);
  // A quote inside a comment must not open a string.
  assert.equal(destructiveReason("select * from t -- it's fine\n"), null);
  // A quoted identifier that happens to be a keyword is still an identifier.
  assert.equal(destructiveReason('select "update" from t'), null);
  // Underscored column names are not keywords.
  assert.equal(destructiveReason('select create_date, update_time from t'), null);
  // But a real trailing statement after a comment still counts.
  assert.match(String(destructiveReason('select 1 /* x */ ; drop table t')), /more than one statement/);
});

test('hasMultipleStatements ignores a single trailing semicolon', () => {
  assert.equal(hasMultipleStatements('select 1;'), false);
  assert.equal(hasMultipleStatements('select 1;   \n'), false);
  assert.equal(hasMultipleStatements('select 1; select 2'), true);
  assert.equal(hasMultipleStatements("select ';'"), false);
});

test('a dollar-quoted string cannot smuggle a second statement past Safe Mode', () => {
  // The scanner used to enter a string at the `'` INSIDE the dollar quote and
  // consume everything to the next one, swallowing the `;` and the DROP with
  // it. What survived looked like a single select with no write keyword, so
  // Safe Mode allowed it; DuckDB reads three statements.
  const sql = `select $a$'$a$ as c; drop table t; select '1'`;
  assert.ok(
    destructiveReason(sql) !== null || hasMultipleStatements(sql),
    'a dollar-quoted string hid a DROP from the scanner'
  );
});

test('an ordinary dollar-quoted literal is still allowed', () => {
  assert.equal(destructiveReason(`select $tag$ drop table t $tag$ as note`), null);
  assert.equal(destructiveReason(`select $$ delete everything $$ as note`), null);
});
