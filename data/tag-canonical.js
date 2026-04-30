/**
 * Canonical tag taxonomy: map raw words/phrases from API (categories, features, title)
 * to a bounded set of tags. Keeps feed tag_weights small and refill search terms meaningful.
 *
 * - Only canonical tags are stored in catalog and used in feed tag weights.
 * - Add entries to RAW_TO_CANONICAL to map product words → canonical tag.
 * - Canonical tags should be good search terms (e.g. "technology", "outdoor", "kitchen").
 */

/** Max canonical tags per product (keeps vocabulary bounded). */
export const MAX_TAGS_PER_PRODUCT = 12;

/**
 * Raw word or slug → canonical tag.
 * Multiple raw terms can map to the same canonical tag (e.g. device, stream, display → technology).
 */
export const RAW_TO_CANONICAL = {
  // Technology / electronics
  technology: "technology",
  tech: "technology",
  electronics: "technology",
  device: "technology",
  devices: "technology",
  gadget: "technology",
  gadgets: "technology",
  "amazon-devices": "technology",
  stream: "technology",
  streaming: "technology",
  tv: "technology",
  television: "technology",
  display: "technology",
  monitor: "technology",
  screen: "technology",
  smart: "technology",
  "smart-home": "technology",
  audio: "technology",
  sound: "technology",
  camera: "technology",
  webcam: "technology",
  wireless: "technology",
  bluetooth: "technology",
  wifi: "technology",
  speaker: "technology",
  speakers: "technology",
  headphones: "technology",
  headset: "technology",
  earbuds: "technology",
  tablet: "technology",
  ipad: "technology",
  laptop: "technology",
  computer: "technology",
  pc: "technology",
  macbook: "technology",
  gaming: "technology",
  gamer: "technology",
  console: "technology",
  playstation: "technology",
  xbox: "technology",
  nintendo: "technology",
  charger: "technology",
  charging: "technology",
  cable: "technology",
  usb: "technology",
  powerbank: "technology",

  // Outdoor / fitness
  outdoor: "outdoor",
  outdoors: "outdoor",
  hiking: "outdoor",
  trekking: "outdoor",
  camping: "outdoor",
  camp: "outdoor",
  backpack: "outdoor",
  backpacks: "outdoor",
  hydration: "outdoor",
  waterbottle: "outdoor",
  running: "outdoor",
  jogging: "outdoor",
  cycling: "outdoor",
  biking: "outdoor",
  fitness: "outdoor",
  gym: "outdoor",
  workout: "outdoor",
  training: "outdoor",
  sports: "outdoor",
  "sports-outdoors": "outdoor",
  "outdoor-recreation": "outdoor",
  "hydration-packs": "outdoor",
  climbing: "outdoor",
  fishing: "outdoor",
  hunting: "outdoor",
  "yoga-mat": "outdoor",
  resistance: "outdoor",
  dumbbell: "outdoor",

  // Home / living
  home: "home",
  house: "home",
  kitchen: "kitchen",
  cooking: "kitchen",
  bake: "kitchen",
  baking: "kitchen",
  cookware: "kitchen",
  utensils: "kitchen",
  appliance: "kitchen",
  appliances: "kitchen",
  "home-decor": "home",
  decor: "home",
  decoration: "home",
  living: "home",
  furniture: "home",
  sofa: "home",
  chair: "home",
  table: "home",
  bed: "home",
  bedding: "home",
  blanket: "home",
  pillow: "home",
  lighting: "home",
  lamp: "home",
  candle: "home",
  storage: "home",
  organization: "home",
  organizer: "home",

  // Style / wearables
  fashion: "fashion",
  clothing: "fashion",
  clothes: "fashion",
  apparel: "fashion",
  outfit: "fashion",
  jewelry: "fashion",
  necklace: "fashion",
  bracelet: "fashion",
  ring: "fashion",
  earrings: "fashion",
  watch: "fashion",
  watches: "fashion",
  shoes: "fashion",
  sneakers: "fashion",
  boots: "fashion",
  sandals: "fashion",
  bag: "fashion",
  handbag: "fashion",
  purse: "fashion",
  "backpack-fashion": "fashion",
  sunglasses: "fashion",

  // Books / media
  books: "books",
  book: "books",
  novel: "books",
  reading: "books",
  kindle: "books",
  audiobook: "books",
  music: "music",
  song: "music",
  album: "music",
  vinyl: "music",
  record: "music",
  movie: "music",
  film: "music",
  "tv-show": "music",
  entertainment: "music",
  "streaming-service": "music",

  // Health / wellness
  health: "wellness",
  wellness: "wellness",
  wellbeing: "wellness",
  yoga: "wellness",
  meditation: "wellness",
  mindfulness: "wellness",
  skincare: "wellness",
  skin: "wellness",
  beauty: "wellness",
  makeup: "wellness",
  cosmetics: "wellness",
  "self-care": "wellness",
  spa: "wellness",
  relaxation: "wellness",
  massage: "wellness",
  supplement: "wellness",
  vitamins: "wellness",

  // Kids / family
  kids: "kids",
  kid: "kids",
  children: "kids",
  baby: "kids",
  toddler: "kids",
  infant: "kids",
  family: "kids",
  toys: "kids",
  toy: "kids",
  games: "games",
  "board-game": "games",
  boardgame: "games",
  puzzle: "games",
  puzzles: "games",
  lego: "kids",
  doll: "kids",
  playset: "kids",

  // Pet
  pet: "pets",
  pets: "pets",
  dog: "pets",
  puppy: "pets",
  cat: "pets",
  kitten: "pets",
  bird: "pets",
  fish: "pets",
  aquarium: "pets",
  "cat-toy": "pets",
  "dog-toy": "pets",
  "pet-toy": "pets",
  "cat-food": "pets",
  "dog-food": "pets",
  "pet-food": "pets",
  "cat-care": "pets",
  "dog-care": "pets",
  "pet-care": "pets",
  "cat-grooming": "pets",
  "dog-grooming": "pets",
  "pet-grooming": "pets",
  "cat-health": "pets",
  "dog-health": "pets",
  "pet-health": "pets",
  "cat-training": "pets",
  "dog-training": "pets",
  "pet-training": "pets",
  leash: "pets",
  collar: "pets",
  harness: "pets",
  litter: "pets",

  // Office / workspace
  office: "office",
  workspace: "office",
  desk: "office",
  "chair-office": "office",
  stationery: "office",
  notebook: "office",
  planner: "office",
  pen: "office",
  pencil: "office",
  printer: "office",
  paper: "office",
  filing: "office",

  // Automotive / tools
  automotive: "automotive",
  car: "automotive",
  vehicle: "automotive",
  truck: "automotive",
  tire: "automotive",
  tools: "tools",
  tool: "tools",
  drill: "tools",
  hammer: "tools",
  screwdriver: "tools",
  wrench: "tools",
  saw: "tools",
  toolbox: "tools",

  // Garden / gardening
  garden: "garden",
  gardening: "garden",
  plants: "garden",
  plant: "garden",
  planter: "garden",
  soil: "garden",
  seeds: "garden",
  watering: "garden",
  hose: "garden",
  shovel: "garden",
  rake: "garden",
  fertilizer: "garden",

  // Coffee / tea
  coffee: "coffee",
  espresso: "coffee",
  latte: "coffee",
  cappuccino: "coffee",
  tea: "tea",
  "green-tea": "tea",
  "herbal-tea": "tea",
  "coffee-maker": "coffee",
  "espresso-machine": "coffee",
  "tea-maker": "tea",
  kettle: "tea",
  "coffee-grinder": "coffee",
  "coffee-beans": "coffee",
  "tea-bags": "tea",
  mug: "coffee",
  thermos: "coffee",
  tumbler: "coffee",
  colombia: "coffee",
  Nespresso: "coffee",

  // =========================
  // NEW GIFT / HOBBY CATEGORIES
  // =========================

  // Art / creativity
  art: "art",
  artist: "art",
  painting: "art",
  paint: "art",
  drawing: "art",
  sketch: "art",
  sketchbook: "art",
  canvas: "art",
  watercolor: "art",
  acrylic: "art",
  markers: "art",
  coloring: "art",
  coloringbook: "art",
  craft: "crafts",
  crafting: "crafts",
  diy: "crafts",
  handmade: "crafts",

  // Photography / video
  photography: "photography",
  photo: "photography",
  "camera-gear": "photography",
  lens: "photography",
  tripod: "photography",
  "lighting-kit": "photography",
  videography: "photography",
  filming: "photography",

  // Travel
  travel: "travel",
  luggage: "travel",
  suitcase: "travel",
  carryon: "travel",
  passport: "travel",
  "travel-accessories": "travel",
  toiletry: "travel",
  packing: "travel",
  "neck-pillow": "travel",

  // Foodie / gourmet
  food: "food",
  foodie: "food",
  gourmet: "food",
  snacks: "food",
  chocolate: "food",
  candy: "food",
  "baking-mix": "food",
  spice: "food",
  spices: "food",
  "hot-sauce": "food",
  "olive-oil": "food",

  // Drinks / alcohol
  wine: "drinks",
  whiskey: "drinks",
  bourbon: "drinks",
  cocktail: "drinks",
  barware: "drinks",
  glassware: "drinks",
  beer: "drinks",
  brewing: "drinks",

  // Gaming (non-digital emphasis)
  boardgames: "games",
  cardgame: "games",
  "card-games": "games",
  tabletop: "games",
  dice: "games",

  // Music instruments
  instrument: "music-instruments",
  guitar: "music-instruments",
  piano: "music-instruments",
  keyboard: "music-instruments",
  drums: "music-instruments",
  ukulele: "music-instruments",
  violin: "music-instruments",
  microphone: "music-instruments",

  // Fitness specialization
  weightlifting: "fitness",
  dumbbells: "fitness",
  kettlebell: "fitness",
  "resistance-bands": "fitness",
  pilates: "fitness",
  crossfit: "fitness",

  // Collectibles / hobbies
  collectibles: "collectibles",
  collectible: "collectibles",
  "trading-cards": "collectibles",
  pokemon: "collectibles",
  figurine: "collectibles",
  "action-figure": "collectibles",
  "model-kit": "collectibles",
  "lego-set": "collectibles",

  // Spiritual / mindfulness
  spirituality: "spirituality",
  crystals: "spirituality",
  tarot: "spirituality",
  incense: "spirituality",
  journaling: "spirituality",
  journal: "spirituality",

  // Home improvement / DIY
  "home-improvement": "diy-home",
  renovation: "diy-home",
  woodworking: "diy-home",
  "power-tools": "diy-home",
  drill: "diy-home",
  saw: "diy-home",

  // Party / celebration
  party: "party",
  celebration: "party",
  decorations: "party",
  balloons: "party",
  "gift-wrap": "party",
  wrapping: "party",
  "candles-party": "party",

  // Subscription / experiences
  subscription: "experience",
  membership: "experience",
  experience: "experience",
  class: "experience",
  workshop: "experience",
  course: "experience",

  // Luxury / premium
  luxury: "luxury",
  premium: "luxury",
  designer: "luxury",
  "high-end": "luxury",

  // Eco / sustainability
  eco: "eco",
  sustainable: "eco",
  reusable: "eco",
  "zero-waste": "eco",
  organic: "eco",
  bamboo: "eco",

  // Hobby electronics / maker
  maker: "maker",
  robotics: "maker",
  arduino: "maker",
  raspberrypi: "maker",
  soldering: "maker",
  "3d-printing": "maker",

  // Beauty tools
  haircare: "beauty-tools",
  hairdryer: "beauty-tools",
  straightener: "beauty-tools",
  curler: "beauty-tools",
  grooming: "beauty-tools",
  trimmer: "beauty-tools",

  // Sleep / comfort
  sleep: "comfort",
  mattress: "comfort",
  "weighted-blanket": "comfort",
  "sleep-mask": "comfort",
  comfort: "comfort",
};

/**
 * Normalize raw tags to canonical set. Unmapped tags are dropped.
 * @param {string[]} rawTags - Tags from API (categories, features, title, etc.)
 * @param {{ maxTags?: number }} [opts] - maxTags caps output length (default MAX_TAGS_PER_PRODUCT)
 * @returns {string[]} Unique canonical tags, order preserved, capped
 */
export function normalizeTags(rawTags, opts = {}) {
  const max = opts.maxTags ?? MAX_TAGS_PER_PRODUCT;
  const seen = new Set();
  const out = [];
  for (const raw of rawTags) {
    if (!raw || typeof raw !== "string") continue;
    const key = raw
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    const canonical =
      RAW_TO_CANONICAL[key] ?? RAW_TO_CANONICAL[raw.toLowerCase()];
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
      if (out.length >= max) break;
    }
  }
  return out;
}
