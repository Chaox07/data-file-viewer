import type { QueryTarget } from './queryCatalog';

export interface QueryTargetGroup {
  label: string;
  options: { id: string; label: string }[];
}

/**
 * The Query table picker's contents.
 *
 * With a worksheet open, only that sheet is listed: its raw grid under
 * "Worksheet", its detected tables under "Tables". A table on another sheet
 * cannot be outlined on the grid in front of you, so listing it only invites a
 * choice that shows nothing. Without an open worksheet (a .duckdb, a .sqlite,
 * or a workbook before its first preview) the list is grouped as it always was.
 */
export function groupQueryTargets(targets: Iterable<QueryTarget>, openSheet?: string): QueryTargetGroup[] {
  const all = [...targets];
  const raw = openSheet === undefined ? undefined : all.find((t) => t.rawWorksheet && t.name === openSheet);
  if (raw) {
    const prefix = `${raw.name} · `;
    const tables = all
      .filter((t) => !t.rawWorksheet && t.worksheet === raw.name)
      .map((t) => {
        const name = t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name;
        return { id: t.id, label: `${name}${t.range ? ` — ${t.range}` : ''}` };
      });
    const groups: QueryTargetGroup[] = [
      { label: 'Worksheet', options: [{ id: raw.id, label: `${raw.name} — whole sheet (A, B, C…)` }] },
    ];
    if (tables.length > 0) groups.push({ label: 'Tables', options: tables });
    return groups;
  }

  const groups = new Map<string, QueryTargetGroup>();
  for (const target of all) {
    const groupName = target.worksheet ?? `${target.catalog}.${target.schema}`;
    let group = groups.get(groupName);
    if (!group) {
      group = { label: groupName, options: [] };
      groups.set(groupName, group);
    }
    const label = target.rawWorksheet
      ? `${target.name} — Raw worksheet (A, B, C…)${target.prepared ? '' : ' — not prepared'}`
      : `${target.name}${target.range ? ` — ${target.range}` : ''}`;
    group.options.push({ id: target.id, label });
  }
  return [...groups.values()];
}
