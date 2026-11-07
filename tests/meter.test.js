import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sfloat, parseMeasurement, parseContext, racpRequest, racpResult, hexToBytes, bytesToHex } from '../www/src/meter.js';

test('SFLOAT decoding', () => {
  assert.equal(sfloat(0x4a, 0xc0), 74 * 1e-4); // 0.0074 mol/L
  assert.equal(sfloat(0x85, 0xb0), 133 * 1e-5); // 0.00133 kg/L
  assert.ok(Number.isNaN(sfloat(0xff, 0x07)));
});

test('glucose measurement in mmol/L with time offset and context flag', () => {
  // flags: time offset + concentration + mol/L + context follows
  const b = [0x17, 0x2a, 0x00, 0xea, 0x07, 11, 2, 7, 45, 10, 0x00, 0x00, 0x4a, 0xc0, 0x11];
  const r = parseMeasurement(b);
  assert.equal(r.seq, 42);
  assert.equal(r.mmol, 7.4);
  assert.equal(r.hasContext, true);
  assert.equal(new Date(r.ts).getHours(), 7);
  assert.equal(new Date(r.ts).getFullYear(), 2026);
});

test('glucose measurement in mg/dL is converted to mmol/L', () => {
  const b = [0x02, 0x05, 0x00, 0xea, 0x07, 11, 2, 13, 0, 0, 0x85, 0xb0, 0x11];
  assert.equal(parseMeasurement(b).mmol, 7.4); // 133 mg/dL
});

test('time offset shifts the reading time', () => {
  const base = [0x07, 0x01, 0x00, 0xea, 0x07, 11, 2, 8, 0, 0];
  const plus30 = parseMeasurement([...base, 30, 0, 0x4a, 0xc0, 0x11]);
  const none = parseMeasurement([...base, 0, 0, 0x4a, 0xc0, 0x11]);
  assert.equal(plus30.ts - none.ts, 30 * 60000);
});

test('context meal marker', () => {
  assert.deepEqual(parseContext([0x02, 0x2a, 0x00, 0x01]), { seq: 42, meal: 1 });
  assert.deepEqual(parseContext([0x03, 0x2a, 0x00, 0x01, 0x10, 0xe0, 0x03]), { seq: 42, meal: 3 });
  assert.deepEqual(parseContext([0x00, 0x2a, 0x00]), { seq: 42, meal: null });
});

test('RACP request and response', () => {
  assert.deepEqual(racpRequest(null), [1, 1]);
  assert.deepEqual(racpRequest(300), [1, 3, 1, 0x2c, 0x01]);
  assert.equal(racpResult([0x06, 0x00, 0x01, 0x01]), 'done');
  assert.equal(racpResult([0x06, 0x00, 0x01, 0x06]), 'none');
  assert.equal(racpResult([0x06, 0x00, 0x01, 0x02]), 'error');
  assert.equal(racpResult([0x05, 0x01, 0x00]), null);
});

test('hex helpers round-trip', () => {
  assert.equal(bytesToHex([1, 3, 1, 0x2c, 1]), '0103012c01');
  assert.deepEqual(hexToBytes('01 03 01 2c 01'), [1, 3, 1, 0x2c, 1]);
});
