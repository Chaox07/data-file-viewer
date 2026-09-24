export interface QueryColumn { name: string; type: string }
/** 0-based worksheet-grid rectangle, bottom/right exclusive (DetectedSheetTable's coordinates). */
export interface SheetBounds { top: number; bottom: number; left: number; right: number }
export interface QueryCatalogRelation {
  catalog: string;
  schema: string;
  name: string;
  sqlName: string;
  worksheet?: string;
  rawWorksheet: boolean;
  prepared: boolean;
  range?: string;
  /** A detected table's cells, or a prepared raw worksheet's used range. */
  bounds?: SheetBounds;
}
export interface QueryTarget extends QueryCatalogRelation {
  id: string;
  generation: number;
}
export interface QueryTargetDetails { target: QueryTarget; columns: QueryColumn[] }
