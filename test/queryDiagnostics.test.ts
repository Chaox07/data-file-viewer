import assert from 'node:assert/strict';
import test from 'node:test';
import { queryDiagnostic } from '../src/queryDiagnostics';

test('diagnostics preserve categories without exposing echoed rows, SQL, paths or credentials', () => {
  const sentinel = 'SYNTHETIC_PRIVATE_VALUE';
  for (const prefix of ['Conversion Error: Could not convert', 'Parser Error:', 'Binder Error: Referenced column not found', 'unknown failure']) {
    const diagnostic = queryDiagnostic(new Error(`${prefix} ${sentinel} /private/${sentinel} https://user:${sentinel}@example.test/?token=${sentinel}\nLINE 3: select '${sentinel}'`));
    assert.ok(!JSON.stringify(diagnostic).includes(sentinel));
  }
  assert.equal(queryDiagnostic(new Error('Parser Error: syntax\nLINE 3: secret')).line, 3);
  assert.equal(queryDiagnostic(new Error('interrupt')).category, 'cancelled');
});

test('type guidance distinguishes text comparisons and raw worksheet columns', () => {
  assert.match(queryDiagnostic(new Error('Binder Error: Cannot compare values of type VARCHAR and type INTEGER_LITERAL')).message, /CAST\(column AS DATE\)/);
  assert.match(queryDiagnostic(new Error('Binder Error: Cannot compare values of type DATE and type INTEGER_LITERAL')).message, /numeric year is not a date literal/);
  assert.match(queryDiagnostic(new Error('Binder Error: Referenced column not found'), true).message, /detected table/);
});
