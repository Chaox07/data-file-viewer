export interface QueryColumn { name: string; type: string }
export interface QueryCatalogRelation {
  catalog: string;
  schema: string;
  name: string;
  sqlName: string;
  worksheet?: string;
  rawWorksheet: boolean;
  prepared: boolean;
  range?: string;
}
export interface QueryTarget extends QueryCatalogRelation {
  id: string;
  generation: number;
}
export interface QueryTargetDetails { target: QueryTarget; columns: QueryColumn[] }
