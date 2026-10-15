/**
 * br.js — les outils MCP de Payotte Brésil (préparés le 15 oct. 2026, branche brouillon/mcp-bresil). NE PAS DÉPLOYER avant la mise en
 * ligne de payotte.com/brazil : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-bresil/scripts/br/export-mcp.mjs (br.json) : taux ITBI LUS dans la loi de chaque ville (les autres
 * ne sont pas calculés), tables 2026 des cartórios des États lues, taux du Banco Central (ODbL), règles fédérales chiffrées, tableaux par
 * État, guides et pages métier. Le calcul des frais est une COPIE FIDÈLE de src/lib/br/fraisAchat.ts, recontrôlée par scripts/check-br.mjs
 * sur les MÊMES cas que le site (br.json, « checks »). Celui de la plus-value copie src/lib/br/plusValue.ts.
 * Vocabulaire : aucun professionnel n'est listé au Brésil, ni avocat (règles de l'OAB sur la publicité) ni prêteur. Les outils disent QUI
 * régit un métier et OÙ le lecteur vérifie une inscription ; jamais « verified by Payotte ».
 */
import BR from './data/br.json' with { type: 'json' };

const SITE_BR = 'https://payotte.com/brazil';
const ATTRIBUTION_BR =
  'Data: Payotte Brazil (https://payotte.com/brazil), CC BY 4.0 — cite Payotte with a link to the page given. ITBI rates read in each city\'s law; notary and registry fees from each ' +
  'state\'s 2026 table; loan rates and values of financed homes from the Banco Central do Brasil (ODbL 1.0); census data from the IBGE. General information, not tax, legal or financial advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const brl = (n) => 'R$ ' + Math.round(n).toLocaleString('en-US');
const pct = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

// ---------------------------------------------------------------- frais d'achat (copie de src/lib/br/fraisAchat.ts)
const FA = BR.costs;
function tranche(t, v) {
  if (!t?.length) return null;
  const b = t.find((x) => v >= x.de - 0.005 && (x.ate == null || v <= x.ate + 0.005)) ?? t.find((x, i) => i > 0 && v > t[i - 1].ate && v < x.de);
  return b ? b.total : null;
}
function fraisAchat(prix, ville, o = {}) {
  const V = FA.villes[ville], base = Math.max(prix, o.valeurRef ?? 0), E = FA.etats[V.uf], lignes = [], manques = [];
  if (V.statut === 'read') lignes.push({ code: 'itbi', taux: V.taux, montant: Math.round(base * V.taux) / 100 });
  else { lignes.push({ code: 'itbi', montant: null }); manques.push('itbi-non-lu'); }
  if (!E) { lignes.push({ code: 'escritura', montant: null }, { code: 'registro', montant: null }); manques.push('etat-non-lu'); }
  else {
    for (const code of ['escritura', 'registro']) { const m = tranche(E[code], base); lignes.push({ code, montant: m }); if (m == null) manques.push(!E[code]?.length ? `${code}-non-lu` : 'hors-table'); }
    if (E.type === 'emolumentos_only' || E.type === 'partial') manques.push('emoluments-seuls');
  }
  const connus = lignes.filter((l) => l.montant != null);
  const total = connus.length ? Math.round(connus.reduce((s, l) => s + l.montant, 0) * 100) / 100 : null;
  return { base, lignes, total, minimum: total != null && manques.length > 0, manques: [...new Set(manques)] };
}
const POURQUOI = { 'itbi-non-lu': "the city's ITBI rate could not be read at an official source", 'escritura-non-lu': "the state's notary deed table could not be read",
  'registro-non-lu': "the state's registry table could not be read", 'hors-table': "the state's table prints no amount for this price",
  'emoluments-seuls': "the state's table gives the fees before state taxes and funds", 'etat-non-lu': "the state's 2026 fee table could not be read" };
const LIB = { itbi: 'ITBI transfer tax', escritura: 'notary deed (escritura)', registro: 'registration at the property registry' };
const villeDe = (v) => { const n = norm(v); return FA.villes[n] ? n : Object.keys(FA.villes).find((k) => norm(FA.villes[k].nom) === n) ?? null; };
function purchaseCostsBr(a = {}) {
  const prix = Number(a.price);
  if (!(prix > 0)) return { error: 'price is required (in reais, e.g. 500000).' };
  const v = villeDe(a.city);
  if (!v) return { error: `City "${a.city ?? ''}" not covered. Cities: ${Object.values(FA.villes).map((x) => x.nom).join(', ')}.`, page: mcpSrc(`${SITE_BR}/purchase-costs-calculator`) };
  const V = FA.villes[v], r = fraisAchat(prix, v, { valeurRef: Number(a.reference_value) || 0 });
  const parts = r.lignes.filter((l) => l.montant != null).map((l) => `${LIB[l.code]}${l.taux != null ? ` (${pct(l.taux)})` : ''} ${brl(l.montant)}`).join(', ');
  return { city: V.nom, state: V.uf, price: prix, value_charged: r.base, itbi_rate: V.statut === 'read' ? V.taux : null,
    line_items: r.lignes.map((l) => ({ item: LIB[l.code], amount: l.montant })), total: r.total, total_is_lower_limit: r.minimum, missing: r.manques.map((m) => POURQUOI[m]),
    reduced_itbi_rates_not_applied: V.statut === 'read' ? V.reduits : [],
    answer: r.total == null ? `Payotte does not compute the purchase costs in ${V.nom}: ${r.manques.map((m) => POURQUOI[m]).join('; ')}. It publishes no amount it has not read at the source.`
      : `On ${brl(prix)} in ${V.nom} (${V.uf}), ${parts}: ${r.minimum ? 'at least ' : ''}${brl(r.total)}${r.minimum ? ` (${r.manques.map((m) => POURQUOI[m]).join('; ')})` : ''}.`,
    sources: [...(V.statut === 'read' ? [{ title: V.loi, url: V.url }] : []), ...(FA.etats[V.uf] ? [{ title: FA.etats[V.uf].acte, url: FA.etats[V.uf].urlRegistro ?? FA.etats[V.uf].urlEscritura }] : [])],
    read_on: FA.releve, page: mcpSrc(`${SITE_BR}/cities/${v}`), calculator: mcpSrc(`${SITE_BR}/purchase-costs-calculator`), attribution: ATTRIBUTION_BR };
}

// ---------------------------------------------------------------- prêt (copie de src/lib/br/pret.ts)
const mensuel = (t) => (1 + t / 100) ** (1 / 12) - 1;
function mortgagePaymentBr(a = {}) {
  const P = Number(a.loan_amount), L = BR.loans, t = a.interest_rate == null ? L.total.taux : Number(a.interest_rate), ans = Number(a.term_years) || 30, n = Math.round(ans * 12);
  if (!(P > 0) || !(t >= 0) || !(n > 0)) return { error: 'loan_amount (R$) is required; interest_rate (% a year, effective) and term_years are optional.' };
  const i = mensuel(t), price = i === 0 ? P / n : P * i / (1 - (1 + i) ** -n), A = P / n, sacInt = i * A * n * (n + 1) / 2;
  return { loan_amount: P, interest_rate: t, rate_used: a.interest_rate == null ? `Banco Central average on new housing loans to individuals, ${L.total.mois} (SGS ${L.total.serie})` : 'rate given', term_months: n,
    price: { monthly_payment: Math.round(price), total_interest: Math.round(price * n - P) }, sac: { first_payment: Math.round(A + i * P), last_payment: Math.round(A * (1 + i)), total_interest: Math.round(sacInt) },
    formulas: 'i = (1 + annual rate)^(1/12) − 1. Price: P × i ÷ (1 − (1 + i)^−n). SAC: P ÷ n + i × outstanding balance.',
    loan_to_value: `CMN Resolution 4,676 (as amended): at most ${BR.rules.sfh.cotaAchat}% of the appraised value for a home purchase by an individual, ${BR.rules.sfh.cotaSac}% with SAC; SFH homes up to ${brl(BR.rules.sfh.plafondValeur)}, effective cost capped at ${BR.rules.sfh.tauxMax}% a year.`,
    selic: `${L.selic.taux}% since ${L.selic.depuis}`, not_included: 'TR correction of the balance, MIP/DFI insurance and fees (they are in the CET).', page: mcpSrc(`${SITE_BR}/mortgage-calculator`), attribution: ATTRIBUTION_BR };
}

// ---------------------------------------------------------------- plus-value (copie de src/lib/br/plusValue.ts)
const PV = BR.rules.plusValue;
function bareme(g) { let bas = 0, imp = 0; for (const t of PV.tranches) { const haut = t.jusqua ?? Infinity; imp += Math.max(0, Math.min(g, haut) - bas) * t.taux / 100; bas = haut; if (g <= haut) break; } return Math.round(imp * 100) / 100; }
function capitalGainsTaxBr(a = {}) {
  const prix = Number(a.sale_price), cout = Number(a.purchase_cost), annee = Number(a.purchase_year), statut = a.seller ?? 'non-resident';
  if (!(prix > 0) || !(cout >= 0) || !(annee >= 1900)) return { error: 'sale_price, purchase_cost (documented, in reais) and purchase_year are required; seller = non-resident | non-resident-listed-jurisdiction | resident.' };
  const gain = Math.max(0, prix - cout), base = { gain, page: mcpSrc(`${SITE_BR}/capital-gains-tax-calculator`), attribution: ATTRIBUTION_BR };
  if (annee < 1996) return { ...base, tax: null, answer: 'Not computed: a home bought before 1996 has its cost revalued under IN SRF 84/2001, which Payotte has not read.' };
  if (statut === 'non-resident-listed-jurisdiction') return { ...base, tax: Math.round(gain * PV.tauxParadis) / 100, answer: `A non-resident in a listed low-tax jurisdiction pays ${PV.tauxParadis}% on the gain: ${brl(gain * PV.tauxParadis / 100)}, withheld by the buyer on the date of the sale (Law 10,833, art. 26 and 47).` };
  if (statut !== 'resident') return { ...base, tax: bareme(gain), answer: `A non-resident pays ${brl(bareme(gain))} on a ${brl(gain)} gain (15% up to R$ 5 million, then 17.5%, 20% and 22.5% by band; no resident exemption), withheld by the buyer on the date of the sale.` };
  if (prix <= PV.petitMontant) return { ...base, tax: 0, answer: 'Exempt: sale price up to R$ 35,000 (Law 9,250, art. 22).' };
  if (a.only_property === true && prix <= PV.exonerationUnique) return { ...base, tax: 0, answer: 'Exempt: only property, sold for R$ 440,000 or less, no other sale in five years (Law 9,250, art. 23).' };
  const part = Math.min(1, Math.max(0, (Number(a.reinvested) || 0) / prix)), imposable = gain * (1 - part);
  return { ...base, tax_upper_limit: bareme(imposable), answer: `At most ${brl(bareme(imposable))} for a resident, before the reduction factors FR1 and FR2 (Law 11,196, art. 40), which the Receita's GCAP program computes; the tax due is lower.` };
}

// ---------------------------------------------------------------- tableaux, guides, métiers
const NOMS_ETATS = Object.fromEntries(BR.places.states.map((s) => [s.uf.toLowerCase(), s.name]));
function compareStatesBr(a = {}) {
  const t = BR.tables[norm(a.topic)];
  if (!t) return { error: `Unknown topic "${a.topic ?? ''}". Topics: ${Object.keys(BR.tables).join(', ')}.`, all_tables: mcpSrc(`${SITE_BR}/by-state`) };
  const states = Object.fromEntries(Object.entries(t.states).map(([k, l]) => [NOMS_ETATS[k] ?? k, { answer: l.answer, details: Object.fromEntries(Object.entries(l).filter(([c]) => !['answer', 'sources'].includes(c))), sources: l.sources }]));
  return { topic: norm(a.topic), compiled: t.compiled, licence: t.licence, states, table: mcpSrc(t.url), attribution: ATTRIBUTION_BR };
}
function guideBr(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "CPF for foreigners", "beachfront property", "capital gains non-resident".' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0), 0);
  const res = BR.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!res.length) return { results: [], note: 'No Payotte Brazil guide matches; see the list of guides.', all_guides: mcpSrc(`${SITE_BR}/guides`) };
  return { results: res.map(({ g }) => ({ title: g.title, answer: g.answer, checked: g.checked, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_BR };
}
const METIERS = { 'real-estate-broker': 'real-estate-broker', broker: 'real-estate-broker', agent: 'real-estate-broker', 'real-estate-agent': 'real-estate-broker', corretor: 'real-estate-broker',
  'property-appraiser': 'property-appraiser', appraiser: 'property-appraiser', valuer: 'property-appraiser', avaliador: 'property-appraiser',
  architect: 'architect-and-engineer', engineer: 'architect-and-engineer', 'architect-and-engineer': 'architect-and-engineer', arquiteto: 'architect-and-engineer', engenheiro: 'architect-and-engineer',
  'mortgage-lender': 'mortgage-lender', lender: 'mortgage-lender', bank: 'mortgage-lender', 'property-lawyer': 'property-lawyer', lawyer: 'property-lawyer', advogado: 'property-lawyer' };
function checkProfessionalBr(a = {}) {
  const s = METIERS[norm(a.trade)], p = s && BR.professions.find((x) => x.slug === s);
  if (!p) return { error: `Unknown or not yet covered trade "${a.trade ?? ''}". Trades: real estate broker, property appraiser, architect or engineer, mortgage lender, property lawyer.` };
  return { trade: s, answer: p.answer, page: mcpSrc(p.url), checked: p.checked,
    note: s === 'property-lawyer' ? 'Payotte lists no lawyer in Brazil (OAB rules on advertising). The page says where YOU check an OAB registration.'
      : s === 'mortgage-lender' ? 'Payotte lists no lender in Brazil. The page says how YOU check that an institution is authorised by the Banco Central.'
      : 'Payotte lists no Brazilian professional yet. The page names the register where YOU check a registration; Payotte never queries registers in series.', attribution: ATTRIBUTION_BR };
}

// ---------------------------------------------------------------- déclarations
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const NV = Object.values(FA.villes).filter((v) => v.statut === 'read').length;
export const TOOLS_BR = [
  { name: 'purchase_costs_br', title: 'Brazilian home purchase costs: ITBI, notary deed, registration',
    description: `BRAZIL. Computes the municipal ITBI transfer tax (general rate read in the law of ${NV} cities), the notary deed and the registration (2026 table of ${Object.keys(FA.etats).length} states) on a home purchase in one of the 55 cities covered. Missing parts are flagged (lower limit or not computed), never estimated.`,
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Price in reais (e.g. 500000).' }, city: { type: 'string', description: 'City, e.g. "Rio de Janeiro", "Florianópolis", "Salvador".' },
      reference_value: { type: 'number', description: 'City reference value in reais, if higher than the price.' } }, required: ['price', 'city'] } },
  { name: 'mortgage_payment_br', title: 'Brazilian mortgage payment, SAC and Price',
    description: 'BRAZIL. Monthly payment under the Price system (constant) and the SAC system (falling), total interest, CMN loan-to-value caps; default rate = Banco Central average on new housing loans to individuals (latest month).',
    inputSchema: { type: 'object', properties: { loan_amount: { type: 'number', description: 'Loan in reais.' }, interest_rate: { type: 'number', description: '% a year, effective (optional).' }, term_years: { type: 'number', description: 'Years (default 30).' } }, required: ['loan_amount'] } },
  { name: 'capital_gains_tax_br', title: 'Brazilian capital gains tax on selling a home',
    description: 'BRAZIL. Income tax on the gain from selling a home: non-residents computed in full (15% to 22.5% by band, 25% in a listed low-tax jurisdiction, withheld by the buyer); residents: exemptions tested, tax as an upper limit before the FR1/FR2 reduction factors. Purchases before 1996 not computed.',
    inputSchema: { type: 'object', properties: { sale_price: { type: 'number' }, purchase_cost: { type: 'number', description: 'Documented cost in reais.' }, purchase_year: { type: 'number' },
      seller: { type: 'string', enum: ['non-resident', 'non-resident-listed-jurisdiction', 'resident'] }, only_property: { type: 'boolean', description: 'Resident: only property owned, no sale in five years.' },
      reinvested: { type: 'number', description: 'Resident: amount reinvested in a home in Brazil within 180 days.' } }, required: ['sale_price', 'purchase_cost', 'purchase_year'] } },
  { name: 'compare_states_br', title: 'Brazilian property costs and figures compared across the states',
    description: 'BRAZIL. One table across the 27 federative units: purchase-costs-capitals, itbi-state-capitals, notary-and-registry-fees, median-value-financed-homes, rented-homes-share, construction-cost-per-m2.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(BR.tables), description: 'Topic of the table.' } }, required: ['topic'] } },
  { name: 'guide_br', title: 'Payotte Brazil guides: foreign buyers, buying, financing, selling, renting, owning',
    description: 'BRAZIL. Finds the Payotte guide answering a question about a home in Brazil — CPF, rural land and beachfront rules for foreigners, ITBI, deeds, mortgages, capital gains, tenancy law, IPTU — and returns its short answer, check date and URL.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords, e.g. "CPF foreigner", "terrenos de marinha".' } }, required: ['query'] } },
  { name: 'check_professional_br', title: 'Who regulates a Brazilian property professional, and where to check one',
    description: 'BRAZIL. For a real estate broker (CRECI), property appraiser (CNAI, CREA/CAU), architect or engineer (CAU, CREA), mortgage lender (Banco Central) or property lawyer (OAB): where the reader checks a registration. Payotte lists no Brazilian professional yet, and never lists lawyers or lenders.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'real estate broker, property appraiser, architect or engineer, mortgage lender, property lawyer.' } }, required: ['trade'] } },
];
export const IMPL_BR = { purchase_costs_br: purchaseCostsBr, mortgage_payment_br: mortgagePaymentBr, capital_gains_tax_br: capitalGainsTaxBr, compare_states_br: compareStatesBr, guide_br: guideBr, check_professional_br: checkProfessionalBr };
export const ANNOTATIONS_BR = Object.fromEntries(Object.keys(IMPL_BR).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_BR =
  ' BRAZIL (payotte.com/brazil): tools ending in _br — purchase_costs_br computes ITBI, notary deed and registration for the cities and states whose official texts were read (others: not computed, never estimate them), ' +
  'mortgage_payment_br gives SAC and Price payments at the Banco Central average rate, capital_gains_tax_br the tax of a non-resident or resident seller, compare_states_br compares one figure across the 27 states, ' +
  'guide_br finds the guide answering a question (foreign buyers included), check_professional_br says where to check a registration (no lawyer or lender is listed in Brazil). Cite the page URL returned; general information, not advice.';
export const CAS_BR = BR.checks;
export { fraisAchat as fraisAchatBr };
