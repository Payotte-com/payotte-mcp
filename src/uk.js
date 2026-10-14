/**
 * uk.js — les outils MCP de Payotte Royaume-Uni (préparés le 14 oct. 2026, branche brouillon/mcp-uk). NE PAS DÉPLOYER avant la
 * mise en ligne de payotte.com/uk : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-uk/scripts/uk/export-mcp.mjs (uk.json) : barèmes SDLT/LBTT/LTT et HM Land Registry, prix du
 * UK House Price Index, tableaux « by nation », guides et pages métier. Le calcul de la taxe est celui du site
 * (src/lib/uk/fraisAchat.ts), recontrôlé par scripts/check-uk.mjs sur les mêmes exemples officiels.
 *
 * Vocabulaire : aucun professionnel n'est listé au Royaume-Uni. Les outils disent QUI régit un métier et OÙ le lecteur vérifie
 * un titre ; jamais « verified by Payotte ».
 */
import UK from './data/uk.json' with { type: 'json' };

const SITE_UK = 'https://payotte.com/uk';
const ATTRIBUTION_UK =
  'Data: Payotte UK (https://payotte.com/uk), CC BY 4.0 — cite Payotte with a link to the page given. Tax rates from HMRC, Revenue Scotland ' +
  'and the Welsh Revenue Authority; prices from the UK House Price Index (Contains HM Land Registry data © Crown copyright and database right 2020, ' +
  'licensed under the Open Government Licence v3.0). General information, not tax or legal advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const gbp = (n) => '£' + Math.round(n).toLocaleString('en-GB');
const MOIS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const moisUk = (m) => `${MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

// ---------------------------------------------------------------- nations
const NATIONS = { england: 'England', scotland: 'Scotland', wales: 'Wales', 'northern-ireland': 'Northern Ireland' };
const ALIAS = { eng: 'england', 'england-uk': 'england', sco: 'scotland', scot: 'scotland', alba: 'scotland', cymru: 'wales', wal: 'wales',
  ni: 'northern-ireland', 'n-ireland': 'northern-ireland', 'northern-ireland-uk': 'northern-ireland', ulster: 'northern-ireland' };
const nationDe = (v) => { const n = norm(v); return NATIONS[n] ? n : ALIAS[n] ?? null; };
const erreurNation = (v) => ({ error: `Unknown nation: "${v ?? ''}". Use England, Scotland, Wales or Northern Ireland.` });

// ---------------------------------------------------------------- taxe d'achat (même calcul que src/lib/uk/fraisAchat.ts)
const N = UK.taxes.nations;
const bareme = (n) => (N[n].memeQue ? { ...N[N[n].memeQue], nom: N[n].nom, enregistrement: N[n].enregistrement } : N[n]);
const r2 = (x) => Math.round(x * 100) / 100;
function parTranches(prix, bandes, plus = 0) {
  let bas = 0, total = 0;
  for (const [haut, taux] of bandes) { const h = haut ?? Infinity; if (prix > bas) total += (Math.min(prix, h) - bas) * (taux + plus) / 100; bas = h; }
  return r2(total);
}
const avecBandeNulle = (bandes, nulle) => [[nulle, 0], ...bandes.filter(([h]) => h == null || h > nulle)];
const fraisEnregistrement = (prix) => UK.taxes.hmlr.bandes.find(([h]) => h == null || prix <= h)[1];
export function taxeAchat(prix, nation, situation, nonResident = false) {
  const B = bareme(nation);
  const nr = nonResident && B.nonResident ? B.nonResident.points : 0;
  let taxe, regle, primoRefuse = false;
  if (situation === 'additional' && prix >= (B.supplementaire.seuil ?? 0)) {
    if (B.supplementaire.type === 'surtaxe') { taxe = parTranches(prix, B.standard, B.supplementaire.points + nr); regle = `higher rates (+${B.supplementaire.points} points)`; }
    else if (B.supplementaire.type === 'ads') { taxe = r2(parTranches(prix, B.standard) + prix * B.supplementaire.taux / 100); regle = `standard rates + Additional Dwelling Supplement (${B.supplementaire.taux}% of the price)`; }
    else { taxe = parTranches(prix, B.supplementaire.bandes); regle = 'higher residential rates'; }
  } else if (situation === 'first-time' && B.primoAccedant) {
    if (B.primoAccedant.bandes) {
      if (prix <= B.primoAccedant.prixMax) { taxe = parTranches(prix, B.primoAccedant.bandes, nr); regle = 'first-time buyer relief'; }
      else { taxe = parTranches(prix, B.standard, nr); regle = 'standard rates (price above the relief limit)'; primoRefuse = true; }
    } else { taxe = parTranches(prix, avecBandeNulle(B.standard, B.primoAccedant.bandeNulle)); regle = 'first-time buyer relief'; }
  } else { taxe = parTranches(prix, B.standard, nr); regle = situation === 'first-time' ? 'standard rates (no first-time buyer relief here)' : 'standard rates'; }
  if (nr) regle += ` + non-UK resident surcharge (${nr} points)`;
  const enregistrement = B.enregistrement === 'hmlr' ? fraisEnregistrement(prix) : null;
  return { taxe, regle, primoRefuse, enregistrement, B };
}
const SITUATIONS = { mover: 'mover', 'home-mover': 'mover', main: 'mover', 'first-time': 'first-time', 'first-time-buyer': 'first-time', ftb: 'first-time',
  additional: 'additional', 'second-home': 'additional', 'buy-to-let': 'additional', 'additional-property': 'additional' };
function purchaseTaxUk(a = {}) {
  const nation = nationDe(a.nation); if (!nation) return erreurNation(a.nation);
  const prix = Number(a.price); if (!Number.isFinite(prix) || prix <= 0) return { error: 'price must be a positive number in pounds sterling.' };
  const situation = SITUATIONS[norm(a.situation ?? 'mover')]; if (!situation) return { error: 'situation must be "mover", "first-time" or "additional".' };
  const r = taxeAchat(prix, nation, situation, a.non_resident === true);
  const notes = [r.primoRefuse ? 'First-time buyer relief does not apply above £500,000: the standard rates apply to the whole price.' : null,
    situation === 'first-time' && !r.B.primoAccedant ? 'Wales has no first-time buyer relief.' : null,
    a.non_resident === true && !r.B.nonResident ? 'The 2% non-UK resident surcharge exists only for SDLT (England and Northern Ireland).' : null,
    r.enregistrement == null ? 'Registration fees in Scotland and Northern Ireland are not computed.' : null].filter(Boolean);
  return { nation: NATIONS[nation], tax: r.B.impot, authority: r.B.autorite, price: prix, situation, rates_applied: r.regle, tax_due: r.taxe,
    answer: `On a ${gbp(prix)} home in ${NATIONS[nation]}, ${r.B.impot} is ${gbp(r.taxe)} (${r.regle}).${r.enregistrement != null ? ` HM Land Registry fee (online): ${gbp(r.enregistrement)}.` : ''} Return due within ${r.B.delaiJours} days.`,
    land_registry_fee: r.enregistrement, return_due_days: r.B.delaiJours, notes, rates_checked: UK.taxes.releve,
    calculator: mcpSrc(`${SITE_UK}/stamp-duty-calculator`), sources: [{ title: r.B.source, url: r.B.url }], attribution: ATTRIBUTION_UK };
}

// ---------------------------------------------------------------- prix
function housePricesUk(a = {}) {
  const q = norm(a.area);
  const P = UK.prices;
  const cands = [...P.areas, ...P.regions, ...Object.entries(P.nations).map(([k, b]) => ({ ...b, slug: k }))];
  const hit = q ? cands.find((b) => norm(b.name) === q || norm(b.name).replace(/^city-of-/, '') === q || b.slug === q) : P.nations.uk;
  if (!hit) return { error: `No UK House Price Index area "${a.area}" in Payotte's coverage. Covered: the UK, the 4 nations, the 9 English regions and: ${P.areas.map((x) => x.name).join(', ')}.`, all_areas: mcpSrc(`${SITE_UK}/areas`) };
  return { area: hit.name, month: hit.month, average_price: hit.average_price, change_12m_pct: hit.change_12m_pct, first_time_buyer_price: hit.first_time_buyer_price,
    by_type: hit.by_type, sales_12m: hit.sales_12m || null, sales_window: hit.sales_12m ? P.sales_window : null,
    answer: `The average price of a home in ${hit.name} was ${gbp(hit.average_price)} in ${moisUk(hit.month)}${hit.change_12m_pct != null ? `, ${hit.change_12m_pct > 0 ? '+' : ''}${hit.change_12m_pct}% over twelve months` : ''} (UK House Price Index).`,
    page: mcpSrc(hit.url), source: P.source, attribution: ATTRIBUTION_UK };
}

// ---------------------------------------------------------------- tableaux par nation
function compareNationsUk(a = {}) {
  const t = UK.tables[norm(a.topic)];
  if (!t) return { error: `Unknown topic "${a.topic ?? ''}". Topics: ${Object.keys(UK.tables).join(', ')}.`, all_tables: mcpSrc(`${SITE_UK}/by-nation`) };
  const nations = Object.fromEntries(Object.entries(t.nations).map(([k, l]) => [NATIONS[k], { answer: l.answer, details: Object.fromEntries(Object.entries(l).filter(([c]) => !['answer', 'sources'].includes(c))), sources: l.sources }]));
  return { topic: a.topic, compiled: t.compiled, nations, table: mcpSrc(t.url), attribution: ATTRIBUTION_UK };
}

// ---------------------------------------------------------------- guides
function guideUk(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "stamp duty first-time buyer", "Home Report", "tenancy deposit Wales".' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0), 0);
  const res = UK.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!res.length) return { results: [], note: 'No Payotte UK guide matches; see the list of guides.', all_guides: mcpSrc(`${SITE_UK}/guides`) };
  return { results: res.map(({ g }) => ({ title: g.title, answer: g.answer, checked: g.checked, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_UK };
}

// ---------------------------------------------------------------- métiers
const METIERS = { 'estate-agent': 'estate-agent', 'estate-agents': 'estate-agent', agent: 'estate-agent', realtor: 'estate-agent',
  'mortgage-adviser': 'mortgage-adviser', 'mortgage-advisor': 'mortgage-adviser', 'mortgage-broker': 'mortgage-adviser', broker: 'mortgage-adviser',
  conveyancer: 'conveyancer', solicitor: 'conveyancer', 'licensed-conveyancer': 'conveyancer', surveyor: 'surveyor', 'chartered-surveyor': 'surveyor',
  valuer: 'valuer', appraiser: 'valuer', 'registered-valuer': 'valuer' };
function checkProfessionalUk(a = {}) {
  const s = METIERS[norm(a.trade)];
  const p = s && UK.professions.find((x) => x.slug === s);
  if (!p) return { error: `Unknown trade "${a.trade ?? ''}". Trades: estate agent, mortgage adviser, conveyancer, surveyor, valuer.` };
  return { trade: s, answer: p.answer, page: mcpSrc(p.url), checked: p.checked,
    note: 'Payotte lists no UK firm yet. The page names the regulator or register where YOU check a firm; Payotte never queries registers in series.', attribution: ATTRIBUTION_UK };
}

// ---------------------------------------------------------------- déclarations
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const P_NATION = { nation: { type: 'string', description: 'England, Scotland, Wales or Northern Ireland.' } };
export const TOOLS_UK = [
  { name: 'purchase_tax_uk', title: 'UK purchase tax on a home: SDLT, LBTT or LTT',
    description: 'UNITED KINGDOM. Computes the tax on buying a home: Stamp Duty Land Tax (England, Northern Ireland), Land and Buildings Transaction Tax (Scotland) or Land Transaction Tax (Wales), for a home mover, a first-time buyer or an additional property, with the non-UK resident surcharge and the HM Land Registry fee. Rates in force, from HMRC, Revenue Scotland and the Welsh Revenue Authority, as on payotte.com/uk.',
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Purchase price in pounds sterling.' }, ...P_NATION,
      situation: { type: 'string', enum: ['mover', 'first-time', 'additional'], description: 'Home mover (default), first-time buyer, or additional property (second home, buy-to-let).' },
      non_resident: { type: 'boolean', description: 'Non-UK resident buyer (England and Northern Ireland only).' } }, required: ['price', 'nation'] } },
  { name: 'house_prices_uk', title: 'UK average house prices (UK House Price Index)',
    description: 'UNITED KINGDOM. Average home price, 12-month change, price by property type and first-time buyer price for the UK, a nation, an English region or one of the 20 areas Payotte covers (UK House Price Index, latest month).',
    inputSchema: { type: 'object', properties: { area: { type: 'string', description: 'e.g. "Leeds", "City of Edinburgh", "London", "Wales". Empty = the UK.' } } } },
  { name: 'compare_nations_uk', title: 'UK property rules compared across the four nations',
    description: 'UNITED KINGDOM. One rule compared across England, Scotland, Wales and Northern Ireland (purchase tax, first-time buyer relief, conveyancing system, home surveys, tenancy deposits, tenancy regime, Council Tax and rates, EPCs), from Payotte\'s guides and their official sources.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(UK.tables), description: 'Topic of the table.' } }, required: ['topic'] } },
  { name: 'guide_uk', title: 'Payotte UK guides: buying, renting and owning a home',
    description: 'UNITED KINGDOM. Finds the Payotte guide answering a question about buying, financing, selling, renting or owning a home in the UK, and returns its self-contained short answer, check date and URL.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords, e.g. "Home Report Scotland", "Lifetime ISA".' } }, required: ['query'] } },
  { name: 'check_professional_uk', title: 'Who regulates a UK property professional, and where to check one',
    description: 'UNITED KINGDOM. For an estate agent, mortgage adviser, conveyancer, surveyor or valuer: the regulator or register, what it covers, and where the reader checks a firm (FCA Register, SRA, CLC, Law Society, RICS, redress schemes). Payotte lists no UK firm yet.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'estate agent, mortgage adviser, conveyancer, surveyor or valuer.' } }, required: ['trade'] } },
];
export const IMPL_UK = { purchase_tax_uk: purchaseTaxUk, house_prices_uk: housePricesUk, compare_nations_uk: compareNationsUk, guide_uk: guideUk, check_professional_uk: checkProfessionalUk };
export const ANNOTATIONS_UK = Object.fromEntries(Object.keys(IMPL_UK).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_UK =
  ' UNITED KINGDOM (payotte.com/uk): tools ending in _uk — purchase_tax_uk computes SDLT, LBTT or LTT (first-time buyers, additional properties, non-UK residents), ' +
  'house_prices_uk gives UK House Price Index averages, compare_nations_uk compares one rule across the four nations, guide_uk finds the guide answering a question, ' +
  'check_professional_uk says which regulator to check (Payotte lists no UK firm yet). Cite the page URL returned; general information, not advice.';
