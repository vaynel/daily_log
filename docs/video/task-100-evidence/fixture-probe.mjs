// Independent proof of the preserved uniqueness boundary on the injected test DB.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
const schema=`qa100_${randomBytes(6).toString('hex')}`;
await c.connect();
try {
 await c.query(`CREATE SCHEMA ${schema}`);
 await c.query(`SET search_path TO ${schema}`);
 const dir='apps/server/src/db/migrations';
 for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await c.query(readFileSync(`${dir}/${f}`,'utf8'));
 const insert="INSERT INTO interviews(id,owner_id,life_date,started_at,status) VALUES($1,$2,'2030-01-01',now(),'CONFIRMED')";
 await c.query(insert,[randomUUID(),'fixture']);
 await assert.rejects(c.query(insert,[randomUUID(),'fixture']), e=>e.code==='23505' && e.constraint==='interviews_owner_id_life_date_key');
 console.log('PASS old shared owner/date: expected 23505 interviews_owner_id_life_date_key');
 for(let n=0;n<2;n++){const id=randomUUID();await c.query(insert,[id,`quality-stage-${id}`]);}
 assert.equal((await c.query('SELECT count(*)::int n FROM interviews')).rows[0].n,3);
 console.log('PASS isolated owner UUID: both cases insert; original unique constraint retained');
 assert.equal((await c.query('SELECT 1 AS n')).rows[0].n,1);
} finally {await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await c.end();}
