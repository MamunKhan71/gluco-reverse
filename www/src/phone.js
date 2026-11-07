// Bangladeshi mobile numbers: 01XXXXXXXXX (operators 013–019), with or without +880 / 880,
// spaces, dashes or Bangla digits. Stored as +8801XXXXXXXXX.

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function bdPhone(raw) {
  const digits = String(raw ?? '')
    .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
    .replace(/\D/g, '');
  const m = digits.match(/^(?:880|0)?(1[3-9]\d{8})$/);
  return m ? `+880${m[1]}` : '';
}

// +8801712345678 → 01712-345678 (how people write it in Bangladesh)
export function prettyPhone(p) {
  const m = String(p ?? '').match(/^\+880(1\d{3})(\d{6})$/);
  return m ? `0${m[1]}-${m[2]}` : String(p ?? '');
}
