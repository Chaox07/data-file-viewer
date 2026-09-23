import { QueryPolicyError, QUERY_LIMITS, validateSqlSize } from './queryPolicy';
import type { DetectedTableFilter } from './duckdbConnection';

const operators = new Set(['contains', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between', 'isBlank', 'isNotBlank']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
function reject(): never { throw new QueryPolicyError('Invalid or oversized query request.'); }

export function validateTableFilters(filters: unknown, sort: unknown, limit: unknown): asserts filters is DetectedTableFilter[] {
  if (!Array.isArray(filters) || filters.length > QUERY_LIMITS.filters || !integer(limit, 0, 100_000)) reject();
  for (const filter of filters) {
    if (!record(filter) || !text(filter.column) || !operators.has(String(filter.operator)) ||
      (filter.value !== undefined && !text(filter.value, QUERY_LIMITS.filterChars)) ||
      (filter.valueTo !== undefined && !text(filter.valueTo, QUERY_LIMITS.filterChars))) reject();
    if (Object.keys(filter).some(key => !['column', 'operator', 'value', 'valueTo'].includes(key))) reject();
  }
  if (sort !== undefined && (!record(sort) || !text(sort.column) || !['asc', 'desc'].includes(String(sort.direction)) ||
    Object.keys(sort).some(key => !['column', 'direction'].includes(key)))) reject();
}

/** Validate untrusted transport values before any native/file operation. */
export function validateQueryMessage(message: unknown): asserts message is Record<string, unknown> & { command: string } {
  if (!record(message) || !text(message.command, 80)) reject();
  let encoded: string;
  try { encoded = JSON.stringify(message); } catch { return reject(); }
  if (Buffer.byteLength(encoded) > 512 * 1024 || Object.hasOwn(message, '__proto__') || Object.hasOwn(message, 'constructor') || Object.hasOwn(message, 'prototype')) reject();
  if (message.requestId !== undefined && !integer(message.requestId, 1, Number.MAX_SAFE_INTEGER)) reject();
  if (message.generation !== undefined && !integer(message.generation, 0, Number.MAX_SAFE_INTEGER)) reject();
  switch (message.command) {
    case 'ready': case 'cancelQuery': case 'diffQuery': return;
    case 'queryCatalog':
      if (message.cursor !== undefined && !integer(message.cursor, 0, 1_000_000)) reject();
      return;
    case 'queryTarget': case 'queryTargetSql':
      if (!text(message.targetId, 128) || !integer(message.generation, 0, Number.MAX_SAFE_INTEGER)) reject();
      return;
    case 'runQuery':
      validateSqlSize(message.sql);
      if (message.sheetPreview !== undefined && !text(message.sheetPreview)) reject();
      return;
    case 'sortQuery':
      if (!text(message.column) || !['asc', 'desc'].includes(String(message.direction))) reject();
      return;
    case 'runCombinedQuery': if (!text(message.table)) reject(); return;
    case 'toggleSafeMode':
      if ([message.safeMode, message.backupBeforeWrite, message.checkForChanges].some(value => typeof value !== 'boolean')) reject();
      return;
    case 'columnStats':
      if (!text(message.column) || !['numeric', 'datetime', 'other'].includes(String(message.statsKind)) ||
        (message.limit !== undefined && !integer(message.limit, 1, 1000))) reject();
      return;
    case 'toggleLiveRefresh':
      if (typeof message.enabled !== 'boolean') reject();
      if (message.intervalMs !== undefined && !integer(message.intervalMs, 250, 86_400_000)) reject();
      return;
    case 'setLiveRefreshInterval': if (!integer(message.intervalMs, 250, 86_400_000)) reject(); return;
    case 'chartQuery':
      if (!text(message.xColumn) || typeof message.xIsText !== 'boolean' ||
        (message.xIsCategory !== undefined && typeof message.xIsCategory !== 'boolean') ||
        !Array.isArray(message.yColumns) || !message.yColumns.length || message.yColumns.length > 100 || !message.yColumns.every(value => text(value))) reject();
      return;
    case 'sheetTableQuery': case 'sheetTableStats': case 'sheetTableChart': case 'sheetTableSql':
      if (!text(message.table) || (message.column !== undefined && !text(message.column))) reject();
      validateTableFilters(message.filters, message.sort, message.limit);
      return;
    case 'updateCell':
      if (!text(message.column) || !record(message.rowValues) || Object.keys(message.rowValues).length > 10_000) reject();
      for (const value of [...Object.values(message.rowValues), message.newValue]) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) reject();
      }
      return;
    default: reject();
  }
}
