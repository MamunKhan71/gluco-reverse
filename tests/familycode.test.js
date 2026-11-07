import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, newFamilyCode, cleanCode, prettyCode } from '../www/src/familycode.js';

test('word list: 256 distinct, plain words', () => {
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256);
  for (const w of WORDS) assert.match(w, /^[A-Z]{3,8}$/);
});

test('new codes look like MANGO-RIVER-427', () => {
  for (let i = 0; i < 200; i++) {
    const c = newFamilyCode();
    assert.match(c, /^[A-Z]{3,8}-[A-Z]{3,8}-[1-9]\d\d$/);
    const [a, b] = c.split('-');
    assert.notEqual(a, b);
    assert.ok(c.length >= 9);
  }
});

test('typed codes are cleaned to the stored form', () => {
  assert.equal(cleanCode('mango river 427'), 'MANGO-RIVER-427');
  assert.equal(cleanCode(' Mango-River-427 '), 'MANGO-RIVER-427');
  assert.equal(cleanCode('MANGORIVER427'), 'MANGO-RIVER-427');
  assert.equal(cleanCode('sun moon 105'), 'SUN-MOON-105');
  assert.equal(cleanCode('abcd-efgh-jkmn'), 'ABCDEFGHJKMN'); // old codes still work
});

test('pretty code', () => {
  assert.equal(prettyCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
  assert.equal(prettyCode('MANGO-RIVER-427'), 'MANGO-RIVER-427');
});
