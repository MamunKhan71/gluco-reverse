import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bdPhone, prettyPhone } from '../www/src/phone.js';

test('Bangladeshi mobile numbers are accepted in common forms', () => {
  for (const raw of ['01712345678', '+8801712345678', '8801712345678', '017 1234 5678', '01712-345678', '০১৭১২৩৪৫৬৭৮']) {
    assert.equal(bdPhone(raw), '+8801712345678', raw);
  }
  assert.equal(bdPhone('01312345678'), '+8801312345678');
  assert.equal(bdPhone('01912345678'), '+8801912345678');
});

test('wrong numbers are refused', () => {
  for (const raw of ['', '0171234567', '017123456789', '01212345678', '02712345678', '+15551234567', 'abc']) {
    assert.equal(bdPhone(raw), '', raw);
  }
});

test('pretty phone', () => {
  assert.equal(prettyPhone('+8801712345678'), '01712-345678');
});
