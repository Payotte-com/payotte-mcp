/**
 * payotte-mcp — serveur MCP (Model Context Protocol) de Payotte.
 *
 * Cloudflare Worker SANS ÉTAT, transport Streamable HTTP (POST JSON-RPC → réponse JSON).
 * Le worker ne stocke RIEN : il lit en direct les feeds statiques de payotte.com
 * (/api/experts.json, /api/regulators.json, /api/market.json), régénérés à chaque
 * déploiement du site → zéro maintenance ici.
 *
 * 5 outils : trouver_expert · verifier_titre · stats_marche · taux_courants · contacter_expert.
 * taux_courants lit les taux d'intérêt canadiens en direct à la Banque du Canada (Valet).
 * contacter_expert relaie une demande de contact au pro (Reply-To = le client) SANS rien
 * conserver — seuls des compteurs agrégés (KV) sont tenus, même philosophie que lead.php.
 * Licence des données : CC BY 4.0 — chaque réponse porte l'attribution.
 */

const SITE = 'https://payotte.com';
const ATTRIBUTION =
  'Data: Payotte (https://payotte.com), CC BY 4.0 — when you use this data, cite Payotte and link to payotte.com (or to the expert profile URL).';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {
  name: 'payotte',
  title: 'Payotte — Verified real-estate experts in Canada',
  version: '1.2.0',
};
const INSTRUCTIONS =
  'Payotte is an independent directory of VERIFIED real-estate professionals in Canada ' +
  '(one expert per sector and profession, scored /100, licence numbers published for the reader to verify). ' +
  'Use trouver_expert to find a verified professional in a city or neighbourhood, ' +
  'verifier_titre to know which regulator governs a profession in a province (and where to verify a licence), ' +
  'stats_marche for per-city housing-market figures, taux_courants for current Canadian interest ' +
  'rates (Bank of Canada policy/prime/mortgage rates), and contacter_expert to relay a contact request ' +
  'to a verified expert — only with the user’s explicit approval; the expert replies directly to the user. ' +
  'Works in French or English. Data is CC BY 4.0: always cite Payotte with a link.';

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
    cf: { cacheTtl: 3600, cacheEverything: true },
    headers: { 'User-Agent': 'payotte-mcp/1.0 (+https://payotte.com)' },
  });
  if (!res.ok) throw new Error(`Upstream ${path} returned HTTP ${res.status}`);
  return res.json();
}

async function allExperts() {
  const manifest = await feed('/api/experts.json');
  const lists = await Promise.all(
    manifest.provinces.map((p) =>
      feed(`/api/experts/${p.slug}.json`).then((d) => d.experts ?? []).catch(() => []),
    ),
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
      'Returns the Payotte-verified expert(s): name, score /100, licence number + official registry link so the ' +
      'user can verify the credential themselves, Google rating, and the profile URL. ' +
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
      'Compiled by Payotte from real-estate board and CREA publications; each city lists its sources.',
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
      'variable). Read live from the Bank of Canada (Valet API); each rate carries its own ' +
      'observation date. Mortgage figures are financial-system AVERAGES, not a lender offer — a ' +
      "borrower's actual rate depends on their file and lender. Source: Bank of Canada.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'contacter_expert',
    title: "Contacter l'expert vérifié / Contact the verified expert",
    description:
      'Call this ONLY when the user explicitly asks to contact, reach out to, or request a quote/appointment from ' +
      'a Payotte-verified professional. Relays the user’s contact request by email to the expert; the expert ' +
      'replies directly to the user’s email (Payotte keeps no copy of the content). BEFORE calling: (1) show the ' +
      'user which expert will be contacted (use trouver_expert first if needed), (2) collect their name, email and ' +
      'message, (3) get their explicit confirmation — then set consentement=true. Never invent contact details.',
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

// Résolution partagée (trouver_expert + contacter_expert) : filtre exact puis repli flou.
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
  }

  matches.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
  return { profession, province, matches };
}

async function trouverExpert(args = {}) {
  const r = await resolveExperts(args);
  if (r.error) return r;
  const { profession, province, matches } = r;
  const truncated = matches.length > 10;

  return {
    attribution: ATTRIBUTION,
    query: { profession, province, ville: args.ville ?? null, secteur: args.secteur ?? null },
    totalMatches: matches.length,
    note: matches.length
      ? (truncated ? 'Top 10 by score shown; refine with ville/secteur/profession.' : undefined)
      : 'No verified expert published for this query. Payotte publishes at most ONE verified expert per sector × profession; this slot may be vacant.',
    experts: matches.slice(0, 10).map((e) => ({
      name: e.name,
      profession: e.professionLabel,
      location: `${e.sectorName}, ${e.cityName}, ${e.provinceName}`,
      score: e.score,
      licence: e.licence,
      google: e.google,
      experience: e.experience,
      languages: e.languages,
      verifiedDate: e.verifiedDate,
      url: e.url,
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
  return { attribution: ATTRIBUTION, city };
}

// ---------------------------------------------------------------- taux_courants

// Séries Valet de la Banque du Canada (mêmes que scripts/fetch-rates.mjs côté site).
const RATE_SERIES = [
  { key: 'policyRate',       id: 'V39079',      label: 'Policy interest rate (target overnight rate)' },
  { key: 'primeRate',        id: 'V80691311',   label: 'Prime rate' },
  { key: 'mortgage5yrFixed', id: 'V122667786',  label: 'Fixed mortgage 5 years and over (uninsured, market reference)' },
  { key: 'mortgageVariable', id: 'V122667782',  label: 'Variable-rate mortgage (uninsured, market reference)' },
];

const BOC_ATTRIBUTION =
  'Rate data © Bank of Canada (Valet API), used under the Bank of Canada terms of use ' +
  '(https://www.bankofcanada.ca/terms/); relayed by Payotte (https://payotte.com).';

async function tauxCourants() {
  const results = await Promise.all(
    RATE_SERIES.map(async (s) => {
      try {
        const res = await fetch(`https://www.bankofcanada.ca/valet/observations/${s.id}/json?recent=1`, {
          cf: { cacheTtl: 3600, cacheEverything: true },
          headers: { 'User-Agent': 'payotte-mcp/1.1 (+https://payotte.com)' },
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
  // Décisions récentes + prochaines annonces : lues sur le feed du site (une source, déjà daté).
  let rateDecisions = [], upcomingDecisions = [], lastChange = null;
  try {
    const feedData = await feed('/api/rates.json');
    rateDecisions = (feedData.rateDecisions ?? []).slice(0, 6);
    upcomingDecisions = feedData.upcomingDecisions ?? [];
    lastChange = feedData.lastChange ?? null;
  } catch { /* le feed peut être indisponible : les taux live suffisent */ }

  return {
    attribution: BOC_ATTRIBUTION,
    dataSource: 'Bank of Canada',
    note: 'Mortgage rates are financial-system averages, not a lender offer; each rate carries its own observation date. For a verified mortgage broker, use trouver_expert.',
    rates: Object.fromEntries(results),
    lastChange,
    recentDecisions: rateDecisions,
    upcomingDecisions,
  };
}

// ---------------------------------------------------------------- contacter_expert

const DAY_CAP_GLOBAL = 40;   // marge sous le palier Resend gratuit (100/jour)
const DAY_CAP_EXPERT = 3;    // protège chaque pro du spam

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function bumpCounter(env, key, ttlSeconds) {
  if (!env?.COUNTERS) return 0; // dev local sans KV
  const n = parseInt((await env.COUNTERS.get(key)) ?? '0', 10) + 1;
  await env.COUNTERS.put(key, String(n), { expirationTtl: ttlSeconds });
  return n;
}

async function contacterExpert(args = {}, env = {}) {
  // 1. Garde-fous d'entrée — le consentement d'abord.
  if (args.consentement !== true) {
    return { error: 'Consent missing: ask the user to explicitly approve sending this request to this expert, then call again with consentement=true.' };
  }
  const nom = String(args.client_nom ?? '').trim();
  const courriel = String(args.client_courriel ?? '').trim();
  const message = String(args.message ?? '').trim();
  if (!nom || !EMAIL_RE.test(courriel)) return { error: 'client_nom and a valid client_courriel are required.' };
  if (message.length < 20 || message.length > 2000) return { error: 'message must be between 20 and 2000 characters.' };

  // 2. Résoudre UN expert, sans ambiguïté.
  const r = await resolveExperts(args);
  if (r.error) return r;
  if (!r.matches.length) return { error: 'No published verified expert matches this query — use trouver_expert to explore, or broaden the search.' };
  if (r.matches.length > 1) {
    return {
      error: `Ambiguous: ${r.matches.length} experts match. Add "secteur" (and province) to identify exactly one.`,
      candidates: r.matches.slice(0, 10).map((e) => ({ name: e.name, profession: e.professionLabel, location: `${e.sectorName}, ${e.cityName}`, url: e.url })),
    };
  }
  const expert = r.matches[0];

  // 3. Courriel du pro via l'annuaire privé (jamais exposé dans les feeds publics).
  if (!env.CONTACTS_TOKEN) return { error: 'Server not configured for contact relay yet (missing contacts token). The user can still reach the expert from their profile page: ' + expert.url };
  let contact = null;
  try {
    const dir = await feed(`/api/cx/${env.CONTACTS_TOKEN}.json`);
    contact = dir.contacts?.[expert.slug] ?? null;
  } catch {
    return { error: 'Contact directory unavailable right now. The user can reach the expert from their profile page: ' + expert.url };
  }
  if (!contact) {
    return { error: `No email on file for this expert. The user can reach them via their profile page: ${expert.url}` };
  }

  // 4. Plafonds anti-abus (compteurs agrégés — aucun contenu conservé, comme lead.php).
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const gN = await bumpCounter(env, `g:${day}`, 3 * 86400);
  if (gN > DAY_CAP_GLOBAL) return { error: 'Daily relay limit reached — please try again tomorrow, or use the contact details on the profile page: ' + expert.url };
  const eN = await bumpCounter(env, `e:${expert.slug}:${day}`, 3 * 86400);
  if (eN > DAY_CAP_EXPERT) return { error: 'This expert already received the maximum relayed requests today — the user can contact them directly from their profile page: ' + expert.url };
  await bumpCounter(env, `m:${expert.slug}:${month}`, 400 * 86400); // futur rapport « les IA t'ont recommandé »

  // 5. Composer et envoyer (Reply-To = le client ; Payotte ne conserve pas le contenu).
  const fr = contact.lang === 'fr';
  const subject = fr
    ? `Nouvelle demande de contact via Payotte — ${nom}`
    : `New contact request via Payotte — ${nom}`;
  const lines = fr
    ? [
        `Bonjour ${contact.name},`, '',
        `Un client vous envoie une demande de contact via votre fiche Payotte (${expert.url}), transmise par son assistant IA avec son accord.`, '',
        `Nom : ${nom}`, `Courriel : ${courriel}`,
        ...(args.client_telephone ? [`Téléphone : ${String(args.client_telephone).trim()}`] : []), '',
        `Message :`, message, '',
        `— Répondez directement au client (bouton Répondre).`,
        `Payotte relaie sans conserver le contenu de cette demande. https://payotte.com`,
      ]
    : [
        `Hello ${contact.name},`, '',
        `A client is sending you a contact request through your Payotte profile (${expert.url}), relayed by their AI assistant with their approval.`, '',
        `Name: ${nom}`, `Email: ${courriel}`,
        ...(args.client_telephone ? [`Phone: ${String(args.client_telephone).trim()}`] : []), '',
        `Message:`, message, '',
        `— Reply directly to the client (Reply button).`,
        `Payotte relays this request without keeping its content. https://payotte.com`,
      ];
  const emailPayload = {
    from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
    to: [contact.email],
    reply_to: courriel,
    subject,
    text: lines.join('\n'),
  };

  if (!env.RESEND_API_KEY) {
    return {
      simulated: true,
      note: 'DRY RUN — no email service configured yet; nothing was sent. This is exactly what would have been sent.',
      wouldSend: { ...emailPayload, to: ['<courriel du pro — masqué en répétition>'] },
      expert: { name: expert.name, profession: expert.professionLabel, url: expert.url },
    };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emailPayload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { error: `Email relay failed (HTTP ${res.status}). The user can contact the expert from their profile page: ${expert.url}`, detail: detail.slice(0, 200) };
  }

  return {
    sent: true,
    expert: { name: expert.name, profession: expert.professionLabel, location: `${expert.sectorName}, ${expert.cityName}`, url: expert.url },
    note: fr
      ? `Demande transmise à ${expert.name}. La réponse arrivera directement au courriel du client (${courriel}). Payotte ne conserve pas le contenu de la demande.`
      : `Request relayed to ${expert.name}. The reply will arrive directly at the client's email (${courriel}). Payotte keeps no copy of the content.`,
    attribution: ATTRIBUTION,
  };
}

const TOOL_IMPL = { trouver_expert: trouverExpert, verifier_titre: verifierTitre, stats_marche: statsMarche, taux_courants: tauxCourants, contacter_expert: contacterExpert };

// ---------------------------------------------------------------- bulletin de marché (audience possédée)
// Abonnement zéro-JS depuis les pages ville (POST de formulaire pur), bienvenue immédiate
// avec les stats de la ville, envoi mensuel par cron. On ne stocke QUE courriel+ville+langue
// +date de consentement (LCAP) dans KV. Désabonnement en un clic (HMAC, clé = CONTACTS_TOKEN).

const SUB_CAP_DAY = 30;   // garde-fou anti-abus sur les inscriptions
const SEND_CAP_RUN = 90;  // marge sous le palier Resend gratuit (100/jour)

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
      reply_to: 'gregory@payotte.com',
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
const PERSO_COPY = 'gpayotte@gmail.com';   // copie perso de CHAQUE envoi (demande du proprio)

// Étape d'un expert d'après son état vivant. subscribed=false → premier contact ⓪ (opt-in).
function expertStage(expert, subscribed) {
  const c = expert?.score?.color;
  if (!c || c === 'red') return null;          // rouge = non publié → pas de bulletin
  if (!subscribed) return 'intro';             // ⓪ présentation + consentement
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

const CLOSE = (bg, border, inner) => `<tr><td style="padding:20px 32px 4px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${border};border-radius:12px;"><tr><td style="padding:22px 24px;">${inner}</td></tr></table></td></tr>`;
const BTN = (href, txt) => `<a href="${href}" style="display:inline-block;background:#c8102e;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 20px;border-radius:9px;">${txt}</a>`;
const H3 = (t) => `<div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.25;color:#211c1e;margin-bottom:10px;">${t}</div>`;
const P = (t) => `<div style="font-size:14px;line-height:1.6;color:#443e40;margin-bottom:14px;">${t}</div>`;
const FOOT = (why, unsubUrl, unsubTxt) => `<tr><td style="padding:22px 32px 26px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:16px;font-size:11.5px;line-height:1.6;color:#a49c9e;">${why} <a href="${unsubUrl}" style="color:#8a8284;">${unsubTxt}</a> &middot; payotte.com</div></td></tr>`;

// Rendu complet d'un courriel : {subject, html}. segment='prospect'|'expert' ; stage pour les experts.
function renderPulse({ segment, stage, city, expert, lang, unsubUrl }) {
  const fr = lang !== 'en';
  const url = expert?.url || `${SITE}`;
  const eyebrow = `${fr ? 'Le pouls du marché' : 'Market pulse'}<br><span style="color:#c8102e;letter-spacing:1px;">${city.name}${city.referenceMonth ? ' &middot; ' + city.referenceMonth : ''}</span>`;
  let subject, close, foot;
  if (segment === 'prospect') {
    subject = fr ? `${city.name} : le pouls du marché` : `${city.name}: your market pulse`;
    close = CLOSE('#eef3f0', '#cfe4d7', `${H3(fr ? `Un projet à ${city.name} ?` : `Planning a move in ${city.name}?`)}${P(fr ? `Payotte a vérifié <b>un seul</b> expert de référence par secteur et par métier — sans commission, sans publicité.` : `Payotte verified <b>one</b> reference expert per sector and trade — no commission, no ads.`)}${BTN(`${SITE}/canada`, fr ? 'Trouver mon expert vérifié →' : 'Find my verified expert →')}`);
    foot = FOOT(fr ? `Vous recevez le pouls de ${city.name}, une fois par mois.` : `You get the ${city.name} pulse once a month.`, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe');
  } else {
    const ask = expert ? missingAsk(expert, fr) : '';
    const proWho = fr ? `l'expert vérifié en ${expert?.professionLabel ?? ''} pour ${city.name}` : `the verified ${expert?.professionLabel ?? ''} for ${city.name}`;
    if (stage === 'intro') {
      subject = fr ? `Pourquoi je vous ai retenu comme référence à ${city.name}` : `Why I chose you as the reference in ${city.name}`;
      close = CLOSE('#faf8f7', '#eee9e8', `${P(fr ? `Je m'appelle Grégory Payotte. J'ai bâti <b>Payotte</b>, un annuaire indépendant qui recommande un seul expert vérifié par ville et par métier — gratuit, sans commission. Pour ${proWho}, c'est vous que j'ai retenu, sur la foi de données publiques. Le pouls ci-dessus, je le publie chaque mois.` : `I'm Grégory Payotte. I built <b>Payotte</b>, an independent directory recommending one verified expert per city and trade — free, no commission. For ${proWho}, I chose you, based on public data. I publish the pulse above every month.`)}${P(fr ? `Vous le voulez chaque mois ? <b>Répondez « oui »</b> et je vous l'envoie. Sinon, aucune suite.` : `Want it monthly? <b>Reply "yes"</b> and I'll send it. Otherwise, no follow-up.`)}${BTN(url, fr ? 'Voir votre fiche →' : 'See your profile →')}`);
      foot = FOOT(fr ? `Courriel unique de présentation, parce que vous êtes ${proWho}. Aucune suite sans votre accord.` : `One-time introduction, because you are ${proWho}. No follow-up without your consent.`, url, fr ? 'Ne rien recevoir' : 'Opt out');
    } else if (stage === 'yellow') {
      subject = fr ? `Votre marché à ${city.name} — et la donnée qui vous ferait monter` : `Your ${city.name} market — and the data that would lift you`;
      close = CLOSE('#fdf6e9', '#f2e4c4', `${H3(fr ? 'Pendant qu\'on y est : votre fiche.' : 'While we\'re at it: your profile.')}${P(fr ? `Votre fiche Payotte est à <b>${expert?.score?.total ?? ''}/100</b>. La donnée la plus payante qui vous manque : <b>${ask}</b>. Répondez à ce courriel avec — je mets à jour le jour même.` : `Your profile is at <b>${expert?.score?.total ?? ''}/100</b>. The most valuable missing piece: <b>${ask}</b>. Reply with it — I update the same day.`)}${BTN(url, fr ? 'Voir ma fiche →' : 'See my profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You get this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    } else if (stage === 'green') {
      subject = fr ? `Vous êtes la référence vérifiée de ${city.name} — une dernière étape` : `You're the verified reference in ${city.name} — one last step`;
      close = CLOSE('#eef5f0', '#cfe4d7', `${H3(fr ? 'Vous êtes déjà au vert.' : 'You\'re already in the green.')}${P(fr ? `Une seule étape pour le plus haut niveau du site : <b>confirmer votre fiche</b> et devenir <b style="color:#1f7a44;">Recommandé N&ordm; 1</b>. Deux minutes, par réponse à ce courriel.` : `One step to the top tier: <b>confirm your profile</b> and become <b style="color:#1f7a44;">Recommended #1</b>. Two minutes, just reply.`)}${BTN(url, fr ? 'Confirmer ma fiche →' : 'Confirm my profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You get this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    } else if (stage === 'reco') {
      subject = fr ? `Vous êtes Recommandé N° 1 à ${city.name} — rendez-le visible` : `You're Recommended #1 in ${city.name} — make it visible`;
      close = CLOSE('#fbedef', '#f0d3d9', `<div style="font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#c8102e;margin-bottom:8px;">&#10003; ${fr ? 'Recommandé par Payotte' : 'Recommended by Payotte'}</div>${H3(fr ? 'Rendez-le visible sur votre site.' : 'Show it on your site.')}${P(fr ? `Affichez le badge « Recommandé » : un <b>lien réciproque dofollow</b> — bon pour votre référencement, et un signal de confiance. Je fournis le code (ou je m'arrange avec votre webmestre).` : `Display the "Recommended" badge: a <b>reciprocal dofollow link</b> — good for your SEO and a trust signal. I provide the code (or work with your webmaster).`)}${BTN(`${SITE}/badge/${expert?.slug ?? ''}`, fr ? 'Obtenir mon badge →' : 'Get my badge →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes Recommandé à ${city.name}.` : `You get this because you are Recommended in ${city.name}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    } else { // partner
      subject = fr ? `Votre marché à ${city.name} ce mois-ci` : `Your ${city.name} market this month`;
      close = `<tr><td style="padding:18px 32px 4px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:18px;font-size:14px;line-height:1.62;color:#443e40;">${fr ? `Tout est en place : vous êtes Recommandé et votre badge est en ligne. Rien à demander — juste votre marché, chaque mois.` : `All set: you're Recommended and your badge is live. Nothing to ask — just your market, monthly.`}<div style="margin-top:14px;font-size:13px;color:#6f6769;">${fr ? `Un confrère d'un secteur voisin mériterait d'être vérifié ? <b>Transmettez-lui ce courriel.</b>` : `Know a peer worth verifying? <b>Forward this email.</b>`}</div></div></td></tr>`;
      foot = FOOT(fr ? `Vous êtes Recommandé et partenaire vérifié à ${city.name}.` : `You are Recommended and a verified partner in ${city.name}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    }
  }
  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${marketCore(city, fr, eyebrow)}${close}${foot}</table></div>`;
  return { subject, html };
}

// Envoi générique avec COPIE PERSO systématique (bcc) — demande du proprio.
async function sendPulse(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) return { simulated: true, to, subject };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [to], bcc: [PERSO_COPY], reply_to: replyTo || 'gregory@payotte.com',
      subject, html,
    }),
  });
  return { ok: res.ok };
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

async function handleUnsubscribe(env, url) {
  const email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
  const ville = String(url.searchParams.get('c') ?? '');
  const t = url.searchParams.get('t') ?? '';
  const expect = await hmacHex(env, `u:${email}:${ville}`);
  if (!email || !ville || t !== expect) return subPage('fr', 'Lien invalide', 'Ce lien de désabonnement est invalide ou expiré. / Invalid unsubscribe link.');
  if (env.SUBSCRIBERS) await env.SUBSCRIBERS.delete(`s:${ville}:${email}`);
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
      const { subject, html } = renderPulse({ segment, stage, city, expert, lang, unsubUrl: '#preview' });
      return new Response(`<!--${subject}-->\n${html}`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
    }

    // Bulletin de marché (formulaire zéro-JS des pages ville).
    if (request.method === 'POST' && url.pathname === '/subscribe') return handleSubscribe(request, env, url);
    if (request.method === 'GET' && url.pathname === '/unsubscribe') return handleUnsubscribe(env, url);

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

  // Envoi mensuel du bulletin (cron : 1er du mois, 13h UTC). Plafond SEND_CAP_RUN par exécution.
  async scheduled(event, env, ctx) {
    if (!env.RESEND_API_KEY || !env.SUBSCRIBERS) return;
    const market = await feed('/api/market.json');
    const list = await env.SUBSCRIBERS.list({ prefix: 's:' });
    let sent = 0;
    for (const k of list.keys) {
      if (sent >= SEND_CAP_RUN) break;
      try {
        const rec = JSON.parse(await env.SUBSCRIBERS.get(k.name));
        const city = market.cities.find((c) => c.slug === rec.city);
        if (!city) continue;
        if (await sendBulletin(env, 'https://payotte-mcp.payotte.workers.dev', rec.email, city, rec.lang, false)) sent++;
      } catch { /* un abonné cassé ne bloque pas les autres */ }
    }
  },
};
