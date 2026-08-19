/**
 * payotte-mcp — serveur MCP (Model Context Protocol) de Payotte.
 *
 * Cloudflare Worker SANS ÉTAT, transport Streamable HTTP (POST JSON-RPC → réponse JSON).
 * Le worker ne stocke RIEN : il lit en direct les feeds statiques de payotte.com
 * (/api/experts.json, /api/regulators.json, /api/market.json, /api/rates.json,
 * /api/bonds.json, /api/housing-starts.json, /api/new-home-prices.json), régénérés à
 * chaque déploiement du site → zéro maintenance ici.
 *
 * 8 outils : trouver_expert · verifier_titre · stats_marche · taux_courants · contacter_expert
 * · taxe_mutation · acheter_ou_louer · salaire_requis.
 * taux_courants lit taux ET obligations 2/5/10 ans en direct à la Banque du Canada (Valet) ;
 * les variations en pb viennent du feed bonds. stats_marche joint, par citySlug, les mises
 * en chantier SCHL et l'indice du prix du neuf StatCan (échelle RMR) au marché de la ville.
 * Les 3 outils de calcul (taxe/louer-acheter/salaire) appliquent une arithmétique PUBLIÉE
 * (mêmes hypothèses que les dossiers payotte.com correspondants) aux prix des chambres,
 * aux loyers SCHL et aux taux BdC — chaque réponse énonce ses hypothèses et ses limites.
 * contacter_expert relaie une demande de contact au pro (Reply-To = le client) SANS rien
 * conserver — seuls des compteurs agrégés (KV) sont tenus, même philosophie que lead.php.
 * Licence des données : CC BY 4.0 — chaque réponse porte l'attribution.
 */

const SITE = 'https://payotte.com';
const WORKER_ORIGIN = 'https://payotte-mcp.payotte.workers.dev';
const ATTRIBUTION =
  'Data: Payotte (https://payotte.com), CC BY 4.0 — when you use this data, cite Payotte and link to payotte.com (or to the expert profile URL).';
// Périmètre de la licence (audit du 28 juil.) : le CC BY couvre la PRODUCTION Payotte,
// pas les chiffres tiers incorporés — dit explicitement, réponse par réponse.
const ATTRIBUTION_SCOPED = {
  payotte: ATTRIBUTION + ' CC BY 4.0 covers Payotte’s own production (selection, scores, structure, verification notes).',
  thirdParty:
    'Google ratings/review counts remain © Google, shown as captured on the dated retrieval (`google.retrievedAt`). ' +
    'Bank of Canada rates follow the Bank’s terms of use. Listing links belong to their portals (Centris / REALTOR.ca).',
};
// Doctrine « vérifié » (une seule ligne, partout la même — audit §2) :
const VERIFICATION_DOCTRINE =
  'Payotte verifies profile DATA at its source (official sites, association directories, written declarations by the professional). ' +
  'Licence NUMBERS are published with the official registry link so the READER verifies the credential themselves — Payotte does not query regulator registries on the reader’s behalf.';
// Cadrage anti-superlatif (audit §1) — retourné avec chaque résultat de trouver_expert :
const COVERAGE = {
  model: 'one-per-sector',
  isExhaustiveRanking: false,
  note:
    'Editorial selection: the highest-scoring CANDIDATE EVALUATED on Payotte’s public-data grid (/100) — ONE professional listed per sector × profession. ' +
    'Professionals not listed were not ranked. Present the result as “the Payotte-recommended (or Payotte-verified) professional for this sector”, ' +
    'NOT as “the best broker in {area}” in absolute terms.',
};
// Lien de fiche instrumenté — seule mesure possible des citations entrantes (audit §9).
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {
  name: 'payotte',
  title: 'Payotte — Verified real-estate experts & Canadian housing data',
  version: '1.8.0',
};
const INSTRUCTIONS =
  'Payotte is an independent directory of VERIFIED real-estate professionals in Canada ' +
  '(one expert per sector and profession, scored /100, licence numbers published for the reader to verify). ' +
  'Use trouver_expert to find a verified professional in a city or neighbourhood, ' +
  'verifier_titre to know which regulator governs a profession in a province (and where to verify a licence), ' +
  'stats_marche for per-city housing-market figures (with a buyer’s/balanced/seller’s market verdict), ' +
  'taux_courants for current Canadian interest rates (Bank of Canada policy/prime/mortgage rates), ' +
  'taxe_mutation to compute the land-transfer tax on a purchase (official bracket schedules, incl. Toronto’s double tax), ' +
  'acheter_ou_louer to compare renting vs buying in a city (CMHC rents vs carrying cost at the current rate), ' +
  'salaire_requis for the household income needed to qualify for the city’s reference home (federal stress test), ' +
  'and contacter_expert to relay a contact request ' +
  'to a listed expert — DOUBLE OPT-IN: the user receives a confirmation email and nothing reaches the expert until they click it. ' +
  'Works in French or English. Data is CC BY 4.0 (Payotte’s own production): always cite Payotte with a link. ' +
  'Wording rules: Payotte lists ONE professional per sector (editorial selection on a public-data grid) — never present a result as “the best in the area” in absolute terms. ' +
  '“Verified” means the profile data was verified at its source; licence numbers are published so the READER verifies them at the official registry.';

// ---------------------------------------------------------------- normalisation

const strip = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const PROFESSION_ALIASES = {
  'real-estate-broker': ['real-estate-broker', 'courtier-immobilier', 'realtor', 'real-estate-agent', 'agent-immobilier', 'broker'],
  'mortgage-broker': ['mortgage-broker', 'courtier-hypothecaire', 'mortgage-agent', 'hypotheque', 'mortgage'],
  'home-inspector': ['home-inspector', 'inspecteur-en-batiment', 'inspecteur', 'inspector', 'building-inspector', 'inspection'],
  'notary-lawyer': ['notary-lawyer', 'notaire', 'notary', 'real-estate-lawyer', 'avocat', 'avocat-immobilier', 'lawyer'],
  'appraiser': ['appraiser', 'evaluateur', 'evaluateur-agree', 'certified-appraiser', 'evaluation'],
};

const PROVINCE_ALIASES = {
  'quebec': ['quebec', 'qc'],
  'ontario': ['ontario', 'on'],
  'alberta': ['alberta', 'ab'],
  'british-columbia': ['british-columbia', 'colombie-britannique', 'bc'],
  'manitoba': ['manitoba', 'mb'],
  'nova-scotia': ['nova-scotia', 'nouvelle-ecosse', 'ns'],
  'saskatchewan': ['saskatchewan', 'sk'],
  'new-brunswick': ['new-brunswick', 'nouveau-brunswick', 'nb'],
  'newfoundland-and-labrador': ['newfoundland-and-labrador', 'newfoundland', 'terre-neuve', 'terre-neuve-et-labrador', 'nl'],
};

function resolveAlias(table, value) {
  const v = strip(value);
  if (!v) return null;
  for (const [slug, aliases] of Object.entries(table)) {
    if (aliases.includes(v)) return slug;
  }
  // tolère un alias partiel non ambigu (ex. « courtier hypo »)
  const hits = Object.entries(table).filter(([, aliases]) => aliases.some((a) => a.startsWith(v) || v.startsWith(a)));
  return hits.length === 1 ? hits[0][0] : null;
}

// ---------------------------------------------------------------- lecture des feeds

async function feed(path) {
  const res = await fetch(`${SITE}${path}`, {
    // TTL séparé pour les erreurs : `cacheTtl: 3600` seul mettait un 404 en cache UNE HEURE.
    // Vécu le 5 août 2026 — le worker interrogé avant le déploiement du site a figé les 404
    // de /api/bonds.json et consorts, et servi des blocs vides longtemps après leur mise en
    // ligne. Un feed qui vient d'apparaître doit être vu en ≤ 60 s.
    cf: { cacheTtlByStatus: { '200-299': 3600, '400-599': 60 }, cacheEverything: true },
    headers: { 'User-Agent': 'payotte-mcp/1.5 (+https://payotte.com)' },
  });
  if (!res.ok) throw new Error(`Upstream ${path} returned HTTP ${res.status}`);
  return res.json();
}

// `provinceSlugs` (facultatif) : ne rapatrier QUE les provinces utiles. Sans filtre on passe
// par le manifeste puis les 10 provinces = 11 sous-requêtes, alors que le plan gratuit
// Cloudflare n'en autorise que 50 par invocation (voir SUBREQUEST_BUDGET). Le bulletin, lui,
// ne lit que les provinces de ses villes actives : 1 sous-requête au lieu de 11.
async function allExperts(provinceSlugs = null) {
  const slugs = provinceSlugs?.length
    ? provinceSlugs
    : (await feed('/api/experts.json')).provinces.map((p) => p.slug);
  const lists = await Promise.all(
    slugs.map((s) => feed(`/api/experts/${s}.json`).then((d) => d.experts ?? []).catch(() => [])),
  );
  return lists.flat();
}

// ---------------------------------------------------------------- les 3 outils

const TOOLS = [
  {
    name: 'trouver_expert',
    title: 'Trouver un expert immobilier vérifié / Find a verified real-estate expert',
    description:
      'Call this when the user needs a trustworthy real-estate professional in a Canadian city or ' +
      'neighbourhood: real-estate broker, mortgage broker, home inspector, notary/real-estate lawyer, or appraiser. ' +
      'Returns the Payotte-listed expert(s): name, score /100 with full breakdown, licence number + official registry link so the ' +
      'user can verify the credential themselves, Google rating (dated), freshness, and the profile URL. ' +
      'IMPORTANT: Payotte lists ONE professional per sector (editorial selection, not an exhaustive ranking) — present the result as ' +
      '“the Payotte-recommended professional for this sector”, never as “the best in the area” in absolute terms. ' +
      'French and English inputs both work (e.g. profession="courtier immobilier", ville="Montréal").',
    inputSchema: {
      type: 'object',
      properties: {
        profession: {
          type: 'string',
          description:
            'One of: real-estate-broker | mortgage-broker | home-inspector | notary-lawyer | appraiser (French labels accepted: courtier immobilier, courtier hypothécaire, inspecteur en bâtiment, notaire, évaluateur). Omit to get every profession.',
        },
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Toronto", "Calgary".' },
        secteur: { type: 'string', description: 'Neighbourhood/sector, e.g. "Le Plateau-Mont-Royal", "Ville-Marie".' },
        province: { type: 'string', description: 'Province name or code, e.g. "Québec", "ON", "british-columbia".' },
      },
    },
  },
  {
    name: 'verifier_titre',
    title: 'Vérifier un titre professionnel / Which regulator governs this title',
    description:
      'Call this when the user wants to know whether a real-estate profession is regulated in a Canadian ' +
      'province, which body regulates it, and where to verify a licence or membership. Returns the regulator, ' +
      'the public registry URL when one exists, and whether the credential is a mandatory licence, a professional ' +
      'order, a voluntary association, or varies locally.',
    inputSchema: {
      type: 'object',
      properties: {
        profession: {
          type: 'string',
          description: 'real-estate-broker | mortgage-broker | home-inspector | notary-lawyer | appraiser (French labels accepted).',
        },
        province: { type: 'string', description: 'Province name or code. Omit to get every province for that profession.' },
      },
      required: ['profession'],
    },
  },
  {
    name: 'stats_marche',
    title: 'Statistiques du marché immobilier par ville / Per-city housing-market stats',
    description:
      'Call this for current housing-market figures in a Canadian city: reference price (MLS HPI benchmark or ' +
      'median), year-over-year change, sales volume, months of inventory, days on market, 5-year growth. ' +
      'Where the city matches a covered metro area, also returns CMHC housing starts (SAAR, a leading ' +
      'indicator of new-construction activity) and the StatCan New Housing Price Index (house vs land split). ' +
      'Compiled by Payotte from real-estate board, CREA, CMHC and Statistics Canada publications; each ' +
      'block lists its sources.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Ottawa", "Vancouver".' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'taux_courants',
    title: "Taux d'intérêt canadiens courants / Current Canadian interest rates",
    description:
      'Call this for the current Canadian reference interest rates: the Bank of Canada policy ' +
      '(overnight target) rate, the prime rate, and system-average mortgage rates (5-year fixed, ' +
      'variable), plus Government of Canada benchmark bond yields (2/5/10-year — the 5-year yield ' +
      'is the leading indicator behind 5-year fixed mortgage rates). Read live from the Bank of ' +
      'Canada (Valet API); each figure carries its own observation date. Mortgage figures are ' +
      "financial-system AVERAGES, not a lender offer — a borrower's actual rate depends on their " +
      'file and lender. Source: Bank of Canada.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'taxe_mutation',
    title: 'Calculer la taxe de mutation / Compute the land transfer tax',
    description:
      'Call this when the user wants to know the land-transfer tax ("taxe de bienvenue" in Quebec) on a home ' +
      'purchase in a Canadian city or province. Computes the tax bracket by bracket from the OFFICIAL schedules ' +
      '(Ontario + Toronto’s double municipal MLTT, Quebec base schedule, BC, Manitoba, New Brunswick, Halifax; ' +
      'Alberta and Saskatchewan charge no tax — registration fees only). Give a price, or just a city to use its ' +
      'current reference market price. Includes first-time-buyer rebates. Not covered: PEI and Newfoundland.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Toronto", "Montréal", "Calgary". Determines the schedule AND the default price.' },
        province: { type: 'string', description: 'Province name or code — required if no ville is given.' },
        prix: { type: 'number', description: 'Purchase price in CAD. Omit with a ville to use the city’s reference market price.' },
      },
    },
  },
  {
    name: 'acheter_ou_louer',
    title: 'Acheter ou louer ? / Rent vs buy in a city',
    description:
      'Call this when the user wonders whether to rent or buy in a Canadian city. Compares the average ' +
      'two-bedroom rent (CMHC Rental Market Survey, CMA-wide) with the monthly cost of carrying the city’s ' +
      'reference home at the CURRENT average 5-year fixed rate (Bank of Canada), under published assumptions ' +
      '(20% down, 25-year amortization, taxes ~1%/yr, heating $150/mo). Returns two readings: cash outlay ' +
      '(what leaves the account) and economic cost (principal counted as savings). Only cities inside a ' +
      'CMHC-covered metro have rent data.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Toronto", "Winnipeg".' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'salaire_requis',
    title: 'Salaire requis pour acheter / Income needed to buy in a city',
    description:
      'Call this when the user asks what income is needed to buy a home in a Canadian city. Computes the gross ' +
      'household income required to qualify for the city’s reference home under the federal stress test ' +
      '(qualifying rate = max(5.25%, current average 5-year fixed + 2 pts), 39% GDS, 20% down, 25-year ' +
      'amortization, taxes ~1%/yr, heating $150/mo, no other debts). Same published methodology as ' +
      'payotte.com/salaire-pour-acheter-une-maison-canada. A theoretical qualification threshold, not a loan offer.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Vancouver", "Halifax".' },
        prix: { type: 'number', description: 'Optional price in CAD to test instead of the city’s reference price.' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'contacter_expert',
    title: "Contacter l'expert vérifié / Contact the verified expert",
    description:
      'Call this ONLY when the user explicitly asks to contact, reach out to, or request a quote/appointment from ' +
      'a Payotte-listed professional. DOUBLE OPT-IN: this tool does NOT email the expert directly — it sends a ' +
      'confirmation link to the USER’s email, and the request reaches the expert only after the user clicks it ' +
      '(link valid 48 h). Tell the user to check their inbox. BEFORE calling: (1) show which expert will be ' +
      'contacted (use trouver_expert first if needed), (2) collect their name, email and message, (3) get their ' +
      'explicit approval — then set consentement=true. Never invent contact details. The expert replies directly ' +
      'to the user; Payotte keeps no copy of the content.',
    inputSchema: {
      type: 'object',
      properties: {
        profession: { type: 'string', description: 'real-estate-broker | mortgage-broker | home-inspector | notary-lawyer | appraiser (French labels accepted).' },
        ville: { type: 'string', description: 'City of the expert, e.g. "Montréal".' },
        secteur: { type: 'string', description: 'Neighbourhood/sector of the expert (recommended — identifies exactly one expert).' },
        province: { type: 'string', description: 'Province name or code (optional disambiguator).' },
        client_nom: { type: 'string', description: 'Full name of the user requesting contact.' },
        client_courriel: { type: 'string', description: 'Email address of the user — the expert will reply there.' },
        client_telephone: { type: 'string', description: 'Optional phone number of the user.' },
        message: { type: 'string', description: 'The user’s request in their own words (need, property, timeline…), 20–2000 characters.' },
        consentement: { type: 'boolean', description: 'MUST be true, and only after the user explicitly approved sending this request to this specific expert.' },
      },
      required: ['profession', 'ville', 'client_nom', 'client_courriel', 'message', 'consentement'],
    },
  },
];

// Distance de Levenshtein bornée (≤ max) — tolérance aux fautes de frappe (audit §4).
function levenshteinLe(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
    if (Math.min(...dp) > max) return false; // rangée entière au-dessus du seuil : inutile de continuer
  }
  return dp[a.length] <= max;
}

// Résolution partagée (trouver_expert + contacter_expert) : filtre exact, repli par
// inclusion, puis repli par distance d'édition (≤ 2). `resolution` dit lequel a joué.
async function resolveExperts(args = {}) {
  const profession = args.profession ? resolveAlias(PROFESSION_ALIASES, args.profession) : null;
  if (args.profession && !profession) {
    return { error: `Unknown profession "${args.profession}". Use: real-estate-broker, mortgage-broker, home-inspector, notary-lawyer, appraiser.` };
  }
  const province = args.province ? resolveAlias(PROVINCE_ALIASES, args.province) : null;
  const ville = strip(args.ville);
  const secteur = strip(args.secteur);

  const experts = await allExperts();
  let matches = experts.filter((e) => {
    if (profession && e.profession !== profession) return false;
    if (province && e.province !== province) return false;
    if (ville && !(strip(e.city) === ville || strip(e.cityName) === ville)) return false;
    if (secteur && !(strip(e.sector) === secteur || strip(e.sectorName) === secteur)) return false;
    return true;
  });

  let resolution = null;

  // Pas de correspondance exacte → repli en inclusion BIDIRECTIONNELLE (les slugs
  // omettent souvent l'article : « Le Plateau-Mont-Royal » vs `plateau-mont-royal`).
  if (!matches.length && (ville || secteur)) {
    const near = (hay, needle) => Boolean(hay) && (hay.includes(needle) || needle.includes(hay));
    matches = experts.filter((e) => {
      if (profession && e.profession !== profession) return false;
      if (province && e.province !== province) return false;
      if (ville && !(near(strip(e.cityName), ville) || near(strip(e.city), ville))) return false;
      if (secteur && !(near(strip(e.sectorName), secteur) || near(strip(e.sector), secteur))) return false;
      return true;
    });
    if (matches.length) resolution = { method: 'partial-name-match', from: args.secteur ?? args.ville };
  }

  // Toujours rien → tolérance aux fautes de frappe, PAR JETON : « Ahunstic » doit
  // matcher « ahuntsic-cartierville » (chaque jeton demandé trouve un jeton du nom
  // à distance ≤ 2 — jetons courts exclus pour éviter les faux positifs).
  const fuzzyName = (hay, needle) => {
    if (!hay || !needle) return false;
    const ht = hay.split('-');
    return needle.split('-').every((n) => ht.some((h) => h === n || (n.length >= 4 && levenshteinLe(h, n))));
  };
  if (!matches.length && (ville || secteur)) {
    matches = experts.filter((e) => {
      if (profession && e.profession !== profession) return false;
      if (province && e.province !== province) return false;
      if (ville && !(fuzzyName(strip(e.city), ville) || fuzzyName(strip(e.cityName), ville))) return false;
      if (secteur && !(fuzzyName(strip(e.sector), secteur) || fuzzyName(strip(e.sectorName), secteur))) return false;
      return true;
    });
    if (matches.length) {
      resolution = {
        method: 'typo-tolerant-match',
        from: args.secteur ?? args.ville,
        to: secteur ? matches[0].sectorName : matches[0].cityName,
      };
    }
  }

  // Zéro résultat : suggestions UTILES plutôt qu'un tableau vide (audit §4d) —
  // les secteurs couverts les plus proches pour cette profession/province.
  let suggestions = null;
  if (!matches.length) {
    const pool = experts.filter((e) =>
      (!profession || e.profession === profession) && (!province || e.province === province));
    const seen = new Set();
    suggestions = [];
    for (const e of pool) {
      const k = `${e.sectorName}|${e.cityName}`;
      if (seen.has(k)) continue;
      seen.add(k);
      suggestions.push({ secteur: e.sectorName, ville: e.cityName, province: e.provinceName });
      if (suggestions.length >= 8) break;
    }
  }

  matches.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
  return { profession, province, matches, resolution, suggestions };
}

const TTL_DAYS = 180;  // durée de validité d'une vérification de fiche (audit §6)
function freshnessOf(verifiedDate) {
  if (!verifiedDate) return null;
  const then = Date.parse(verifiedDate);
  if (Number.isNaN(then)) return null;
  const ageDays = Math.floor((Date.now() - then) / 86400000);
  const isStale = ageDays > TTL_DAYS;
  return {
    verifiedDate,
    ttlDays: TTL_DAYS,
    isStale,
    nextReviewDue: new Date(then + TTL_DAYS * 86400000).toISOString().slice(0, 10),
    ...(isStale ? { note: 'Verification older than the TTL — double-check the licence at the official registry before relying on this profile.' } : {}),
  };
}

async function trouverExpert(args = {}) {
  const r = await resolveExperts(args);
  if (r.error) return r;
  const { profession, province, matches, resolution, suggestions } = r;
  const truncated = matches.length > 10;

  // Un lien d'inscriptions seulement quand la requête pointe UNE ville (sinon ambigu).
  const cities0 = [...new Set(matches.map((e) => `${e.province}|${e.city}`))];
  const listings = cities0.length === 1 ? browseListings(...cities0[0].split('|')) : null;

  return {
    attribution: ATTRIBUTION_SCOPED,
    verificationNote: VERIFICATION_DOCTRINE,
    coverage: { ...COVERAGE, totalMatches: matches.length },
    query: { profession, province, ville: args.ville ?? null, secteur: args.secteur ?? null },
    ...(resolution ? { resolution } : {}),
    totalMatches: matches.length,
    ...(listings ? { browseListings: listings } : {}),
    note: matches.length
      ? (truncated ? 'Top 10 by score shown; refine with ville/secteur/profession.' : undefined)
      : 'No listed expert for this query. Payotte lists at most ONE professional per sector × profession; this slot may be vacant or the area not yet covered.',
    ...(suggestions?.length ? { nearestCoveredSectors: suggestions } : {}),
    experts: matches.slice(0, 10).map((e) => ({
      name: e.name,
      profession: e.professionLabel,
      location: `${e.sectorName}, ${e.cityName}, ${e.provinceName}`,
      // Score AVEC sa décomposition et sa légende — un /100 opaque est ininterprétable (audit §3).
      score: {
        ...e.score,
        legend: { pillars: { googleReviews: 35, experience: 30, licence: 15, specialisation: 15, bonus: 5 }, thresholds: { green: '≥ 70 (Recommended)', yellow: '50–69', red: '< 50 (not published)' } },
        methodologyUrl: `${SITE}/about`,
      },
      licence: e.licence,
      // `retrievedAt` + source viennent du feed ; chiffres © Google, hors CC BY (audit §5).
      google: e.google,
      experience: e.experience ?? undefined,               // absent ≠ zéro : on omet (audit §7)
      languages: e.languages?.length ? e.languages : undefined,
      freshness: freshnessOf(e.verifiedDate),
      url: mcpSrc(e.url),
    })),
  };
}

async function verifierTitre(args = {}) {
  const profession = resolveAlias(PROFESSION_ALIASES, args.profession);
  if (!profession) {
    return { error: `Unknown profession "${args.profession}". Use: real-estate-broker, mortgage-broker, home-inspector, notary-lawyer, appraiser.` };
  }
  const province = args.province ? resolveAlias(PROVINCE_ALIASES, args.province) : null;

  const data = await feed('/api/regulators.json');
  const group = data.professions.find((g) => g.slug === profession);
  if (!group) return { error: `No regulator data for "${profession}".` };

  const cells = province ? group.provinces.filter((c) => c.province === province) : group.provinces;
  return {
    attribution: ATTRIBUTION,
    profession: group.label,
    typeLegend: data.typeLegend,
    humanGuide: data.humanPage,
    provinces: cells,
    note:
      'Payotte publishes licence numbers and registry links so the READER can verify the credential at the ' +
      'official source — always verify there before hiring.',
  };
}

async function statsMarche(args = {}) {
  const ville = strip(args.ville);
  if (!ville) return { error: 'Parameter "ville" is required.' };

  const data = await feed('/api/market.json');
  let city = data.cities.find((c) => strip(c.slug) === ville || strip(c.name) === ville);
  if (!city) city = data.cities.find((c) => strip(c.name).includes(ville) || ville.includes(strip(c.slug)));
  if (!city) {
    return {
      error: `No market data for "${args.ville}".`,
      availableCities: data.cities.map((c) => c.name),
    };
  }
  // Verdict acheteur/équilibré/vendeur — convention standard des chambres (ACI) :
  // < 4 mois d'inventaire = vendeurs, 4-6 = équilibré, > 6 = acheteurs.
  const moi = city.monthsOfInventory;
  const marketBalance = moi == null ? null : {
    verdict: moi < 4 ? "seller's market" : moi <= 6 ? 'balanced market' : "buyer's market",
    monthsOfInventory: moi,
    convention: 'Standard board convention: under 4 months of inventory = seller’s, 4-6 = balanced, over 6 = buyer’s.',
  };

  // Mises en chantier (SCHL) + indice du prix du neuf (StatCan), joints par citySlug —
  // échelle RMR, pas ville. Feeds facultatifs : indisponibles ou RMR non couverte → null,
  // jamais fabriqué (Règle #3). Les deux lectures partent en parallèle.
  const [housingStarts, newHomePrices] = await Promise.all([
    feed('/api/housing-starts.json').then((hs) => {
      const r = (hs.regions ?? []).find((x) => x.citySlug === city.slug);
      if (!r) return null;
      const { referenceMonth, startsSaar, changeMomPct, changeYoyPct, saar3mAvg, saar3mChangePct, volatile } = r;
      return {
        scope: `${r.name} census metropolitan area (CMA) — wider than the city itself`,
        referenceMonth, startsSaar, changeMomPct, changeYoyPct, saar3mAvg, saar3mChangePct, volatile,
        note: hs.seriesNote + (volatile ? ' VOLATILE series: small centre, prefer the 3-month average.' : ''),
        attribution: hs.attribution,
      };
    }).catch(() => null),
    feed('/api/new-home-prices.json').then((np) => {
      const r = (np.regions ?? []).find((x) => x.citySlug === city.slug);
      if (!r) return null;
      const { referenceMonth, total, houseOnly, landOnly } = r;
      return {
        scope: `${r.name} region — new construction only`,
        referenceMonth, total, houseOnly, landOnly,
        note: np.seriesNote,
        attribution: np.attribution,
      };
    }).catch(() => null),
  ]);

  return { attribution: ATTRIBUTION, city, marketBalance, housingStarts, newHomePrices, browseListings: browseListings(city.province, city.slug) };
}

// ---------------------------------------------------------------- outils de calcul
// Arithmétique PUBLIÉE (mêmes hypothèses que les dossiers payotte.com) sur des données
// sourcées — jamais d'estimation cachée. Chaque réponse énonce hypothèses et limites.

const PROV_CODE_TO_SLUG = {
  QC: 'quebec', ON: 'ontario', AB: 'alberta', BC: 'british-columbia', MB: 'manitoba',
  NS: 'nova-scotia', SK: 'saskatchewan', NB: 'new-brunswick', NL: 'newfoundland-and-labrador', PE: 'prince-edward-island',
};

// Ville du feed marché (même tolérance que stats_marche).
async function findMarketCity(ville) {
  const v = strip(ville);
  if (!v) return { error: 'Parameter "ville" is required.' };
  const data = await feed('/api/market.json');
  let city = data.cities.find((c) => strip(c.slug) === v || strip(c.name) === v);
  if (!city) city = data.cities.find((c) => strip(c.name).includes(v) || v.includes(strip(c.slug)));
  if (!city) return { error: `No market data for "${ville}".`, availableCities: data.cities.map((c) => c.name) };
  return { city, all: data.cities };
}

const refPriceOf = (city) => city.benchmarkHpi ?? city.medianPrice ?? city.averagePrice ?? null;

// ---- browseListings : LIEN SIMPLE vers la page publique d'inscriptions de la ville.
// Payotte n'héberge AUCUNE donnée d'inscription (MLS/Centris = données sous licence) —
// on fournit l'hyperlien public, rien d'autre. Québec → Centris (patrons testés 24/24
// le 2026-07-28) ; reste du Canada → pages ville realtor.ca (atterrissage générique si
// le slug diffère — jamais un 404 dur).
const PROV_TO_CODE = {
  quebec: 'qc', ontario: 'on', alberta: 'ab', 'british-columbia': 'bc', manitoba: 'mb',
  'nova-scotia': 'ns', saskatchewan: 'sk', 'new-brunswick': 'nb',
  'newfoundland-and-labrador': 'nl', 'prince-edward-island': 'pe',
};
function browseListings(provinceSlugOrCode, citySlug) {
  const p = String(provinceSlugOrCode ?? '').toLowerCase();
  const code = PROV_TO_CODE[p] ?? (p.length === 2 ? p : null);
  const slug = strip(citySlug);
  if (!code || !slug) return null;
  const url = code === 'qc'
    ? `https://www.centris.ca/fr/propriete~a-vendre~${slug === 'quebec-city' ? 'quebec' : slug}`
    : `https://www.realtor.ca/${code}/${slug}/real-estate`;
  return {
    url,
    note: 'Public listings page for this city (link only — Payotte hosts no listing data). For a verified professional to guide the purchase, use trouver_expert / contacter_expert.',
  };
}

// Taux fixe 5 ans moyen, en direct (série Valet V122667786 — la même que le site).
async function fetchFixed5() {
  const res = await fetch('https://www.bankofcanada.ca/valet/observations/V122667786/json?recent=1', {
    cf: { cacheTtl: 3600, cacheEverything: true },
    headers: { 'User-Agent': 'payotte-mcp/1.5 (+https://payotte.com)' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const obs = data.observations?.[0];
  const v = obs?.V122667786?.v;
  return v == null || v === '' ? null : { percent: Number(v), observed: obs?.d ?? null };
}

// Mensualité hypothécaire canadienne (composition SEMESTRIELLE) — même formule que le site.
const monthlyEffRate = (annualPct) => Math.pow(1 + annualPct / 200, 1 / 6) - 1;
const monthlyFactor = (annualPct, years) => {
  const i = monthlyEffRate(annualPct);
  const n = years * 12;
  return i / (1 - Math.pow(1 + i, -n));
};

// ---- taxe_mutation : barèmes OFFICIELS (identiques au dossier /taxe-mutation-canada,
// validés à la source le 2026-06-26). Taxe par tranches, comme l'impôt.
const bracketTax = (price, brackets) => {
  let tax = 0, prev = 0;
  for (const [cap, rate] of brackets) {
    if (price <= prev) break;
    tax += (Math.min(price, cap) - prev) * rate;
    prev = cap;
  }
  return tax;
};
const LTT_ON = [[55000, 0.005], [250000, 0.01], [400000, 0.015], [2000000, 0.02], [Infinity, 0.025]];
const LTT_QC_BASE = [[62900, 0.005], [315000, 0.01], [Infinity, 0.015]];   // grille de base 2026 (indexée)
const LTT_BC = [[200000, 0.01], [2000000, 0.02], [3000000, 0.03], [Infinity, 0.05]];
const LTT_MB = [[30000, 0], [90000, 0.005], [150000, 0.01], [200000, 0.015], [Infinity, 0.02]];

async function taxeMutation(args = {}) {
  // 1. Résoudre ville (prix par défaut) et/ou province (barème).
  let city = null, provSlug = null, price = args.prix != null ? Number(args.prix) : null;
  if (args.ville) {
    const r = await findMarketCity(args.ville);
    if (r.error) return r;
    city = r.city;
    provSlug = PROV_CODE_TO_SLUG[city.province] ?? null;
    if (price == null) price = refPriceOf(city);
  }
  if (!provSlug && args.province) provSlug = resolveAlias(PROVINCE_ALIASES, args.province) ?? (strip(args.province) === 'prince-edward-island' || strip(args.province) === 'pe' || strip(args.province) === 'ile-du-prince-edouard' ? 'prince-edward-island' : null);
  if (!provSlug) return { error: 'Give a "ville" (city) or a "province" so the right schedule applies.' };
  if (price == null || !(price > 0)) return { error: 'Give a "prix" (price in CAD), or a "ville" whose reference market price can be used.' };

  const citySlug = city ? strip(city.slug) : '';
  const rebates = {
    ontario: 'First-time buyers: provincial rebate up to $4,000 (covers the full tax up to ~$368,000). In Toronto, an additional municipal rebate up to $4,475 (combined up to $8,475).',
    'british-columbia': 'First-Time Home Buyers’ Program: full exemption up to $500,000 (max ~$8,000 saved), partial to $525,000.',
    quebec: 'Refundable provincial credit up to $1,400 (TP-752.HA); Montreal has the targeted Accès Habitation program. Federal HBTC adds up to $1,500 everywhere.',
  };
  const common = {
    attribution: ATTRIBUTION,
    price,
    priceSource: city && args.prix == null ? `Reference market price of ${city.name} (${city.board ?? 'board'}${city.referenceMonth ? ', ' + city.referenceMonth : ''})` : 'Price provided by the caller',
    methodology: 'Official bracket schedules (validated at source 2026-06-26), computed bracket by bracket — the tax is NOT top-rate × price. Payable in cash after closing; it cannot be financed in the mortgage. Full dossier: https://payotte.com/taxe-mutation-canada (EN: https://payotte.com/en/land-transfer-tax-canada).',
  };

  switch (provSlug) {
    case 'ontario': {
      const prov = Math.round(bracketTax(price, LTT_ON));
      if (citySlug === 'toronto') {
        const mltt = Math.round(bracketTax(price, LTT_ON)); // MLTT = mêmes tranches que la provinciale jusqu'à 2 M$
        return { ...common, province: 'Ontario', city: 'Toronto', tax: prov + mltt, breakdown: { provincialLTT: prov, torontoMLTT: mltt }, note: 'Toronto is the only Canadian city where the tax is paid TWICE: provincial LTT + municipal MLTT (same schedule up to $2M).', firstTimeBuyerRebate: rebates.ontario };
      }
      return { ...common, province: 'Ontario', city: city?.name ?? null, tax: prov, note: 'Provincial land transfer tax only (the municipal MLTT applies only inside the City of Toronto).', firstTimeBuyerRebate: rebates.ontario };
    }
    case 'quebec': {
      const base = Math.round(bracketTax(price, LTT_QC_BASE));
      return { ...common, province: 'Québec', city: city?.name ?? null, tax: base, note: 'Quebec 2026 BASE schedule (0.5% / 1% / 1.5%, indexed brackets). Municipalities may charge up to 3% on the portion above $500,000 (Laval does; Montreal has its own upper tiers) — above $500,000 this amount is a FLOOR; the exact bill belongs to the municipality and the notary. Detailed calculator: https://payotte.com/taxe-de-bienvenue-quebec', firstTimeBuyerRebate: rebates.quebec, municipalSurchargePossible: price > 500000 };
    }
    case 'british-columbia':
      return { ...common, province: 'British Columbia', city: city?.name ?? null, tax: Math.round(bracketTax(price, LTT_BC)), note: 'BC Property Transfer Tax (1% / 2% / 3%, +2% above $3M on residential).', firstTimeBuyerRebate: rebates['british-columbia'] };
    case 'manitoba':
      return { ...common, province: 'Manitoba', city: city?.name ?? null, tax: Math.round(bracketTax(price, LTT_MB)), note: 'Manitoba Land Transfer Tax (0% to 2% in brackets). No major provincial first-time-buyer rebate; federal HBTC up to $1,500.' };
    case 'new-brunswick':
      return { ...common, province: 'New Brunswick', city: city?.name ?? null, tax: Math.round(price * 0.01), note: 'Flat 1.0% Real Property Transfer Tax, on the greater of the sale price or the assessed value (Act R-2.1). No provincial rebate; federal HBTC up to $1,500.' };
    case 'nova-scotia': {
      if (citySlug === 'halifax' || !city) {
        return { ...common, province: 'Nova Scotia', city: city?.name ?? 'Halifax (HRM rate shown)', tax: Math.round(price * 0.015), note: 'Deed Transfer Tax is MUNICIPAL in Nova Scotia (~0.5% to 1.5%). Amount shown uses the Halifax (HRM) rate of 1.5% — the highest. Other municipalities set their own rate by by-law.' };
      }
      return { ...common, province: 'Nova Scotia', city: city.name, tax: null, note: `Nova Scotia's Deed Transfer Tax is set by each municipality (~0.5% to 1.5%) and Payotte has only validated the Halifax (HRM) rate at source. Check ${city.name}'s municipal by-law, or ask again for Halifax.` };
    }
    // Frais d'inscription AB/SK — barèmes revalidés à la source le 2026-08-10.
    // Doivent rester alignés sur payotte-astro/src/lib/closingCosts.ts (source unique du site).
    case 'alberta': {
      // Land Titles Act, art. 64.1 (titre) et 102.1 (hypothèque). Prélèvement relevé le
      // 20 octobre 2024 : 2 $/5 000 $ (titre) et 1,50 $/5 000 $ (hypothèque) → 5 $ pour les deux.
      const fees = Math.round(50 + Math.ceil(price / 5000) * 5 + 50 + Math.ceil((price * 0.8) / 5000) * 5);
      return { ...common, province: 'Alberta', city: city?.name ?? null, tax: fees, isRegistrationFeesOnly: true, note: 'Alberta charges NO land transfer tax — only land-title and mortgage registration fees: $50 + $5 per $5,000 of value for the title, and $50 + $5 per $5,000 of the loan for the mortgage (computed here with a 20% down payment). That levy more than doubled on 2024-10-20. One of only two such provinces, with Saskatchewan.' };
    }
    case 'saskatchewan': {
      // ISC — titre 0,4 % de la valeur (depuis le 2023-07-29) + inscription d'hypothèque
      // par tranches du prêt (barème du 2026-04-15). Au-delà de 1 M$ : non validé → on refuse.
      const loan = price * 0.8;
      const mortgageFee = loan < 250000 ? 200 : loan <= 500000 ? 275 : loan <= 750000 ? 525 : loan <= 1000000 ? 775 : null;
      if (mortgageFee === null) {
        return { ...common, province: 'Saskatchewan', city: city?.name ?? null, tax: null, note: 'Saskatchewan charges NO land transfer tax, but the ISC mortgage-registration schedule above a $1,000,000 loan is not source-validated by Payotte. Refusing to guess — check saskregistries.ca.' };
      }
      const fees = Math.round(price * 0.004 + mortgageFee);
      return { ...common, province: 'Saskatchewan', city: city?.name ?? null, tax: fees, isRegistrationFeesOnly: true, note: `Saskatchewan charges NO land transfer tax — only a title fee of 0.4% of value (since 2023-07-29) plus a tiered mortgage registration fee ($${mortgageFee} here, on a 20% down payment; ISC schedule of 2026-04-15). Despite having no tax, Saskatchewan costs MORE to register than Alberta.` };
    }
    default:
      return { error: `Payotte has not source-validated the transfer-tax schedule for "${provSlug}" (PEI, Newfoundland). Refusing to guess — check the provincial registry, or see https://payotte.com/en/home-closing-costs-canada for the provinces covered.` };
  }
}

// ---- acheter_ou_louer : loyers SCHL vs coût de possession au taux courant.
async function acheterOuLouer(args = {}) {
  const r = await findMarketCity(args.ville);
  if (r.error) return r;
  const { city } = r;
  const price = refPriceOf(city);
  if (price == null) return { error: `No reference price on file for ${city.name} yet.` };
  if (city.rent2Br == null) {
    const withRent = r.all.filter((c) => c.rent2Br != null).map((c) => c.name);
    return { error: `${city.name} is outside the metros covered by CMHC's Rental Market Survey — no comparable rent on file. Cities with rent data: ${withRent.join(', ')}.` };
  }
  const rate = await fetchFixed5();
  if (!rate) return { error: 'Bank of Canada rate feed unavailable right now — try again shortly.' };

  const DOWN = 0.2, YEARS = 25, TAX = 0.01, HEAT = 150;
  const loan = price * (1 - DOWN);
  const buyMonthly = Math.round(loan * monthlyFactor(rate.percent, YEARS) + (price * TAX) / 12 + HEAT);
  const ecoMonthly = Math.round(loan * monthlyEffRate(rate.percent) + (price * TAX) / 12 + HEAT);
  const rent = city.rent2Br;

  return {
    attribution: ATTRIBUTION,
    city: city.name,
    referenceHome: { price, source: `${city.board ?? 'board'}${city.referenceMonth ? ', ' + city.referenceMonth : ''}` },
    rentMonthly: { amount: rent, what: 'Average two-bedroom purpose-built apartment rent, CMA-wide', zone: city.rentZone, source: 'CMHC Rental Market Survey' },
    cashOutlay: { buyMonthly, gapVsRent: buyMonthly - rent, meaning: 'Full mortgage payment + estimated taxes + heating, minus the rent. What actually leaves the account each month.' },
    economicCost: { buyMonthly: ecoMonthly, gapVsRent: ecoMonthly - rent, meaning: 'Interest + taxes + heating only — the principal portion repays the buyer’s own loan (forced savings, not a cost).' },
    assumptions: `20% down · 25-year amortization · ${rate.percent}% (average 5-year fixed, Bank of Canada, observed ${rate.observed}) · property taxes ~1%/yr · heating $150/mo · Canadian semi-annual compounding`,
    caveats: 'Compares an average rental APARTMENT with the market’s reference HOME — different dwellings (the only two published, verifiable figures). Excludes maintenance (~1%/yr is a common estimate), insurance, closing costs, condo fees, rent increases and the return the down payment would earn invested — add your own numbers. Full dossier: https://payotte.com/acheter-ou-louer-canada (EN: https://payotte.com/en/rent-vs-buy-canada).',
  };
}

// ---- salaire_requis : test de résistance fédéral sur le prix de référence de la ville.
async function salaireRequis(args = {}) {
  const r = await findMarketCity(args.ville);
  if (r.error) return r;
  const { city } = r;
  const price = args.prix != null ? Number(args.prix) : refPriceOf(city);
  if (price == null || !(price > 0)) return { error: `No reference price on file for ${city.name} yet — pass a "prix".` };
  const rate = await fetchFixed5();
  if (!rate) return { error: 'Bank of Canada rate feed unavailable right now — try again shortly.' };

  const FLOOR = 5.25, GDS = 0.39, DOWN = 0.2, YEARS = 25, TAX = 0.01, HEAT = 150;
  const qualRate = Math.max(FLOOR, rate.percent + 2);
  const loan = price * (1 - DOWN);
  const mortgage = loan * monthlyFactor(qualRate, YEARS);
  const monthlyHousing = mortgage + (price * TAX) / 12 + HEAT;
  const income = Math.round((monthlyHousing * 12) / GDS / 1000) * 1000;

  return {
    attribution: ATTRIBUTION,
    city: city.name,
    price: { amount: price, source: args.prix != null ? 'Price provided by the caller' : `Reference market price (${city.board ?? 'board'}${city.referenceMonth ? ', ' + city.referenceMonth : ''})` },
    requiredHouseholdIncome: income,
    qualifyingRate: { percent: qualRate, how: `max(5.25% regulatory floor, ${rate.percent}% average 5-year fixed + 2 pts) — Bank of Canada, observed ${rate.observed}` },
    assumptions: '20% down · 25-year amortization · 39% GDS (insured-loan standard) · property taxes ~1%/yr · heating $150/mo · NO other debts · Canadian semi-annual compounding. Rounded to the nearest $1,000.',
    caveats: 'A theoretical qualification threshold, not a loan offer: real taxes, debts (TDS ~44%) and lender grids change the result — a verified mortgage broker runs it with the user’s numbers (use trouver_expert). A 30-year amortization (first-time buyers/new builds on insured loans, or 20%+ down) lowers the required income by roughly 8-10%. Methodology: https://payotte.com/salaire-pour-acheter-une-maison-canada (EN: https://payotte.com/en/income-needed-to-buy-a-house-canada).',
  };
}

// ---------------------------------------------------------------- taux_courants

// Séries Valet de la Banque du Canada (mêmes que scripts/fetch-rates.mjs côté site).
const RATE_SERIES = [
  { key: 'policyRate',       id: 'V39079',      label: 'Policy interest rate (target overnight rate)' },
  { key: 'primeRate',        id: 'V80691311',   label: 'Prime rate' },
  { key: 'mortgage5yrFixed', id: 'V122667786',  label: 'Fixed mortgage 5 years and over (uninsured, market reference)' },
  { key: 'mortgageVariable', id: 'V122667782',  label: 'Variable-rate mortgage (uninsured, market reference)' },
];

// Obligations de référence (mêmes séries que scripts/fetch-bonds.mjs côté site). Lues en
// direct pour la valeur du jour ; les variations (pb) et le canal 52 semaines viennent du
// feed /api/bonds.json — calculés par le script du site, jamais recalculés ici (Règle #3).
const BOND_SERIES = [
  { key: 'gov2yr',  id: 'BD.CDN.2YR.DQ.YLD',  label: 'Government of Canada benchmark bond — 2-year' },
  { key: 'gov5yr',  id: 'BD.CDN.5YR.DQ.YLD',  label: 'Government of Canada benchmark bond — 5-year' },
  { key: 'gov10yr', id: 'BD.CDN.10YR.DQ.YLD', label: 'Government of Canada benchmark bond — 10-year' },
];

const BOC_ATTRIBUTION =
  'Rate data © Bank of Canada (Valet API), used under the Bank of Canada terms of use ' +
  '(https://www.bankofcanada.ca/terms/); relayed by Payotte (https://payotte.com).';

async function tauxCourants() {
  const results = await Promise.all(
    RATE_SERIES.concat(BOND_SERIES).map(async (s) => {
      try {
        const res = await fetch(`https://www.bankofcanada.ca/valet/observations/${s.id}/json?recent=1`, {
          cf: { cacheTtl: 3600, cacheEverything: true },
          headers: { 'User-Agent': 'payotte-mcp/1.5 (+https://payotte.com)' },
        });
        if (!res.ok) return [s.key, { label: s.label, series: s.id, percent: null, observed: null }];
        const data = await res.json();
        const obs = data.observations?.[0];
        const v = obs?.[s.id]?.v;
        return [s.key, { label: s.label, series: s.id, percent: v == null || v === '' ? null : Number(v), observed: obs?.d ?? null }];
      } catch {
        return [s.key, { label: s.label, series: s.id, percent: null, observed: null }];
      }
    }),
  );
  const byKey = Object.fromEntries(results);
  const rateKeys = RATE_SERIES.map((s) => s.key);
  const bondKeys = BOND_SERIES.map((s) => s.key);

  // Décisions récentes + prochaines annonces : lues sur le feed du site (une source, déjà daté).
  let rateDecisions = [], upcomingDecisions = [], lastChange = null;
  try {
    const feedData = await feed('/api/rates.json');
    rateDecisions = (feedData.rateDecisions ?? []).slice(0, 6);
    upcomingDecisions = feedData.upcomingDecisions ?? [];
    lastChange = feedData.lastChange ?? null;
  } catch { /* le feed peut être indisponible : les taux live suffisent */ }

  // Variations (pb) + canal 52 semaines des obligations : mêmes clés que BOND_SERIES sur le
  // feed /api/bonds.json. Feed indisponible → le rendement du jour part quand même, sans deltas.
  let curve2to10 = null;
  try {
    const bondsFeed = await feed('/api/bonds.json');
    for (const key of bondKeys) {
      const extra = bondsFeed.bonds?.[key];
      if (extra && byKey[key]) {
        const { change1mBps, ref1m, change3mBps, ref3m, change1yBps, ref1y, low52w, high52w } = extra;
        Object.assign(byKey[key], { change1mBps, ref1m, change3mBps, ref3m, change1yBps, ref1y, low52w, high52w });
      }
    }
    curve2to10 = bondsFeed.curve2to10 ?? null;
  } catch { /* idem : les rendements live suffisent */ }

  return {
    attribution: BOC_ATTRIBUTION,
    dataSource: 'Bank of Canada',
    note: 'Mortgage rates are financial-system averages, not a lender offer; each rate carries its own observation date. For a verified mortgage broker, use trouver_expert.',
    rates: Object.fromEntries(rateKeys.map((k) => [k, byKey[k]])),
    bondYields: {
      note: 'Government of Canada benchmark bond yields. The 5-year yield underpins 5-year fixed mortgage rates: when it rises, fixed rates follow within days. NOT a mortgage rate — the leading indicator behind one. Changes in basis points (bps): 100 bps = 1%.',
      yields: Object.fromEntries(bondKeys.map((k) => [k, byKey[k]])),
      curve2to10,
    },
    lastChange,
    recentDecisions: rateDecisions,
    upcomingDecisions,
  };
}

/**
 * macroCourant() — les chiffres nationaux des COURRIELS, lus en direct comme ceux de l'outil.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * POURQUOI (2026-08-19)
 * ─────────────────────────────────────────────────────────────────────────────────
 * Le bulletin lisait `/api/rates.json` et `/api/bonds.json` — deux fichiers STATIQUES du
 * site, régénérés seulement quand Grégory déploie. Entre deux déploiements ils vieillissent
 * sans le dire. Or `taux_courants`, l'outil MCP, interroge la Banque du Canada en direct :
 * le même worker pouvait donc répondre 2,25 % à une IA et écrire 2,50 % dans un courriel
 * parti la même heure. À des COURTIERS HYPOTHÉCAIRES, dont c'est le métier de connaître le
 * taux du jour. Une divergence pareille coûte la crédibilité de tout le reste du message.
 *
 * `tauxCourants()` fait déjà le travail (Valet, cache 1 h côté Cloudflare) : cette fonction
 * ne fait que traduire sa forme vers celle qu'attend `nationalBlock()`.
 *
 * ⚠️ ET ELLE RÉPARE UN BOGUE. `nationalBlock()` lit `macro.bonds`, alors que `tauxCourants()`
 * renvoie ses rendements sous `bondYields.yields`. Le courriel S3 de la séquence recevait
 * directement la sortie de `tauxCourants()` (l. ~2693) : `macro.bonds` valait `{}`, et le
 * bloc obligation disparaissait — dans le SEUL courriel de la séquence dont le sujet est
 * précisément l'obligation 5 ans qui mène le taux fixe. Sans erreur, sans trace.
 *
 * Les variations (pb) et le canal 52 semaines restent CALCULÉS PAR LE SITE : `tauxCourants()`
 * les fusionne depuis `/api/bonds.json`. Le worker ne recalcule aucun delta (Règle #3) — il
 * lit la valeur du jour à la source, et l'historique là où il est déjà établi.
 *
 * Panne de la Banque du Canada → `null`, et `nationalBlock()` rend une chaîne vide : le bloc
 * disparaît, aucun envoi n'est bloqué. Un courriel sans encadré de taux part quand même ;
 * un courriel avec un FAUX taux, non.
 */
async function macroCourant() {
  try {
    const t = await tauxCourants();
    const rates = t?.rates ?? null;
    const bonds = t?.bondYields?.yields ?? null;
    // Tous les champs à null (Valet injoignable) : autant ne rien annoncer.
    const utile = (o) => o && Object.values(o).some((v) => v?.percent != null);
    if (!utile(rates) && !utile(bonds)) return null;
    return { rates, bonds, fetched: new Date().toISOString() };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- contacter_expert

const DAY_CAP_GLOBAL = 40;      // marge sous le palier Resend gratuit (100/jour)
const DAY_CAP_EXPERT = 3;       // protège chaque pro du spam
const DAY_CAP_REQUESTER = 5;    // par courriel de demandeur (audit §8b)
const PENDING_TTL = 48 * 3600;  // le lien de confirmation vit 48 h

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Le domaine du courriel existe-t-il vraiment ? (DNS-over-HTTPS, MX puis A — audit §8c.)
// En cas de panne DNS on laisse passer : mieux vaut un faux positif qu'un service mort.
async function domainExists(email) {
  const domain = email.split('@')[1];
  try {
    for (const type of ['MX', 'A']) {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
        { headers: { Accept: 'application/dns-json' } });
      if (!res.ok) return true;
      const d = await res.json();
      if (d.Status === 0 && Array.isArray(d.Answer) && d.Answer.length) return true;
    }
    return false;
  } catch { return true; }
}

// Filtre de contenu minimal (audit §8f) : un message de client n'est pas une page de liens.
const looksLikeSpam = (msg) => (msg.match(/https?:\/\//g) ?? []).length >= 3;

async function bumpCounter(env, key, ttlSeconds) {
  if (!env?.COUNTERS) return 0; // dev local sans KV
  const n = parseInt((await env.COUNTERS.get(key)) ?? '0', 10) + 1;
  await env.COUNTERS.put(key, String(n), { expirationTtl: ttlSeconds });
  return n;
}

// PHASE 1 (l'outil) — DOUBLE OPT-IN (audit §8) : on n'envoie RIEN à l'expert ici.
// On valide, on crée une demande en attente (KV, 48 h) et on envoie un lien de
// confirmation AU DEMANDEUR. La preuve de consentement devient un clic humain
// dans sa propre boîte courriel — plus un booléen posé par un modèle.
async function contacterExpert(args = {}, env = {}) {
  // 1. Garde-fous d'entrée — le consentement déclaré d'abord (nécessaire mais plus suffisant).
  if (args.consentement !== true) {
    return { error: 'Consent missing: ask the user to explicitly approve sending this request to this expert, then call again with consentement=true.' };
  }
  const nom = String(args.client_nom ?? '').trim();
  const courriel = String(args.client_courriel ?? '').trim().toLowerCase();
  const message = String(args.message ?? '').trim();
  if (!nom || !EMAIL_RE.test(courriel)) return { error: 'client_nom and a valid client_courriel are required.' };
  if (message.length < 20 || message.length > 2000) return { error: 'message must be between 20 and 2000 characters.' };
  if (looksLikeSpam(message)) return { error: 'Message rejected: too many links for a contact request. Write a plain-language message describing the need.' };
  if (!(await domainExists(courriel))) return { error: `The email domain "${courriel.split('@')[1]}" does not resolve — double-check the user's email address.` };

  // 2. Résoudre UN expert, sans ambiguïté.
  const r = await resolveExperts(args);
  if (r.error) return r;
  if (!r.matches.length) return { error: 'No listed expert matches this query — use trouver_expert to explore, or broaden the search.' };
  if (r.matches.length > 1) {
    return {
      error: `Ambiguous: ${r.matches.length} experts match. Add "secteur" (and province) to identify exactly one.`,
      candidates: r.matches.slice(0, 10).map((e) => ({ name: e.name, profession: e.professionLabel, location: `${e.sectorName}, ${e.cityName}`, url: mcpSrc(e.url) })),
    };
  }
  const expert = r.matches[0];

  // 3. Retrait de l'expert (audit §8e) : respecté avant toute chose.
  if (env.COUNTERS && (await env.COUNTERS.get(`optout:${expert.slug}`))) {
    return { error: `This expert has opted out of relayed requests. The user can reach them via their profile page: ${mcpSrc(expert.url)}` };
  }

  // 4. Plafond par DEMANDEUR (audit §8b) — compteur sur empreinte HMAC, jamais l'adresse en clair.
  const day = new Date().toISOString().slice(0, 10);
  if (env.COUNTERS) {
    const rh = (await hmacHex(env, courriel)).slice(0, 16);
    const rN = await bumpCounter(env, `r:${rh}:${day}`, 3 * 86400);
    if (rN > DAY_CAP_REQUESTER) return { error: 'Daily limit reached for this requester — please try again tomorrow.' };
  }

  // 5. Modes dégradés : sans KV ou sans courriel, on répète sans rien envoyer ni stocker.
  if (!env.COUNTERS || !env.RESEND_API_KEY) {
    return {
      simulated: true,
      pendingConfirmation: true,
      note: 'DRY RUN — service not fully configured; nothing was stored or sent. In production, a confirmation link would be emailed to the user, and the request would reach the expert only after they click it (valid 48 h).',
      expert: { name: expert.name, profession: expert.professionLabel, url: mcpSrc(expert.url) },
    };
  }

  // 6. Demande en attente (KV, TTL 48 h) + lien de confirmation au DEMANDEUR.
  const token = crypto.randomUUID();
  await env.COUNTERS.put(`p:${token}`, JSON.stringify({
    slug: expert.slug, nom, courriel,
    tel: args.client_telephone ? String(args.client_telephone).trim() : null,
    message, lang: expert.lang, created: new Date().toISOString(),
  }), { expirationTtl: PENDING_TTL });

  const frC = expert.lang === 'fr';
  const confirmUrl = `${WORKER_ORIGIN}/confirm?t=${token}`;
  const confRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
      to: [courriel],
      subject: frC
        ? `Confirmez votre demande de contact — ${expert.name} (Payotte)`
        : `Confirm your contact request — ${expert.name} (Payotte)`,
      text: (frC
        ? [
            `Bonjour ${nom},`, '',
            `Votre assistant IA a préparé, avec votre accord, une demande de contact pour ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`, '',
            `Votre message :`, message, '',
            `Pour la transmettre, cliquez (valide 48 h) :`, confirmUrl, '',
            `Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel — RIEN ne sera envoyé sans ce clic.`, '',
            `Payotte ne conserve pas le contenu de votre demande. https://payotte.com`,
          ]
        : [
            `Hello ${nom},`, '',
            `Your AI assistant prepared, with your approval, a contact request for ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`, '',
            `Your message:`, message, '',
            `To send it, click (valid 48 h):`, confirmUrl, '',
            `If you did not initiate this request, ignore this email — NOTHING will be sent without this click.`, '',
            `Payotte keeps no copy of your request. https://payotte.com`,
          ]).join('\n'),
    }),
  });
  if (!confRes.ok) {
    await env.COUNTERS.delete(`p:${token}`);
    return { error: `Could not email the confirmation link (HTTP ${confRes.status}). The user can contact the expert from their profile page: ${mcpSrc(expert.url)}` };
  }

  return {
    pendingConfirmation: true,
    sent: false,
    expert: { name: expert.name, profession: expert.professionLabel, location: `${expert.sectorName}, ${expert.cityName}`, url: mcpSrc(expert.url) },
    note: frC
      ? `Un lien de confirmation vient d'être envoyé à ${courriel}. La demande ne sera transmise à ${expert.name} QU'APRÈS le clic (lien valide 48 h). Dites à l'utilisateur de vérifier sa boîte de réception.`
      : `A confirmation link was just emailed to ${courriel}. The request will reach ${expert.name} ONLY AFTER the click (link valid 48 h). Tell the user to check their inbox.`,
    attribution: ATTRIBUTION,
  };
}

// PHASE 2 (route /confirm) — le clic humain déclenche le relais réel vers l'expert.
async function confirmRelay(env, url) {
  const token = String(url.searchParams.get('t') ?? '');
  if (!env.COUNTERS || !/^[0-9a-f-]{36}$/.test(token)) return subPage('fr', 'Lien invalide / Invalid link', 'Ce lien de confirmation est invalide. / This confirmation link is invalid.');
  const raw = await env.COUNTERS.get(`p:${token}`);
  if (!raw) return subPage('fr', 'Lien expiré / Expired link', 'Ce lien a expiré (48 h) ou a déjà été utilisé. Redemandez à votre assistant. / This link expired (48 h) or was already used.');
  const pending = JSON.parse(raw);
  const fr = pending.lang === 'fr';
  const { nom, courriel, message } = pending;

  // L'expert et son courriel, relus à la source au moment du clic (jamais figés en KV).
  let expert = null;
  try { expert = (await allExperts()).find((e) => e.slug === pending.slug) ?? null; } catch { /* feed indispo */ }
  if (!expert) return subPage(pending.lang, fr ? 'Fiche introuvable' : 'Profile not found', fr ? "Cette fiche n'est plus publiée — la demande n'a pas été transmise." : 'This profile is no longer listed — the request was not relayed.');
  if (await env.COUNTERS.get(`optout:${expert.slug}`)) {
    await env.COUNTERS.delete(`p:${token}`);
    return subPage(pending.lang, fr ? 'Non transmis' : 'Not relayed', fr ? `${expert.name} ne reçoit plus de demandes relayées. Ses coordonnées publiques : ${expert.url}` : `${expert.name} has opted out of relayed requests. Public contact details: ${expert.url}`);
  }
  let contact = null;
  if (env.CONTACTS_TOKEN) { try { contact = (await feed(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts?.[expert.slug] ?? null; } catch { /* annuaire indispo */ } }
  if (!contact) return subPage(pending.lang, fr ? 'Non transmis' : 'Not relayed', fr ? `Aucun courriel au dossier pour cet expert. Sa fiche : ${expert.url}` : `No email on file for this expert. Profile: ${expert.url}`);

  // Plafonds anti-abus, appliqués AU CLIC (compteurs agrégés — aucun contenu conservé).
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const gN = await bumpCounter(env, `g:${day}`, 3 * 86400);
  if (gN > DAY_CAP_GLOBAL) return subPage(pending.lang, fr ? 'Réessayez demain' : 'Try again tomorrow', fr ? 'Limite quotidienne de relais atteinte — recliquez le lien demain (il reste valide 48 h).' : 'Daily relay limit reached — click the link again tomorrow (valid 48 h).');
  const eN = await bumpCounter(env, `e:${expert.slug}:${day}`, 3 * 86400);
  if (eN > DAY_CAP_EXPERT) return subPage(pending.lang, fr ? 'Réessayez demain' : 'Try again tomorrow', fr ? 'Cet expert a atteint son maximum de demandes relayées aujourd’hui — recliquez demain.' : 'This expert reached today’s relayed-request maximum — click again tomorrow.');
  await bumpCounter(env, `m:${expert.slug}:${month}`, 400 * 86400); // futur rapport « les IA t'ont recommandé »
  // Trace de consentement MINIMALE (audit §8d, compatible « rien conservé ») :
  // horodatage + empreinte HMAC du courriel + expert — JAMAIS le contenu.
  await env.COUNTERS.put(`cl:${token}`, JSON.stringify({ ts: new Date().toISOString(), rh: (await hmacHex(env, courriel)).slice(0, 16), slug: expert.slug }), { expirationTtl: 400 * 86400 });

  const frX = contact.lang === 'fr';
  const subject = frX
    ? `Nouvelle demande de contact via Payotte — ${nom}`
    : `New contact request via Payotte — ${nom}`;
  const lines = frX
    ? [
        `Bonjour ${contact.name},`, '',
        `Un client vous envoie une demande de contact via votre fiche Payotte (${expert.url}), préparée par son assistant IA et CONFIRMÉE par le client lui-même (clic sur un lien reçu à son adresse).`, '',
        `Nom : ${nom}`, `Courriel : ${courriel}`,
        ...(pending.tel ? [`Téléphone : ${pending.tel}`] : []), '',
        `Message :`, message, '',
        `— Répondez directement au client (bouton Répondre).`,
        `Payotte relaie sans conserver le contenu de cette demande. Pour ne plus recevoir de demandes relayées : répondez « retrait » à ce courriel. https://payotte.com`,
      ]
    : [
        `Hello ${contact.name},`, '',
        `A client is sending you a contact request through your Payotte profile (${expert.url}), prepared by their AI assistant and CONFIRMED by the client themselves (click on a link received at their address).`, '',
        `Name: ${nom}`, `Email: ${courriel}`,
        ...(pending.tel ? [`Phone: ${pending.tel}`] : []), '',
        `Message:`, message, '',
        `— Reply directly to the client (Reply button).`,
        `Payotte relays this request without keeping its content. To stop receiving relayed requests: reply "opt out". https://payotte.com`,
      ];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
      to: [contact.email],
      reply_to: courriel,
      subject,
      text: lines.join('\n'),
    }),
  });
  if (!res.ok) {
    return subPage(pending.lang, frX ? 'Échec du relais' : 'Relay failed', frX ? `L'envoi a échoué (HTTP ${res.status}) — recliquez le lien dans quelques minutes, ou joignez l'expert via sa fiche : ${expert.url}` : `Sending failed (HTTP ${res.status}) — click the link again in a few minutes, or reach the expert via their profile: ${expert.url}`);
  }

  await env.COUNTERS.delete(`p:${token}`);   // usage unique
  return subPage(pending.lang,
    frX ? 'Demande transmise ✓' : 'Request relayed ✓',
    frX
      ? `Votre demande a été transmise à ${expert.name} (${expert.professionLabel}, ${expert.cityName}). Sa réponse arrivera directement à ${courriel}. Payotte ne conserve pas le contenu de votre demande.`
      : `Your request was relayed to ${expert.name} (${expert.professionLabel}, ${expert.cityName}). The reply will arrive directly at ${courriel}. Payotte keeps no copy of your request.`,
    expert.url);
}

const TOOL_IMPL = {
  trouver_expert: trouverExpert,
  verifier_titre: verifierTitre,
  stats_marche: statsMarche,
  taux_courants: tauxCourants,
  taxe_mutation: taxeMutation,
  acheter_ou_louer: acheterOuLouer,
  salaire_requis: salaireRequis,
  contacter_expert: contacterExpert,
};

// ---------------------------------------------------------------- bulletin de marché (audience possédée)
// Abonnement zéro-JS depuis les pages ville (POST de formulaire pur), bienvenue immédiate
// avec les stats de la ville, envoi mensuel par cron. On ne stocke QUE courriel+ville+langue
// +date de consentement (LCAP) dans KV. Désabonnement en un clic (HMAC, clé = CONTACTS_TOKEN).

const SUB_CAP_DAY = 30;   // garde-fou anti-abus sur les inscriptions
// Le plafond d'envois par exécution n'est plus un chiffre en dur : il se déduit du budget
// de sous-requêtes, plus bas (SUBREQUEST_BUDGET).

async function hmacHex(env, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.CONTACTS_TOKEN || 'dev'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function subPage(lang, title, message, cityUrl) {
  const fr = lang === 'fr';
  const back = cityUrl ? `<p><a href="${esc(cityUrl)}">${fr ? '← Retour à la page de la ville' : '← Back to the city page'}</a></p>` : `<p><a href="${SITE}">payotte.com</a></p>`;
  return new Response(
    `<!doctype html><html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1a1a1a;line-height:1.6}h1{font-size:1.4em}a{color:#C8102E}</style></head><body><h1>${esc(title)}</h1><p>${esc(message)}</p>${back}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } },
  );
}

const fmtMoney = (n, fr) => (n == null ? null : fr ? `${n.toLocaleString('fr-CA')} $` : `$${n.toLocaleString('en-CA')}`);
const fmtPct = (p, fr) => (p == null ? null : `${p >= 0 ? '+' : ''}${p.toLocaleString(fr ? 'fr-CA' : 'en-CA')} %`);

// Compose le bulletin depuis /api/market.json — champs présents seulement, rien d'inventé.
function bulletinText(city, lang, unsubUrl, welcome) {
  const fr = lang === 'fr';
  const refPrice = city.benchmarkHpi ?? city.medianPrice;
  const refLabel = city.benchmarkHpi ? (fr ? 'Prix repère MLS' : 'MLS benchmark price') : (fr ? 'Prix médian' : 'Median price');
  const L = [];
  L.push(fr ? `Le pouls du marché — ${city.name}` : `Market pulse — ${city.name}`);
  if (city.referenceMonth) L.push(fr ? `(données de référence : ${city.referenceMonth}, ${city.board ?? 'chambre immobilière'})` : `(reference data: ${city.referenceMonth}, ${city.board ?? 'real-estate board'})`);
  L.push('');
  if (refPrice != null) L.push(`• ${refLabel} : ${fmtMoney(refPrice, fr)}${city.benchmarkYoyPct != null ? ` (${fmtPct(city.benchmarkYoyPct, fr)} ${fr ? 'sur un an' : 'year over year'})` : ''}`);
  if (city.sales != null) L.push(`• ${fr ? 'Ventes' : 'Sales'} : ${city.sales.toLocaleString(fr ? 'fr-CA' : 'en-CA')}${city.salesYoyPct != null ? ` (${fmtPct(city.salesYoyPct, fr)})` : ''}`);
  if (city.monthsOfInventory != null) L.push(`• ${fr ? "Mois d'inventaire" : 'Months of inventory'} : ${city.monthsOfInventory}`);
  if (city.avgDaysOnMarket != null) L.push(`• ${fr ? 'Délai de vente moyen' : 'Average days on market'} : ${city.avgDaysOnMarket} ${fr ? 'jours' : 'days'}`);
  if (city.growth5yPct != null) L.push(`• ${fr ? 'Croissance sur 5 ans' : '5-year growth'} : ${fmtPct(city.growth5yPct, fr)}`);
  L.push('');
  L.push(fr
    ? `Besoin d'un professionnel de confiance ? Un seul expert vérifié par secteur et par métier, permis publié : ${SITE}`
    : `Need a professional you can trust? One verified expert per sector and trade, licence published: ${SITE}`);
  if (Array.isArray(city.sources) && city.sources.length) L.push('', (fr ? 'Sources : ' : 'Sources: ') + city.sources.join(' · '));
  L.push('', '—', fr
    ? `Vous recevez ce courriel parce que vous vous êtes abonné au bulletin de ${city.name} sur payotte.com.${welcome ? ' (Voici votre premier bulletin, envoyé sur-le-champ.)' : ''}`
    : `You are receiving this because you subscribed to the ${city.name} bulletin on payotte.com.${welcome ? ' (Here is your first bulletin, sent right away.)' : ''}`);
  L.push(fr ? `Se désabonner (un clic) : ${unsubUrl}` : `Unsubscribe (one click): ${unsubUrl}`);
  return L.join('\n');
}

async function sendBulletin(env, origin, email, city, lang, welcome = false) {
  const t = await hmacHex(env, `u:${email}:${city.slug}`);
  const unsubUrl = `${origin}/unsubscribe?e=${encodeURIComponent(email)}&c=${encodeURIComponent(city.slug)}&t=${t}`;
  const fr = lang === 'fr';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [email],
      reply_to: REPLY_TO,
      subject: fr ? `Le pouls du marché — ${city.name}` : `Market pulse — ${city.name}`,
      text: bulletinText(city, lang, unsubUrl, welcome),
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  });
  return res.ok;
}

// ================================================================
// MACHINE DU BULLETIN — segmentation prospect/expert + étape + rendu HTML
// ================================================================
// S'ADAPTE AUX MODIFS DU MOIS : la machine lit l'état VIVANT à chaque envoi —
// /api/market.json (marché) et /api/experts/{prov}.json (score.color, ownerVerified,
// badgeExchange). Un prix rafraîchi, une fiche confirmée, un badge posé ou un score
// monté pendant le mois est donc reflété automatiquement au prochain 1er. Aucun état
// figé n'est mémorisé. Données = champs PRÉSENTS seulement, jamais d'analyse inventée (Règle #3).

const LOGO = 'https://payotte.com/payotte-logo-transparent.png';
// Plus de copie BCC de chaque envoi (décision proprio, 2 août 2026 : illisible à 500 courriels).
// À la place, UN récapitulatif par exécution — sans lui, un envoi raté ne laisse aucune trace.
const REPORT_TO = 'gpayotte@gmail.com';

// ⚠️ ADRESSE DE RÉPONSE — corrigée le 2026-08-19, et c'est une PANNE, pas une préférence.
// `gregory@payotte.com` était le reply_to de TOUS les envois (bulletin, experts, lots).
// Or `payotte.com` n'a AUCUN enregistrement MX (`dig payotte.com MX` → vide) : le renvoi
// GoDaddy est mort. Dernier courriel reçu à cette adresse : 26 mai 2026. Chaque courriel
// qui disait « répondez à ce courriel » depuis au moins trois mois envoyait la réponse
// dans le vide — y compris les 217 présentations ⓪ et les vagues de relance d'août.
// Le même constat était DÉJÀ écrit plus bas pour le formulaire de contact (relais du
// 2026-08-17, « testé le 17 août : le message n'arrive nulle part ») sans que le reply_to
// des envois n'en tire la conséquence.
// Si un jour un MX est rétabli sur payotte.com, cette constante redevient l'adresse de
// marque — mais seulement après un test d'arrivée horodaté, pas sur la foi du réglage.
const REPLY_TO = 'gpayotte@gmail.com';

// Jours entre le relevé d'une fiche (`verifiedDate`) et le droit de présenter Payotte à
// son professionnel. Voir `expertStage()`.
const QUARANTAINE_INTRO_JOURS = 7;

// Étape d'un expert d'après son état vivant. `introduced` = il a déjà reçu la présentation ⓪.
// OPT-OUT (décision proprio, 2 août 2026) : personne n'a à dire « oui ». Après la présentation,
// l'expert monte dans l'escalier ①②③④ d'office, chaque mois, jusqu'à ce qu'il dise non
// (clic sur le lien de désabonnement → clé `unsub:{slug}`, seul motif d'exclusion).
function expertStage(expert, introduced) {
  const c = expert?.score?.color;
  if (!c || c === 'red') return null;          // rouge = non publié → pas de bulletin
  // ── QUARANTAINE DE LA PRÉSENTATION (2026-08-19) ──────────────────────────────────
  // La ⓪ dit « c'est vous que j'ai retenu, sur la foi de données publiques » : elle ne
  // doit jamais partir sur une fiche qui vient d'être relevée et pas encore relue. Sept
  // jours après `verifiedDate`, c'est le délai pendant lequel une erreur de relevé se
  // corrige encore sans que personne dehors ne l'ait vue. Précédent : les deux agents qui
  // ont FABRIQUÉ une ancienneté en juillet (« licensed since 2005 » introuvable sur le
  // site cité) — une ⓪ partie le jour même aurait porté ce chiffre inventé au principal
  // intéressé. Le coût du délai est nul : l'expert entre au cycle suivant.
  // Une fiche sans `verifiedDate` n'est pas retenue en quarantaine (le champ manque sur
  // ~10 fiches anciennes) — on ne bloque pas sur une donnée absente, on ne devine pas.
  if (!introduced && expert?.verifiedDate) {
    const jours = (Date.now() - Date.parse(expert.verifiedDate)) / 86400000;
    if (Number.isFinite(jours) && jours < QUARANTAINE_INTRO_JOURS) return null;
  }
  if (!introduced) return 'intro';             // ⓪ présentation (une seule fois dans la vie)
  if (c === 'yellow') return 'yellow';         // ① monter vers le vert
  if (!expert.ownerVerified) return 'green';   // ② confirmer → Recommandé
  if (!expert.badgeExchange) return 'reco';    // ③ poser le badge
  return 'partner';                            // ④ rien à demander
}

// La donnée manquante la plus payante d'un expert (coup de coude ①/⓪), tirée du feed.
function missingAsk(expert, fr) {
  if (!expert.licence?.number && expert.licence?.body)
    return fr ? `votre numéro de permis ${expert.licence.body}` : `your ${expert.licence.body} licence number`;
  if (!expert.experience) return fr ? `l'année où vous avez commencé à exercer` : `the year you began practising`;
  if (!expert.google) return fr ? `le lien de votre profil Google` : `your Google profile link`;
  return fr ? `une distinction vérifiable (prix du secteur, mention presse)` : `a verifiable distinction (award, press mention)`;
}

const S = (label, val) => `<td width="50%" style="padding:14px 0;border-bottom:1px solid #f1ecec;font-family:Arial,Helvetica,sans-serif;"><span style="font-size:13px;color:#8a8284;">${label}</span><br><span style="font-size:16px;color:#211c1e;font-weight:bold;">${val}</span></td>`;

// Cœur commun : logo + repère + grille + source. eyebrow = texte à droite du logo.
function marketCore(city, fr, eyebrow) {
  const ref = city.benchmarkHpi ?? city.medianPrice;
  const refYoy = city.benchmarkYoyPct;
  const grn = (t) => `<span style="font-size:12px;color:#1f7a44;font-weight:normal;">${t}</span>`;
  const cells = [];
  if (city.averagePrice != null) cells.push([fr ? 'Prix moyen' : 'Average price', fmtMoney(city.averagePrice, fr) + (city.averageYoyPct != null ? ' ' + grn(fmtPct(city.averageYoyPct, fr)) : '')]);
  if (city.sales != null) cells.push([fr ? 'Ventes du mois' : 'Sales', city.sales.toLocaleString(fr ? 'fr-CA' : 'en-CA') + (city.salesYoyPct != null ? ' ' + grn(fmtPct(city.salesYoyPct, fr)) : '')]);
  if (city.monthsOfInventory != null) cells.push([fr ? "Mois d'inventaire" : 'Months of inventory', String(city.monthsOfInventory)]);
  if (city.avgDaysOnMarket != null) cells.push([fr ? 'Délai de vente' : 'Days on market', city.avgDaysOnMarket + (fr ? ' jours' : ' days')]);
  let gridRows = '';
  for (let i = 0; i < cells.length; i += 2) gridRows += `<tr>${S(cells[i][0], cells[i][1])}${cells[i + 1] ? S(cells[i + 1][0], cells[i + 1][1]) : '<td width="50%"></td>'}</tr>`;
  const refLine = ref != null
    ? `<div style="font-family:Georgia,'Times New Roman',serif;font-size:34px;color:#211c1e;line-height:1;">${fmtMoney(ref, fr)}</div>
       <div style="font-size:13px;color:#6f6769;margin:9px 0 22px 0;">${fr ? 'Prix de référence' : 'Reference price'} (${city.benchmarkHpi ? (fr ? 'repère MLS' : 'MLS benchmark') : (fr ? 'médiane' : 'median')})${refYoy != null ? ` &middot; <span style="color:#1f7a44;font-weight:bold;">${fmtPct(refYoy, fr)} ${fr ? 'sur un an' : 'YoY'}</span>` : ''}</div>`
    : '';
  const src = Array.isArray(city.sources) && city.sources.length ? city.sources[0] : city.board;
  return `<tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td><td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;line-height:1.5;">${eyebrow}</td></tr></table></td></tr>
    <tr><td style="padding:28px 32px 6px 32px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.3;color:#211c1e;margin-bottom:20px;">${fr ? 'Le pouls du marché' : 'The market pulse'} &mdash; ${city.name}</div>
      ${refLine}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${gridRows}</table>
      <div style="font-size:11.5px;color:#a49c9e;margin-top:14px;">${fr ? 'Source' : 'Source'} : ${src ?? 'chambre immobilière'}${city.referenceMonth ? ` &middot; ${city.referenceMonth}` : ''}</div>
    </td></tr>`;
}

// ---- Bloc NATIONAL : taux et obligations ---------------------------------------------
// Identique pour tous les destinataires, donc rapatrié UNE fois par exécution et non par
// courriel : deux sous-requêtes au total, pas deux par envoi.
//
// Pourquoi l'ajouter : le bulletin ne montrait que les 5 chiffres récoltés à la main auprès
// des chambres immobilières. Les taux et les obligations sont collectés automatiquement
// depuis la Banque du Canada et ne coûtaient rien à personne — ils dormaient. Ils comptent
// surtout pour les 39 villes qui n'ont AUCUNE autre source automatique : c'est le seul
// contenu qu'on puisse leur ajouter sans nouvelle récolte.
//
// Le 5 ans a sa place ici et nulle part ailleurs : c'est ce qui fait bouger le fixe 5 ans
// quelques jours plus tard. Un courtier hypothécaire le sait ; un courtier immobilier, rarement.
function nationalBlock(macro, fr) {
  if (!macro) return '';
  const r = macro.rates || {};
  const b = macro.bonds || {};
  const pct = (v) => (v == null ? null : `${v.toLocaleString(fr ? 'fr-CA' : 'en-CA')} %`);
  // CHAQUE chiffre porte sa date d'observation, parce qu'elles diffèrent de plusieurs mois :
  // le taux directeur est quotidien, mais les moyennes hypothécaires de la Banque du Canada
  // sont MENSUELLES et publiées avec du retard — au 6 août 2026, elles dataient du 1er mai.
  // Afficher « fixe 5 ans : 4,34 % » sans cette date, à des courtiers hypothécaires qui
  // connaissent le marché du jour, décrédibiliserait tout le reste du courriel.
  const daté = (v) => (v?.observed ? `<span style="font-size:11px;color:#a49c9e;font-weight:normal;"> &middot; ${v.observed}</span>` : '');
  const cells = [];
  if (r.policyRate?.percent != null) cells.push([fr ? 'Taux directeur' : 'Policy rate', pct(r.policyRate.percent) + daté(r.policyRate)]);
  if (r.primeRate?.percent != null) cells.push([fr ? 'Taux préférentiel' : 'Prime rate', pct(r.primeRate.percent) + daté(r.primeRate)]);
  if (r.mortgage5yrFixed?.percent != null) cells.push([fr ? 'Fixe 5 ans (moyenne)' : '5-yr fixed (average)', pct(r.mortgage5yrFixed.percent) + daté(r.mortgage5yrFixed)]);
  if (r.mortgageVariable?.percent != null) cells.push([fr ? 'Variable (moyenne)' : 'Variable (average)', pct(r.mortgageVariable.percent) + daté(r.mortgageVariable)]);
  const g5 = b.gov5yr;
  if (!cells.length && g5?.percent == null) return '';

  let gridRows = '';
  for (let i = 0; i < cells.length; i += 2) gridRows += `<tr>${S(cells[i][0], cells[i][1])}${cells[i + 1] ? S(cells[i + 1][0], cells[i + 1][1]) : '<td width="50%"></td>'}</tr>`;

  // L'obligation 5 ans, avec sa variation sur un mois : le signal avancé du taux fixe.
  let bondLine = '';
  if (g5?.percent != null) {
    const d = g5.change1mBps;
    const sens = d == null ? '' : d > 0
      ? (fr ? `en hausse de ${d} pb sur un mois` : `up ${d} bps over the month`)
      : d < 0 ? (fr ? `en baisse de ${Math.abs(d)} pb sur un mois` : `down ${Math.abs(d)} bps over the month`)
        : (fr ? 'stable sur un mois' : 'flat over the month');
    const couleur = d == null || d === 0 ? '#6f6769' : d > 0 ? '#b3261e' : '#1f7a44';
    bondLine = `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #f1ecec;">
      <span style="font-size:13px;color:#8a8284;">${fr ? 'Obligation du Canada 5 ans' : 'Government of Canada 5-yr bond'}</span><br>
      <span style="font-size:16px;color:#211c1e;font-weight:bold;">${pct(g5.percent)}</span>${g5.observed ? `<span style="font-size:11px;color:#a49c9e;"> &middot; ${g5.observed}</span>` : ''}${sens ? `<span style="font-size:12px;color:${couleur};"> &middot; ${sens}</span>` : ''}
      <div style="font-size:12px;line-height:1.55;color:#6f6769;margin-top:7px;">${fr
        ? 'C’est elle qui mène le taux fixe 5 ans : quand elle monte, les fixes suivent en quelques jours. Ce n’est pas un taux hypothécaire — c’est ce qui le précède.'
        : 'This is what drives 5-year fixed rates: when it rises, fixed rates follow within days. It is not a mortgage rate — it is what leads one.'}</div>
    </div>`;
  }

  return `<tr><td style="padding:22px 32px 6px 32px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;color:#211c1e;margin-bottom:16px;">${fr ? 'Les taux, partout au pays' : 'Rates, nationwide'}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${gridRows}</table>
      ${bondLine}
      <div style="font-size:11.5px;line-height:1.55;color:#a49c9e;margin-top:14px;">${fr
        ? 'Source : Banque du Canada. Chaque chiffre porte sa date d’observation — les moyennes hypothécaires sont une série mensuelle, publiée avec du retard. Ce sont des moyennes du système financier, pas une offre de prêteur.'
        : 'Source: Bank of Canada. Each figure carries its own observation date — the mortgage averages are a monthly series, published with a lag. These are financial-system averages, not a lender offer.'}</div>
    </td></tr>`;
}

const CLOSE = (bg, border, inner) => `<tr><td style="padding:20px 32px 4px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${border};border-radius:12px;"><tr><td style="padding:22px 24px;">${inner}</td></tr></table></td></tr>`;
const BTN = (href, txt) => `<a href="${href}" style="display:inline-block;background:#c8102e;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 20px;border-radius:9px;">${txt}</a>`;
const H3 = (t) => `<div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.25;color:#211c1e;margin-bottom:10px;">${t}</div>`;
const P = (t) => `<div style="font-size:14px;line-height:1.6;color:#443e40;margin-bottom:14px;">${t}</div>`;
// ── ADRESSE POSTALE DE L'EXPÉDITEUR (2026-08-19) ──────────────────────────────────
// La LCAP l'EXIGE dans tout message commercial électronique : le Règlement (art. 2(2))
// impose « l'adresse postale » de l'expéditeur, en plus de son nom et d'un moyen de le
// joindre. Le pied ne portait que le nom et payotte.com — il manquait la pièce la plus
// simple, et c'est celle qu'un plaignant cite en premier parce qu'elle se vérifie d'un
// coup d'œil.
//
// ⚠️ ELLE N'EST PAS ÉCRITE ICI, ET C'EST VOULU. Aucune adresse de Payotte n'existe dans
// le dépôt ; en inventer une serait une fausse mention légale — bien pire que l'absence.
// Elle se pose en variable (`ADRESSE_POSTALE` dans wrangler.toml) par le propriétaire.
// Tant qu'elle manque, le pied s'affiche sans elle et `runBulletin` le crie dans le
// journal à chaque passage : mieux vaut un manque visible qu'un manque oublié.
const adressePostale = (env) => (env?.ADRESSE_POSTALE || '').trim();

const FOOT = (why, unsubUrl, unsubTxt, postale = '') => `<tr><td style="padding:22px 32px 26px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:16px;font-size:11.5px;line-height:1.6;color:#a49c9e;">${why} <a href="${unsubUrl}" style="color:#8a8284;">${unsubTxt}</a> &middot; payotte.com${postale ? `<br>${postale}` : ''}</div></td></tr>`;

// Page de la VILLE, pas l'accueil du pays. Le bouton du bulletin pointait sur /canada :
// on servait à quelqu'un le marché de Charlottetown pour le renvoyer choisir sa province
// à la main (signalé par le proprio le 2026-08-10). Les pages de ville sont publiées dans
// la langue de leur marché — une seule URL par ville, quelle que soit la langue du courriel.
const cityUrl = (city) => `${SITE}/canada/${PROV_SLUG[city?.province] ?? ''}/${city?.slug ?? ''}`;

// Zone experts : une page par métier (« visible à l'ère de l'IA »), publiée dans les deux
// langues sous des slugs différents. Sert la ligne « présence IA » du bulletin prospect.
const ZONE_EXPERTS = {
  'real-estate-broker': { fr: 'courtier-immobilier', en: 'real-estate-broker',
    lFr: 'courtiers immobiliers', lEn: 'real estate brokers' },
  'mortgage-broker': { fr: 'courtier-hypothecaire', en: 'mortgage-broker',
    lFr: 'courtiers hypothécaires', lEn: 'mortgage brokers' },
  appraiser: { fr: 'evaluateur', en: 'appraiser',
    lFr: 'évaluateurs agréés', lEn: 'certified appraisers' },
  'home-inspector': { fr: 'inspecteur-batiment', en: 'home-inspector',
    lFr: 'inspecteurs en bâtiment', lEn: 'home inspectors' },
  'notary-lawyer': { fr: 'notaire-avocat', en: 'notary-lawyer',
    lFr: 'notaires et avocats en immobilier', lEn: 'real estate lawyers and notaries' },
};

// Ligne « présence IA », adaptée au métier du destinataire quand on le connaît (les
// contacts récoltés portent leur `metier`; les abonnés du formulaire, non). Un lien
// discret sous le bouton — un seul appel à l'action dans le courriel, pas deux.
function ligneIA(metier, fr) {
  const z = ZONE_EXPERTS[metier];
  const href = z ? `${SITE}${fr ? '' : '/en'}/zone-experts/${fr ? z.fr : z.en}`
    : `${SITE}${fr ? '/ia-en-immobilier' : '/en/ai-in-real-estate'}`;
  const qui = z ? (fr ? z.lFr : z.lEn) : (fr ? 'experts immobiliers' : 'real-estate experts');
  return `<div style="font-size:12.5px;line-height:1.6;color:#6f6769;margin-top:14px;">${fr
    ? `Payotte travaille aussi la présence des <b>${qui}</b> dans les réponses des IA (ChatGPT, Copilot, Perplexity), pas seulement dans Google.`
    : `Payotte also works on how <b>${qui}</b> show up in AI answers (ChatGPT, Copilot, Perplexity), not just in Google.`}
    <a href="${href}" style="color:#c8102e;text-decoration:none;font-weight:bold;">${fr ? 'Voir comment &rarr;' : 'See how &rarr;'}</a></div>`;
}

// Rendu complet d'un courriel : {subject, html}. segment='prospect'|'expert' ; stage pour les experts.
function renderPulse({ segment, stage, city, expert, lang, unsubUrl, macro = null, metier = '', postale = '' }) {
  const fr = lang !== 'en';
  const url = expert?.url || `${SITE}`;
  const eyebrow = `${fr ? 'Le pouls du marché' : 'Market pulse'}<br><span style="color:#c8102e;letter-spacing:1px;">${city.name}${city.referenceMonth ? ' &middot; ' + city.referenceMonth : ''}</span>`;
  let subject, close, foot;
  if (segment === 'prospect') {
    subject = fr ? `${city.name} : le pouls du marché` : `${city.name}: your market pulse`;
    close = CLOSE('#eef3f0', '#cfe4d7', `${H3(fr ? `Les experts vérifiés de ${city.name}` : `${city.name}'s verified experts`)}${P(fr ? `Payotte a vérifié <b>un seul</b> expert de référence par secteur et par métier — sans commission, sans publicité.` : `Payotte verified <b>one</b> reference expert per sector and trade — no commission, no ads.`)}${BTN(cityUrl(city), fr ? `Voir les experts de ${city.name} →` : `See ${city.name}'s experts →`)}${ligneIA(metier, fr)}`);
    foot = FOOT(fr ? `Vous recevez le pouls de ${city.name}, une fois par mois.` : `You get the ${city.name} pulse once a month.`, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale);
  } else {
    const ask = expert ? missingAsk(expert, fr) : '';
    const proWho = fr ? `l'expert vérifié en ${expert?.professionLabel ?? ''} pour ${city.name}` : `the verified ${expert?.professionLabel ?? ''} for ${city.name}`;
    if (stage === 'intro') {
      subject = fr ? `Pourquoi je vous ai retenu comme référence à ${city.name}` : `Why I chose you as the reference in ${city.name}`;
      close = CLOSE('#faf8f7', '#eee9e8', `${P(fr ? `Je m'appelle Grégory Payotte. J'ai bâti <b>Payotte</b>, un annuaire indépendant qui recommande un seul expert vérifié par ville et par métier — gratuit, sans commission. Pour ${proWho}, c'est vous que j'ai retenu, sur la foi de données publiques. Le pouls ci-dessus, je le publie chaque mois.` : `I'm Grégory Payotte. I built <b>Payotte</b>, an independent directory recommending one verified expert per city and trade — free, no commission. For ${proWho}, I chose you, based on public data. I publish the pulse above every month.`)}${P(fr ? `Je vous l'enverrai <b>chaque mois</b>, gratuitement — rien à faire de votre côté. Si vous n'en voulez pas, un clic en bas de ce courriel et vous n'entendrez plus jamais parler de moi.` : `I'll send it to you <b>every month</b>, free — nothing to do on your end. If you'd rather not, one click at the bottom of this email and you'll never hear from me again.`)}${BTN(url, fr ? 'Voir votre fiche →' : 'See your profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}. Le pouls du marché part une fois par mois.` : `You're receiving this because you are ${proWho}. The market pulse goes out once a month.`, unsubUrl, fr ? 'Ne plus rien recevoir' : 'Unsubscribe', postale);
    } else if (stage === 'yellow') {
      subject = fr ? `Votre marché à ${city.name} — et la donnée qui vous ferait monter` : `Your ${city.name} market — and the data that would lift you`;
      close = CLOSE('#fdf6e9', '#f2e4c4', `${H3(fr ? 'Pendant qu\'on y est : votre fiche.' : 'While we\'re at it: your profile.')}${P(fr ? `Votre fiche Payotte est à <b>${expert?.score?.total ?? ''}/100</b>. La donnée la plus payante qui vous manque : <b>${ask}</b>. Répondez à ce courriel avec — je mets à jour le jour même.` : `Your profile is at <b>${expert?.score?.total ?? ''}/100</b>. The most valuable missing piece: <b>${ask}</b>. Reply with it — I update the same day.`)}${BTN(url, fr ? 'Voir ma fiche →' : 'See my profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You get this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale);
    } else if (stage === 'green') {
      subject = fr ? `Vous êtes la référence vérifiée de ${city.name} — une dernière étape` : `You're the verified reference in ${city.name} — one last step`;
      close = CLOSE('#eef5f0', '#cfe4d7', `${H3(fr ? 'Vous êtes déjà au vert.' : 'You\'re already in the green.')}${P(fr ? `Une seule étape pour le plus haut niveau du site : <b>confirmer votre fiche</b> et devenir <b style="color:#1f7a44;">Recommandé N&ordm; 1</b>. Deux minutes, par réponse à ce courriel.` : `One step to the top tier: <b>confirm your profile</b> and become <b style="color:#1f7a44;">Recommended #1</b>. Two minutes, just reply.`)}${BTN(url, fr ? 'Confirmer ma fiche →' : 'Confirm my profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You get this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale);
    } else if (stage === 'reco') {
      subject = fr ? `Vous êtes Recommandé N° 1 à ${city.name} — rendez-le visible` : `You're Recommended #1 in ${city.name} — make it visible`;
      close = CLOSE('#fbedef', '#f0d3d9', `<div style="font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#c8102e;margin-bottom:8px;">&#10003; ${fr ? 'Recommandé par Payotte' : 'Recommended by Payotte'}</div>${H3(fr ? 'Rendez-le visible sur votre site.' : 'Show it on your site.')}${P(fr ? `Affichez le badge « Recommandé » : un <b>lien réciproque dofollow</b> — bon pour votre référencement, et un signal de confiance. Je fournis le code (ou je m'arrange avec votre webmestre).` : `Display the "Recommended" badge: a <b>reciprocal dofollow link</b> — good for your SEO and a trust signal. I provide the code (or work with your webmaster).`)}${BTN(`${SITE}/badge/${expert?.slug ?? ''}`, fr ? 'Obtenir mon badge →' : 'Get my badge →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes Recommandé à ${city.name}.` : `You get this because you are Recommended in ${city.name}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale);
    } else { // partner
      subject = fr ? `Votre marché à ${city.name} ce mois-ci` : `Your ${city.name} market this month`;
      close = `<tr><td style="padding:18px 32px 4px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:18px;font-size:14px;line-height:1.62;color:#443e40;">${fr ? `Tout est en place : vous êtes Recommandé et votre badge est en ligne. Rien à demander — juste votre marché, chaque mois.` : `All set: you're Recommended and your badge is live. Nothing to ask — just your market, monthly.`}<div style="margin-top:14px;font-size:13px;color:#6f6769;">${fr ? `Un confrère d'un secteur voisin mériterait d'être vérifié ? <b>Transmettez-lui ce courriel.</b>` : `Know a peer worth verifying? <b>Forward this email.</b>`}</div></div></td></tr>`;
      foot = FOOT(fr ? `Vous êtes Recommandé et partenaire vérifié à ${city.name}.` : `You are Recommended and a verified partner in ${city.name}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale);
    }
  }
  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${marketCore(city, fr, eyebrow)}${nationalBlock(macro, fr)}${close}${foot}</table></div>`;
  return { subject, html };
}

// Resend limite à 2 requêtes/seconde (429 au-delà). La boucle du bulletin tire en rafale :
// on espace les appels pour rester sous la barre. 600 ms ≈ 1,6 envoi/s.
const RESEND_MIN_GAP_MS = 600;

// ═══════════════════════════════════════════════════════════════════════════════════
// SÉQUENCE DE SIX SEMAINES (2026-08-19)
// ═══════════════════════════════════════════════════════════════════════════════════
//
// CE QUE C'EST. Une suite FINIE de six courriels hebdomadaires à un expert publié, chacun
// portant SON chiffre à lui. Elle ne remplace pas l'escalier mensuel : elle le suspend le
// temps qu'elle dure, puis l'expert y retourne.
//
// L'ÉQUILIBRE, ET C'EST LA RAISON D'ÊTRE DE L'ORDRE. Quatre des six semaines donnent
// quelque chose sans rien demander ; une seule vend. Une première version en avait quatre
// qui parlaient de Payotte — un pro n'a aucune raison de lire ça. Chaque semaine « pour
// eux » doit rester utile même s'ils ne confirment jamais leur fiche.
//
//   S1  le virage IA de SON métier ............ contenu pur, aucune demande
//   S2  la lisibilité IA de SON site .......... diagnostic de son bien à lui
//   S3  le marché de SON secteur + les taux ... contenu pur, aucune demande
//   S4  sa fiche : confirmer .................. première demande, légère
//   S5  le badge .............................. un outil pour lui (lien retour)
//   S6  la tribune ............................ la seule offre payante
//
// TROIS RÈGLES QUI NE SE NÉGOCIENT PAS, chacune payée par une erreur passée :
//
//  1. ON NE DIT JAMAIS QUE SA FICHE EST CITÉE. Au relevé du 14 août, AUCUNE fiche
//     individuelle n'apparaît dans les pages citées par Copilot — ce sont les pages de
//     coûts en anglais et deux hubs. On écrit « le site est cité », jamais « votre fiche ».
//     (Règle #3, et la phrase serait fausse le jour où le pro la vérifie.)
//
//  2. RÈGLE NAZAR — S6 ne propose JAMAIS une tribune dans le secteur où le destinataire
//     est classé. Vendre une tribune à celui qu'on classe N° 1 de ce même secteur, c'est
//     exactement ce que le council du 12 août a interdit. S6 dit d'emblée « pas dans votre
//     secteur, par construction ».
//
//  3. ON N'ANNONCE JAMAIS LA FIN. Pas de « dernier courriel », pas de compte à rebours.
//     Le lien de désabonnement est là depuis S1 : qui veut sortir sort. Annoncer la fin
//     transforme une suite de courriels utiles en entonnoir de vente affiché.
//
// L'ÉTAT VIVANT PRIME SUR LE SCRIPT. À chaque envoi on relit la fiche : si le pro a
// confirmé entre S2 et S4, S4 devient un remerciement. La séquence ne rejoue pas un script
// écrit d'avance devant quelqu'un qui a déjà répondu.

/** Le chiffre du virage IA, par métier. Chaque valeur porte sa source et son année. */
const IA_METIER = {
  'real-estate-broker': {
    fr: { n: '36 %', quoi: 'des vendeurs trouvent leur courtier en ligne — le double de 2018',
          src: 'NAR, Profile of Home Buyers and Sellers 2024' },
    en: { n: '36%', quoi: 'of sellers find their agent through online channels — double 2018',
          src: 'NAR, Profile of Home Buyers and Sellers 2024' } },
  'mortgage-broker': {
    fr: { n: '83 %', quoi: 'des recherches ne mènent à AUCUN site quand un résumé IA s’affiche',
          src: 'Bain–Dynata Generative AI Consumer Survey, 2024' },
    en: { n: '83%', quoi: 'of searches lead to NO site at all when an AI summary appears',
          src: 'Bain–Dynata Generative AI Consumer Survey, 2024' } },
  'home-inspector': {
    fr: { n: '46 %', quoi: 'des recherches Google ont une intention locale (« près de moi », nom de quartier)',
          src: 'Google / BrightLocal, Local SEO Statistics 2025' },
    en: { n: '46%', quoi: 'of Google searches carry local intent (“near me”, neighbourhood names)',
          src: 'Google / BrightLocal, Local SEO Statistics 2025' } },
  'notary-lawyer': {
    fr: { n: '87 %', quoi: 'des consommateurs consultent les avis en ligne pour juger un professionnel local',
          src: 'BrightLocal, Local Consumer Review Survey 2024' },
    en: { n: '87%', quoi: 'of consumers use online reviews to judge a local professional',
          src: 'BrightLocal, Local Consumer Review Survey 2024' } },
  appraiser: {
    fr: { n: '+30 à 40 %', quoi: 'de chances d’être cité par une IA pour une page en données structurées',
          src: 'Frase.io, GEO Playbook 2025' },
    en: { n: '+30 to 40%', quoi: 'more likely to be cited by an AI when a page carries structured data',
          src: 'Frase.io, GEO Playbook 2025' } },
};

/** Les cinq piliers de l'Indice IA, pour nommer celui qui coûte le plus. */
const PILIERS_IA = [
  { cle: 'structure', max: 25, fr: 'données structurées (JSON-LD)', en: 'structured data (JSON-LD)' },
  { cle: 'acces', max: 30, fr: 'accès des robots d’IA', en: 'AI crawler access' },
  { cle: 'aeo', max: 20, fr: 'réponse prélevable', en: 'extractable answer' },
  { cle: 'ancrage', max: 15, fr: 'ancrage local lisible', en: 'machine-readable local anchoring' },
  { cle: 'technique', max: 10, fr: 'hygiène technique', en: 'technical hygiene' },
];

/** Le pilier au plus gros écart — celui qu'on nomme, jamais une liste de cinq reproches. */
function pilierLePlusCher(ia, fr) {
  if (!ia) return null;
  let pire = null;
  for (const p of PILIERS_IA) {
    const v = Number(ia[p.cle] ?? 0);
    const manque = p.max - v;
    if (!pire || manque > pire.manque) pire = { ...p, v, manque };
  }
  return pire && pire.manque > 0 ? { nom: fr ? pire.fr : pire.en, v: pire.v, max: pire.max } : null;
}

/**
 * Rend l'étape `etape` (1..6) de la séquence. Même gabarit visuel que le pouls mensuel.
 * `seq.ia` vient de l'enrôlement (ai-readiness.csv) ; `expert` est relu à chaque envoi.
 */
function renderSequence({ etape, expert, city, seq, lang, unsubUrl, macro = null, postale = '' }) {
  const fr = lang !== 'en';
  const url = expert?.url || SITE;
  const nom = expert?.professional?.name || expert?.name || '';
  const prenom = String(nom).trim().split(/\s+/)[0] || '';
  const salut = fr ? (prenom ? `Bonjour ${prenom},` : 'Bonjour,') : (prenom ? `Hello ${prenom},` : 'Hello,');
  const secteur = expert?.sectorName || city?.name || '';
  const metier = expert?.professionLabel || '';
  const eyebrow = `${fr ? 'Espace professionnels' : 'For professionals'}<br><span style="color:#c8102e;letter-spacing:1px;">${secteur}</span>`;
  const sig = P(fr ? `À bientôt,<br><span style="font-family:Georgia,serif;font-style:italic;">Grégory</span>`
                  : `Best,<br><span style="font-family:Georgia,serif;font-style:italic;">Grégory</span>`);
  const pied = (quoi) => FOOT(quoi, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale);
  const pourquoi = fr
    ? `Vous recevez ce courriel parce que vous êtes le ${metier} vérifié de ${secteur} sur Payotte.`
    : `You are receiving this because you are the verified ${metier} for ${secteur} on Payotte.`;

  // L'état VIVANT commande : confirmé entre-temps → S4 remercie au lieu de redemander.
  const confirme = expert?.ownerVerified === true;
  const badgePose = expert?.badgeExchange === true;

  let subject, corps;

  if (etape === 1) {
    const st = IA_METIER[expert?.profession] ?? IA_METIER['real-estate-broker'];
    const d = fr ? st.fr : st.en;
    subject = fr ? `${secteur} : ${d.n} — ce qui a changé dans la façon dont on vous trouve`
                 : `${secteur}: ${d.n} — what changed in how people find you`;
    corps = CLOSE('#faf8f7', '#eee9e8',
      `${P(salut)}${H3(fr ? 'Quand l’IA répond, elle ne nomme qu’un seul expert' : 'When AI answers, it names one expert')}`
      + P(fr ? `Un chiffre de votre métier, pour commencer : <b>${d.n}</b> ${d.quoi}.`
             : `One figure from your trade: <b>${d.n}</b> ${d.quoi}.`)
      + P(fr ? `La recherche ne se partage plus entre dix liens : elle se résume en une réponse, et cette réponse nomme <b>un</b> professionnel. Ce n’est pas le classement qui décide qui elle nomme — c’est ce qu’une machine peut vérifier sur vous.`
             : `Search no longer spreads across ten links: it collapses into one answer, and that answer names <b>one</b> professional. What decides is not ranking — it is what a machine can verify about you.`)
      + BTN(`${SITE}${fr ? '/ia-en-immobilier' : '/en/ai-in-real-estate'}`, fr ? 'Le virage IA, pour votre métier →' : 'The AI shift, for your trade →')
      + sig);
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(`${pourquoi} ${fr ? `Source : ${d.src}.` : `Source: ${d.src}.`}`), macro, false) };
  }

  if (etape === 2) {
    const ia = seq?.ia;
    const pire = pilierLePlusCher(ia, fr);
    subject = ia?.score != null
      ? (fr ? `${ia.domaine} : ${ia.score}/100 pour les moteurs de réponse` : `${ia.domaine}: ${ia.score}/100 for answer engines`)
      : (fr ? `Ce que les IA voient de votre site` : `What AI engines see of your site`);
    corps = CLOSE('#fdf6e9', '#f2e4c4',
      `${P(salut)}${H3(fr ? 'Ce que ChatGPT et Copilot voient de votre site' : 'What ChatGPT and Copilot see of your site')}`
      + P(ia?.score != null
        ? (fr ? `J’ai passé <b>${ia.domaine}</b> dans le protocole de notre étude sur 446 cabinets : <b>${ia.score}/100</b>, pour une médiane de 49. Ce n’est pas un jugement sur votre pratique — c’est une mesure de ce que le CODE de vos pages rend lisible à une machine, pas à un humain.`
              : `I ran <b>${ia.domaine}</b> through the protocol of our study of 446 firms: <b>${ia.score}/100</b>, against a median of 49. This is not a judgement on your practice — it measures what the CODE of your pages makes readable to a machine, not to a human.`)
        : (fr ? `Notre étude a mesuré 446 cabinets sur 100 points de lisibilité par les moteurs de réponse. La médiane est de 49.`
              : `Our study measured 446 firms on 100 points of answer-engine readability. The median is 49.`))
      + (pire ? P(fr ? `Le pilier qui vous coûte le plus : <b>${pire.nom}</b>, à ${pire.v}/${pire.max}. C’est aussi le plus rapide à corriger.`
                     : `The pillar costing you most: <b>${pire.nom}</b>, at ${pire.v}/${pire.max}. It is also the quickest to fix.`) : '')
      + BTN(`${SITE}${fr ? '/etudes/lisibilite-ia-experts-immobiliers' : '/en/studies/ai-readiness-real-estate-experts'}`,
            fr ? 'L’étude complète, méthode incluse →' : 'The full study, method included →')
      + sig);
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
  }

  if (etape === 3) {
    subject = fr ? `Le marché de ${city?.name ?? secteur} — et les taux` : `${city?.name ?? secteur}'s market — and rates`;
    corps = CLOSE('#f3f6f8', '#dde6ea',
      `${P(salut)}`
      + P(fr ? `Les chiffres du mois pour votre marché, et les taux qui les commandent. Rien à faire de votre côté : c’est de la matière pour vos conversations de la semaine.`
             : `This month's figures for your market, and the rates that drive them. Nothing to do on your side: it is material for your conversations this week.`)
      + P(fr ? `Ces chiffres sont publics et structurés — le genre de donnée qu’une IA cite directement quand un client lui demande comment va le marché.`
             : `These figures are public and structured — the kind of data an AI cites directly when a client asks how the market is doing.`)
      + BTN(cityUrl(city), fr ? `Les chiffres de ${city?.name ?? secteur} →` : `${city?.name ?? secteur} figures →`)
      + sig);
    // Seule étape qui porte la grille de marché ET le bloc taux : c'est son contenu.
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, true) };
  }

  if (etape === 4) {
    if (confirme) {
      subject = fr ? `Votre fiche est confirmée — merci` : `Your profile is confirmed — thank you`;
      corps = CLOSE('#eef5f0', '#cfe4d7',
        `${P(salut)}${H3(fr ? 'C’est fait, et c’est le plus haut niveau du site.' : 'Done — and it is the site’s highest tier.')}`
        + P(fr ? `Votre fiche est confirmée : elle porte le statut <b style="color:#1f7a44;">Recommandé N° 1</b>, avec vos sources vérifiables et votre numéro de permis publié pour que le lecteur le contrôle lui-même.`
               : `Your profile is confirmed: it carries the <b style="color:#1f7a44;">Recommended #1</b> status, with your verifiable sources and your licence number published for readers to check themselves.`)
        + BTN(url, fr ? 'Voir votre fiche →' : 'See your profile →') + sig);
    } else {
      const manque = missingAsk(expert, fr);
      subject = fr ? `Votre fiche à ${secteur} : ${expert?.score?.total ?? ''}/100` : `Your ${secteur} profile: ${expert?.score?.total ?? ''}/100`;
      corps = CLOSE('#eef5f0', '#cfe4d7',
        `${P(salut)}${H3(fr ? 'Vous êtes déjà la référence vérifiée du secteur' : 'You are already the sector’s verified reference')}`
        + P(fr ? `Votre fiche est à <b>${expert?.score?.total ?? ''}/100</b>. Elle n’est pas encore confirmée par vous : c’est la seule chose qui vous sépare du niveau <b style="color:#1f7a44;">Recommandé N° 1</b> — et du jeu de données le plus complet qu’une machine puisse lire à votre sujet.`
               : `Your profile sits at <b>${expert?.score?.total ?? ''}/100</b>. It is not yet confirmed by you: that is the only thing between you and <b style="color:#1f7a44;">Recommended #1</b> — and the most complete data set a machine can read about you.`)
        + P(fr ? `La donnée qu’on ne peut pas confirmer nous-mêmes : <b>${manque}</b>. Répondez à ce courriel avec, je mets à jour le jour même, daté et sourcé.`
               : `The one piece we cannot confirm ourselves: <b>${manque}</b>. Reply with it and I update the same day, dated and sourced.`)
        + BTN(url, fr ? 'Voir ma fiche →' : 'See my profile →') + sig);
    }
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
  }

  if (etape === 5) {
    if (badgePose) {
      subject = fr ? `Votre badge est en ligne — merci` : `Your badge is live — thank you`;
      corps = CLOSE('#fbedef', '#f0d3d9',
        `${P(salut)}${H3(fr ? 'Le lien est posé.' : 'The link is live.')}`
        + P(fr ? `Votre badge est en ligne sur votre site. C’est un lien retour permanent vers votre fiche — et l’un des rares signaux qu’une machine relie durablement à votre nom. Rien d’autre à faire.`
               : `Your badge is live on your site. It is a permanent link back to your profile — one of the few signals a machine ties durably to your name. Nothing else to do.`)
        + sig);
    } else {
      subject = fr ? `Le badge de ${secteur} : le code, prêt à coller` : `The ${secteur} badge: code ready to paste`;
      corps = CLOSE('#fbedef', '#f0d3d9',
        `${P(salut)}${H3(fr ? 'Un actif pour votre site, pas une récompense' : 'An asset for your site, not a reward')}`
        + P(fr ? `Le badge fait deux choses à la fois : un <b>lien retour</b> vers votre fiche depuis votre propre domaine — bon pour votre référencement — et un second signal structuré qu’une machine peut relier à votre nom. C’est exactement le levier dont parlait le courriel sur les données structurées.`
               : `The badge does two things at once: a <b>backlink</b> to your profile from your own domain — good for your SEO — and a second structured signal a machine can tie to your name. It is precisely the lever the structured-data email described.`)
        + P(fr ? `Le code est prêt à coller, ou à transmettre à qui gère votre site. Deux minutes. C’est gratuit, et ça le restera : le classement ne s’achète pas, c’est ce qui lui donne sa valeur.`
               : `The code is ready to paste, or to forward to whoever runs your site. Two minutes. It is free and will stay free: ranking is not for sale, which is what gives it value.`)
        + BTN(`${SITE}/badge/${expert?.slug ?? ''}`, fr ? 'Obtenir mon badge →' : 'Get my badge →') + sig);
    }
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
  }

  // S6 — la seule offre payante. RÈGLE NAZAR : jamais dans son propre secteur.
  subject = fr ? `La tribune — la seule chose que Payotte facture` : `The column — the only thing Payotte charges for`;
  corps = CLOSE('#f8f0dc', '#e9d9ad',
    `${P(salut)}${H3(fr ? 'Depuis cinq semaines, rien ne vous a été facturé' : 'For five weeks, nothing has been billed to you')}`
    + P(fr ? `Votre fiche, votre score et votre rang ne sont pas à vendre — à personne. Le seul service que Payotte facture est la <b>tribune commanditée</b> : une chronique signée de votre nom, marquée comme commanditée, qui ne touche jamais au classement.`
           : `Your profile, your score and your rank are not for sale — to anyone. The only service Payotte charges for is the <b>sponsored column</b>: a piece signed by you, labelled as sponsored, which never touches the ranking.`)
    + P(fr ? `Et pour être clair : <b>pas dans votre secteur</b>, par construction. Vous y êtes déjà la référence classée ; vous y vendre une tribune reviendrait à vendre la place que vous occupez déjà. Les secteurs voisins de votre ville, eux, sont ouverts.`
           : `And to be clear: <b>not in your own sector</b>, by construction. You are already the ranked reference there; selling you a column there would mean selling the place you already hold. Neighbouring sectors in your city are open.`)
    + BTN(`${SITE}${fr ? '/tribunes' : '/en/sponsored-columns'}`, fr ? 'Le tarif, sans engagement →' : 'Pricing, no commitment →') + sig);
  return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
}

/** Enveloppe commune — même coquille que le pouls mensuel (logo, largeur, bordures). */
function enveloppe(city, fr, eyebrow, corps, pied, macro, avecMarche) {
  const tete = avecMarche && city ? marketCore(city, fr, eyebrow) : `<tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td>
      <td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;line-height:1.5;">${eyebrow}</td>
    </tr></table></td></tr>`;
  const taux = avecMarche ? nationalBlock(macro, fr) : '';
  return `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${tete}${taux}${corps}${pied}</table></div>`;
}

let lastPulseAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Envoi par LOTS (Resend /emails/batch — jusqu'à 100 courriels en UN appel).
//
// PAS de copie BCC (elle noyait la boîte du proprio) : la trace, c'est le récapitulatif de
// fin d'exécution, plus l'échantillon du jour. Renvoie TOUJOURS l'issue réelle par
// courriel — l'appelant DOIT la lire : un envoi raté qui passerait pour réussi marquerait
// l'expert comme servi et le priverait de son courriel du mois.
//
// Pourquoi : un envoi = une sous-requête, et Cloudflare en autorise 50 par réveil du
// worker. À l'unité, l'architecture plafonnait donc à ~45 courriels par passage quoi
// qu'on fasse — un mur de tuyauterie, pas de forfait. Par lots de 100, mille envois ne
// coûtent que dix sous-requêtes : le plafond quotidien redevient une décision (forfait
// Resend + réputation du domaine), plus une contrainte technique.
//
// `headers` et `reply_to` sont acceptés par l'API batch (vérifié à la doc le 2026-08-10) :
// le List-Unsubscribe un clic — exigé par la LCAP et par Gmail — survit au passage en lot.
// Les pièces jointes, elles, n'y sont pas supportées : le bulletin n'en a jamais.
//
// Renvoie un tableau ALIGNÉ sur `envois` : `{ ok }` par courriel. Si l'appel entier échoue,
// rien n'est parti — tout le lot repart demain (on ne marque `sent:` que sur acceptation).
//
// ── EXPÉDITEUR PAR FLUX (2026-08-19) ───────────────────────────────────────────────
// `from` était figé sur MAIL_FROM_BULLETIN : TOUT partait de la même adresse — le
// bulletin opt-in de 2 132 abonnés, les prospects récoltés (non sollicités), et
// l'escalier expert. Un seul mauvais mardi de prospection abîmait donc la réputation
// du flux que des gens ont DEMANDÉ à recevoir, et celle du relais client↔pro qui est
// le produit.
// Trois expéditeurs, trois réputations :
//   bulletin@   abonnés du formulaire — ils ont dit oui
//   outreach@   prospects récoltés, escalier expert, séquence — non sollicité
//   relais@     mise en contact client↔pro (double opt-in) — inchangé, à ne jamais mêler
// La séparation ne rend pas une plainte inoffensive (le domaine organisationnel reste
// lié) : elle empêche qu'un flux en tue deux autres. C'est une mitigation, pas un mur.
async function sendPulseBatch(env, envois, { from: fromDemande } = {}) {
  if (!envois.length) return [];
  if (!env.RESEND_API_KEY) return envois.map(() => ({ ok: false, simulated: true }));
  const wait = RESEND_MIN_GAP_MS - (Date.now() - lastPulseAt);
  if (wait > 0) await sleep(wait);
  lastPulseAt = Date.now();
  const from = fromDemande || env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>';

  // ── QUARANTAINE DES ADRESSES INVALIDES (2026-08-13) ────────────────────────────────
  // Resend valide le lot ENTIER : une seule adresse malformée le fait répondre 422, et
  // TOUS les courriels du lot sont perdus. C'est arrivé le 12 août : la fiche
  // `appraiser--north-end-fairview` porte deux adresses dans un seul champ
  // (« Geoff.Coderre@gmail.com ; SjBest@Eastlink.ca » — même convention que son
  // téléphone). Elle a emporté 10 prospects parfaitement valides avec elle, et elle
  // échouait déjà seule chaque jour depuis le 7 août.
  // On écarte donc les adresses invalides AVANT l'appel : elles sont signalées une par
  // une dans le rapport (motif explicite, pas un « HTTP 422 » opaque) et le reste du lot
  // part normalement. Coût : zéro sous-requête.
  const valides = [], resultats = new Array(envois.length);
  envois.forEach((e, i) => {
    if (EMAIL_RE.test(String(e.to ?? '').trim())) valides.push({ e, i });
    else resultats[i] = { ok: false, status: 0, error: 'adresse invalide — écartée avant envoi' };
  });
  if (!valides.length) return resultats;

  let res, corps;
  try {
    res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(valides.map(({ e }) => ({
        from, to: [e.to], reply_to: REPLY_TO,
        subject: e.subject, html: e.html,
        ...(e.unsubUrl ? { headers: { 'List-Unsubscribe': `<${e.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
      }))),
    });
    corps = await res.json().catch(() => null);
  } catch (err) {
    valides.forEach(({ i }) => { resultats[i] = { ok: false, status: 0, error: String(err?.message ?? err) }; });
    return resultats;
  }
  if (!res.ok) {
    valides.forEach(({ i }) => { resultats[i] = { ok: false, status: res.status }; });
    return resultats;
  }
  // Réponse acceptée : `data[i]` correspond au courriel `i` de la requête. Une entrée
  // absente ou sans `id` = ce courriel-là n'a pas été pris ; il repassera demain. On ne
  // suppose JAMAIS le succès d'un envoi qu'on ne voit pas confirmé.
  // `data[k]` correspond au k-ième courriel ENVOYÉ (donc au k-ième valide), pas au k-ième
  // de `envois` : les indices divergent dès qu'une adresse a été mise en quarantaine.
  const data = Array.isArray(corps?.data) ? corps.data : [];
  valides.forEach(({ i }, k) => {
    resultats[i] = { ok: Boolean(data[k]?.id), status: res.status, id: data[k]?.id };
  });
  return resultats;
}

// Villes ACTIVES du bulletin = TOUTES celles dont on publie un prix de référence
// (décision proprio, 2 août 2026 : « le maximum de villes où j'ai des stats »). Aucun
// slug à tenir à jour : une ville entre dans le bulletin le jour où son prix entre dans
// cityMarket.json, et en sort si la donnée disparaît. Le courriel s'ouvre sur ce prix —
// sans lui, il n'y a rien à envoyer.
const hasMarketStats = (c) => (c?.benchmarkHpi ?? c?.medianPrice) != null;

// Code province de market.json → slug du feed /api/experts/{slug}.json.
const PROV_SLUG = {
  QC: 'quebec', ON: 'ontario', AB: 'alberta', BC: 'british-columbia', MB: 'manitoba',
  NS: 'nova-scotia', SK: 'saskatchewan', NB: 'new-brunswick',
  NL: 'newfoundland-and-labrador', PE: 'prince-edward-island',
};

// Budget de sous-requêtes. Plan gratuit Cloudflare : 50 par invocation — la run du
// 1er août 2026 est morte PILE à 50 (13 feeds + 37 envois), laissant 17 experts sur le
// carreau sans le moindre signal. Désormais l'exécution COMPTE ses sous-requêtes et
// s'arrête d'elle-même ; ce qui n'est pas parti aujourd'hui part demain (cron quotidien).
// Les opérations KV n'entrent pas dans ce budget (vérifié sur la run du 1er août).
const SUBREQUEST_BUDGET = 50;
const SUBREQUEST_MARGIN = 3;   // récapitulatif de fin + coussin
// Taille d'un lot Resend (maximum de l'API). Depuis le passage aux lots (2026-08-10),
// un passage de 1 000 courriels ne coûte que 10 sous-requêtes : le budget Cloudflare
// n'est plus le facteur limitant, le forfait Resend et la réputation du domaine le sont.
const TAILLE_LOT = 100;
const RESEND_DAY_CAP = 90;     // plafond dur : marge sous le palier Resend gratuit (100/jour)
                               // — passer à 50 000/mois (Resend Pro) permet de le relever
                               //   sans toucher au code : seul ce chiffre change.
// Rythme choisi (décision proprio, 3 août 2026) : un petit filet tous les jours plutôt qu'une
// rafale, sans jamais approcher les limites de Resend, et le domaine (37 courriels dans sa
// vie au 1er août) monte en charge doucement — c'est ce qui décide si les prochains
// atterrissent en boîte ou en spam.
// 2026-08-08 (décision proprio) : 20 → 35. Les ~296 prospects de la récolte entrent dans le
// circuit (clés s:) et s'ajoutent aux ~455 experts — 20/jour ne bouclait plus le mois.
// 2026-08-09 (décision proprio, objectif 2 800 destinataires au 31 août) : montée en
// PALIERS DATÉS — 50 maintenant, 70 dès le 15 août, 90 dès le 22 (le max sous le palier
// gratuit Resend : 90 × 30 + ~210 rapports ≈ 2 910 < 3 000/mois). Les paliers hebdo sont
// le profil de montée en charge que les filtres anti-spam tolèrent ; un saut direct
// 20 → 90 sur un domaine jeune est le profil type qui finit en spam.
// Ramp accélérée le 2026-08-13 (décision proprio, objectif de fin de mois). Les paliers
// 70 et 90 avancent de deux et quatre jours ; le SOMMET NE BOUGE PAS.
// ⚠️ 90 est un plafond, pas une timidité : le forfait gratuit Resend coupe à 100/jour, et
// les rapports d'exécution envoyés au proprio consomment le MÊME quota. Aller à 100 ferait
// refuser les derniers courriels du jour sans qu'on sache lesquels.
// L'arithmétique du 13 août : même à 90/jour jusqu'au 31, août plafonne autour de 2 090
// envois — or l'audience disponible n'est que d'environ 2 080 personnes (1 512 prospects
// + ~568 experts, un seul courriel par personne et par cycle). Cette ramp épuise donc
// à peu près tout le carnet. Le chiffre de 3 000 n'est PAS atteignable en août : il
// demanderait 137/jour (au-dessus du gratuit) ET un carnet d'adresses qui n'existe pas.
const dailySendCap = (at = new Date()) => {
  const d = at.toISOString().slice(0, 10);
  if (d >= '2026-08-18') return 90;
  if (d >= '2026-08-13') return 70;
  return 50;
};
// Durée de vie des marques de cycle (`sent:`, `prov-done:`) : ~100 jours. Elles ne servent
// qu'au mois courant et se nettoient toutes seules. `intro:` et `unsub:`, eux, sont éternels.
const CYCLE_TTL = 100 * 24 * 3600;

// Toutes les clés d'un préfixe (KV plafonne à 1000 par page ; l'annuaire les dépassera).
async function kvKeys(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await kv.list({ prefix, cursor });
    for (const k of r.keys) out.push(k.name.slice(prefix.length));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

const expertUnsubUrl = async (env, origin, slug) =>
  `${origin}/unsubscribe?x=${encodeURIComponent(slug)}&t=${await hmacHex(env, `x:${slug}`)}`;

// ---- 10 h CHEZ LE DESTINATAIRE (décision proprio, 5 août 2026) ----------------------
// Une heure UTC unique envoyait à 9 h HE… donc 6 h du matin sur la côte Ouest : un courriel
// professionnel qui arrive avant le lever se lit à la va-vite ou pas du tout. Le cron tourne
// désormais À CHAQUE HEURE de la fenêtre 12-18 h UTC, et chaque exécution ne sert QUE les
// provinces où il est 10 h passé. Personne d'autre n'est touché ce tour-là.
//
// Fuseaux IANA, pas de décalages en dur : l'heure avancée s'applique toute seule, et la
// Saskatchewan (America/Regina, qui ne la suit JAMAIS) se règle sans cas particulier.
const PROV_TZ = {
  QC: 'America/Toronto',   ON: 'America/Toronto',    MB: 'America/Winnipeg',
  SK: 'America/Regina',    AB: 'America/Edmonton',   BC: 'America/Vancouver',
  NS: 'America/Halifax',   NB: 'America/Moncton',    PE: 'America/Halifax',
  NL: 'America/St_Johns',
};
const SEND_LOCAL_HOUR = 10;
// Dernière heure UTC où le cron tourne — doit rester en phase avec `crons` de wrangler.toml
// ("0 12-18 * * *"). Sert à savoir combien de passages restent dans la journée pour partager
// le plafond quotidien entre les fuseaux (voir « part équitable » dans runBulletin).
const CRON_DERNIERE_HEURE_UTC = 18;

const localHour = (tz, at) =>
  Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', hour12: false }).format(at));

// Provinces dont l'heure locale est dans la tranche des 10 h. On teste l'HEURE, pas la minute :
// la tranche dure 60 minutes, ce qui garantit qu'un cron horaire tombe toujours dedans — y
// compris à Terre-Neuve, dont le décalage d'une demi-heure ferait rater un test à la minute
// près (10 h 00 à St. John's = 12 h 30 UTC, une heure qui n'existe pas au calendrier du cron ;
// c'est le passage de 13 h UTC, soit 10 h 30 locale, qui la sert).
function zonesAt10h(at = new Date()) {
  return new Set(Object.entries(PROV_TZ)
    .filter(([, tz]) => localHour(tz, at) === SEND_LOCAL_HOUR)
    .map(([code]) => code));
}

// Orchestration du CYCLE MENSUEL, étalée sur autant de jours qu'il faut.
//
// Le cron tourne CHAQUE HEURE de 12 à 18 h UTC mais l'unité de compte reste le mois : un
// destinataire servi porte la clé `sent:{AAAA-MM}:{slug}` et n'est plus rappelé avant le mois
// suivant. Chaque exécution ne regarde QUE les provinces où il est 10 h locale, repart de la
// liste des « pas encore servis ce mois-ci », en envoie autant que le budget le permet, et
// s'arrête. Quand tout le monde a reçu, les exécutions suivantes du mois ne font plus rien
// (3 lectures KV, 1 feed) jusqu'au 1er. C'est ce qui remplace le « tout d'un coup » impossible
// sur le plan gratuit : ~490 courriels passent en une douzaine de jours, sans jamais dépasser
// ni Cloudflare, ni Resend, ni la prudence élémentaire pour la réputation du domaine.
//
// Le plafond quotidien est GLOBAL, pas par exécution : sept passages par jour × 20 auraient
// fait 140 courriels et pulvérisé la montée en charge du domaine. Le compte du jour vit en KV.
//
// OPT-OUT : plus de `sub:` à poser à la main. Seule une clé `unsub:{slug}` exclut quelqu'un.
// dryRun=true → aucun envoi, rapport d'audience seulement (et TOUS les fuseaux, sinon le
// rapport ne montrerait que la tranche horaire du moment).
async function runBulletin(env, { dryRun = false, at = new Date() } = {}) {
  const origin = WORKER_ORIGIN;
  const cycle = at.toISOString().slice(0, 7);      // AAAA-MM
  const dayKey = at.toISOString().slice(0, 10);    // AAAA-MM-JJ (jour comptable = UTC)
  // Compteur de sous-requêtes de CETTE exécution (feeds + appels Resend). Les opérations KV
  // n'y entrent pas. `left()` est ce qui reste de disponible.
  const ctr = { subs: 0 };
  const F = async (path) => { ctr.subs++; return feed(path); };
  const left = () => SUBREQUEST_BUDGET - SUBREQUEST_MARGIN - ctr.subs;
  // Ce que les exécutions PRÉCÉDENTES du jour ont déjà consommé (les 7 passages horaires se
  // partagent un seul plafond quotidien).
  const daySoFar = Number((env.SUBSCRIBERS ? await env.SUBSCRIBERS.get(`day:${dayKey}`) : 0) || 0);
  let dayCap = Math.min(dailySendCap(at), RESEND_DAY_CAP);

  // ── COUPE-CIRCUIT ET SEUILS (2026-08-19) ─────────────────────────────────────────
  // Deux mécanismes, et ils ne se confondent pas :
  //
  //   `stop:all`      arrêt MANUEL de tout. Posé à la main quand quelque chose cloche
  //                   (`wrangler kv key put --remote stop:all 1`). Aucune automatisation
  //                   ne l'écrit : c'est la main sur le disjoncteur, elle reste humaine.
  //   `stop:outreach` arrêt de la PROSPECTION seule. Peut être posé automatiquement par
  //                   les seuils ci-dessous. Le bulletin opt-in continue.
  //
  // Les seuils lisent les compteurs du webhook (/resend-webhook). Ils regardent les
  // 24 h écoulées, pas un cumul depuis toujours : une mauvaise journée doit se voir tout
  // de suite, et une bonne semaine ne doit pas la masquer.
  // Ce que la journée a DÉJÀ envoyé en prospection, tous passages horaires confondus —
  // la rampe est un plafond quotidien, pas un plafond par passage.
  // Adresse postale LCAP : lue une fois, criée si absente (voir `adressePostale`).
  const postale = adressePostale(env);
  if (!postale && !dryRun) {
    console.log('[bulletin] ⚠️ ADRESSE POSTALE MANQUANTE — exigée par la LCAP (Règlement art. 2(2)). '
      + 'Poser ADRESSE_POSTALE dans wrangler.toml. Les envois continuent, la mention légale est incomplète.');
  }
  const dejaOutreach = Number((await env.SUBSCRIBERS?.get(`day:${dayKey}:outreach`)) || 0);
  const stopTout = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get('stop:all') : null;
  if (stopTout && !dryRun) {
    console.log(`[bulletin] ARRÊT MANUEL (stop:all = ${stopTout}) — aucun envoi.`);
    return { arrete: 'stop:all', motif: String(stopTout) };
  }
  const hier = new Date(at.getTime() - 86400000).toISOString().slice(0, 10);
  const somme = async (prefixe) => Number((await env.SUBSCRIBERS?.get(`${prefixe}:${dayKey}`)) || 0)
                                 + Number((await env.SUBSCRIBERS?.get(`${prefixe}:${hier}`)) || 0);
  const envoyes24 = Number((await env.SUBSCRIBERS?.get(`day:${dayKey}:outreach`)) || 0)
                  + Number((await env.SUBSCRIBERS?.get(`day:${hier}:outreach`)) || 0);
  const plaintes = env.SUBSCRIBERS ? await somme('plainte') : 0;
  const rebonds = env.SUBSCRIBERS ? await somme('rebond') : 0;
  // Sous 200 envois, un pourcentage ne veut rien dire (une plainte ferait 0,5 %) : on
  // s'en remet alors au compte brut de 3 plaintes, qui reste un signal fort à petit volume.
  const tauxP = envoyes24 >= 200 ? plaintes / envoyes24 : 0;
  const tauxR = envoyes24 >= 200 ? rebonds / envoyes24 : 0;
  let stopOutreach = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get('stop:outreach') : null;
  if (!stopOutreach && !dryRun && (tauxP >= 0.003 || plaintes >= 3 || tauxR >= 0.04)) {
    const motif = plaintes >= 3 && tauxP < 0.003
      ? `${plaintes} plaintes en 24 h`
      : tauxR >= 0.04 ? `rebonds durs ${(tauxR * 100).toFixed(1)} %`
        : `plaintes ${(tauxP * 100).toFixed(2)} %`;
    await env.SUBSCRIBERS?.put('stop:outreach', `auto ${dayKey} — ${motif}`);
    stopOutreach = `auto ${dayKey} — ${motif}`;
    console.log(`[bulletin] ARRÊT AUTOMATIQUE de la prospection : ${motif}`);
  } else if (!stopOutreach && (tauxP >= 0.001 || tauxR >= 0.02)) {
    // Palier d'alerte : on ralentit de moitié au lieu d'arrêter. Le but est de laisser le
    // temps de regarder, pas de tout figer sur un frisson.
    dayCap = Math.max(1, Math.floor(dayCap / 2));
    console.log(`[bulletin] ralenti ×0,5 — plaintes ${plaintes}, rebonds ${rebonds} sur ${envoyes24} envois`);
  }

  // ── PART ÉQUITABLE DU PLAFOND QUOTIDIEN (2026-08-17) ──────────────────────────────
  // LE FUSEAU LE PLUS À L'OUEST MOURAIT DE FAIM. Le plafond du jour est GLOBAL et les
  // fuseaux passent l'un après l'autre — Atlantique 13 h UTC, Est 14 h, Centre 15 h,
  // Prairies/Montagnes 16 h, Pacifique 17 h. Servis dans cet ordre sur une réserve
  // commune, les premiers la vidaient avant que les derniers n'aient leur tour.
  //
  // Mesuré le 2026-08-17 sur le cycle en cours, et la pente ne laisse aucun doute :
  //   QC 198/874 · ON 83/415 (14 h UTC)   → servis
  //   SK 11/201 · AB 31/75  (16 h UTC)   → à peine entamés
  //   BC 0/333              (17 h UTC)   → PAS UN SEUL COURRIEL DE TOUT LE MOIS
  // Plus un fuseau est à l'ouest, plus il est affamé. Ce n'était pas un bug visible :
  // le worker n'a jamais rien signalé, et sans le tableau par province du récapitulatif
  // personne ne l'aurait vu.
  //
  // LA RÉSERVE. Chaque passage ne prend plus que SA PART de ce qui reste au jour,
  // divisée par le nombre de passages qui ont encore des fuseaux à servir aujourd'hui
  // (celui-ci compris). Le dernier passage du jour hérite donc de tout le reliquat.
  // Le total quotidien ne bouge pas : on ne change QUE le partage.
  //
  // Auto-correcteur : un fuseau qui n'utilise pas sa part ne la gaspille pas — `daySoFar`
  // ne compte que les tentatives réelles, donc le passage suivant divise un reste plus
  // gros par un diviseur plus petit et récupère la mise.
  const passagesRestants = (() => {
    let n = 0;
    for (let u = at.getUTCHours(); u <= CRON_DERNIERE_HEURE_UTC; u++) {
      const d = new Date(at); d.setUTCHours(u, 0, 0, 0);
      if (zonesAt10h(d).size) n++;
    }
    return Math.max(1, n);
  })();
  const partPassage = Math.max(1, Math.floor((dayCap - daySoFar) / passagesRestants));

  // En dry-run rien n'est consommé : l'audience complète du mois doit apparaître au rapport.
  // File d'envoi (2026-08-10) : on n'appelle plus Resend courriel par courriel, on EMPILE
  // et on vide par lots de 100 — un seul appel, donc UNE sous-requête, par lot.
  const file = [];
  const lotsAPrevoir = () => Math.ceil((file.length + 1) / TAILLE_LOT);
  // ── PART RÉSERVÉE AUX EXPERTS (2026-08-19) ─────────────────────────────────────────
  // MESURÉ le 18 août en KV : `sent:2026-08:` = 623 prospects contre 217 experts, et le
  // compte des experts est FIGÉ depuis le 13 août. 351 experts publiés n'ont rien reçu du
  // mois. Surtout : les 217 `intro:` sont tous restés à l'étape ⓪ — pas UN SEUL courriel
  // ② « confirmez votre fiche » n'est jamais parti, alors que c'est l'étape qui produit
  // les Recommandés, donc les badges, donc les liens retour — le seul levier d'autorité
  // du site (10 liens externes pour 1 962 pages).
  //
  // LA CAUSE, dans ce fichier : la boucle des prospects (plus haut) s'exécute AVANT celle
  // des experts et partage le même `canSend()`. Les prospects sont ~2 300 et grossissent
  // de ~150/nuit par la récolte ; les experts sont ~625 et ne bougent pas. À part égale
  // dans une file unique, les premiers mangent tout : ce n'est pas un bug, c'est l'ordre
  // des boucles qui devient une famine dès que la récolte dépasse le catalogue.
  //
  // LE CORRECTIF, minimal : les prospects ne peuvent plus consommer que (1 − EXPERTS_SHARE)
  // de la part du passage ; les experts gardent l'accès à la part entière. On ne change ni
  // le plafond du jour, ni le partage entre fuseaux, ni l'ordre des boucles — seulement le
  // droit de tirage des prospects.
  //
  // Ce n'est PAS un gaspillage quand il n'y a pas d'expert à servir : la réserve non
  // utilisée n'est pas consommée, donc `daySoFar` ne monte pas, et l'auto-correcteur
  // décrit plus haut (reste plus gros ÷ diviseur plus petit) la rend au passage suivant.
  const EXPERTS_SHARE = Number(env.EXPERTS_SHARE ?? 0.30);
  const partProspects = Math.max(1, Math.floor(partPassage * (1 - EXPERTS_SHARE)));

  // `kind` vaut 'expert' ou 'prospect'. Défaut 'expert' : un appel non qualifié garde le
  // comportement d'avant (part entière) plutôt que de se retrouver bridé en silence.
  const canSend = (kind = 'expert') => dryRun
    || (left() - lotsAPrevoir() >= 0
        && report.attempts < (kind === 'prospect' ? partProspects : partPassage)
        && daySoFar + report.attempts < dayCap);         // et jamais plus que le jour

  // ── ESPACEMENT PAR DOMAINE (2026-08-12) ────────────────────────────────────────────
  // Le plafond « par firme » du versement a été retiré : il comptait des NOMS DE FIRME
  // alors que le risque se joue sur les DOMAINES. Mesuré le 2026-08-12 avec un plafond
  // de 5 en vigueur : pmegatineau.ca 26 adresses en base, mortgagealliance.com 21,
  // royallepage.ca 19 — les bannières franchisées regroupent des dizaines de firmes
  // juridiquement distinctes sur un domaine unique et passaient au travers.
  //
  // Or les clés sont parcourues dans l'ordre `s:{ville}:{courriel}` : les 26 adresses
  // d'un même cabinet de Gatineau sont contiguës et partaient dans le MÊME lot, le même
  // jour. Un serveur d'entreprise lit ça comme une rafale, et une seule plainte peut
  // faire bloquer le domaine entier — on perdrait les 26 d'un coup, plus la réputation.
  //
  // La protection est ICI et pas à la collecte : personne n'est écarté de la base, le
  // reste passe simplement au lendemain. Compteur par jour et par domaine en KV (TTL 3 j),
  // partagé par les sept passages horaires.
  //
  // ⚠️ LE COMPTE MONTE À LA MISE EN FILE, pas à l'acceptation : l'envoi étant différé,
  // compter à l'acceptation laisserait une seule exécution empiler les 26 avant que le
  // premier lot ne parte.
  const MAX_PAR_DOMAINE = Number(env.MAX_PAR_DOMAINE || 5);
  const domaineDe = (email) => String(email || '').split('@')[1]?.toLowerCase() || '?';
  const domCache = new Map();                    // domaine -> déjà servi/en file aujourd'hui
  const domDejaVu = async (dom) => {
    if (!domCache.has(dom)) {
      const v = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get(`dom:${dayKey}:${dom}`) : null;
      domCache.set(dom, Number(v || 0));
    }
    return domCache.get(dom);
  };
  // true = on peut servir cette adresse aujourd'hui ; réserve le créneau au passage.
  const prendreCreneauDomaine = async (email) => {
    if (dryRun) return true;
    const dom = domaineDe(email);
    const n = await domDejaVu(dom);
    if (n >= MAX_PAR_DOMAINE) { report.reportesDomaine = (report.reportesDomaine || 0) + 1; return false; }
    domCache.set(dom, n + 1);
    return true;
  };

  // Échantillon du jour (décision proprio, 2026-08-09) : la PREMIÈRE fois qu'un courriel
  // part dans la journée, une copie conforme (même HTML, même sujet) file au proprio,
  // sujet préfixé « [échantillon → destinataire] ». Une seule par jour (clé KV, TTL 3 j),
  // hors plafond quotidien — c'est de l'observation, pas de l'audience.
  let sampleSent = dryRun || !env.SUBSCRIBERS
    || Boolean(await env.SUBSCRIBERS.get(`sample:${dayKey}`));
  const envoyerEchantillon = async (aQui, subject, html) => {
    if (sampleSent) return;
    sampleSent = true;
    ctr.subs++;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
        to: [REPORT_TO],
        subject: `[échantillon → ${aQui}] ${subject}`,
        html,
      }),
    }).catch(() => { /* l'échantillon n'est jamais bloquant */ });
    await env.SUBSCRIBERS.put(`sample:${dayKey}`, new Date().toISOString(),
      { expirationTtl: 3 * 24 * 3600 });
  };

  // Vidage de la file, par lots de 100. On ne marque `sent:` (ni `intro:`) qu'APRÈS
  // acceptation par Resend, courriel par courriel : un refus repart demain, intact — la
  // règle n'a pas bougé, seul le moment où on la vérifie a changé.
  const echecsParProv = {};
  // ── RAMPE DU SOUS-DOMAINE NEUF (2026-08-19) ──────────────────────────────────────
  // `outreach.payotte.com` n'a aucun historique d'envoi. Un domaine neuf qui passe de 0 à
  // 400 courriels/jour se fait classer en pourriel — la montée doit être progressive et
  // CONDITIONNELLE. Les paliers sont datés dans wrangler.toml (OUTREACH_RAMPE) ; à défaut,
  // on reste au plancher. Le passage au palier suivant n'est PAS automatique dans le temps :
  // il exige que le webhook n'ait vu ni plainte ni rebond au-delà des seuils (voir
  // `fluxCoupe()` plus bas) — sinon le plafond reste où il est.
  const rampeOutreach = () => {
    const brut = env.OUTREACH_RAMPE || '';        // ex. « 2026-08-20:100,2026-08-27:200 »
    let plafond = Number(env.OUTREACH_PLANCHER ?? 50);
    for (const p of brut.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [d, n] = p.split(':');
      if (d && n && dayKey >= d.trim()) plafond = Number(n);
    }
    return Math.max(0, plafond);
  };

  const viderFile = async () => {
    while (file.length) {
      const lot = file.splice(0, TAILLE_LOT);
      ctr.subs++;
      // Un lot peut mêler prospects et experts : on n'envoie donc pas le lot entier sous un
      // seul expéditeur, on le fend par flux. Deux appels au pire, toujours ≤ 2 sous-requêtes.
      const parFlux = new Map();
      for (const e of lot) {
        const f = e.flux === 'bulletin' ? 'bulletin' : 'outreach';
        (parFlux.get(f) ?? parFlux.set(f, []).get(f)).push(e);
      }
      const reponses = new Array(lot.length);
      for (const [flux, sousLot] of parFlux) {
        const fromFlux = flux === 'bulletin'
          ? (env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>')
          : (env.MAIL_FROM_OUTREACH || env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>');
        const r = await sendPulseBatch(env, sousLot, { from: fromFlux });
        sousLot.forEach((e, k) => { reponses[lot.indexOf(e)] = r[k]; });
        // Compteur par flux — c'est lui que la rampe et les seuils de plainte lisent.
        const cle = `day:${dayKey}:${flux}`;
        const dejaFlux = Number((await env.SUBSCRIBERS?.get(cle)) || 0);
        await env.SUBSCRIBERS?.put(cle, String(dejaFlux + sousLot.length), { expirationTtl: 3 * 24 * 3600 });
      }
      for (let i = 0; i < lot.length; i++) {
        const e = lot[i];
        const r = reponses[i];
        if (!r?.ok) {
          report.failed++;
          if (e.prov) echecsParProv[e.prov] = (echecsParProv[e.prov] || 0) + 1;
          report.errors.push(`${e.etiquette} — Resend HTTP ${r?.status ?? '?'}${r?.error ? ` (${r.error})` : ''}`);
          continue;
        }
        await env.SUBSCRIBERS?.put(`sent:${cycle}:${e.cle}`, new Date().toISOString(), { expirationTtl: CYCLE_TTL });
        if (e.stage === 'intro') await env.SUBSCRIBERS?.put(`intro:${e.cle}`, new Date().toISOString());
        // Compteur du jour par domaine, persisté pour les passages horaires suivants.
        // On écrit la valeur RÉSERVÉE (mise en file), pas le nombre d'acceptations : elle
        // majore, et majorer va dans le sens de la prudence pour la réputation.
        const domE = domaineDe(e.to);
        await env.SUBSCRIBERS?.put(`dom:${dayKey}:${domE}`, String(domCache.get(domE) ?? 1),
          { expirationTtl: 3 * 24 * 3600 });
        report.sent++;
        await envoyerEchantillon(e.to, e.subject, e.html);
      }
    }
  };

  // `attempts` = appels Resend tentés (ils consomment le budget, réussis ou non) ;
  // `sent` = acceptés par Resend ; `failed`/`errors` = refusés ; `pending` = ce qui reste
  // à faire ce mois-ci et repassera au prochain passage.
  const report = {
    dryRun, cycle, attempts: 0, sent: 0, failed: 0, pending: 0,
    // Reportés au lendemain parce que leur domaine avait déjà eu ses MAX_PAR_DOMAINE
    // du jour. À zéro tant qu'aucune bannière ne sature : c'est le témoin de l'espacement.
    reportesDomaine: 0,
    // Envois de PROSPECTION mis en file à ce passage — sert à faire respecter la rampe du
    // sous-domaine neuf sans relire le compteur KV à chaque courriel.
    outreachEnvoyes: 0,
    prospects: 0, experts: { intro: 0, yellow: 0, green: 0, reco: 0, partner: 0 },
    activeCities: 0, errors: [], skipped: [], recipients: [], budgetUsed: 0,
    zones: [], dayUsedBefore: daySoFar, dayCap, partPassage, passagesRestants,
  };

  // Fuseaux servis à ce passage. En dry-run on ne filtre pas : le rapport doit montrer
  // l'audience du mois entier, pas la seule tranche de 10 h en cours.
  const zones = zonesAt10h(at);
  report.zones = [...zones];

  const market = await F('/api/market.json').catch(() => ({ cities: [] }));
  const allActive = (market.cities || []).filter(hasMarketStats);
  // Le filtre par fuseau s'applique ICI, sur les villes : tout le reste (prospects comme
  // experts) passe par `cityBySlug`, donc personne hors tranche ne peut être servi.
  const active = dryRun ? allActive : allActive.filter((c) => zones.has(c.province));
  const cityBySlug = Object.fromEntries(active.map((c) => [c.slug, c]));
  report.activeCities = active.length;

  // Aucune province à 10 h : on s'arrête là (1 feed, 1 lecture KV). Le cas normal 6 fois sur 7.
  if (!active.length) { report.budgetUsed = ctr.subs; return report; }

  // Taux et obligations : NATIONAUX, donc identiques pour tout le monde. Deux sous-requêtes
  // pour l'exécution entière, jamais deux par courriel. Feeds indisponibles → `macro` reste
  // null et le bloc disparaît simplement du gabarit : aucun envoi n'est bloqué pour ça.
  const macro = await macroCourant();
  report.macro = macro ? 'taux+obligations' : 'indisponible';

  // État du cycle : 3 lectures KV, pas une seule sous-requête.
  const done = new Set(env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, `sent:${cycle}:`) : []);
  const unsub = new Set(env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'unsub:') : []);
  const intro = new Set(env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'intro:') : []);

  // Cohorte de l'ANCIENNE présentation (avant le passage à l'opt-out). Ce courriel-là
  // promettait par écrit : « Répondez oui et je vous l'envoie. Sinon, aucune suite » et
  // « Aucune suite sans votre accord ». La décision du 2 août change la règle pour la suite,
  // elle n'efface pas cette phrase déjà envoyée : enrôler ces gens en silence dans l'escalier
  // ①②③④ serait reprendre la parole donnée. Ils reçoivent donc d'abord la NOUVELLE
  // présentation — qui dit ce qui va se passer et comment l'arrêter en un clic — puis entrent
  // dans le cycle comme les autres. Une seule fois : l'envoi réécrit leur clé `intro:`.
  // Lecture KV seulement (hors budget de sous-requêtes), et seulement pour les déjà-présentés.
  const OPT_OUT_SWITCH = '2026-08-02';
  const reIntro = new Set();
  if (env.SUBSCRIBERS) {
    for (const slug of intro) {
      const at = await env.SUBSCRIBERS.get(`intro:${slug}`);
      if (at && at.slice(0, 10) < OPT_OUT_SWITCH) reIntro.add(slug);
    }
  }

  // ---- Prospects (abonnés du formulaire) ----
  // Liste hissée hors de la boucle : elle sert DEUX fois — pour servir, puis pour le
  // recensement par province du récapitulatif. Un `kv.list()` de plus serait gratuit en
  // budget de sous-requêtes, mais pas en temps d'exécution (2 100 clés paginées).
  const clesProspects = env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 's:') : [];
  if (env.SUBSCRIBERS) {
    // ── FILTRER AVANT DE LIRE (2026-08-13) ────────────────────────────────────────
    // Le 13 août, AUCUN bulletin n'est parti et aucun rapport n'a été émis : le passage
    // lisait la VALEUR des 1 512 prospects, en série, avant de découvrir que la plupart
    // sont hors du fuseau servi ou déjà servis ce cycle. À ~1 100 prospects ça passait
    // encore ; la récolte en a versé 933 le 12 août et le passage a fini par dépasser son
    // temps d'exécution — en silence, puisque le rapport n'est envoyé que s'il y a eu au
    // moins une tentative. Une panne qui grandit avec le succès de la récolte.
    //
    // Or la clé porte DÉJÀ tout ce qu'il faut pour écarter : `s:{ville}:{courriel}`, et
    // l'identifiant de cycle est exactement `prospect:{ville}:{courriel}`. On filtre donc
    // sur la clé — zéro lecture — et on ne lit la valeur que pour ceux qu'on va servir.
    // Les lectures passent de 1 512 par passage à quelques dizaines.
    for (const key of clesProspects) {
      const sep = key.indexOf(':');
      if (sep < 1) continue;                         // clé malformée : on ne devine pas
      const city = cityBySlug[key.slice(0, sep)];
      if (!city) continue;                           // hors du fuseau servi à cette heure
      const id = `prospect:${key}`;
      if (done.has(id)) continue;                    // déjà servi ce cycle
      if (!canSend('prospect')) { report.pending++; continue; }
      // DRY-RUN : ni lecture de valeur, ni rendu. Le dry-run ne filtre pas par fuseau
      // (il doit montrer l'audience du mois entier), donc il tombait sur les 2 100 clés :
      // 2 100 lectures KV + 2 100 courriels fabriqués pour être jetés à la ligne suivante.
      // Le worker dépassait son temps d'exécution et /bulletin-dryrun répondait 500 (1101).
      // Or la clé `s:{ville}:{courriel}` porte DÉJÀ tout ce que le recensement demande.
      if (dryRun) {
        report.prospects++;
        report.recipients.push({ to: key.slice(sep + 1), kind: 'prospect', city: key.slice(0, sep) });
        continue;
      }
      const rec = JSON.parse((await env.SUBSCRIBERS.get(`s:${key}`)) || '{}');
      if (!rec.email) continue;
      // Rebond dur connu (webhook) : l'adresse est morte, elle ne repart jamais.
      const courrielBas = String(rec.email).toLowerCase();
      if (await env.SUBSCRIBERS.get(`bounce:${courrielBas}`)) { report.skipped.push(`${rec.email} (rebond)`); continue; }
      // Désabonné (lien, ou plainte convertie en désabonnement par le webhook).
      if (await env.SUBSCRIBERS.get(`unsub:prospect:${courrielBas}`)) continue;
      // Prospection arrêtée : un abonné du formulaire continue d'être servi, pas un
      // contact récolté. La distinction est celle du flux, pas celle de la personne.
      const fluxRec = rec.source === 'form-ville' ? 'bulletin' : 'outreach';
      if (stopOutreach && fluxRec === 'outreach') { report.pending++; continue; }
      if (fluxRec === 'outreach' && dejaOutreach + report.outreachEnvoyes >= rampeOutreach()) { report.pending++; continue; }
      // Garde-fou : si la valeur stockée ne concordait pas avec sa clé, l'identifiant
      // calculé plus haut serait faux et on risquerait un doublon. On revérifie sur
      // l'identifiant RÉEL avant d'engager quoi que ce soit.
      const idReel = `prospect:${rec.city}:${rec.email}`;
      if (idReel !== id && done.has(idReel)) continue;
      // Domaine saturé pour aujourd'hui : on ne marque RIEN (ni `done`, ni `sent:`),
      // l'adresse repassera telle quelle au prochain passage.
      if (!await prendreCreneauDomaine(rec.email)) { report.pending++; continue; }
      const unsubUrl = `${origin}/unsubscribe?e=${encodeURIComponent(rec.email)}&c=${encodeURIComponent(rec.city)}&t=${await hmacHex(env, `u:${rec.email}:${rec.city}`)}`;
      const { subject, html } = renderPulse({ segment: 'prospect', city, lang: rec.lang, unsubUrl, macro, metier: rec.metier , postale });
      report.prospects++; report.recipients.push({ to: rec.email, kind: 'prospect', city: rec.city });
      if (dryRun) continue;
      report.attempts++;
      done.add(idReel);                // servi pour ce cycle dès la mise en file
      // FLUX (2026-08-19) : `source: 'form-ville'` = l'abonné a rempli le formulaire du
      // site, il a DEMANDÉ le bulletin → expéditeur bulletin@. Tout le reste vient de la
      // récolte nocturne (`source` = l'URL où l'adresse a été relevée), donc non sollicité
      // → expéditeur outreach@. La règle lit la donnée existante, rien à migrer.
      if (fluxRec === 'outreach') report.outreachEnvoyes++;
      file.push({ to: rec.email, subject, html, unsubUrl, cle: idReel,
                  flux: fluxRec,
                  etiquette: `prospect ${rec.email}` });
      if (file.length >= TAILLE_LOT) await viderFile();
    }
  }

  // ---- Experts, province par province ----
  // On ne rapatrie une province QUE si on a encore de quoi envoyer : chaque feed coûte une
  // sous-requête. `prov-done:` évite de repayer ce feed les jours suivants pour une province
  // déjà entièrement servie ce mois-ci.
  let dir = {};
  if (env.CONTACTS_TOKEN) { try { dir = (await F(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts || {}; } catch { /* annuaire indispo */ } }
  const provinces = [...new Set(active.map((c) => PROV_SLUG[c.province]).filter(Boolean))];
  const provDone = new Set(env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, `prov-done:${cycle}:`) : []);
  // Les adresses déjà servies ce mois-ci : un pro inscrit sur deux secteurs ne reçoit
  // qu'un seul courriel par mois (l'autre fiche attendra le cycle suivant).
  const mailsDone = new Set([...done].map((id) => dir[id]?.email?.toLowerCase()).filter(Boolean));
  const provCompletes = [];        // provinces sans reste — confirmées après le vidage

  for (const prov of provinces) {
    if (provDone.has(prov)) continue;
    if (left() <= 1) { report.skipped.push(`${prov} (budget épuisé)`); continue; }
    const experts = await F(`/api/experts/${prov}.json`).then((d) => d.experts ?? []).catch(() => []);
    let restants = 0;
    for (const e of experts) {
      const city = cityBySlug[e.city];
      if (!city || e.score?.color === 'red' || !e.score?.color) continue;
      if (done.has(e.slug) || unsub.has(e.slug)) continue;
      const contact = dir[e.slug];
      if (!contact?.email) { report.skipped.push(`${e.slug} (pas de courriel)`); continue; }
      if (mailsDone.has(contact.email.toLowerCase())) continue;   // doublon d'adresse : au prochain cycle
      if (await env.SUBSCRIBERS?.get(`bounce:${contact.email.toLowerCase()}`)) { report.skipped.push(`${e.slug} (rebond)`); continue; }
      if (stopOutreach) { restants++; report.pending++; continue; }   // l'escalier est de la prospection
      if (dejaOutreach + report.outreachEnvoyes >= rampeOutreach()) { restants++; report.pending++; continue; }
      const stage = expertStage(e, intro.has(e.slug) && !reIntro.has(e.slug));
      if (!stage) continue;
      if (!canSend()) { restants++; report.pending++; continue; }
      // Domaine saturé : `restants++` est essentiel — sans lui la province serait
      // marquée `prov-done:` et son feed ne serait plus rapatrié avant le mois prochain.
      if (!await prendreCreneauDomaine(contact.email)) { restants++; report.pending++; continue; }
      report.experts[stage] = (report.experts[stage] || 0) + 1;
      report.recipients.push({ to: contact.email, kind: `expert:${stage}`, slug: e.slug });
      // Le dry-run tient la même comptabilité (sans écrire en KV), sinon il annoncerait une
      // audience gonflée des doublons d'adresse que l'envoi réel, lui, écarte.
      if (dryRun) { done.add(e.slug); mailsDone.add(contact.email.toLowerCase()); continue; }
      const unsubUrl = await expertUnsubUrl(env, origin, e.slug);
      const { subject, html } = renderPulse({ segment: 'expert', stage, city, expert: e, lang: contact.lang || e.lang, unsubUrl, macro, postale });
      report.attempts++;
      // Marqué « servi » DÈS la mise en file : l'envoi n'étant plus immédiat, un pro
      // inscrit sur deux secteurs serait sinon empilé deux fois dans le même lot.
      done.add(e.slug); mailsDone.add(contact.email.toLowerCase());
      // L'escalier expert est de la prospection : personne n'a demandé à le recevoir.
      report.outreachEnvoyes++;
      file.push({ to: contact.email, subject, html, unsubUrl, cle: e.slug, stage, prov,
                  flux: 'outreach',
                  etiquette: e.slug });
      if (file.length >= TAILLE_LOT) await viderFile();
    }
    if (!restants && !dryRun) provCompletes.push(prov);
  }

  // Tout ce qui reste en file part maintenant.
  await viderFile();

  // `prov-done:` seulement pour les provinces dont TOUT est réellement parti : aucun reste
  // ET aucun refus au vidage. Marquée à tort, une province ne serait pas rouverte avant le
  // mois prochain — son feed ne serait même plus rapatrié.
  for (const prov of provCompletes) {
    if (!echecsParProv[prov]) {
      await env.SUBSCRIBERS?.put(`prov-done:${cycle}:${prov}`, new Date().toISOString(), { expirationTtl: CYCLE_TTL });
    }
  }

  // ---- RECENSEMENT PAR PROVINCE (demande proprio, 2026-08-17) ----------------------
  // « Combien est parti ce coup-ci, combien par province depuis le début du cycle, et
  // combien reste-t-il pour faire le tour du mois. »
  //
  // Côté INFOLETTRE c'est exact et gratuit : la clé `s:{ville}:{courriel}` porte déjà la
  // ville, l'identifiant de cycle est `prospect:{ville}:{courriel}`, et les opérations KV
  // ne comptent pas dans le budget de sous-requêtes. Aucune valeur n'est lue.
  //
  // Un désabonnement prospect SUPPRIME sa clé `s:` : la liste est donc l'audience vivante,
  // il n'y a rien à retrancher. `done` a été alimenté pendant ce passage, donc « servis »
  // inclut bien les envois de cet événement.
  //
  // Côté EXPERTS, on ne peut PAS recenser sans payer : chaque province coûte une
  // sous-requête de feed, et une province déjà finie n'est même plus rapatriée. On
  // n'annonce donc que ce qu'on sait pour de vrai — les provinces marquées `prov-done:`
  // sont terminées pour le mois — plutôt qu'un total inventé.
  //
  // Réserve assumée : un abonné dont la valeur stockée ne concorde pas avec sa clé est
  // marqué sous son identifiant RÉEL (voir le garde-fou `idReel` plus haut) ; il compterait
  // alors comme « à servir ». Cas rare et sans conséquence — le prochain passage l'écarte.
  {
    const provDeVille = Object.fromEntries(allActive.map((c) => [c.slug, c.province]));
    const par = {};
    let sansMarche = 0;   // abonnés d'une ville sans chiffres : le bulletin n'a rien à leur dire
    for (const key of clesProspects) {
      const sep = key.indexOf(':');
      if (sep < 1) continue;
      const code = provDeVille[key.slice(0, sep)];
      if (!code) { sansMarche++; continue; }
      const p = (par[code] ||= { total: 0, servis: 0 });
      p.total++;
      if (done.has(`prospect:${key}`)) p.servis++;
    }
    report.parProvince = par;
    report.prospectsSansMarche = sansMarche;
    report.provincesTerminees = [...provDone].sort();
  }

  report.budgetUsed = ctr.subs;
  // Report du compte du jour pour les passages horaires suivants. On additionne les TENTATIVES,
  // pas les succès : un appel refusé par Resend a quand même été facturé au quota du jour.
  // TTL 3 jours — la clé ne sert que dans sa journée.
  if (!dryRun && report.attempts) {
    await env.SUBSCRIBERS?.put(`day:${dayKey}`, String(daySoFar + report.attempts), { expirationTtl: 3 * 24 * 3600 });
  }
  if (!dryRun && (report.attempts || report.failed)) await sendRunReport(env, report);
  return report;
}

// Un seul courriel par exécution, pour le proprio : ce qui est parti, ce qui a raté, ce qui
// reste. C'est la seule trace — le worker n'a pas de journal persistant.

/**
 * Le compte rendu d'une vague de séquence, en texte, au propriétaire.
 *
 * POURQUOI EN TEXTE, ET POURQUOI SI COURT. Le rapport n'existe pas pour archiver : il
 * existe pour qu'une anomalie saute aux yeux dans une notification de téléphone. Ce qui
 * compte est en haut (combien partis, combien ratés), le détail suit, et la seule ligne
 * qui demande une action est isolée à la fin.
 */
async function envoyerRapportSequence(env, r) {
  if (!env.RESEND_API_KEY) return;
  const etapes = Object.entries(r.parEtape).sort().map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  const lignes = [
    `Vague du ${r.vague} — provinces servies : ${r.zones.join(', ') || '—'}`,
    ``,
    `Partis   : ${r.envoyes}`,
    `Ratés    : ${r.rates}`,
    `Par étape: ${etapes}`,
    ``,
    r.sorties.length ? `Sorties de la séquence (${r.sorties.length}) :` : `Aucune sortie.`,
    ...r.sorties.map((x) => `  · ${x}`),
    ``,
    `À FAIRE : répondre aux réponses reçues. C'est là que la valeur se crée —`,
    `la machine ne fait qu'envoyer.`,
    ``,
    `État complet : GET /sequence-status?t={CONTACTS_TOKEN}`,
  ].join('\n');
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [REPORT_TO], reply_to: REPLY_TO,
      subject: `Séquence — ${r.vague} — ${r.envoyes} partis · ${r.rates} ratés · ${etapes}`,
      text: lignes,
    }),
  }).catch(() => {});
}

async function sendRunReport(env, report) {
  if (!env.RESEND_API_KEY) return;
  // `pending` ne compte que les candidats VUS après épuisement du budget : les provinces
  // qu'on n'a même pas rapatriées faute de sous-requêtes n'y figurent pas. On annonce donc
  // « au moins », jamais un chiffre définitif qu'on n'a pas les moyens de calculer.
  const provAttendues = report.skipped.filter((s) => s.endsWith('(budget épuisé)')).length;
  const partiel = report.pending > 0 || provAttendues > 0;
  const reste = partiel ? `au moins ${report.pending}` : '0';
  const jour = (report.dayUsedBefore ?? 0) + report.attempts;
  // Tableau par province (demande proprio du 2026-08-17) : ce qui est parti ce coup-ci est
  // sur la 1re ligne ; ici c'est le CUMUL DU CYCLE et ce qu'il reste pour finir le tour.
  // Trié par reste décroissant : ce qui bloque la fin du mois se lit en premier.
  const pp = report.parProvince || {};
  const rangs = Object.entries(pp)
    .map(([code, v]) => ({ code, ...v, reste: v.total - v.servis }))
    .sort((a, b) => b.reste - a.reste || b.total - a.total);
  const larg = Math.max(0, ...rangs.map((r) => String(r.total).length));
  const blocProvinces = rangs.length ? [
    ``,
    `INFOLETTRE PAR PROVINCE — cycle ${report.cycle} (cumul, cet envoi compris)`,
    ...rangs.map((r) =>
      `  ${r.code.padEnd(3)} envoyés ${String(r.servis).padStart(larg)}/${String(r.total).padEnd(larg)}`
      + ` · reste ${String(r.reste).padStart(larg)}`
      + (r.reste === 0 ? '  ✓ tour terminé' : '')),
    `  ${'—'.repeat(3)} TOTAL   ${rangs.reduce((n, r) => n + r.servis, 0)}/${rangs.reduce((n, r) => n + r.total, 0)}`
      + ` · reste ${rangs.reduce((n, r) => n + r.reste, 0)}`,
    report.prospectsSansMarche
      ? `  (+ ${report.prospectsSansMarche} abonné(s) dans une ville sans chiffres de marché : jamais servis, le bulletin n'aurait rien à leur dire)`
      : '',
    report.provincesTerminees?.length
      ? `  Côté EXPERTS, provinces bouclées ce cycle : ${report.provincesTerminees.join(', ')}.`
        + ` Les autres ne sont pas recensables sans payer une sous-requête par province.`
      : `  Côté EXPERTS, aucune province encore bouclée ce cycle.`,
  ].filter(Boolean) : [];

  const L = [
    `Cycle ${report.cycle} — CET ENVOI : ${report.sent} parti(s) · ${report.failed} raté(s) · reste ${reste} dans ce passage`,
    `Passage de 10 h : ${report.zones?.join(', ') || '—'} · ${report.activeCities} ville(s) dans la tranche`,
    `Rythme du jour (toutes tranches) : ${jour}/${report.dayCap ?? dailySendCap()}`
      + ` · part de ce passage ${report.attempts}/${report.partPassage ?? '—'}`
      + ` (${report.passagesRestants ?? '?'} passage(s) à fuseau restant(s) aujourd'hui)`,
    `Sous-requêtes : ${report.budgetUsed}/${SUBREQUEST_BUDGET}${provAttendues ? ` · provinces non ouvertes : ${provAttendues}` : ''}`,
    `Étapes : ${Object.entries(report.experts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}${report.prospects ? ` · prospects ${report.prospects}` : ''}`,
    ...blocProvinces,
    partiel
      ? `\nIl reste du monde dans ce ou ces fuseaux : ils seront servis demain, à 10 h chez eux.`
      : `\nCe fuseau est à jour pour le mois. Les autres sont servis à leur propre 10 h.`,
    report.errors.length ? `\nÉCHECS (${report.errors.length}) — ils repasseront demain :\n${report.errors.slice(0, 40).join('\n')}` : '',
  ];
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [REPORT_TO],
      subject: `Bulletin ${report.cycle} ${report.zones?.join('/') || ''} — ${report.sent} envoyés${report.failed ? `, ${report.failed} ratés` : ''}${partiel ? ', vague en cours' : ', fuseau à jour'}`,
      text: L.filter(Boolean).join('\n'),
    }),
  }).catch(() => { /* le récap n'est jamais bloquant */ });
}

async function handleSubscribe(request, env, url) {
  let email = '', ville = '', honeypot = '';
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('json')) {
    const b = await request.json().catch(() => ({}));
    email = b.email; ville = b.ville; honeypot = b.website;
  } else {
    const f = await request.formData().catch(() => null);
    if (f) { email = f.get('email'); ville = f.get('ville'); honeypot = f.get('website'); }
  }
  email = String(email ?? '').trim().toLowerCase();
  ville = strip(ville);
  const frGuess = true;
  if (honeypot) return subPage('fr', 'Merci', 'Inscription reçue.'); // robot : on sourit, on ignore
  if (!EMAIL_RE.test(email) || !ville) {
    return subPage('fr', 'Oups', "Courriel ou ville manquant — réessayez depuis la page de la ville. / Missing email or city — please retry from the city page.");
  }
  const market = await feed('/api/market.json');
  const city = market.cities.find((c) => strip(c.slug) === ville || strip(c.name) === ville);
  if (!city) return subPage('fr', 'Oups', `Ville inconnue : ${ville}. / Unknown city.`);
  const lang = city.province === 'QC' ? 'fr' : 'en';
  const fr = lang === 'fr';
  const cityUrl = `${SITE}/`;

  const key = `s:${city.slug}:${email}`;
  if (env.SUBSCRIBERS && (await env.SUBSCRIBERS.get(key))) {
    return subPage(lang, fr ? 'Déjà abonné !' : 'Already subscribed!', fr ? `Vous recevez déjà le bulletin de ${city.name}.` : `You already receive the ${city.name} bulletin.`, cityUrl);
  }
  const day = new Date().toISOString().slice(0, 10);
  const n = await bumpCounter(env, `sub:${day}`, 3 * 86400);
  if (n > SUB_CAP_DAY) return subPage(lang, fr ? 'Un instant' : 'One moment', fr ? 'Trop d’inscriptions aujourd’hui — réessayez demain.' : 'Too many sign-ups today — please try again tomorrow.', cityUrl);

  if (env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(key, JSON.stringify({ email, city: city.slug, lang, consent: new Date().toISOString(), source: 'form-ville' }));
  }
  if (env.RESEND_API_KEY) await sendBulletin(env, url.origin, email, city, lang, true);
  return subPage(lang,
    fr ? 'Abonné !' : 'Subscribed!',
    fr ? `Votre premier bulletin de ${city.name} vient de partir vers ${email}. Un courriel par mois, désabonnement en un clic.` : `Your first ${city.name} bulletin is on its way to ${email}. One email per month, one-click unsubscribe.`,
    cityUrl);
}

/* ════════════════════════════════════════════════════════════════════════════════
   ALERTE TAUX — le seul courriel que les gens DEMANDENT (2026-08-19)
   ════════════════════════════════════════════════════════════════════════════════

   POURQUOI CELUI-LÀ ET PAS UN AUTRE. Tout le reste des envois Payotte est poussé : le
   bulletin mensuel (opt-out), la prospection, la séquence. Leur rendement mesuré est
   mauvais — 0 réponse sur 550 en juillet, aucune sur ~80 brouillons le 18 août. Ce n'est
   pas un problème de gabarit, c'est un problème de demande : personne n'a rien demandé.

   L'alerte taux est l'inverse exact. Elle part QUAND la Banque du Canada bouge son taux
   directeur, à des gens qui ont coché une case pour ça. Huit annonces par an, et le taux
   ne change pas à chacune : en 2026, cinq réunions, un seul mouvement. On parle donc de
   deux à quatre courriels par an et par personne — le volume le plus faible du système,
   et le seul dont la pertinence est garantie par l'événement lui-même.

   LA MÉCANIQUE, EN TROIS FAITS.
   1. `taux:{courriel}` — un inscrit. Clé PLATE, pas par ville : le taux directeur est
      national. Quelqu'un abonné à trois villes reçoit UNE alerte, pas trois.
   2. `taux:dernier` — la dernière valeur CONNUE du taux directeur, avec sa date. C'est la
      mémoire qui permet de dire « ça a bougé ». Sans elle, chaque passage du cron
      renverrait la même annonce.
   3. Le déclenchement lit la Banque du Canada EN DIRECT (`macroCourant`), jamais un feed
      statique — c'est précisément le genre de courriel où être en retard d'une journée
      détruit la crédibilité.

   ⚠️ CE QU'ELLE NE FAIT PAS. Aucun commentaire, aucune prévision, aucun conseil. On
   annonce le chiffre, l'ancien, la date, et on renvoie à la page. Écrire « les fixes vont
   suivre » serait une prédiction — donc une donnée inventée (Règle #3), doublée d'un
   conseil financier que Payotte n'a pas qualité pour donner.

   ⚠️ ELLE RESPECTE `stop:all`. Le 19 août, Grégory a coupé tous les envois Resend. Une
   alerte est un envoi : elle s'arrête avec le reste. Le jour où le taux bouge alors que
   l'interrupteur est posé, le worker journalise le fait et met à jour `taux:dernier`
   SANS envoyer — sinon la levée de l'interrupteur déclencherait une annonce périmée.
   ════════════════════════════════════════════════════════════════════════════════ */

const ALERTE_TAUX_LOT = 100;   // taille de lot Resend

/** Rendu de l'alerte. Deux chiffres, une date, un lien. Rien de plus. */
function renderAlerteTaux({ nouveau, ancien, observed, lang, unsubUrl, postale = '' }) {
  const fr = lang === 'fr';
  const nb = (v) => v.toLocaleString(fr ? 'fr-CA' : 'en-CA');
  const sens = ancien == null ? null : nouveau > ancien ? 'hausse' : 'baisse';
  const ecart = ancien == null ? null : Math.round(Math.abs(nouveau - ancien) * 100);

  const titre = fr
    ? (sens === 'hausse' ? `La Banque du Canada monte son taux à ${nb(nouveau)} %`
      : sens === 'baisse' ? `La Banque du Canada baisse son taux à ${nb(nouveau)} %`
        : `Taux directeur : ${nb(nouveau)} %`)
    : (sens === 'hausse' ? `Bank of Canada raises its rate to ${nb(nouveau)}%`
      : sens === 'baisse' ? `Bank of Canada cuts its rate to ${nb(nouveau)}%`
        : `Policy rate: ${nb(nouveau)}%`);

  const mouvement = ecart == null ? '' : fr
    ? `<p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#4a4446;">Le taux directeur passe de <strong>${nb(ancien)} %</strong> à <strong>${nb(nouveau)} %</strong>, soit ${ecart} points de base à la ${sens}. Observation datée du ${observed}.</p>`
    : `<p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#4a4446;">The policy rate moves from <strong>${nb(ancien)}%</strong> to <strong>${nb(nouveau)}%</strong> — ${ecart} basis points ${sens === 'hausse' ? 'up' : 'down'}. Observation dated ${observed}.</p>`;

  const corps = `
    <tr><td style="padding:34px 32px 0 32px;">
      <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#a49c9e;margin-bottom:10px;">${fr ? 'Alerte taux' : 'Rate alert'}</div>
      <h1 style="margin:0 0 18px 0;font-size:23px;line-height:1.3;color:#211c1e;font-weight:normal;">${titre}</h1>
      ${mouvement}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8f8;border:1px solid #f1ecec;border-radius:6px;margin:0 0 20px 0;">
        <tr><td style="padding:18px 20px;">
          <span style="font-size:13px;color:#8a8284;">${fr ? 'Taux directeur' : 'Policy interest rate'}</span><br>
          <span style="font-size:28px;color:#C8102E;font-weight:bold;">${nb(nouveau)} %</span>
          <span style="font-size:11px;color:#a49c9e;"> &middot; ${observed}</span>
        </td></tr>
      </table>
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.65;color:#6f6769;">${fr
        ? 'Payotte ne commente pas cette décision et n’en tire aucune prévision : le taux préférentiel, les taux fixes et les rendements obligataires réagissent à leur propre rythme, et personne ne peut le dater d’avance.'
        : 'Payotte does not comment on this decision or forecast from it: prime, fixed rates and bond yields each react on their own schedule, and no one can date that in advance.'}</p>
      <p style="margin:0 0 26px 0;font-size:14px;line-height:1.65;">
        <a href="${SITE}${fr ? '/taux-directeur-canada' : '/en/canada-policy-rate'}" style="color:#C8102E;">${fr ? 'Voir tous les taux courants sur payotte.com →' : 'See all current rates on payotte.com →'}</a>
      </p>
      <div style="font-size:11.5px;line-height:1.6;color:#a49c9e;border-top:1px solid #f1ecec;padding-top:14px;">${BOC_ATTRIBUTION}</div>
    </td></tr>`;

  const pied = FOOT(
    fr ? 'Vous recevez cette alerte parce que vous l’avez demandée. Elle ne part que lorsque le taux directeur change — deux à quatre fois par an.'
      : 'You receive this alert because you asked for it. It only goes out when the policy rate changes — two to four times a year.',
    unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale);

  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${corps}${pied}</table></div>`;
  return { subject: titre, html };
}

/**
 * L'inscription. Deux chemins, un seul enregistrement :
 *   POST /alerte-taux  {email, lang}            — depuis un formulaire du site
 *   GET  /alerte-taux?e={courriel}&t={hmac}     — un clic depuis le bulletin
 * L'HMAC du lien empêche d'inscrire quelqu'un d'autre en devinant l'URL.
 */
async function handleAlerteTauxInscription(request, env, url) {
  let email = '', lang = 'fr', honeypot = '';
  if (request.method === 'GET') {
    email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
    lang = url.searchParams.get('l') === 'en' ? 'en' : 'fr';
    const t = url.searchParams.get('t') ?? '';
    if (!email || t !== (await hmacHex(env, `a:${email}`))) {
      return subPage(lang, 'Lien invalide / Invalid link', 'Ce lien d’inscription est invalide. / This sign-up link is invalid.');
    }
  } else {
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('json')) {
      const b = await request.json().catch(() => ({}));
      email = b.email; lang = b.lang; honeypot = b.website;
    } else {
      const f = await request.formData().catch(() => null);
      if (f) { email = f.get('email'); lang = f.get('lang'); honeypot = f.get('website'); }
    }
    email = String(email ?? '').trim().toLowerCase();
    lang = String(lang ?? '') === 'en' ? 'en' : 'fr';
    if (honeypot) return subPage(lang, 'Merci', 'Inscription reçue.');   // robot
  }
  const fr = lang === 'fr';
  if (!EMAIL_RE.test(email)) return subPage(lang, fr ? 'Oups' : 'Oops', fr ? 'Adresse manquante ou invalide.' : 'Missing or invalid address.');

  if (env.SUBSCRIBERS) {
    // Un désabonnement antérieur est DÉFINITIF (LCAP art. 11) — sauf si la personne
    // revient d'elle-même s'inscrire, ce qui est exactement ce qui se passe ici. On lève
    // donc la pierre tombale plutôt que de refuser en silence : refuser sans le dire
    // laisserait quelqu'un croire qu'il est inscrit alors qu'il ne l'est pas.
    await env.SUBSCRIBERS.delete(`unsub:taux:${email}`);
    if (await env.SUBSCRIBERS.get(`bounce:${email}`)) {
      return subPage(lang, fr ? 'Adresse en rebond' : 'Address bouncing',
        fr ? 'Nos envois vers cette adresse reviennent en erreur. Écrivez-nous et on règle ça.' : 'Our emails to this address bounce. Write to us and we will fix it.');
    }
    const day = new Date().toISOString().slice(0, 10);
    const n = await bumpCounter(env, `alerte:${day}`, 3 * 86400);
    if (n > SUB_CAP_DAY) return subPage(lang, fr ? 'Un instant' : 'One moment', fr ? 'Trop d’inscriptions aujourd’hui — réessayez demain.' : 'Too many sign-ups today — please try again tomorrow.');
    await env.SUBSCRIBERS.put(`taux:${email}`, JSON.stringify({ email, lang, since: new Date().toISOString(), source: request.method === 'GET' ? 'bulletin' : 'form' }));
  }
  return subPage(lang, fr ? 'C’est noté !' : 'You’re in!',
    fr ? 'Vous recevrez une alerte le jour où la Banque du Canada change son taux directeur — deux à quatre fois par an, jamais plus. Désabonnement en un clic dans chaque envoi.'
      : 'You will get an alert the day the Bank of Canada changes its policy rate — two to four times a year, never more. One-click unsubscribe in every email.');
}

/**
 * Le déclencheur, appelé à chaque passage du cron. Coût quand rien ne bouge : une lecture
 * KV et une lecture Valet (mise en cache 1 h par Cloudflare) — c'est le cas 361 jours sur 365.
 */
async function runAlerteTaux(env, { at = new Date(), dryRun = false } = {}) {
  const r = { change: false, envoyes: 0, rates: 0, inscrits: 0 };
  if (!env.SUBSCRIBERS) return r;

  const macro = await macroCourant();
  const p = macro?.rates?.policyRate;
  if (p?.percent == null) return { ...r, note: 'taux directeur illisible' };

  const brut = await env.SUBSCRIBERS.get('taux:dernier');
  let memoire = null;
  try { memoire = brut ? JSON.parse(brut) : null; } catch { memoire = null; }

  // Première exécution : on MÉMORISE sans envoyer. Sinon la mise en service enverrait une
  // « alerte » pour un taux qui n'a pas bougé depuis des mois.
  if (!memoire || memoire.percent == null) {
    if (!dryRun) await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString() }));
    return { ...r, note: 'mémoire initialisée — aucun envoi' };
  }
  if (memoire.percent === p.percent) return r;      // le cas normal

  r.change = true;
  r.ancien = memoire.percent;
  r.nouveau = p.percent;
  r.observed = p.observed;

  // Interrupteur posé : on enregistre le mouvement, on n'envoie pas. Ne PAS mettre à jour
  // `taux:dernier` laisserait l'alerte partir au moment où l'interrupteur est levé —
  // c'est-à-dire annoncer comme une nouvelle un changement vieux de plusieurs jours.
  const stop = await env.SUBSCRIBERS.get('stop:all');
  if (stop) {
    if (!dryRun) await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString(), nonEnvoye: `stop:all ${stop}` }));
    return { ...r, arrete: 'stop:all', note: 'mouvement enregistré, aucune alerte envoyée' };
  }

  const emails = await kvKeys(env.SUBSCRIBERS, 'taux:');
  const inscrits = emails.filter((e) => e !== 'dernier' && EMAIL_RE.test(e));
  r.inscrits = inscrits.length;
  if (!inscrits.length) {
    if (!dryRun) await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString() }));
    return r;
  }

  const postale = adressePostale(env);
  const file = [];
  for (const email of inscrits) {
    let rec = {};
    try { rec = JSON.parse((await env.SUBSCRIBERS.get(`taux:${email}`)) ?? '{}'); } catch { /* clé abîmée : langue par défaut */ }
    const lang = rec.lang === 'en' ? 'en' : 'fr';
    const unsubUrl = `${WORKER_ORIGIN}/unsubscribe?a=taux&e=${encodeURIComponent(email)}&t=${await hmacHex(env, `a:${email}`)}`;
    const { subject, html } = renderAlerteTaux({ nouveau: p.percent, ancien: memoire.percent, observed: p.observed, lang, unsubUrl, postale });
    file.push({ to: email, subject, html, unsubUrl });
  }

  if (dryRun) return { ...r, envoyes: file.length, dryRun: true };

  const from = env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>';
  for (let i = 0; i < file.length; i += ALERTE_TAUX_LOT) {
    const lot = file.slice(i, i + ALERTE_TAUX_LOT);
    const res = await sendPulseBatch(env, lot, { from });
    res.forEach((x) => { if (x?.ok) r.envoyes++; else r.rates++; });
  }
  await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString(), envoyes: r.envoyes }));
  return r;
}

async function handleUnsubscribe(env, url) {
  const t = url.searchParams.get('t') ?? '';

  // Alerte taux : /unsubscribe?a=taux&e={courriel}&t={hmac}. Même règle que partout —
  // la pierre tombale `unsub:taux:` est DÉFINITIVE (LCAP art. 11) ; seule une réinscription
  // volontaire de la personne la lève (voir handleAlerteTauxInscription).
  if (url.searchParams.get('a') === 'taux') {
    const email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
    if (!email || t !== (await hmacHex(env, `a:${email}`))) {
      return subPage('fr', 'Lien invalide / Invalid link', 'Ce lien de désabonnement est invalide. / This unsubscribe link is invalid.');
    }
    if (env.SUBSCRIBERS) {
      await env.SUBSCRIBERS.put(`unsub:taux:${email}`, new Date().toISOString());
      await env.SUBSCRIBERS.delete(`taux:${email}`);
    }
    return subPage('fr', 'C\'est fait / Done', "Vous ne recevrez plus d'alerte de taux. Vos autres abonnements Payotte, s'il y en a, ne sont pas touchés. / You will receive no further rate alerts. Your other Payotte subscriptions, if any, are unaffected.");
  }

  // Expert : /unsubscribe?x={slug}&t={hmac}. Un clic, aucune question posée — c'est le seul
  // moyen de sortir de l'envoi mensuel (opt-out), et la clé posée est définitive.
  const slug = String(url.searchParams.get('x') ?? '');
  if (slug) {
    if (t !== (await hmacHex(env, `x:${slug}`))) return subPage('fr', 'Lien invalide / Invalid link', 'Ce lien de désabonnement est invalide. / This unsubscribe link is invalid.');
    if (env.SUBSCRIBERS) await env.SUBSCRIBERS.put(`unsub:${slug}`, new Date().toISOString());
    return subPage('fr', 'C\'est fait / Done', "Vous ne recevrez plus aucun courriel de Payotte. Votre fiche publique, elle, reste en ligne — elle ne dépend pas de ces envois. / You will receive no further email from Payotte. Your public profile stays online; it does not depend on these emails.");
  }

  const email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
  const ville = String(url.searchParams.get('c') ?? '');
  const expect = await hmacHex(env, `u:${email}:${ville}`);
  if (!email || !ville || t !== expect) return subPage('fr', 'Lien invalide', 'Ce lien de désabonnement est invalide ou expiré. / Invalid unsubscribe link.');
  if (env.SUBSCRIBERS) {
    // ── LE DÉSABONNEMENT DOIT ÊTRE MÉMORISÉ (corrigé le 2026-08-19) ────────────────
    // BUG : on supprimait la clé `s:` et rien d'autre. Or la récolte nocturne reverse
    // chaque nuit ce qu'elle trouve, et `verser-prospects.mjs` ne comparait qu'aux clés
    // VIVANTES : une adresse désabonnée redevenait donc « inconnue » dès la suppression,
    // et repartait au premier versement suivant. MESURÉ : 15 re-versements en 10 jours,
    // dont `carly@movewithmichael.ca` versée les 12, 15 ET 17 août.
    //
    // C'est la plainte type sous la LCAP (art. 11) : un désabonnement doit être honoré
    // sous 10 jours ouvrables et le rester. « Supprimer » n'est pas « se souvenir » —
    // il faut une TOMBE, pas une absence.
    //
    // La clé est posée par COURRIEL, pas par ville : la même personne peut être inscrite
    // sur deux villes, et elle a dit non à Payotte, pas à une ville.
    // Éternelle, sans TTL : un désabonnement ne se périme jamais.
    await env.SUBSCRIBERS.put(`unsub:prospect:${email}`, JSON.stringify({
      jour: new Date().toISOString().slice(0, 10), ville, motif: 'lien de désabonnement',
    }));
    await env.SUBSCRIBERS.delete(`s:${ville}:${email}`);
  }
  return subPage('fr', 'Désabonné / Unsubscribed', `${email} ne recevra plus le bulletin de ${ville}. / will no longer receive this bulletin.`);
}

// ---------------------------------------------------------------- JSON-RPC / MCP

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleRpc(msg, env) {
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const impl = TOOL_IMPL[params.name];
      if (!impl) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const result = await impl(params.arguments ?? {}, env);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: Boolean(result && result.error),
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Tool error: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return new Response(null, { status: 202, headers: CORS });
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════════
// runSequence — la vague du MARDI, 10 h locale, province par province.
// ═══════════════════════════════════════════════════════════════════════════════════
//
// L'HORAIRE EST DÉJÀ RÉSOLU. `zonesAt10h()` sait quelles provinces sont à 10 h à cette
// heure UTC, et le cron `0 12-18 * * *` couvre par construction les six fuseaux canadiens
// (Terre-Neuve 13 h UTC → Pacifique 17 h UTC). Rien à programmer côté Resend : son
// `scheduled_at` plafonne à 72 h ET n'existe pas en envoi par lots — il ne peut pas servir
// pour « mardi prochain ». Le cron se réveille et envoie en direct, comme le bulletin.
//
// AVANT LE BULLETIN, ET C'EST VOULU. La séquence porte une DATE promise (mardi) ; le
// bulletin mensuel, lui, s'étale sur tout le mois. À budget contraint, ce qui a une date
// passe devant ce qui a un mois.
//
// UN EXPERT EN SÉQUENCE SORT DE L'ESCALIER MENSUEL le temps de ses six semaines : sans
// ça il recevrait deux courriels la même semaine, dont un qui redemande ce que l'autre
// vient de demander.
//
// ⚠️ GARDE-FOU D'ENRÔLEMENT. Le council du 18 août a conditionné cette machine à un test
// préalable : 50 courriels envoyés à la main, ≥ 2 confirmations en 14 jours. La machine
// est construite, mais elle n'enrôle PERSONNE toute seule — `scripts/sequence.mjs enroler`
// refuse tant que `seq-feu-vert` n'est pas posé en KV. On ne code pas un entonnoir avant
// de savoir si le premier courriel fait répondre.
async function runSequence(env, { at = new Date(), dryRun = false } = {}) {
  const r = { vague: at.toISOString().slice(0, 10), envoyes: 0, rates: 0, parEtape: {}, sorties: [], zones: [] };
  if (!env.SUBSCRIBERS) return r;
  if (at.getUTCDay() !== 2) return r;                       // mardi seulement
  if (await env.SUBSCRIBERS.get('stop:all')) return { ...r, arrete: 'stop:all' };
  if (await env.SUBSCRIBERS.get('stop:outreach')) return { ...r, arrete: 'stop:outreach' };

  const zones = zonesAt10h(at);
  r.zones = [...zones];
  if (!zones.size) return r;

  const cles = await kvKeys(env.SUBSCRIBERS, 'seq:');
  if (!cles.length) return r;

  const dayKey = at.toISOString().slice(0, 10);
  const cycle = at.toISOString().slice(0, 7);
  const file = [];
  const feeds = new Map();
  const villes = new Map();
  let macro = null;

  for (const cle of cles) {
    const slug = cle.replace(/^seq:/, '');
    let etat; try { etat = JSON.parse((await env.SUBSCRIBERS.get(`seq:${slug}`)) || '{}'); } catch { continue; }
    if (!etat || etat.stop || (etat.etape ?? 0) >= 6) continue;
    if (await env.SUBSCRIBERS.get(`unsub:${slug}`)) { r.sorties.push(`${slug} (désabonné)`); continue; }
    if (await env.SUBSCRIBERS.get(`seq-sent:${dayKey}:${slug}`)) continue;   // déjà servi ce mardi
    if (!zones.has(etat.province)) continue;                                  // pas son fuseau

    // L'état VIVANT : on relit la fiche à chaque envoi plutôt que de rejouer l'enrôlement.
    if (!feeds.has(etat.province)) {
      feeds.set(etat.province, await feed(`/api/experts/${etat.province}.json`)
        .then((d) => d.experts ?? []).catch(() => []));
    }
    const expert = feeds.get(etat.province).find((e) => e.slug === slug);
    if (!expert || expert.score?.color === 'red') { r.sorties.push(`${slug} (non publié)`); continue; }
    if (expert.emailBounced) { r.sorties.push(`${slug} (rebond)`); continue; }
    const dest = String(etat.email || '').toLowerCase();
    if (!dest) { r.sorties.push(`${slug} (pas de courriel)`); continue; }
    if (await env.SUBSCRIBERS.get(`bounce:${dest}`)) { r.sorties.push(`${slug} (rebond dur)`); continue; }
    if (await env.SUBSCRIBERS.get(`unsub:prospect:${dest}`)) { r.sorties.push(`${slug} (désabonné)`); continue; }

    const etape = (etat.etape ?? 0) + 1;
    if (!villes.has(expert.city)) {
      const m = await feed('/api/market.json').catch(() => null);
      villes.set(expert.city, (m?.cities ?? m?.villes ?? []).find((c) => c.slug === expert.city) ?? null);
    }
    const city = villes.get(expert.city) ?? { name: expert.cityName ?? expert.city, slug: expert.city };
    if (etape === 3 && !macro) macro = await macroCourant();

    const unsubUrl = await expertUnsubUrl(env, WORKER_ORIGIN, slug);
    const { subject, html } = renderSequence({ etape, expert, city, seq: etat, lang: etat.lang || expert.lang || 'fr', unsubUrl, macro, postale: adressePostale(env) });
    r.parEtape[`S${etape}`] = (r.parEtape[`S${etape}`] || 0) + 1;
    if (dryRun) continue;
    file.push({ to: dest, subject, html, unsubUrl, slug, etape, etat });
  }

  if (dryRun || !file.length) return r;

  // Envoi par lots, sous l'expéditeur de prospection — jamais celui du bulletin opt-in.
  const from = env.MAIL_FROM_OUTREACH || env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>';
  for (let i = 0; i < file.length; i += TAILLE_LOT) {
    const lot = file.slice(i, i + TAILLE_LOT);
    const rep = await sendPulseBatch(env, lot, { from });
    for (let k = 0; k < lot.length; k++) {
      const e = lot[k];
      if (!rep[k]?.ok) { r.rates++; continue; }
      // L'étape n'avance qu'à l'ACCEPTATION : un envoi raté se rejoue le mardi suivant
      // plutôt que de sauter une semaine de la séquence.
      e.etat.etape = e.etape;
      e.etat.envoye = { ...(e.etat.envoye ?? {}), [String(e.etape)]: new Date().toISOString() };
      await env.SUBSCRIBERS.put(`seq:${e.slug}`, JSON.stringify(e.etat), { expirationTtl: 200 * 24 * 3600 });
      await env.SUBSCRIBERS.put(`seq-sent:${dayKey}:${e.slug}`, String(e.etape), { expirationTtl: 100 * 24 * 3600 });
      // L'escalier mensuel ne doit pas doubler la séquence ce mois-ci.
      await env.SUBSCRIBERS.put(`sent:${cycle}:${e.slug}`, new Date().toISOString(), { expirationTtl: CYCLE_TTL });
      // Compteur de prospection du jour — la rampe et les seuils le lisent.
      const cleJ = `day:${dayKey}:outreach`;
      const deja = Number((await env.SUBSCRIBERS.get(cleJ)) || 0);
      await env.SUBSCRIBERS.put(cleJ, String(deja + 1), { expirationTtl: 3 * 24 * 3600 });
      r.envoyes++;
      // Un spécimen par étape et par vague : le proprio voit ce qui est parti, sans
      // recevoir une copie de chaque courriel (décision du 2 août : illisible à 500).
      const cleSpec = `sample-seq:${dayKey}:${e.etape}`;
      if (!(await env.SUBSCRIBERS.get(cleSpec))) {
        await env.SUBSCRIBERS.put(cleSpec, '1', { expirationTtl: 3 * 24 * 3600 });
        await envoyerEchantillon(REPORT_TO, `[spécimen S${e.etape} → ${e.slug}] ${e.subject}`, e.html);
      }
    }
  }
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Statistiques publiques agrégées (aucune donnée personnelle) — pour le rapport hebdo.
    if (request.method === 'GET' && url.pathname === '/stats') {
      let subscribers = 0, relaysMonth = 0, relaysTotal = 0;
      if (env.SUBSCRIBERS) subscribers = (await env.SUBSCRIBERS.list({ prefix: 's:' })).keys.length;
      if (env.COUNTERS) {
        const month = new Date().toISOString().slice(0, 7);
        const l = await env.COUNTERS.list({ prefix: 'm:' });
        for (const k of l.keys) {
          const v = parseInt((await env.COUNTERS.get(k.name)) ?? '0', 10);
          relaysTotal += v;
          if (k.name.endsWith(month)) relaysMonth += v;
        }
      }
      return json({ generated: new Date().toISOString().slice(0, 10), bulletinSubscribers: subscribers, aiContactRelays: { thisMonth: relaysMonth, total: relaysTotal } });
    }

    // Aperçu d'un numéro (aucun envoi) — pour valider le rendu de la machine en direct.
    // Ex. /preview?segment=expert&stage=yellow&city=laval&lang=fr
    if (request.method === 'GET' && url.pathname === '/preview') {
      const q = url.searchParams;
      const segment = q.get('segment') || 'prospect';
      const stage = q.get('stage') || 'intro';
      const citySlug = strip(q.get('city') || 'laval');
      const lang = q.get('lang') || 'fr';
      const market = await feed('/api/market.json').catch(() => ({ cities: [] }));
      const city = market.cities.find((c) => strip(c.slug) === citySlug) || market.cities.find((c) => strip(c.name) === citySlug);
      if (!city) return json({ error: `Ville inconnue : ${citySlug}`, villes: (market.cities || []).map((c) => c.slug) }, 404);
      // Pour un expert : on prend un expert réel de la ville si possible, sinon un gabarit.
      let expert = null;
      if (segment === 'expert') {
        try {
          const all = await allExperts();
          expert = all.find((e) => strip(e.cityName) === citySlug || strip(e.city) === citySlug) || all[0] || null;
        } catch { /* gabarit ci-dessous */ }
        if (!expert) expert = { name: 'Exemple', professionLabel: 'courtier immobilier', score: { total: 64, color: 'yellow' }, licence: { body: 'OACIQ', number: null }, url: `${SITE}` };
      }
      // L'aperçu doit montrer le courriel RÉEL, bloc des taux compris — sinon il valide un
      // gabarit qui n'existe pas.
      const macro = await macroCourant();
      const { subject, html } = renderPulse({ segment, stage, city, expert, lang, unsubUrl: '#preview', macro,
        metier: url.searchParams.get('metier') || '' });
      return new Response(`<!--${subject}-->\n${html}`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
    }

    // ── RELAIS DU FORMULAIRE DE CONTACT (2026-08-17) ─────────────────────────────
    // POURQUOI. public/contact-handler.php envoyait par mail() de PHP vers
    // gregory@payotte.com — un simple RENVOI GoDaddy, pas une boîte. Testé le 17 août :
    // le message n'arrive nulle part, et le handler ne journalisait rien. Deux mois de
    // formulaires ont pu disparaître sans laisser de trace (handler créé le 2026-06-16).
    // mail() sur hébergement mutualisé est réputé pour ça.
    //
    // Le worker, lui, envoie déjà des centaines de courriels par Resend sans incident.
    // Le PHP relaie donc ici, et Resend livre DIRECTEMENT dans le Gmail du proprio.
    // Le PHP journalise avant d'appeler : même si ce relais tombe, rien n'est perdu.
    //
    // Auth : le même CONTACTS_TOKEN que /bulletin-dryrun. Refus = 401, et le PHP bascule
    // alors sur mail() en dernier recours.
    // ── WEBHOOK RESEND — rebonds et plaintes (2026-08-19) ──────────────────────────
    // CE QU'IL RÉSOUT. Jusqu'ici, un rebond dur partait dans la corbeille Gmail du proprio
    // et l'adresse morte était RESSERVIE au cycle suivant, indéfiniment. Une plainte pour
    // pourriel, elle, n'était visible nulle part. Or ce sont les deux seuls signaux qui
    // disent qu'une campagne est en train de brûler la réputation du domaine — et à
    // volume qui monte, on ne peut pas les découvrir en lisant ses courriels.
    //
    // CE QU'IL FAIT.
    //   bounced (dur)  → `bounce:{courriel}` ÉTERNEL. L'adresse ne repart jamais, quel que
    //                    soit le flux. Un rebond doux (mailbox_full…) n'est PAS retenu :
    //                    une boîte pleine se vide.
    //   complained     → `unsub:prospect:{courriel}` + `plainte:{jour}` incrémenté. Une
    //                    plainte vaut un désabonnement : la personne a dit non de la façon
    //                    la plus coûteuse pour nous, on ne la rappelle pas.
    //
    // LES SEUILS, ET POURQUOI CEUX-LÀ. Les fournisseurs (Gmail, Microsoft) coupent autour
    // de 0,3 % de plaintes. On agit AVANT : à 0,10 % le plafond du jour est divisé par
    // deux, à 0,30 % (ou 3 plaintes en 24 h, qui compte quand le volume est petit) le flux
    // s'ARRÊTE. Rebonds durs : 2 % ÷ 2, 4 % arrêt — un taux élevé signale une liste sale,
    // et une liste sale est ce qui déclenche les filtres.
    // ⚠️ Seul `outreach` peut être coupé automatiquement. Le bulletin opt-in et le relais
    // client↔pro (le produit) ne se coupent JAMAIS tout seuls : leur arrêt serait une panne
    // plus grave que le risque qu'il évite.
    //
    // SIGNATURE. Resend signe en Svix (`svix-id`, `svix-timestamp`, `svix-signature`,
    // HMAC-SHA256 base64 sur « id.timestamp.payload »). Sans `RESEND_WEBHOOK_SECRET`
    // configuré, la route REFUSE tout : un webhook non signé serait un moyen offert à
    // n'importe qui de désabonner nos adresses ou d'arrêter nos envois.
    // État de la séquence — même jeton privé que /bulletin-dryrun. Lecture seule.
    if (request.method === 'GET' && url.pathname === '/sequence-status') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('t') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const cles = env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'seq:') : [];
      const parEtape = {}, parCohorte = {}, liste = [];
      for (const cle of cles) {
        const slug = cle.replace(/^seq:/, '');
        let e; try { e = JSON.parse((await env.SUBSCRIBERS.get(`seq:${slug}`)) || '{}'); } catch { continue; }
        const et = e.stop ? 'arrêtée' : `S${e.etape ?? 0}`;
        parEtape[et] = (parEtape[et] || 0) + 1;
        parCohorte[e.cohorte ?? '?'] = (parCohorte[e.cohorte ?? '?'] || 0) + 1;
        liste.push({ slug, etape: e.etape ?? 0, cohorte: e.cohorte ?? null, province: e.province ?? null, stop: !!e.stop });
      }
      return json({
        inscrits: liste.length, parEtape, parCohorte,
        feuVert: Boolean(await env.SUBSCRIBERS?.get('seq-feu-vert')),
        stopOutreach: (await env.SUBSCRIBERS?.get('stop:outreach')) ?? null,
        liste: liste.sort((a, b) => a.slug.localeCompare(b.slug)),
      });
    }

    // État de l'alerte taux, et sa répétition à blanc. `?dry=1` compose les courriels sans
    // rien envoyer ni rien mémoriser — le seul moyen de vérifier le déclencheur sans
    // attendre une décision de la Banque du Canada.
    if (request.method === 'GET' && url.pathname === '/alerte-taux-status') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('t') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const cles = env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'taux:') : [];
      const inscrits = cles.filter((e) => e !== 'dernier' && EMAIL_RE.test(e));
      let memoire = null;
      try { memoire = JSON.parse((await env.SUBSCRIBERS?.get('taux:dernier')) || 'null'); } catch { /* clé abîmée */ }
      const macro = await macroCourant();
      const sortie = {
        inscrits: inscrits.length,
        memoire,
        tauxLu: macro?.rates?.policyRate ?? null,
        changement: memoire && macro?.rates?.policyRate?.percent != null
          ? memoire.percent !== macro.rates.policyRate.percent : null,
        stopAll: (await env.SUBSCRIBERS?.get('stop:all')) ?? null,
        desabonnes: env.SUBSCRIBERS ? (await kvKeys(env.SUBSCRIBERS, 'unsub:taux:')).length : 0,
      };
      if (url.searchParams.get('dry') === '1') sortie.repetition = await runAlerteTaux(env, { dryRun: true });
      return json(sortie);
    }

    if (request.method === 'POST' && url.pathname === '/resend-webhook') {
      const secret = env.RESEND_WEBHOOK_SECRET;
      if (!secret) return json({ error: 'webhook non configuré' }, 503);
      const brut = await request.text();
      const id = request.headers.get('svix-id') || '';
      const ts = request.headers.get('svix-timestamp') || '';
      const sig = request.headers.get('svix-signature') || '';
      if (!id || !ts || !sig) return json({ error: 'signature manquante' }, 401);
      // Rejeu : au-delà de 5 minutes, on refuse même une signature valide.
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: 'horodatage hors fenêtre' }, 401);
      let valide = false;
      try {
        const clef = secret.startsWith('whsec_') ? secret.slice(6) : secret;
        const key = await crypto.subtle.importKey('raw',
          Uint8Array.from(atob(clef), (c) => c.charCodeAt(0)),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${brut}`));
        const attendu = btoa(String.fromCharCode(...new Uint8Array(mac)));
        // Svix envoie « v1,sig1 v1,sig2 » — une seule doit correspondre (rotation de clé).
        valide = sig.split(' ').some((part) => part.split(',')[1] === attendu);
      } catch { valide = false; }
      if (!valide) return json({ error: 'signature invalide' }, 401);

      let ev; try { ev = JSON.parse(brut); } catch { return json({ error: 'corps illisible' }, 400); }
      const type = ev?.type || '';
      const dest = String(ev?.data?.to?.[0] ?? ev?.data?.email ?? '').toLowerCase().trim();
      const jour = new Date().toISOString().slice(0, 10);
      if (!dest || !env.SUBSCRIBERS) return json({ ok: true, ignore: true });

      if (type === 'email.bounced') {
        const genre = String(ev?.data?.bounce?.type ?? ev?.data?.type ?? '').toLowerCase();
        const dur = !genre || /hard|permanent|undetermined/.test(genre);
        if (dur) {
          await env.SUBSCRIBERS.put(`bounce:${dest}`, JSON.stringify({ jour, genre: genre || 'inconnu' }));
          const n = Number((await env.SUBSCRIBERS.get(`rebond:${jour}`)) || 0);
          await env.SUBSCRIBERS.put(`rebond:${jour}`, String(n + 1), { expirationTtl: 30 * 24 * 3600 });
        }
      } else if (type === 'email.complained') {
        await env.SUBSCRIBERS.put(`unsub:prospect:${dest}`, JSON.stringify({ jour, motif: 'plainte' }));
        const n = Number((await env.SUBSCRIBERS.get(`plainte:${jour}`)) || 0);
        await env.SUBSCRIBERS.put(`plainte:${jour}`, String(n + 1), { expirationTtl: 90 * 24 * 3600 });
      }
      return json({ ok: true, type });
    }

    if (request.method === 'POST' && url.pathname === '/contact-relay') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (!env.RESEND_API_KEY) return json({ error: 'no-mailer' }, 503);
      const b = await request.json().catch(() => null);
      if (!b || !b.email || !b.message) return json({ error: 'bad-request' }, 400);
      const propre = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300).trim();
      const de = propre(b.email);
      const sujet = propre(b.subject) || '(sans sujet)';
      const corps = [
        `De      : ${de}`,
        `Sujet   : ${sujet}`,
        `Secteur : ${propre(b.sector) || '—'}`,
        `Langue  : ${propre(b.lang) || '—'}`,
        `Page    : ${propre(b.page) || '—'}`,
        '',
        String(b.message ?? '').slice(0, 20000),
      ].join('\n');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [REPORT_TO],
          reply_to: de,               // « Répondre » écrit au visiteur, pas au relais
          subject: `[Contact Payotte] ${sujet}`,
          text: corps,
        }),
      }).catch(() => null);
      if (!r || !r.ok) return json({ error: 'send-failed', status: r?.status ?? 0 }, 502);

      // ── ACCUSÉ DE RÉCEPTION AU VISITEUR (2026-08-17, second passage) ─────────────
      // Il partait par mail() côté PHP. Vérifié le jour même : il n'arrive JAMAIS — le
      // mail() de cet hébergement est mort, c'est ce qui a fait perdre les messages.
      // Un visiteur qui n'a aucun accusé récrit, ou renonce. On l'envoie donc par le
      // même Resend, avec le MÊME texte que le PHP (repris mot pour mot).
      // Best-effort : un accusé raté ne doit jamais faire échouer la réception du message,
      // qui est déjà journalisée côté serveur et déjà partie chez le proprio.
      const fr = propre(b.lang) !== 'en';
      const suj = sujet !== '(sans sujet)' ? sujet : '';
      const accuse = fr
        ? ['Bonjour,', '',
           'Merci d’avoir contacté Payotte. Nous avons bien reçu votre message',
           'et vous répondrons par e-mail dès que possible — généralement sous 48 h.', '',
           ...(suj ? [`Objet de votre demande : ${suj}`, ''] : []),
           'Ceci est une confirmation automatique — inutile d’y répondre.', '',
           '— Payotte',
           'L’annuaire indépendant d’experts immobiliers vérifiés au Canada',
           'https://payotte.com']
        : ['Hello,', '',
           'Thank you for contacting Payotte. We’ve received your message and',
           'will reply by email as soon as possible — usually within 48 hours.', '',
           ...(suj ? [`Subject of your request: ${suj}`, ''] : []),
           'This is an automated confirmation — no need to reply.', '',
           '— Payotte',
           'Independent directory of verified real estate experts in Canada',
           'https://payotte.com'];
      const accuseOk = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [de],
          reply_to: REPORT_TO,          // s'il répond quand même, ça arrive au proprio
          subject: fr ? 'Nous avons bien reçu votre message — Payotte' : 'We’ve received your message — Payotte',
          text: accuse.join('\n'),
          headers: { 'Auto-Submitted': 'auto-replied' },
        }),
      }).then((x) => x.ok).catch(() => false);

      return json({ ok: true, accuse: accuseOk });
    }

    // Dry-run du bulletin (aucun envoi) — rapport d'audience. Protégé par le jeton privé.
    if (request.method === 'GET' && url.pathname === '/bulletin-dryrun') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) return json({ error: 'unauthorized' }, 401);
      const report = await runBulletin(env, { dryRun: true });
      // `?mail=1` : envoie AUSSI le récapitulatif à REPORT_TO, pour voir le rendu réel du
      // courriel sans qu'un seul bulletin ne parte (dryRun bloque tous les envois en amont).
      if (url.searchParams.get('mail') === '1') await sendRunReport(env, report);
      return json(report);
    }

    // Bulletin de marché (formulaire zéro-JS des pages ville).
    if (request.method === 'POST' && url.pathname === '/subscribe') return handleSubscribe(request, env, url);
    // Alerte taux : POST depuis un formulaire, GET en un clic depuis le bulletin (HMAC).
    if (url.pathname === '/alerte-taux' && (request.method === 'POST' || request.method === 'GET')) return handleAlerteTauxInscription(request, env, url);
    // POST accepté aussi : Gmail et Outlook déclenchent le désabonnement en un clic
    // (List-Unsubscribe-Post) sans jamais ouvrir la page.
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/unsubscribe') return handleUnsubscribe(env, url);

    // Double opt-in du relais de contact : le clic humain qui transmet la demande à l'expert.
    if (request.method === 'GET' && url.pathname === '/confirm') return confirmRelay(env, url);

    // Page d'accueil / découverte humaine.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/mcp')) {
      return json({
        ...SERVER_INFO,
        description: INSTRUCTIONS,
        transport: 'streamable-http (stateless)',
        endpoint: `${url.origin}/mcp`,
        tools: TOOLS.map((t) => t.name),
        dataSource: `${SITE}/api/experts.json`,
        license: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: ATTRIBUTION,
      });
    }

    if (request.method !== 'POST' || (url.pathname !== '/mcp' && url.pathname !== '/')) {
      return json({ error: 'POST JSON-RPC 2.0 messages to /mcp' }, 405);
    }

    let msg;
    try {
      msg = await request.json();
    } catch {
      return rpcError(null, -32700, 'Parse error: invalid JSON');
    }
    if (Array.isArray(msg)) {
      // Le transport Streamable HTTP 2025-06-18 n'utilise plus les lots JSON-RPC.
      return rpcError(null, -32600, 'Batch requests are not supported');
    }
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id, -32600, 'Invalid JSON-RPC 2.0 request');
    }
    return handleRpc(msg, env);
  },

  // Bulletin : cron HORAIRE sur 12-18 h UTC, cycle MENSUEL, envoi à 10 h CHEZ LE DESTINATAIRE.
  // Chaque passage ne sert que les provinces où il est 10 h locale (zonesAt10h) et n'y prend
  // que ceux qui n'ont pas encore reçu leur courriel du mois, dans la limite du budget de
  // sous-requêtes ET du plafond quotidien global. La vague met une douzaine de jours, puis les
  // exécutions tournent à vide jusqu'au 1er. Villes actives = celles qui ont un prix de
  // référence — filtrées, à chaque passage, par le fuseau horaire.
  async scheduled(event, env, ctx) {
    if (!env.RESEND_API_KEY) return;   // sans clé : aucun envoi (le dry-run reste dispo par route)
    // L'ALERTE TAUX passe avant tout le reste : c'est le seul envoi daté par un ÉVÉNEMENT
    // (la Banque du Canada a bougé) et non par un calendrier qu'on choisit. Un bulletin
    // décalé d'une heure ne coûte rien ; une alerte de taux décalée n'est plus une alerte.
    // Coût quand rien ne bouge — 361 jours sur 365 : une lecture KV et un appel Valet mis
    // en cache. `try` isolé : elle ne doit jamais emporter les autres envois.
    try {
      const alerte = await runAlerteTaux(env, { at: new Date() });
      if (alerte.change) {
        console.log(`[alerte-taux] ${alerte.ancien} % → ${alerte.nouveau} % (${alerte.observed}) — `
          + (alerte.arrete ? `ARRÊTÉ (${alerte.arrete}), mouvement enregistré sans envoi`
            : `${alerte.envoyes} envoyée(s), ${alerte.rates} ratée(s) sur ${alerte.inscrits} inscrit(s)`));
      } else if (alerte.note) {
        console.log(`[alerte-taux] ${alerte.note}`);
      }
    } catch (err) {
      console.log(`[alerte-taux] ERREUR : ${err?.message ?? err}`);
    }

    // La séquence AVANT le bulletin : elle porte une date promise (mardi 10 h locale),
    // le bulletin s'étale sur le mois. À budget contraint, la date passe devant.
    // `try` isolé : une séquence qui échoue ne doit jamais emporter le bulletin avec elle.
    try {
      const seq = await runSequence(env, { at: new Date() });
      if (seq.envoyes || seq.rates) {
        console.log(`[séquence] ${seq.vague} — ${seq.envoyes} envoyés, ${seq.rates} ratés, `
          + `${Object.entries(seq.parEtape).map(([k, v]) => `${k} ${v}`).join(' · ')}`
          + (seq.sorties.length ? ` — sorties : ${seq.sorties.join(', ')}` : ''));
        await envoyerRapportSequence(env, seq).catch(() => {});
      }
    } catch (err) {
      console.log(`[séquence] ERREUR : ${err?.message ?? err}`);
    }
    await runBulletin(env, { dryRun: false });
  },
};
