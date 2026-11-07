// Easy, low-oil Bangladeshi home dishes. `items` is one person's serving (catalogue
// portions) and drives the calories; `need` must be at home for the dish to be planned.
// role: carb | main | dal | veg | bfast (breakfast protein) | snack | salad

const WASH_FISH_BN = 'মাছ লবণ-হলুদ দিয়ে ২–৩ বার ভালো করে ধুয়ে নিন।';
const WASH_FISH_EN = 'Wash the fish 2–3 times with salt and turmeric.';
const WASH_VEG_BN = 'সবজি কাটার আগে পরিষ্কার পানিতে ধুয়ে নিন।';
const WASH_VEG_EN = 'Wash vegetables in clean water before cutting.';
const WASH_MEAT_BN = 'মাংস আলাদা বটি/বোর্ডে কাটুন, ভালো করে ধুয়ে চর্বি ফেলে দিন।';
const WASH_MEAT_EN = 'Cut meat on a separate board, wash well and remove the fat.';

const r = (id, role, bn, en, need, items, mins, stepsBn, stepsEn) => ({ id, role, bn, en, need, items, mins, steps: { bn: stepsBn, en: stepsEn } });

export const RECIPES = [
  // --- carbs (portion scales with the plan) ---
  r('plain_rice', 'carb', 'সাদা ভাত', 'Plain rice', ['rice'], { rice: 1 }, 25,
    ['চাল ২–৩ বার ধুয়ে নিন।', 'বেশি পানিতে সেদ্ধ করে মাড় ঝরিয়ে ফেলুন।', 'বাড়ার সময় একই মাপের কাপ দিয়ে মেপে দিন।'],
    ['Wash the rice 2–3 times.', 'Boil in plenty of water and drain the starch.', 'Serve with the same measuring cup every time.']),
  r('red_rice', 'carb', 'লাল চালের ভাত', 'Red rice', ['red_rice'], { red_rice: 1 }, 35,
    ['চাল ধুয়ে ৩০ মিনিট ভিজিয়ে রাখুন।', 'সাদা ভাতের মতো রান্না করুন, একটু বেশি সময় লাগবে।', 'কাপ দিয়ে মেপে দিন।'],
    ['Wash and soak the rice for 30 minutes.', 'Cook like white rice; it takes a little longer.', 'Serve with the measuring cup.']),
  r('roti', 'carb', 'আটার রুটি', 'Atta roti', ['roti'], { roti: 1 }, 20,
    ['হাত সাবান দিয়ে ধুয়ে আটা মাখুন।', 'পাতলা করে বেলে তেল ছাড়া তাওয়ায় সেঁকুন।', 'গরম থাকতে খান।'],
    ['Wash hands with soap and knead the dough.', 'Roll thin and cook on a dry tawa without oil.', 'Eat while warm.']),
  r('veg_khichuri', 'carb', 'সবজি খিচুড়ি (পাতলা)', 'Light vegetable khichuri', ['rice', 'dal'], { rice: 0.5, dal: 0.5, fulkopi: 0.5, oil: 1 }, 30,
    ['চাল আর ডাল একসাথে ধুয়ে নিন। ' + WASH_VEG_BN, '১ চা-চামচ তেলে পেঁয়াজ, আদা, হলুদ দিন।', 'চাল-ডাল-সবজি দিয়ে ৪ গুণ পানিতে নরম করে রান্না করুন।', 'পাতলা থাকতে নামিয়ে নিন, আলু দেবেন না।'],
    ['Wash rice and dal together. ' + WASH_VEG_EN, 'Fry onion, ginger, turmeric in 1 tsp oil.', 'Add rice, dal, vegetables and 4× water; cook soft.', 'Take off while still loose, no potato.']),
  r('chira_doi', 'carb', 'চিড়া-টক দই', 'Chira with plain yogurt', ['chira', 'tok_doi'], { chira: 1, tok_doi: 0.5 }, 5,
    ['চিড়া ধুয়ে ৫ মিনিট ভিজিয়ে পানি ঝরান।', 'টক দই মিশিয়ে নিন, চিনি/গুড় দেবেন না।', 'চাইলে শসা কুচি দিন।'],
    ['Rinse chira, soak 5 minutes, drain.', 'Mix with plain yogurt, no sugar or gur.', 'Add chopped cucumber if you like.']),
  r('oats_savory', 'carb', 'নোনতা ওটস', 'Savory oats', ['oats'], { oats: 1, fulkopi: 0.3, oil: 0.5 }, 10,
    ['½ চা-চামচ তেলে পেঁয়াজ, কাঁচামরিচ, সবজি কুচি নাড়ুন।', 'ওটস আর ২ কাপ পানি দিন।', '৫ মিনিট রান্না করে লবণ দিন।'],
    ['Fry onion, chili and chopped vegetables in ½ tsp oil.', 'Add oats and 2 cups water.', 'Cook 5 minutes, add salt.']),

  // --- fish ---
  r('rui_lau', 'main', 'রুই মাছের পাতলা ঝোল (লাউ দিয়ে)', 'Rui fish light curry with bottle gourd', ['rui'], { rui: 1, lau: 0.5, oil: 1 }, 30,
    [WASH_FISH_BN, 'মাছ হালকা ভেজে তুলুন (১ চা-চামচ তেল)।', 'পেঁয়াজ, আদা, হলুদ, মরিচ দিয়ে লাউ কষান।', 'পানি দিয়ে লাউ নরম হলে মাছ দিয়ে ৫ মিনিট ফোটান।'],
    [WASH_FISH_EN, 'Lightly fry the fish (1 tsp oil).', 'Sauté bottle gourd with onion, ginger, turmeric, chili.', 'Add water; when soft, add fish and simmer 5 minutes.']),
  r('katla_potol', 'main', 'কাতলা মাছের ঝোল (পটল দিয়ে)', 'Katla curry with pointed gourd', ['katla'], { katla: 1, potol: 0.5, oil: 1 }, 30,
    [WASH_FISH_BN, 'পটল ধুয়ে লম্বা করে কাটুন।', 'অল্প তেলে মসলা কষিয়ে পটল দিন।', 'পানি দিয়ে মাছ দিন, ঝোল পাতলা রাখুন।'],
    [WASH_FISH_EN, 'Wash and slice the pointed gourd.', 'Fry spices in a little oil, add the gourd.', 'Add water and fish; keep the gravy thin.']),
  r('pangas_pepe', 'main', 'পাঙ্গাস মাছের ঝোল (পেঁপে দিয়ে)', 'Pangas curry with green papaya', ['pangas'], { pangas: 1, pepe_kacha: 0.5, oil: 1 }, 30,
    [WASH_FISH_BN, 'কাঁচা পেঁপে খোসা ছাড়িয়ে টুকরা করুন।', 'অল্প তেলে মসলা কষিয়ে পেঁপে সেদ্ধ করুন।', 'মাছ দিয়ে ৮–১০ মিনিট রান্না করুন।'],
    [WASH_FISH_EN, 'Peel and cut the green papaya.', 'Fry spices in a little oil and boil the papaya.', 'Add the fish and cook 8–10 minutes.']),
  r('tilapia_bhuna', 'main', 'তেলাপিয়া ভুনা (কম তেলে)', 'Tilapia bhuna, low oil', ['tilapia'], { tilapia: 1, oil: 1 }, 25,
    [WASH_FISH_BN, 'লবণ-হলুদ মেখে ননস্টিক প্যানে হালকা ভাজুন।', 'পেঁয়াজ-টমেটো-মসলা কষিয়ে মাছ দিন।', 'অল্প পানি দিয়ে মাখা মাখা করে নামান।'],
    [WASH_FISH_EN, 'Rub with salt and turmeric; lightly fry in a non-stick pan.', 'Cook onion, tomato and spices; add the fish.', 'Add a little water and cook until thick.']),
  r('ilish_begun', 'main', 'ইলিশ মাছের ঝোল (বেগুন দিয়ে)', 'Hilsa curry with eggplant', ['ilish'], { ilish: 1, begun: 0.5, oil: 0.5 }, 25,
    [WASH_FISH_BN, 'ইলিশে নিজের তেল আছে, রান্নায় তেল খুব কম দিন।', 'কালোজিরা-কাঁচামরিচ দিয়ে বেগুন দিন।', 'পানি দিয়ে মাছ দিন, ১০ মিনিট রান্না করুন।'],
    [WASH_FISH_EN, 'Hilsa has its own oil, use very little.', 'Add nigella seeds, green chili and eggplant.', 'Add water and fish; cook 10 minutes.']),
  r('small_fish_chorchori', 'main', 'ছোট মাছের চচ্চড়ি', 'Small fish chorchori', ['small_fish'], { small_fish: 1, oil: 1 }, 25,
    ['ছোট মাছ বেছে কয়েকবার ধুয়ে নিন।', 'পেঁয়াজ-রসুন-কাঁচামরিচ দিয়ে অল্প তেলে কষান।', 'মাছ দিয়ে ঢেকে ১০ মিনিট রান্না করুন।'],
    ['Clean the small fish and wash several times.', 'Cook onion, garlic and green chili in a little oil.', 'Add fish, cover and cook 10 minutes.']),
  r('shrimp_lau', 'main', 'চিংড়ি-লাউ', 'Shrimp with bottle gourd', ['shrimp'], { shrimp: 1, lau: 1, oil: 1 }, 25,
    ['চিংড়ির মাথা-খোসা ছাড়িয়ে পিঠের কালো সুতা ফেলে ধুয়ে নিন।', WASH_VEG_BN, 'অল্প তেলে চিংড়ি নেড়ে লাউ দিন।', 'নিজের পানিতেই লাউ নরম করে নামান।'],
    ['Peel the shrimp, remove the dark vein, wash.', WASH_VEG_EN, 'Stir the shrimp in a little oil, add bottle gourd.', 'Cook in its own water until soft.']),

  // --- chicken, egg, meat ---
  r('chicken_pepe', 'main', 'মুরগির পাতলা ঝোল (পেঁপে দিয়ে)', 'Light chicken curry with papaya', ['chicken'], { chicken: 1, pepe_kacha: 0.5, oil: 1 }, 40,
    [WASH_MEAT_BN, 'চামড়া ছাড়িয়ে নিন।', 'অল্প তেলে পেঁয়াজ-আদা-রসুন-মসলা কষিয়ে মুরগি দিন।', 'পেঁপে আর পানি দিয়ে সেদ্ধ না হওয়া পর্যন্ত রান্না করুন।'],
    [WASH_MEAT_EN, 'Remove the skin.', 'Cook onion, ginger, garlic and spices in a little oil; add chicken.', 'Add papaya and water; cook until done.']),
  r('chicken_bhuna', 'main', 'মুরগি ভুনা (কম তেলে)', 'Chicken bhuna, low oil', ['chicken'], { chicken: 1, oil: 1.5 }, 40,
    [WASH_MEAT_BN, 'টক দই-মসলা মেখে ১৫ মিনিট রাখুন।', 'ননস্টিক পাত্রে অল্প তেলে ঢেকে রান্না করুন।', 'পানি শুকিয়ে মাখা মাখা হলে নামান।'],
    [WASH_MEAT_EN, 'Marinate with plain yogurt and spices for 15 minutes.', 'Cook covered with little oil in a non-stick pot.', 'Take off when the water dries and it is thick.']),
  r('egg_curry', 'main', 'ডিমের ঝোল (টমেটো দিয়ে)', 'Egg curry with tomato', ['egg'], { egg: 2, oil: 1 }, 20,
    ['ডিম ১০ মিনিট সেদ্ধ করে খোসা ছাড়ান।', 'অল্প তেলে পেঁয়াজ-টমেটো-মসলা কষান।', 'পানি দিয়ে ডিম দিন, ৫ মিনিট ফোটান। আলু দেবেন না।'],
    ['Boil eggs 10 minutes and peel.', 'Cook onion, tomato and spices in a little oil.', 'Add water and eggs; simmer 5 minutes. No potato.']),
  r('beef_bhuna', 'main', 'গরুর মাংস ভুনা (চর্বি ছাড়া)', 'Lean beef bhuna', ['beef'], { beef: 1, oil: 1 }, 60,
    [WASH_MEAT_BN, 'প্রেশার কুকারে মসলা দিয়ে আগে সেদ্ধ করুন।', 'উপরে জমা চর্বি তুলে ফেলুন।', 'অল্প তেলে কষিয়ে নামান, ২ টুকরার বেশি নয়।'],
    [WASH_MEAT_EN, 'Pressure-cook with spices first.', 'Skim off the fat that collects on top.', 'Finish in a little oil, no more than 2 pieces.']),
  r('mutton_jhol', 'main', 'খাসির পাতলা ঝোল', 'Light mutton curry', ['mutton'], { mutton: 1, oil: 1 }, 60,
    [WASH_MEAT_BN, 'প্রেশার কুকারে মসলা দিয়ে সেদ্ধ করুন।', 'চর্বি তুলে ফেলে পাতলা ঝোল রাখুন।', '২ টুকরার বেশি নয়।'],
    [WASH_MEAT_EN, 'Pressure-cook with spices.', 'Skim the fat; keep the gravy thin.', 'No more than 2 pieces.']),

  // --- dal ---
  r('masur_dal', 'dal', 'পাতলা মসুর ডাল', 'Thin masoor dal', ['dal'], { dal: 1, oil: 0.5 }, 20,
    ['ডাল ২–৩ বার ধুয়ে নিন।', 'হলুদ-লবণ দিয়ে সেদ্ধ করে ঘুঁটে নিন।', '½ চা-চামচ তেলে রসুন-পেঁয়াজের ফোড়ন দিন।'],
    ['Wash the dal 2–3 times.', 'Boil with turmeric and salt; mash.', 'Temper with garlic and onion in ½ tsp oil.']),
  r('mug_dal_lau', 'dal', 'মুগ ডাল লাউ দিয়ে', 'Mung dal with bottle gourd', ['mug_dal'], { mug_dal: 1, lau: 0.5, oil: 0.5 }, 25,
    ['মুগ ডাল শুকনো খোলায় একটু ভেজে ধুয়ে নিন।', WASH_VEG_BN, 'ডাল আর লাউ একসাথে সেদ্ধ করুন।', 'জিরা-কাঁচামরিচের ফোড়ন দিন।'],
    ['Dry-roast the mung dal a little, then wash.', WASH_VEG_EN, 'Boil dal and bottle gourd together.', 'Temper with cumin and green chili.']),

  // --- vegetables ---
  r('lau_ghonto', 'veg', 'লাউ ঘন্ট', 'Bottle gourd ghonto', ['lau'], { lau: 1, oil: 1 }, 20,
    [WASH_VEG_BN, 'লাউ খোসা ছাড়িয়ে ছোট টুকরা করুন।', 'অল্প তেলে কালোজিরা-কাঁচামরিচ দিয়ে লাউ দিন।', 'ঢেকে নিজের পানিতে নরম করুন।'],
    [WASH_VEG_EN, 'Peel and dice the bottle gourd.', 'Add nigella seeds, green chili and gourd to a little oil.', 'Cover and cook in its own water until soft.']),
  r('potol_bhaji', 'veg', 'পটল ভাজি (কম তেলে)', 'Pointed gourd bhaji', ['potol'], { potol: 1, oil: 1 }, 20,
    [WASH_VEG_BN, 'পটল পাতলা গোল করে কাটুন।', 'ননস্টিক প্যানে অল্প তেলে ঢেকে ভাজুন।', 'লবণ-হলুদ-মরিচ দিয়ে নামান।'],
    [WASH_VEG_EN, 'Slice the pointed gourd thin.', 'Cook covered in a non-stick pan with a little oil.', 'Season with salt, turmeric, chili.']),
  r('lal_shak', 'veg', 'লাল শাক ভাজি', 'Red amaranth stir-fry', ['lal_shak'], { lal_shak: 1, oil: 0.5 }, 15,
    ['শাক ৩–৪ বার পানিতে ধুয়ে মাটি পরিষ্কার করুন।', 'রসুন কুচি ½ চা-চামচ তেলে দিন।', 'শাক দিয়ে ৫–৭ মিনিট নাড়ুন।'],
    ['Wash the greens 3–4 times to remove soil.', 'Add chopped garlic to ½ tsp oil.', 'Add greens and stir 5–7 minutes.']),
  r('palong_shak', 'veg', 'পালং শাক ভাজি', 'Spinach stir-fry', ['palong'], { palong: 1, oil: 0.5 }, 15,
    ['শাক ৩–৪ বার ধুয়ে নিন।', 'রসুন-কাঁচামরিচ দিয়ে অল্প তেলে নাড়ুন।', 'নরম হলে নামান।'],
    ['Wash the spinach 3–4 times.', 'Stir with garlic and green chili in a little oil.', 'Take off when soft.']),
  r('kolmi_shak', 'veg', 'কলমি শাক ভাজি', 'Water spinach stir-fry', ['kolmi'], { kolmi: 1, oil: 0.5 }, 15,
    ['শাক বেছে কয়েকবার ধুয়ে নিন।', 'রসুন দিয়ে অল্প তেলে ৫ মিনিট নাড়ুন।', 'লবণ দিয়ে নামান।'],
    ['Pick and wash the greens several times.', 'Stir with garlic in a little oil for 5 minutes.', 'Add salt and serve.']),
  r('pui_shak', 'veg', 'পুঁই শাকের তরকারি', 'Malabar spinach curry', ['pui'], { pui: 1, oil: 0.5 }, 20,
    ['শাক-ডাঁটা ধুয়ে কেটে নিন।', 'অল্প তেলে পাঁচফোড়ন দিয়ে ডাঁটা আগে দিন।', 'পাতা দিয়ে নরম হলে নামান, আলু/মিষ্টি কুমড়া ছাড়া।'],
    ['Wash and cut leaves and stems.', 'Temper panch phoron in a little oil; add stems first.', 'Add leaves and cook soft, without potato or pumpkin.']),
  r('mixed_sobji', 'veg', 'মিক্সড সবজি (আলু ছাড়া)', 'Mixed vegetables (no potato)', ['fulkopi'], { fulkopi: 0.5, bandhakopi: 0.5, oil: 1 }, 20,
    [WASH_VEG_BN, 'ফুলকপি, বাঁধাকপি, টমেটো ছোট করে কাটুন।', 'অল্প তেলে হলুদ-জিরা দিয়ে সবজি দিন।', 'ঢেকে নরম করুন, আলু নয়।'],
    [WASH_VEG_EN, 'Cut cauliflower, cabbage, tomato small.', 'Add turmeric, cumin and vegetables to a little oil.', 'Cover until soft, no potato.']),
  r('bandhakopi', 'veg', 'বাঁধাকপি ভাজি', 'Cabbage stir-fry', ['bandhakopi'], { bandhakopi: 1, oil: 1 }, 20,
    [WASH_VEG_BN, 'বাঁধাকপি সরু করে কুচি করুন।', 'অল্প তেলে পেঁয়াজ-কাঁচামরিচ দিয়ে নাড়ুন।', 'ঢেকে ১০ মিনিট রান্না করুন।'],
    [WASH_VEG_EN, 'Shred the cabbage thin.', 'Stir with onion and green chili in a little oil.', 'Cover and cook 10 minutes.']),
  r('korola', 'veg', 'করলা ভাজি', 'Bitter gourd fry', ['korola'], { korola: 1, oil: 1 }, 20,
    [WASH_VEG_BN, 'পাতলা করে কেটে লবণ মেখে ১০ মিনিট রাখুন, চিপে পানি ফেলুন।', 'ননস্টিক প্যানে অল্প তেলে মচমচে করে ভাজুন।'],
    [WASH_VEG_EN, 'Slice thin, rub with salt for 10 minutes, squeeze out the water.', 'Fry crisp in a non-stick pan with a little oil.']),
  r('begun_bhorta', 'veg', 'বেগুন ভর্তা', 'Roasted eggplant bhorta', ['begun'], { begun: 1, oil: 0.5 }, 20,
    ['বেগুন ধুয়ে আগুনে বা চুলায় পুড়িয়ে নিন।', 'খোসা ছাড়িয়ে পেঁয়াজ-মরিচ-ধনেপাতা দিয়ে মাখুন।', '½ চা-চামচ সরিষার তেল দিন।'],
    ['Wash and roast the eggplant over the flame.', 'Peel; mash with onion, chili and coriander.', 'Add ½ tsp mustard oil.']),
  r('dherosh', 'veg', 'ঢেঁড়স ভাজি', 'Okra stir-fry', ['dherosh'], { dherosh: 1, oil: 1 }, 15,
    ['ঢেঁড়স ধুয়ে ভালো করে মুছে শুকিয়ে নিন, তারপর কাটুন।', 'অল্প তেলে পেঁয়াজ দিয়ে নাড়ুন।', 'ঢাকনা ছাড়া ১০ মিনিট রান্না করুন।'],
    ['Wash, wipe dry, then cut the okra.', 'Stir with onion in a little oil.', 'Cook uncovered for 10 minutes.']),
  r('pepe_bhaji', 'veg', 'কাঁচা পেঁপে ভাজি', 'Green papaya stir-fry', ['pepe_kacha'], { pepe_kacha: 1, oil: 1 }, 20,
    ['পেঁপে খোসা ছাড়িয়ে ধুয়ে কুচি করুন।', 'অল্প তেলে পাঁচফোড়ন-কাঁচামরিচ দিন।', 'ঢেকে নরম করুন।'],
    ['Peel, wash and grate the papaya.', 'Temper panch phoron and chili in a little oil.', 'Cover until soft.']),
  r('chichinga', 'veg', 'চিচিঙ্গা ভাজি', 'Snake gourd stir-fry', ['chichinga'], { chichinga: 1, oil: 1 }, 15,
    [WASH_VEG_BN, 'পাতলা করে কাটুন।', 'অল্প তেলে পেঁয়াজ-মরিচ দিয়ে ঢেকে রান্না করুন।'],
    [WASH_VEG_EN, 'Slice thin.', 'Cook covered with onion and chili in a little oil.']),

  // --- breakfast protein ---
  r('boiled_egg', 'bfast', 'ডিম সেদ্ধ', 'Boiled egg', ['egg'], { egg: 1 }, 12,
    ['ডিম ধুয়ে পানিতে ১০ মিনিট সেদ্ধ করুন।', 'ঠান্ডা পানিতে রেখে খোসা ছাড়ান।'],
    ['Wash the egg and boil 10 minutes.', 'Cool in water and peel.']),
  r('veg_omelette', 'bfast', 'সবজি অমলেট', 'Vegetable omelette', ['egg'], { egg: 1, salad: 0.3, oil: 0.5 }, 10,
    ['ডিম ভাঙার আগে খোসা ধুয়ে নিন।', 'পেঁয়াজ-টমেটো-কাঁচামরিচ কুচি দিয়ে ফেটিয়ে নিন।', 'ননস্টিক প্যানে ½ চা-চামচ তেলে ভাজুন।'],
    ['Wash the shell before cracking the egg.', 'Beat with chopped onion, tomato and chili.', 'Cook in a non-stick pan with ½ tsp oil.']),
  r('dal_small', 'bfast', 'ডাল (ছোট বাটি)', 'Dal (small bowl)', ['dal'], { dal: 0.5 }, 0,
    ['আগের দিনের ডাল হলে ফ্রিজে রাখা ছিল কিনা দেখুন, ফুটিয়ে গরম করে খান।'],
    ['If it is yesterday\'s dal, it must have been in the fridge, boil it hot before eating.']),

  // --- snacks ---
  r('chola_sedho', 'snack', 'ছোলা সেদ্ধ মাখা', 'Boiled chickpea salad', ['chola'], { chola: 0.5 }, 10,
    ['আগের রাতে ছোলা ভিজিয়ে রাখুন, সকালে সেদ্ধ করুন।', 'পেঁয়াজ-শসা-টমেটো-লেবু দিয়ে মাখুন, তেল ছাড়া।'],
    ['Soak chickpeas overnight and boil in the morning.', 'Mix with onion, cucumber, tomato and lemon, no oil.']),
  r('doi_cup', 'snack', 'টক দই', 'Plain yogurt', ['tok_doi'], { tok_doi: 1 }, 0,
    ['চিনি ছাড়া টক দই খান। চাইলে শসা কুচি দিন।'],
    ['Eat plain yogurt without sugar. Add cucumber if you like.']),
  r('muri_shosha', 'snack', 'মুড়ি-শসা মাখা', 'Muri with cucumber', ['muri'], { muri: 1, salad: 0.5 }, 5,
    ['শসা-টমেটো ধুয়ে কুচি করুন।', '১ কাপ মুড়ির সাথে লেবু-কাঁচামরিচ দিয়ে মাখুন, চানাচুর নয়।'],
    ['Wash and chop cucumber and tomato.', 'Mix with 1 cup muri, lemon and chili, no chanachur.']),

  // --- salad ---
  r('salad', 'salad', 'শসা-টমেটো সালাদ', 'Cucumber-tomato salad', [], { salad: 1 }, 5,
    ['শসা-টমেটো-পেঁয়াজ পরিষ্কার পানিতে ধুয়ে কাটুন।', 'লেবু আর অল্প লবণ দিন। খাবারের শুরুতে খান।'],
    ['Wash cucumber, tomato, onion in clean water and cut.', 'Add lemon and a little salt. Eat it first in the meal.']),
];

export const RECIPE = Object.fromEntries(RECIPES.map((x) => [x.id, x]));

// Fruit snack is built from whichever good fruit is at home.
export const fruitSnack = (fruitId) => ({
  id: `fruit:${fruitId}`,
  role: 'snack',
  fruit: fruitId,
  need: [fruitId],
  items: { tea_plain: 1, [fruitId]: 1 },
  mins: 5,
});
