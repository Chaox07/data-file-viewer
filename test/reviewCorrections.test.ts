import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {DuckDbFile} from '../src/duckdbConnection';
import {patchCell} from '../src/xlsxWrite';

for(const value of ['007','+007','1e309','1e-400']) {
 test(`review: preserve CSV ${value} beside a decimal`,async()=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'dfv-review-'));const path=join(dir,'values.csv');
  try{await fs.writeFile(path,`x\n${value}\n1.5\n`);const f=await DuckDbFile.open(path);
   try{const r=await f.runQuery('select * from "values"');assert.equal(r.rows[0][0],value);assert.ok(f.openWarnings.length);}finally{f.dispose();}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 });
}

test('review: post-publication stat error does not roll memory back',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'dfv-review-'));const path=join(dir,'values.csv');
 await fs.writeFile(path,'id,x\n1,3\n');const f=await DuckDbFile.open(path);const raw=require('node:fs/promises');const realStat=raw.stat;
 try{const con=(f as any).connection;const real=con.run.bind(con);let copied=false;
 con.run=async(sql:string,...args:any[])=>{const r=await real(sql,...args);if(/^copy /i.test(sql))copied=true;return r;};
 raw.stat=async(p:string,...args:any[])=>{if(copied&&p===path)throw new Error('injected post-publication stat');return realStat(p,...args);};
 assert.equal(await f.updateCell('values','x','42',{id:'1',x:'3'}),1);
 assert.equal(String((await f.runQuery('select x from "values"')).rows[0][0]),'42');assert.match(await fs.readFile(path,'utf8'),/1,42/);
 }finally{raw.stat=realStat;f.dispose();await fs.rm(dir,{recursive:true,force:true});}
});

for(const [stored,expected] of [[' alpha ','alpha'],[' ',''],['',' ']]){
 test(`review: literal text conflict ${JSON.stringify(stored)}`,async()=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'dfv-review-'));const path=join(dir,'values.xlsx');
  const bytes=zipSync({'xl/worksheets/sheet1.xml':strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">${stored}</t></is></c></row></sheetData></worksheet>`)});
  try{await fs.writeFile(path,bytes);await assert.rejects(patchCell({filePath:path,sheetPath:'xl/worksheets/sheet1.xml',columnName:'A',columnNames:['A'],rowOrdinal:1,verbatim:true,expectedCurrent:expected,newValue:'replacement'}));assert.deepEqual(await fs.readFile(path),Buffer.from(bytes));}
  finally{await fs.rm(dir,{recursive:true,force:true});}
 });
}

test('review: failed CSV verification refuses open',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'dfv-review-'));const path=join(dir,'values.csv');
 const {DuckDBConnection}=require('@duckdb/node-api');const real=DuckDBConnection.prototype.runAndReadAll;let injected=false;
 try{await fs.writeFile(path,'x\n1.5\n2.5\n');
 DuckDBConnection.prototype.runAndReadAll=async function(sql:string,...args:any[]){
  if(sql.includes('isfinite') && sql.includes('read_csv')){injected=true;throw new Error('verification unavailable');}
  return real.call(this,sql,...args);
 };
 await assert.rejects(DuckDbFile.open(path),/fidelity verification failed/);assert.ok(injected);
 }finally{DuckDBConnection.prototype.runAndReadAll=real;await fs.rm(dir,{recursive:true,force:true});}
});

test('review: failed saved-file reconciliation blocks the next edit',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'dfv-review-'));const path=join(dir,'values.csv');
 await fs.writeFile(path,'id,x\n1,3\n');const f=await DuckDbFile.open(path);
 try{
  await f.updateCell('values','x','4',{id:'1',x:'3'});
  const con=(f as any).connection;const real=con.run.bind(con);
  con.run=async(sql:string,...args:any[])=>{
   if(sql==='commit' || sql.startsWith('create or replace table'))throw new Error('injected reconciliation failure');
   return real(sql,...args);
  };
  assert.equal(await f.updateCell('values','x','42',{id:'1',x:'4'}),1);
  assert.match(await fs.readFile(path,'utf8'),/1,42/);assert.ok(f.isReadOnly());
  await assert.rejects(f.updateCell('values','x','43',{id:'1',x:'4'}),/read-only/);
  assert.equal((await f.checkEditableSelect('select * from "values"')).editable,false);
 }finally{f.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
