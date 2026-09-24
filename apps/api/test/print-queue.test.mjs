import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('only one batch is created under concurrent requests; confirmation releases the next four',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const schema = `queue_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
    const admin = await pool.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}",public`);
      for (const name of (await readdir(new URL('../../../db/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
        await admin.query(await readFile(new URL(`../../../db/${name}`, import.meta.url), 'utf8'));
      }
      for (let n = 0; n < 9; n++) {
        await admin.query(`INSERT INTO orders(id,access_hash,customer_name,email,address_line1,postal_code,city,price_lovelace,network,status,tx_hash,paid_at)
          VALUES($1,'hash','Customer','test@example.com','Street','10115','Berlin',5000000,'cardano:preprod','PAID',$2,now())`,
        [randomUUID(), n.toString(16).padStart(64, '0')]);
      }
      const call = async (confirmation = null) => {
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO "${schema}",public`);
          return (await client.query('SELECT * FROM advance_print_queue($1,$2)', [confirmation, 4])).rows;
        } finally { client.release(); }
      };
      const responses = await Promise.all(Array.from({ length: 12 }, () => call()));
      const created = responses.flat().filter(r => r.batch_id);
      assert.equal(created.length, 1);
      assert.equal(created[0].batch_size, 4);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM orders WHERE status='BATCHED'")).rows[0].n, 4);
      await assert.rejects(() => call(created[0].batch_id), /batch is not complete/);

      await admin.query("UPDATE print_batches SET status='PRINTED' WHERE id=$1", [created[0].batch_id]);
      await admin.query("UPDATE orders SET status='PRINTED' WHERE batch_id=$1", [created[0].batch_id]);
      const next = (await call(created[0].batch_id))[0];
      assert.equal(next.batch_size, 4);
      assert.notEqual(next.batch_id, created[0].batch_id);
      assert.equal((await admin.query('SELECT confirmed_at IS NOT NULL AS confirmed FROM print_batches WHERE id=$1', [created[0].batch_id])).rows[0].confirmed, true);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM orders WHERE status='PAID'")).rows[0].n, 1);

      await admin.query("UPDATE print_batches SET status='PRINTED' WHERE id=$1", [next.batch_id]);
      await admin.query("UPDATE orders SET status='PRINTED' WHERE batch_id=$1", [next.batch_id]);
      const last = (await call(next.batch_id))[0];
      assert.equal(last.batch_size, 1);
      assert.equal((await call())[0], undefined);
    } finally {
      admin.release();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
