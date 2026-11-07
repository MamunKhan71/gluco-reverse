// Family codes: two easy English words and three digits, e.g. MANGO-RIVER-427.
// Easy to read out on the phone; 256 × 256 × 900 ≈ 59 million codes. Only logged-in
// people can try a code, and the patient sees (and can remove) everyone who joins.

// prettier-ignore
export const WORDS = [
  'APPLE', 'MANGO', 'LEMON', 'GUAVA', 'PAPAYA', 'BANANA', 'CHERRY', 'GRAPE', 'MELON', 'PEACH',
  'PLUM', 'BERRY', 'OLIVE', 'COCONUT', 'ORANGE', 'LIME', 'DATES', 'FIG', 'KIWI', 'PEAR',
  'ROSE', 'LOTUS', 'LILY', 'TULIP', 'DAISY', 'JASMINE', 'ORCHID', 'POPPY', 'IRIS', 'VIOLET',
  'TIGER', 'LION', 'EAGLE', 'HORSE', 'RABBIT', 'PANDA', 'ZEBRA', 'CAMEL', 'DOLPHIN', 'WHALE',
  'PARROT', 'ROBIN', 'SPARROW', 'PIGEON', 'DUCK', 'SWAN', 'GOOSE', 'OWL', 'FALCON', 'HAWK',
  'DEER', 'BEAR', 'WOLF', 'FOX', 'OTTER', 'BEAVER', 'KOALA', 'MONKEY', 'GIRAFFE', 'TURTLE',
  'RIVER', 'OCEAN', 'LAKE', 'POND', 'ISLAND', 'BEACH', 'HILL', 'VALLEY', 'FOREST', 'GARDEN',
  'MEADOW', 'FIELD', 'DESERT', 'CANYON', 'CLIFF', 'STREAM', 'BROOK', 'HARBOR', 'COAST', 'BAY',
  'SUN', 'MOON', 'STAR', 'CLOUD', 'RAIN', 'SNOW', 'STORM', 'WIND', 'BREEZE', 'RAINBOW',
  'SKY', 'DAWN', 'SUNSET', 'SPRING', 'SUMMER', 'AUTUMN', 'WINTER', 'MORNING', 'EVENING', 'NIGHT',
  'GOLD', 'SILVER', 'COPPER', 'PEARL', 'RUBY', 'CORAL', 'AMBER', 'JADE', 'CRYSTAL', 'DIAMOND',
  'RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE', 'PINK', 'WHITE', 'BLACK', 'BROWN', 'GREY',
  'TEA', 'COFFEE', 'HONEY', 'SUGAR', 'BREAD', 'RICE', 'CHEESE', 'BUTTER', 'COOKIE', 'CANDY',
  'BOOK', 'PEN', 'PAPER', 'LETTER', 'CARD', 'MAP', 'CLOCK', 'WATCH', 'LAMP', 'CANDLE',
  'CHAIR', 'TABLE', 'WINDOW', 'DOOR', 'HOUSE', 'TOWER', 'BRIDGE', 'CASTLE', 'PALACE', 'TEMPLE',
  'BOAT', 'SHIP', 'TRAIN', 'PLANE', 'ROCKET', 'BICYCLE', 'TRUCK', 'WAGON', 'SAIL', 'ANCHOR',
  'DRUM', 'FLUTE', 'PIANO', 'GUITAR', 'VIOLIN', 'BELL', 'SONG', 'MUSIC', 'DANCE', 'POEM',
  'HAPPY', 'BRAVE', 'CALM', 'KIND', 'GENTLE', 'BRIGHT', 'SWEET', 'QUIET', 'WARM', 'COOL',
  'SMART', 'SWIFT', 'STRONG', 'LUCKY', 'NOBLE', 'PROUD', 'WISE', 'JOLLY', 'MERRY', 'SUNNY',
  'TREE', 'LEAF', 'ROOT', 'SEED', 'BRANCH', 'BAMBOO', 'PALM', 'MAPLE', 'OAK', 'PINE',
  'CEDAR', 'WILLOW', 'BIRCH', 'FERN', 'MOSS', 'GRASS', 'FLOWER', 'PETAL', 'BLOSSOM', 'BUD',
  'HEART', 'SMILE', 'HOPE', 'DREAM', 'LIGHT', 'SPARK', 'FLAME', 'SHINE', 'GLOW', 'BLOOM',
  'APRIL', 'JUNE', 'JULY', 'MARCH', 'MAY', 'AUGUST', 'OCTOBER', 'DECEMBER', 'MONDAY', 'FRIDAY',
  'PILOT', 'DOCTOR', 'FARMER', 'BAKER', 'SAILOR', 'SINGER', 'PAINTER', 'TEACHER', 'KING', 'QUEEN',
  'PRINCE', 'KNIGHT', 'HERO', 'ANGEL', 'GIANT', 'WIZARD', 'MAGIC', 'TREASURE', 'CROWN', 'JEWEL',
  'PUZZLE', 'KITE', 'BALLOON', 'ROBOT', 'PLANET', 'COMET',
];

export function newFamilyCode(random = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n) {
  const a = WORDS[random(WORDS.length)];
  let b = WORDS[random(WORDS.length)];
  while (b === a) b = WORDS[random(WORDS.length)];
  return `${a}-${b}-${100 + random(900)}`;
}

const WORD_SET = new Set(WORDS);

// Whatever the person typed ("mango river 427", "MangoRiver427") → "MANGO-RIVER-427".
// Old 12-letter codes (XXXX-XXXX-XXXX) come back as 12 letters without dashes.
export function cleanCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]+)(\d{3})$/);
  if (m) {
    const letters = m[1];
    for (let i = 3; i < letters.length - 2; i++) {
      const a = letters.slice(0, i);
      const b = letters.slice(i);
      if (WORD_SET.has(a) && WORD_SET.has(b)) return `${a}-${b}-${m[2]}`;
    }
  }
  return s;
}

export const prettyCode = (c) => (/^[A-Z0-9]{12}$/.test(c || '') ? c.match(/.{4}/g).join('-') : c || '');
