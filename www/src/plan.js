// Mother's plan from the prescription dated 03.09.2026.
// Doses and allowed ranges come from the prescription (±2).
// Targets, correction scale and meal rules are SAFE DEFAULTS until the doctor
// confirms them — the app shows a notice while `scaleConfirmed` is false.

export const DEFAULT_PLAN = {
  version: 1,
  updatedAt: 0,
  patient: { name: 'আম্মা', age: 50, heightCm: 147.3, prescriptionDate: '2026-09-03' }, // 4'10"
  doctor: { name: '', phone: '' },
  caregiver: { name: '', phone: '' },
  targets: {
    fasting: [5, 8],
    preMeal: [5, 8],
    postMeal: [4, 10],
    bedtime: [6, 10],
  },
  // Medicines as prescribed (see meds.js). New users start empty and add their own;
  // insulin cards fill `doses`, other medicines fill `tablets`.
  meds: [],
  doses: [],
  tablets: [],
  snackAt: '17:00',
  // Before-meal reading (mmol/L) → change to that meal's Actrapid.
  correctionScale: [
    { from: 3.9, to: 5.1, delta: -2 },
    { from: 5.1, to: 14, delta: 0 },
    { from: 14, to: 99, delta: 2 },
  ],
  mealRules: { small: -2, none: 'skip' },
  basalRule: { everyDays: 3, minReadings: 3, step: 2 },
  scaleConfirmed: false,
  // Food: aim ~1300 kcal, never above 1500; menu aims for sugar 7–8 before meals, ≤10 two hours after.
  diet: { kcalTarget: 1300, kcalMax: 1500, riceCupsPerMeal: 1.5, lastReviewedWeight: 64, startWeight: 64, glucoseTarget: [7, 8], postMealMax: 10 },
};
