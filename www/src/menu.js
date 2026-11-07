// Daily menu built from easy dishes the family can cook with what is at home.
import { FOOD } from './foods.js';
import { RECIPES, RECIPE, fruitSnack } from './recipes.js';

const ADD_IDEAS = ['lal_shak', 'lau', 'potol', 'korola', 'egg', 'roti', 'small_fish', 'peyara', 'tok_doi', 'red_rice', 'palong', 'mug_dal', 'chola', 'oats'];
const FALLBACK_VEG = ['lau_ghonto', 'potol_bhaji', 'lal_shak'];
const FISH = new Set(['rui', 'katla', 'pangas', 'tilapia', 'ilish', 'small_fish', 'shrimp']);
const RED_MEAT = new Set(['beef', 'mutton']);

const rot = (list, n) => (list.length ? list[((n % list.length) + list.length) % list.length] : null);
const isRiceDish = (id) => id === 'plain_rice' || id === 'red_rice';

export const recipeOf = (id) => (id.startsWith('fruit:') ? fruitSnack(id.slice(6)) : RECIPE[id]);

// Calories of one dish at a given scale.
export function dishKcal(id, scale = 1) {
  const r = recipeOf(id);
  return Object.entries(r.items).reduce((s, [f, q]) => s + FOOD[f].kcal * q * scale, 0);
}

// All foods (catalogue ids → portions) in a list of dishes.
export function dishesToItems(dishes) {
  const items = {};
  for (const d of dishes) for (const [f, q] of Object.entries(recipeOf(d.id).items)) items[f] = Math.round(((items[f] ?? 0) + q * d.scale) * 100) / 100;
  return items;
}

function available(home) {
  const ok = (r) => r.need.every((f) => home.has(f));
  const of = (role) => RECIPES.filter((r) => r.role === role && ok(r)).map((r) => r.id);
  const mains = of('main');
  return {
    fish: mains.filter((id) => FISH.has(RECIPE[id].need[0])),
    lean: mains.filter((id) => ['chicken', 'egg'].includes(RECIPE[id].need[0])),
    red: mains.filter((id) => RED_MEAT.has(RECIPE[id].need[0])),
    veg: of('veg'),
    dal: of('dal'),
    bfast: of('bfast'),
    snack: of('snack'),
    carb: of('carb'),
    fruits: [...home].filter((f) => FOOD[f]?.group === 'fruit' && FOOD[f].rating === 'good'),
  };
}

// Dishes of the same kind that could replace `id` (home-available first, then others).
export function alternativesFor(homeIds, id) {
  const home = new Set(homeIds);
  const r = recipeOf(id);
  if (r.role === 'snack') {
    const a = available(home);
    return [...a.fruits.map((f) => `fruit:${f}`), ...a.snack].filter((x) => x !== id);
  }
  const same = RECIPES.filter((x) => x.role === r.role && x.id !== id && x.id !== 'dal_small');
  const ok = (x) => x.need.every((f) => home.has(f));
  return [...same.filter(ok), ...same.filter((x) => !ok(x) && r.role === 'veg')].map((x) => x.id);
}

// opts: riceCups, day (rotation), kcalTarget, carbSteps {slot: n}, eaten {slot: kcal}, swaps {'slot:i': recipeId}
// Returns { meals: { slot: [{ id, scale, extra }] }, kcal, tips, limits, addIdeas, shopping }.
export function suggestMenu(homeIds, { riceCups = 1.5, day = 0, kcalTarget = 0, carbSteps = {}, eaten = {}, swaps = {} } = {}) {
  const home = new Set(homeIds);
  const a = available(home);
  const dish = (id, scale = 1) => ({ id, scale, extra: !recipeOf(id).need.every((f) => home.has(f)) });

  let veg = a.veg;
  if (veg.length < 3) veg = [...veg, ...FALLBACK_VEG.filter((v) => !veg.includes(v))];
  const [vegB, vegL, vegD] = [rot(veg, day), rot(veg, day + 1), rot(veg, day + 2)];
  const mainCarb = home.has('red_rice') ? 'red_rice' : 'plain_rice';
  const dal = rot(a.dal, day) ?? 'masur_dal';

  // Breakfast: roti (or khichuri / chira-doi / oats) + vegetable + egg (or a little dal).
  const bCarb = home.has('roti')
    ? dish('roti', 2)
    : a.carb.includes('veg_khichuri')
      ? dish('veg_khichuri')
      : a.carb.includes('chira_doi')
        ? dish('chira_doi')
        : a.carb.includes('oats_savory')
          ? dish('oats_savory')
          : dish('roti', 2);
  const bProtein = home.has('egg') ? dish(rot(['boiled_egg', 'veg_omelette'], day)) : home.has('dal') ? dish('dal_small') : dish('boiled_egg');
  const breakfast = bCarb.id === 'veg_khichuri' ? [bCarb, bProtein] : [bCarb, dish(vegB), bProtein];

  // Lunch: rice + fish (red meat on every 4th day) + dal + vegetable.
  const lunchMain = (a.red.length && day % 4 === 0 ? a.red[0] : null) ?? rot(a.fish, day) ?? rot(a.lean, day) ?? 'egg_curry';
  const lunch = [dish(mainCarb, riceCups), dish(lunchMain), dish(dal), dish(vegL)];

  // Snack: tea without sugar + fruit, or another light snack.
  const snackPool = [...a.fruits.map((f) => `fruit:${f}`), ...a.snack];
  const snack = [dish(rot(snackPool, day) ?? 'fruit:peyara')];

  // Dinner: smaller carb (roti on alternate days) + a different main + vegetable + salad.
  const dCarb = home.has('roti') && day % 2 ? dish('roti', 2) : dish(mainCarb, Math.max(1, riceCups - 0.5));
  const dinnerMain = rot([...a.lean, ...a.fish].filter((x) => x !== lunchMain), day + 1) ?? 'egg_curry';
  const dinner = [dCarb, dish(dinnerMain), dish(vegD), dish('salad')];

  const meals = { breakfast, lunch, snack, dinner };

  for (const [key, id] of Object.entries(swaps)) {
    const [slot, i] = key.split(':');
    const cur = meals[slot]?.[i];
    if (cur && recipeOf(id)) meals[slot][i] = { ...dish(id), scale: recipeOf(id).role === 'carb' && recipeOf(cur.id).role === 'carb' ? cur.scale : 1 };
  }

  // Portions learned from her after-meal sugar.
  for (const [slot, step] of Object.entries(carbSteps)) {
    const c = meals[slot]?.[0];
    if (!c || !step || recipeOf(c.id).role !== 'carb') continue;
    if (c.id === 'roti') c.scale = Math.max(1, c.scale + step);
    else if (isRiceDish(c.id)) c.scale = Math.max(0.5, c.scale + step * 0.5);
    else c.scale = Math.max(0.5, c.scale + step * 0.25);
  }

  const mealKcal = (slot) => (slot in eaten ? eaten[slot] : meals[slot].reduce((s, d) => s + dishKcal(d.id, d.scale), 0));
  const total = () => Object.keys(meals).reduce((s, slot) => s + mealKcal(slot), 0);
  // Over the target: trim rice in meals not yet eaten — dinner first, then lunch.
  const riceAt = (slot, min) => {
    const c = meals[slot][0];
    return !(slot in eaten) && isRiceDish(c.id) && c.scale - 0.5 >= min ? c : null;
  };
  for (let c; kcalTarget && total() > kcalTarget && (c = riceAt('dinner', 0.5) ?? riceAt('lunch', Object.keys(eaten).length ? 0.5 : 1)); ) c.scale -= 0.5;

  const tips = [];
  if (home.has('potato')) tips.push('potato');
  if (['sugar', 'gur', 'tea_sugar', 'sweet', 'mishti_doi'].some((x) => home.has(x))) tips.push('sugar');
  if (a.red.length || home.has('beef') || home.has('mutton')) tips.push('red_meat');
  if (home.has('shutki')) tips.push('shutki');
  if (home.has('paratha')) tips.push('paratha');
  if (['banana', 'mango', 'kathal', 'lichu'].some((x) => home.has(x))) tips.push('sweet_fruit');
  if (!home.has('red_rice') && home.has('rice')) tips.push('red_rice');

  const shopping = [
    ...new Set(
      Object.values(meals)
        .flat()
        .flatMap((d) => Object.keys(recipeOf(d.id).items))
        .filter((f) => !home.has(f) && !['oil', 'tea_plain', 'salad'].includes(f)),
    ),
  ];

  return {
    meals,
    kcal: Math.round(total()),
    tips,
    limits: homeIds.filter((id) => FOOD[id] && FOOD[id].rating !== 'good'),
    addIdeas: ADD_IDEAS.filter((id) => !home.has(id)).slice(0, 6),
    shopping,
  };
}

// --- "What do I have right now?" ----------------------------------------------

// Portion range per ingredient (catalogue portions) and the step used to grow it.
const RANGE = {
  rice: [0.5, 1, 0.5], red_rice: [0.5, 1, 0.5], roti: [1, 2, 1], chira: [1, 1, 1], oats: [1, 1, 1], muri: [1, 1, 1],
  potato: [0.5, 1, 0.5], sweet_potato: [0.5, 1, 0.5],
  dal: [0.5, 1, 0.5], mug_dal: [0.5, 1, 0.5], chola: [0.5, 1, 0.5],
  egg: [1, 2, 1], chicken: [0.5, 1, 0.5], beef: [0.5, 1, 0.5], mutton: [0.5, 1, 0.5],
  rui: [1, 1.5, 0.5], katla: [1, 1.5, 0.5], pangas: [1, 1.5, 0.5], tilapia: [1, 1.5, 0.5], ilish: [1, 1, 1], small_fish: [1, 1, 1], shrimp: [1, 1.5, 0.5],
};
const VEG_RANGE = [1, 2, 1];
export const MEAL_SHARE = { breakfast: 0.25, lunch: 0.35, snack: 0.1, dinner: 0.3 };

// Builds one meal from the ingredients on hand, sized to `budget` kcal:
// everything starts at its smallest portion, then vegetables, protein, dal and
// finally rice/roti grow one step at a time while the meal still fits.
export function pantryMeal(haveIds, budget) {
  const have = haveIds.filter((id) => FOOD[id] && FOOD[id].rating !== 'avoid' && id !== 'shutki');
  const carb = have.find((id) => ['rice', 'red_rice', 'roti', 'chira', 'oats', 'muri'].includes(id)) ?? have.find((id) => ['potato', 'sweet_potato'].includes(id));
  const animal = have.filter((id) => FISH.has(id) || ['egg', 'chicken', 'beef', 'mutton'].includes(id)).slice(0, 1);
  const pulse = have.filter((id) => ['dal', 'mug_dal', 'chola'].includes(id)).slice(0, 1);
  const veg = have.filter((id) => FOOD[id].group === 'veg' && id !== 'salad').slice(0, 2);
  const range = (id) => (FOOD[id].group === 'veg' ? VEG_RANGE : RANGE[id] ?? [1, 1, 1]);

  const qty = {};
  for (const id of [carb, ...animal, ...pulse, ...veg].filter(Boolean)) qty[id] = range(id)[0];
  const oil = Object.keys(qty).filter((id) => id !== carb).length; // ~1 tsp per cooked dish
  const kcal = () => Object.entries(qty).reduce((s, [id, q]) => s + FOOD[id].kcal * q, 0) + oil * FOOD.oil.kcal;

  for (const id of [...veg, ...animal, ...pulse, carb].filter(Boolean)) {
    const [, max, step] = range(id);
    while (qty[id] + step <= max && kcal() + FOOD[id].kcal * step <= budget) qty[id] += step;
  }
  return { items: qty, oil, kcal: Math.round(kcal()), budget: Math.round(budget), over: kcal() > budget, missing: { carb: !carb, protein: !animal.length && !pulse.length, veg: !veg.length } };
}

// A dish from the catalogue that cooks this ingredient (for "how to cook it").
export function recipeFor(foodId) {
  return RECIPES.find((r) => r.need[0] === foodId && r.role !== 'bfast') ?? RECIPES.find((r) => r.need.includes(foodId));
}
