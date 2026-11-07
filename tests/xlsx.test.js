import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeXlsx } from '../www/src/xlsx.js';

test('xlsx: a valid zip with the workbook parts and our cells', () => {
  const bytes = makeXlsx([
    { name: 'Readings', rows: [['Date', 'Sugar'], ['2026-11-01', 6.2], ['2026-11-02', 'আম্মা <ok> & fine']], widths: [12, 8] },
    { name: 'Insulin', rows: [['Slot', 'Units'], ['Breakfast', 16]] },
  ]);
  assert.equal(bytes[0], 0x50); // "PK"
  assert.equal(bytes[1], 0x4b);
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'r.xlsx');
  writeFileSync(file, bytes);
  // the zip opens and lists every part
  const list = execFileSync('unzip', ['-l', file]).toString();
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml']) assert.ok(list.includes(part), part);
  const sheet1 = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml']).toString();
  assert.ok(sheet1.includes('<v>6.2</v>'));
  assert.ok(sheet1.includes('আম্মা &lt;ok&gt; &amp; fine'));
  const wb = execFileSync('unzip', ['-p', file, 'xl/workbook.xml']).toString();
  assert.ok(wb.includes('name="Readings"') && wb.includes('name="Insulin"'));
  // unzip -t checks every CRC
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  readFileSync(file);
});
