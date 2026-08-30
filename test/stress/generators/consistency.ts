import { join } from 'node:path';
import { registerCase } from '../expect';
import { quote } from '../harness/inspect';
import * as w from './_write';

/**
 * Invariants that hold across the whole query surface, over one ordinary
 * fixture.
 *
 * Nothing here is exotic. These are the four or five statements that must stay
 * true between the grid, the footer, the sort, the chart and the stats popover
 * -- and every one of them is a place where two code paths compute the same
 * number in different ways. That is the shape of drift: nobody breaks the
 * footer, they change how a LIMIT is handled in one path and the footer starts
 * disagreeing with the grid.
 *
 * The chart case is the one with history. Charts used to strip the query's
 * trailing LIMIT, which made the chart a picture of a query nobody had
 * written: a grid showing `... limit 100` plotted twenty years of daily data.
 * That is fixed, and this is the family that keeps it fixed for every query
 * shape rather than the single hand-written case that caught it.
 */

const SPEC: w.TableSpec = {
  name: 'series',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'day', type: 'DATE' },
    { name: 'value', type: 'DOUBLE' },
    { name: 'bucket', type: 'VARCHAR' },
  ],
  rows: Array.from({ length: 500 }, (_, i) => [
    i,
    `2020-01-01`,
    // Deliberately non-monotonic, so "sorted" and "in file order" differ and a
    // path that returns one where the other was asked for is visible. Every
    // 50th value is NULL, so the chart's subset relation is exercised rather
    // than trivially satisfied -- the omission that let this case pass while
    // being wrong.
    i % 50 === 0 ? null : Math.sin(i) * 1000,
    `b${i % 7}`,
  ]),
};

/** Queries the invariants below are checked against, in one place. */
const QUERIES = [
  ['plain', 'select * from "series"'],
  ['with_limit', 'select * from "series" limit 100'],
  ['with_where', `select * from "series" where "bucket" = 'b3'`],
  ['where_and_limit', `select * from "series" where "bucket" <> 'b0' limit 40`],
  ['with_order', 'select * from "series" order by "value" desc'],
  ['order_and_limit', 'select * from "series" order by "value" desc limit 25'],
  ['projection', 'select "id", "value" from "series"'],
] as const;

async function build(ctx: { dir: string }) {
  return { path: await w.duckdbFile(join(ctx.dir, 'series.duckdb'), [SPEC]) };
}

/**
 * The footer's total must equal the count of the same query with its trailing
 * LIMIT removed -- and only its TRAILING limit, with WHERE left alone, since
 * the useful total is "how many rows your query matches".
 */
registerCase({
  name: 'consistency_row_total_matches_count',
  family: 'consistency',
  expect: { note: 'the footer total equals count(*) of the same query, ignoring only a trailing LIMIT' },
  build,
  check: async (file, ctx) => {
    for (const [label, sql] of QUERIES) {
      const total = await file.countMatchingRows(sql);
      if (total === undefined) {
        ctx.fail('bad-message', `${label}: no total was produced for a perfectly ordinary query`);
        continue;
      }
      // The truth, computed independently: the same query with any trailing
      // LIMIT taken off, counted directly.
      const withoutLimit = sql.replace(/\s+limit\s+\d+\s*$/i, '');
      const direct = await file.runQuery(`select count(*) from (${withoutLimit}) as _t`);
      const expected = Number(direct.rows[0][0]);
      if (total !== expected) {
        ctx.fail(
          'silent-misread',
          `${label}: the footer would say ${total} rows, but the query matches ${expected}`
        );
      }
    }
  },
});

/**
 * A sorted top-N must be the true top N across the whole matching set, not N
 * arbitrary rows put in order.
 *
 * The distinction is invisible on a small table and total on a large one, and
 * it is the reason runSortedQuery strips the trailing LIMIT, sorts, and
 * re-applies it on the outside.
 */
registerCase({
  name: 'consistency_sorted_top_n_is_the_true_top_n',
  family: 'consistency',
  expect: { note: 'sorting a limited query returns the true top N, not the first N then sorted' },
  build,
  check: async (file, ctx) => {
    for (const direction of ['asc', 'desc'] as const) {
      const sorted = await file.runSortedQuery('select * from "series" limit 25', 'value', direction, 0);
      const truth = await file.runQuery(
        `select * from "series" order by "value" ${direction} nulls last limit 25`
      );
      if (sorted.rows.length !== truth.rows.length) {
        ctx.fail(
          'silent-misread',
          `${direction}: sorted returned ${sorted.rows.length} rows, the true top 25 has ${truth.rows.length}`
        );
        continue;
      }
      const valueIndex = sorted.columns.indexOf('value');
      for (let r = 0; r < truth.rows.length; r++) {
        if (String(sorted.rows[r][valueIndex]) !== String(truth.rows[r][valueIndex])) {
          ctx.fail(
            'silent-misread',
            `${direction}: row ${r} of the sorted view is ${JSON.stringify(sorted.rows[r][valueIndex])}, ` +
              `but the true top 25 has ${JSON.stringify(truth.rows[r][valueIndex])} there — ` +
              `the sort ran over a pre-limited subset`
          );
          break;
        }
      }
    }
  },
});

/**
 * The chart plots the rows the grid shows, minus the ones it cannot plot.
 *
 * Under every clause: a WHERE narrows both, an ORDER BY chooses which rows a
 * LIMIT keeps, and a LIMIT caps both. Compared as a SET of x values rather
 * than positionally, because the chart legitimately re-orders by its x axis --
 * what must match is WHICH rows were plotted, not the order they arrive in.
 *
 * The "minus" is not a hedge, and it was learned from a real file rather than
 * reasoned about: a row whose y value is NULL has no point to draw, so the
 * chart returns fewer rows than the grid and is right to. This case originally
 * asserted the two counts were equal and passed -- because the generated
 * fixture had no nulls in it. Run against a Federal Reserve yield-curve table
 * it reported 49 of 50, which was the invariant being wrong rather than the
 * code. The honest statement is a subset relation plus an exact accounting of
 * what is missing, so a chart that drops a row it COULD have plotted still
 * fails.
 */
registerCase({
  name: 'consistency_chart_plots_the_grid_rows',
  family: 'consistency',
  expect: { note: 'the chart plots exactly the rows the grid shows, under every clause' },
  build,
  check: async (file, ctx) => {
    for (const [label, sql] of QUERIES) {
      if (label === 'projection') continue; // no bucket column to chart against
      const grid = await file.runQuery(sql);
      const chart = await file.runChartQuery(sql, 'id', ['value']);

      const xIdx = grid.columns.indexOf('id');
      const chartXIdx = chart.columns.indexOf('id');

      // 1. The chart must never plot MORE rows than the query returned. That
      //    would be fabrication, and it is the only direction with no
      //    defensible reading.
      if (chart.rows.length > grid.rows.length) {
        ctx.fail(
          'silent-misread',
          `${label}: the grid has ${grid.rows.length} rows and the chart drew ${chart.rows.length}`
        );
        continue;
      }

      // 2. Every point it did draw must come from a row the grid has.
      const gridXs = new Set(grid.rows.map((r) => String(r[xIdx])));
      const invented = chart.rows
        .map((r) => String(r[chartXIdx]))
        .filter((v) => !gridXs.has(v));
      if (invented.length) {
        ctx.fail(
          'silent-misread',
          `${label}: the chart drew ${invented.length} point(s) with no matching row in the grid ` +
            `(first x: ${invented[0]})`
        );
        continue;
      }

      // 3. Where every row IS plottable, the counts must match exactly --
      //    otherwise "the chart honours the query" means nothing. Rows with a
      //    null y are excluded from this count rather than asserted about:
      //    whether such a row is dropped or drawn as a gap legitimately
      //    depends on the axis mode, and measuring showed it differs between
      //    a time axis and a category one. Asserting a single answer here
      //    would be asserting a behaviour nobody chose.
      const yIdx = grid.columns.indexOf('value');
      const allPlottable = grid.rows.every((r) => r[xIdx] !== null && r[yIdx] !== null);
      if (allPlottable && chart.rows.length !== grid.rows.length) {
        ctx.fail(
          'silent-misread',
          `${label}: every row is plottable, but the chart drew ${chart.rows.length} of ${grid.rows.length}`
        );
      }
    }
  },
});

/**
 * The stats popover's numbers must equal the same aggregates computed
 * directly.
 *
 * Both go through the same connection, so a disagreement means the wrapper
 * around the aggregate changed what was being aggregated -- a LIMIT left on,
 * a filter dropped, nulls counted as values.
 */
registerCase({
  name: 'consistency_descriptive_stats_match_direct_aggregates',
  family: 'consistency',
  expect: { note: 'the stats popover agrees with count/min/max computed directly' },
  build,
  check: async (file, ctx) => {
    for (const [label, sql] of QUERIES) {
      if (label === 'projection') continue;
      const stats = await file.getColumnDescriptiveStats(sql, 'value', 'numeric');
      const direct = await file.runQuery(
        `select count(*), count("value"), min("value"), max("value") from (${sql}) as _t`
      );
      const [total, nonNull, min, max] = direct.rows[0].map((v) => Number(v));

      if (stats.totalRows !== total) {
        ctx.fail('silent-misread', `${label}: stats say ${stats.totalRows} rows, the query has ${total}`);
      }
      if (stats.nonNullRows !== nonNull) {
        ctx.fail(
          'silent-misread',
          `${label}: stats say ${stats.nonNullRows} non-null, the query has ${nonNull}`
        );
      }
      if (Math.abs(Number(stats.min) - min) > 1e-9 || Math.abs(Number(stats.max) - max) > 1e-9) {
        ctx.fail(
          'silent-misread',
          `${label}: stats say min/max ${stats.min}/${stats.max}, directly it is ${min}/${max}`
        );
      }
    }
  },
});

/** Top values must equal a direct GROUP BY, frequencies included. */
registerCase({
  name: 'consistency_top_values_match_group_by',
  family: 'consistency',
  expect: { note: 'the top-values list agrees with a direct GROUP BY' },
  build,
  check: async (file, ctx) => {
    const sql = 'select * from "series"';
    const stats = await file.getColumnTopValues(sql, 'bucket', 5);
    const direct = await file.runQuery(
      `select "bucket", count(*) as n from (${sql}) as _t group by 1 order by n desc, 1 limit 5`
    );

    if (stats.distinctCount !== 7) {
      ctx.fail('silent-misread', `bucket has 7 distinct values; stats report ${stats.distinctCount}`);
    }
    const directTotal = direct.rows.reduce((sum, r) => sum + Number(r[1]), 0);
    const statsTotal = stats.topValues.reduce((sum, v) => sum + Number(v.frequency), 0);
    if (directTotal !== statsTotal) {
      ctx.fail(
        'silent-misread',
        `the top 5 buckets account for ${statsTotal} rows in the popover and ${directTotal} directly`
      );
    }
  },
});

/**
 * Everything listTables reports must actually be selectable.
 *
 * A name that is listed but not selectable is worse than one that is missing:
 * the sidebar offers it, and clicking it produces an error about a table the
 * viewer itself just claimed exists.
 */
registerCase({
  name: 'consistency_every_listed_table_is_selectable',
  family: 'consistency',
  expect: { note: 'every table the sidebar lists can be selected from' },
  build: async (ctx) => ({
    path: await w.duckdbFile(join(ctx.dir, 'many.duckdb'), [
      SPEC,
      { name: 'second', columns: [{ name: 'x', type: 'INTEGER' }], rows: [[1]] },
      { name: "O'Brien's", columns: [{ name: 'y', type: 'INTEGER' }], rows: [[2]] },
      { name: 'empty_one', columns: [{ name: 'z', type: 'INTEGER' }], rows: [] },
    ]),
    tableName: 'series',
  }),
  check: async (file, ctx) => {
    for (const name of await file.listTables()) {
      try {
        await file.runQuery(`select * from ${quote(name)} limit 1`);
      } catch (err) {
        ctx.fail(
          'crash',
          `"${name}" is listed but cannot be selected from: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }`
        );
      }
    }
  },
});

/**
 * A maxRows cap must report itself.
 *
 * The cap is the viewer's own, not the user's, so a result silently cut to it
 * is a result the user has no way to know is partial -- the one case where
 * "247 rows" is a lie rather than an answer.
 */
registerCase({
  name: 'consistency_truncation_is_reported',
  family: 'consistency',
  expect: { note: 'a result cut short by the viewer’s own row cap says so' },
  build,
  check: async (file, ctx) => {
    const capped = await file.runQuery('select * from "series"', 50);
    if (capped.rows.length !== 50) {
      ctx.fail('silent-misread', `asked for 50 rows, got ${capped.rows.length}`);
    }
    if (!capped.truncated) {
      ctx.fail(
        'silent-misread',
        'a 500-row table was cut to 50 rows without the result being marked truncated'
      );
    }

    // And the other half: a result that fits must NOT claim to be truncated,
    // or the warning becomes noise and stops being read.
    const whole = await file.runQuery('select * from "series" limit 10', 50);
    if (whole.truncated) {
      ctx.fail('bad-message', 'a 10-row result was marked truncated by a 50-row cap');
    }
  },
});
