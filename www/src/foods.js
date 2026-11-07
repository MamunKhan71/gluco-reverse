// Common Bangladeshi foods with one home portion each. kcal/carb are rough
// per-portion estimates — good enough to see a trend, not exact.
// rating: 'good' = eat regularly, 'limit' = measured portion, 'avoid' = rarely.

export const GROUPS = ['carb', 'fish', 'meat', 'dal', 'veg', 'fruit', 'other'];

export const CATALOG = [
  // carbs
  { id: 'rice', group: 'carb', bn: 'ভাত', en: 'Rice', portion: { bn: '১ কাপ', en: '1 cup' }, grams: 160, kcal: 200, carb: 45, rating: 'limit' },
  { id: 'red_rice', group: 'carb', bn: 'লাল চালের ভাত', en: 'Red/brown rice', portion: { bn: '১ কাপ', en: '1 cup' }, grams: 160, kcal: 190, carb: 40, rating: 'good' },
  { id: 'roti', group: 'carb', bn: 'আটার রুটি', en: 'Atta roti', portion: { bn: '১টা', en: '1' }, grams: 40, kcal: 100, carb: 18, rating: 'good' },
  { id: 'paratha', group: 'carb', bn: 'পরোটা', en: 'Paratha', portion: { bn: '১টা', en: '1' }, kcal: 250, carb: 30, rating: 'avoid' },
  { id: 'oats', group: 'carb', bn: 'ওটস', en: 'Oats', portion: { bn: '½ কাপ', en: '½ cup' }, kcal: 150, carb: 27, rating: 'good' },
  { id: 'chira', group: 'carb', bn: 'চিড়া', en: 'Chira', portion: { bn: '½ কাপ', en: '½ cup' }, kcal: 170, carb: 37, rating: 'limit' },
  { id: 'muri', group: 'carb', bn: 'মুড়ি', en: 'Muri', portion: { bn: '১ কাপ', en: '1 cup' }, kcal: 60, carb: 13, rating: 'limit' },
  { id: 'potato', group: 'carb', bn: 'আলু', en: 'Potato', portion: { bn: '১টা মাঝারি', en: '1 medium' }, kcal: 110, carb: 20, rating: 'limit' },
  { id: 'sweet_potato', group: 'carb', bn: 'মিষ্টি আলু', en: 'Sweet potato', portion: { bn: '১টা ছোট', en: '1 small' }, kcal: 100, carb: 23, rating: 'limit' },
  // fish
  { id: 'rui', group: 'fish', bn: 'রুই মাছ', en: 'Rui fish', portion: { bn: '১ টুকরা', en: '1 piece' }, grams: 70, kcal: 120, carb: 0, rating: 'good' },
  { id: 'katla', group: 'fish', bn: 'কাতলা মাছ', en: 'Katla fish', portion: { bn: '১ টুকরা', en: '1 piece' }, grams: 70, kcal: 120, carb: 0, rating: 'good' },
  { id: 'pangas', group: 'fish', bn: 'পাঙ্গাস মাছ', en: 'Pangas fish', portion: { bn: '১ টুকরা', en: '1 piece' }, grams: 80, kcal: 160, carb: 0, rating: 'good' },
  { id: 'tilapia', group: 'fish', bn: 'তেলাপিয়া মাছ', en: 'Tilapia', portion: { bn: '১ টুকরা', en: '1 piece' }, grams: 70, kcal: 110, carb: 0, rating: 'good' },
  { id: 'ilish', group: 'fish', bn: 'ইলিশ মাছ', en: 'Hilsa', portion: { bn: '১ টুকরা', en: '1 piece' }, grams: 70, kcal: 190, carb: 0, rating: 'good' },
  { id: 'small_fish', group: 'fish', bn: 'ছোট মাছ (মলা, কাচকি)', en: 'Small fish', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 110, carb: 0, rating: 'good' },
  { id: 'shrimp', group: 'fish', bn: 'চিংড়ি', en: 'Shrimp', portion: { bn: '½ বাটি', en: '½ bowl' }, kcal: 100, carb: 0, rating: 'good' },
  { id: 'shutki', group: 'fish', bn: 'শুঁটকি', en: 'Dried fish', portion: { bn: '২ চামচ', en: '2 spoons' }, kcal: 90, carb: 0, rating: 'limit' },
  // meat & egg
  { id: 'chicken', group: 'meat', bn: 'মুরগি', en: 'Chicken', portion: { bn: '২ টুকরা', en: '2 pieces' }, grams: 90, kcal: 150, carb: 0, rating: 'good' },
  { id: 'egg', group: 'meat', bn: 'ডিম', en: 'Egg', portion: { bn: '১টা', en: '1' }, grams: 50, kcal: 80, carb: 0, rating: 'good' },
  { id: 'beef', group: 'meat', bn: 'গরুর মাংস', en: 'Beef', portion: { bn: '২ টুকরা', en: '2 pieces' }, grams: 80, kcal: 200, carb: 0, rating: 'limit' },
  { id: 'mutton', group: 'meat', bn: 'খাসির মাংস', en: 'Mutton', portion: { bn: '২ টুকরা', en: '2 pieces' }, grams: 80, kcal: 220, carb: 0, rating: 'limit' },
  // dal
  { id: 'dal', group: 'dal', bn: 'মসুর ডাল', en: 'Masoor dal', portion: { bn: '১ বাটি', en: '1 bowl' }, grams: 200, kcal: 110, carb: 15, rating: 'good' },
  { id: 'mug_dal', group: 'dal', bn: 'মুগ ডাল', en: 'Mung dal', portion: { bn: '১ বাটি', en: '1 bowl' }, grams: 200, kcal: 110, carb: 15, rating: 'good' },
  { id: 'chola', group: 'dal', bn: 'ছোলা', en: 'Chickpeas', portion: { bn: '½ কাপ', en: '½ cup' }, kcal: 140, carb: 22, rating: 'good' },
  // vegetables (1 bowl cooked)
  { id: 'lau', group: 'veg', bn: 'লাউ', en: 'Bottle gourd', portion: { bn: '১ বাটি', en: '1 bowl' }, grams: 150, kcal: 60, carb: 8, rating: 'good' },
  { id: 'potol', group: 'veg', bn: 'পটল', en: 'Pointed gourd', portion: { bn: '১ বাটি', en: '1 bowl' }, grams: 150, kcal: 60, carb: 8, rating: 'good' },
  { id: 'chichinga', group: 'veg', bn: 'চিচিঙ্গা', en: 'Snake gourd', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 60, carb: 8, rating: 'good' },
  { id: 'dherosh', group: 'veg', bn: 'ঢেঁড়স', en: 'Okra', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 60, carb: 8, rating: 'good' },
  { id: 'korola', group: 'veg', bn: 'করলা', en: 'Bitter gourd', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 50, carb: 6, rating: 'good' },
  { id: 'begun', group: 'veg', bn: 'বেগুন', en: 'Eggplant', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 70, carb: 9, rating: 'good' },
  { id: 'fulkopi', group: 'veg', bn: 'ফুলকপি', en: 'Cauliflower', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 60, carb: 8, rating: 'good' },
  { id: 'bandhakopi', group: 'veg', bn: 'বাঁধাকপি', en: 'Cabbage', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 60, carb: 8, rating: 'good' },
  { id: 'pepe_kacha', group: 'veg', bn: 'কাঁচা পেঁপে', en: 'Green papaya', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 60, carb: 9, rating: 'good' },
  { id: 'kumra', group: 'veg', bn: 'মিষ্টি কুমড়া', en: 'Pumpkin', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 80, carb: 14, rating: 'limit' },
  { id: 'lal_shak', group: 'veg', bn: 'লাল শাক', en: 'Red amaranth', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 50, carb: 6, rating: 'good' },
  { id: 'palong', group: 'veg', bn: 'পালং শাক', en: 'Spinach', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 50, carb: 6, rating: 'good' },
  { id: 'kolmi', group: 'veg', bn: 'কলমি শাক', en: 'Water spinach', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 50, carb: 6, rating: 'good' },
  { id: 'pui', group: 'veg', bn: 'পুঁই শাক', en: 'Malabar spinach', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 50, carb: 6, rating: 'good' },
  { id: 'salad', group: 'veg', bn: 'শসা-টমেটো সালাদ', en: 'Cucumber-tomato salad', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 25, carb: 5, rating: 'good' },
  // fruit
  { id: 'peyara', group: 'fruit', bn: 'পেয়ারা', en: 'Guava', portion: { bn: '১টা', en: '1' }, kcal: 60, carb: 14, rating: 'good' },
  { id: 'apple', group: 'fruit', bn: 'আপেল', en: 'Apple', portion: { bn: '১টা ছোট', en: '1 small' }, kcal: 70, carb: 18, rating: 'good' },
  { id: 'malta', group: 'fruit', bn: 'মাল্টা/কমলা', en: 'Orange', portion: { bn: '১টা', en: '1' }, kcal: 60, carb: 14, rating: 'good' },
  { id: 'jambura', group: 'fruit', bn: 'জাম্বুরা', en: 'Pomelo', portion: { bn: '১ বাটি', en: '1 bowl' }, kcal: 50, carb: 12, rating: 'good' },
  { id: 'pepe_paka', group: 'fruit', bn: 'পাকা পেঁপে', en: 'Ripe papaya', portion: { bn: '১ কাপ', en: '1 cup' }, kcal: 60, carb: 15, rating: 'good' },
  { id: 'banana', group: 'fruit', bn: 'কলা', en: 'Banana', portion: { bn: '½টা', en: '½' }, kcal: 50, carb: 13, rating: 'limit' },
  { id: 'mango', group: 'fruit', bn: 'আম', en: 'Mango', portion: { bn: '২ ফালি', en: '2 slices' }, kcal: 70, carb: 17, rating: 'limit' },
  { id: 'kathal', group: 'fruit', bn: 'কাঁঠাল', en: 'Jackfruit', portion: { bn: '৪ কোয়া', en: '4 pods' }, kcal: 90, carb: 22, rating: 'limit' },
  { id: 'lichu', group: 'fruit', bn: 'লিচু', en: 'Lychee', portion: { bn: '৫টা', en: '5' }, kcal: 70, carb: 17, rating: 'limit' },
  // other
  { id: 'milk', group: 'other', bn: 'দুধ', en: 'Milk', portion: { bn: '১ গ্লাস', en: '1 glass' }, kcal: 120, carb: 12, rating: 'good' },
  { id: 'tok_doi', group: 'other', bn: 'টক দই', en: 'Plain yogurt', portion: { bn: '১ কাপ', en: '1 cup' }, kcal: 100, carb: 8, rating: 'good' },
  { id: 'nuts', group: 'other', bn: 'বাদাম', en: 'Nuts', portion: { bn: '১ মুঠো', en: '1 handful' }, kcal: 160, carb: 5, rating: 'good' },
  { id: 'tea_plain', group: 'other', bn: 'চা (চিনি ছাড়া)', en: 'Tea, no sugar', portion: { bn: '১ কাপ', en: '1 cup' }, kcal: 20, carb: 2, rating: 'good' },
  { id: 'biscuit', group: 'other', bn: 'বিস্কুট', en: 'Biscuits', portion: { bn: '২টা', en: '2' }, kcal: 90, carb: 14, rating: 'limit' },
  { id: 'tea_sugar', group: 'other', bn: 'চা (চিনিসহ)', en: 'Tea with sugar', portion: { bn: '১ কাপ', en: '1 cup' }, kcal: 60, carb: 10, rating: 'avoid' },
  { id: 'sugar', group: 'other', bn: 'চিনি', en: 'Sugar', portion: { bn: '১ চা-চামচ', en: '1 tsp' }, kcal: 20, carb: 5, rating: 'avoid' },
  { id: 'gur', group: 'other', bn: 'গুড়', en: 'Jaggery', portion: { bn: '১ টুকরা', en: '1 piece' }, kcal: 50, carb: 13, rating: 'avoid' },
  { id: 'mishti_doi', group: 'other', bn: 'মিষ্টি দই', en: 'Sweet yogurt', portion: { bn: '১ কাপ', en: '1 cup' }, kcal: 250, carb: 40, rating: 'avoid' },
  { id: 'sweet', group: 'other', bn: 'মিষ্টি/পিঠা', en: 'Sweets/pitha', portion: { bn: '১টা', en: '1' }, kcal: 150, carb: 30, rating: 'avoid' },
  { id: 'oil', group: 'other', bn: 'রান্নার তেল', en: 'Cooking oil', portion: { bn: '১ চা-চামচ', en: '1 tsp' }, kcal: 40, carb: 0, rating: 'limit', hidden: true },
];

export const FOOD = Object.fromEntries(CATALOG.map((f) => [f.id, f]));

// What the family said they usually eat; editable in the app.
export const DEFAULT_HOME_FOODS = ['rice', 'potato', 'rui', 'pangas', 'tilapia', 'beef', 'chicken', 'dal', 'shutki', 'sugar'];

export function mealTotals(items) {
  let kcal = 0;
  let carb = 0;
  for (const [id, n] of Object.entries(items)) {
    const f = FOOD[id];
    if (!f) continue;
    kcal += n * f.kcal;
    carb += n * f.carb;
  }
  return { kcal: Math.round(kcal), carb: Math.round(carb) };
}
