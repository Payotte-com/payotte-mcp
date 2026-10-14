/**
 * au.js — les outils MCP de Payotte Australie (préparés le 14 oct. 2026, branche brouillon/mcp-australie). NE PAS DÉPLOYER avant
 * la mise en ligne de payotte.com/australia : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-australie/scripts/au/export-mcp.mjs (au.json) : barèmes des droits de mutation par État,
 * prix ABS (Total Value of Dwellings), tableaux « by state », guides et pages métier. Le calcul du droit est une COPIE FIDÈLE de
 * src/lib/au/fraisAchat.ts (avertissements compris), recontrôlée par scripts/check-au.mjs sur les exemples officiels.
 *
 * Prix : les États portent le prix MOYEN du parc ; les villes et « rest of state » la MÉDIANE des maisons existantes vendues.
 * Le champ price_type le dit et les deux mesures ne sont jamais mélangées ni comparées entre elles.
 * Vocabulaire : aucun professionnel n'est listé en Australie. Les outils disent QUI régit un métier et OÙ le lecteur vérifie
 * un titre ; jamais « verified by Payotte ».
 */
import AU from './data/au.json' with { type: 'json' };

const SITE_AU = 'https://payotte.com/australia';
const ATTRIBUTION_AU =
  'Data: Payotte Australia (https://payotte.com/australia), CC BY 4.0 — cite Payotte with a link to the page given. Duty rates from each state or territory ' +
  'revenue office; prices from the Australian Bureau of Statistics, Total Value of Dwellings (CC BY 4.0). General information, not tax, legal or financial advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------- États
const F = AU.taxes;
const S = F.etats;
const ETATS = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'];
const ALIAS_ETAT = { 'new-south-wales': 'nsw', victoria: 'vic', queensland: 'qld', 'western-australia': 'wa', 'south-australia': 'sa', tasmania: 'tas',
  'australian-capital-territory': 'act', canberra: 'act', 'northern-territory': 'nt' };
const etatDe = (v) => { const n = norm(v); return ETATS.includes(n) ? n : ALIAS_ETAT[n] ?? null; };
const erreurEtat = (v) => ({ error: `Unknown state: "${v ?? ''}". Use NSW, VIC, QLD, WA, SA, TAS, ACT or NT (or the full name).` });

// ---------------------------------------------------------------- droit de mutation (copie de src/lib/au/fraisAchat.ts)
const r2 = (x) => Math.round(x * 100) / 100;
const dateAu = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
const AUD = (n) => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

function parLignes(prix, lignes, arrondi100 = false, borneExclue = false) {
  const l = lignes.find((x) => x.jusqua == null || (borneExclue ? prix < x.jusqua : prix <= x.jusqua));
  let exc = Math.max(0, prix - l.de);
  if (arrondi100) exc = Math.ceil(exc / 100) * 100;
  return r2(l.base + l.taux * exc / 100);
}
function general(prix, etat, occupant = false) {
  const st = S[etat].standard;
  if (st.quadratique && prix <= st.quadratique.jusqua) { const v = prix / st.quadratique.unite; return r2(st.quadratique.a * v * v + st.quadratique.b * v); }
  if (st.quadratique) { const l = st.lignes.find((x) => x.jusqua == null || prix < x.jusqua); return r2(l.taux * prix / 100); }
  const lignes = st.variantes ? (occupant ? st.variantes.occupant : st.variantes.autres) : st.lignes;
  let d = parLignes(prix, lignes, st.arrondi100, st.borneExclue);
  if (st.minimum) d = Math.max(d, st.minimum);
  return d;
}
function droitMutation(prix, etat, o = {}) {
  const avert = []; let incertain = false;
  const fh = !!o.premierAcheteur, pr = !!o.residencePrincipale;
  const concessions = !o.etranger;
  if (o.etranger && (fh || pr)) avert.push('Foreign buyer: first home and principal place of residence concessions are not applied (cautious assumption: the citizenship and residence conditions were not checked in the texts read).');
  const out = (montant, regle) => ({ montant, regle, avert, incertain });
  const st = S[etat];
  switch (etat) {
    case 'nsw': {
      const std = general(prix, 'nsw');
      if (fh && concessions) {
        const p = st.premierAcheteur;
        if (prix <= p.exonereJusqua) return out(0, `First Home Buyers Assistance Scheme: exemption (up to ${AUD(p.exonereJusqua)})`);
        if (prix < p.concessionJusqua) { incertain = true; avert.push(`NSW: between ${AUD(p.exonereJusqua)} and ${AUD(p.concessionJusqua)}, a concessional rate applies, but its calculation is not published on the pages read: the general duty is shown as an upper limit. Use the Revenue NSW calculator for the exact amount.`); return { montant: std, regle: 'General rates (FHBAS concession not computed: upper limit)', avert, incertain }; }
        avert.push(`NSW: no first home buyer concession from ${AUD(p.concessionJusqua)}.`);
      }
      return out(std, 'General rates');
    }
    case 'vic': {
      const std = general(prix, 'vic');
      if (fh && concessions) {
        const p = st.premierAcheteur;
        if (prix <= p.exonereJusqua) return out(0, `First home buyer: exemption (up to ${AUD(p.exonereJusqua)})`);
        if (prix <= p.concessionJusqua) { incertain = true; avert.push(`VIC: from ${AUD(p.exonereJusqua + 1)} to ${AUD(p.concessionJusqua)}, first home buyers pay a reduced amount of duty, but the SRO does not publish its calculation on the pages read: the general duty is shown as an upper limit. Use the SRO calculator for the exact amount.`); return { montant: std, regle: 'General rates (first home buyer reduction not computed: upper limit)', avert, incertain }; }
      }
      if ((pr || fh) && concessions && prix <= st.residencePrincipale.plafond) return out(parLignes(prix, st.residencePrincipale.lignes), 'Principal place of residence (PPR) rates');
      return out(std, 'General rates');
    }
    case 'qld': {
      if ((fh || pr) && concessions) {
        const hc = parLignes(prix, st.residencePrincipale.lignes, true);
        if (!fh) return out(hc, 'Home concession rates (principal place of residence)');
        if (o.neuf) { incertain = true; avert.push('QLD: full first home (new home) and vacant land concession since 1 May 2025; the detailed conditions were not read.'); return { montant: 0, regle: 'First home concession for a new home or vacant land: no duty', avert, incertain }; }
        const d = st.premierAcheteur.deductions.find(([h]) => h == null || prix <= h)[1];
        return out(Math.max(0, r2(hc - d)), `First home concession (${AUD(d)} off the home concession duty)`);
      }
      return out(general(prix, 'qld'), 'General rates');
    }
    case 'wa': {
      if (fh && concessions) {
        const p = st.premierAcheteur;
        if (prix <= p.exonereJusqua) return out(0, `First home owner rate: no duty (up to ${AUD(p.exonereJusqua)})`);
        if (prix <= p.reduitJusqua) return out(r2(p.tauxReduit * Math.ceil((prix - p.exonereJusqua) / 100)), `First home owner rate: concessional rate above ${AUD(p.exonereJusqua)}`);
      }
      if (pr && concessions && prix <= st.residencePrincipale.plafond) return out(parLignes(prix, st.residencePrincipale.lignes, true), 'Concessional rate (principal place of residence, value up to $200,000)');
      return out(general(prix, 'wa'), 'General rates');
    }
    case 'sa': {
      if (fh && concessions && o.neuf) return out(0, 'First home buyer relief for a new home or land to build on: no duty');
      avert.push('SA: the RevenueSA rate pages could not be read (blocked), so Payotte computes no South Australian duty. Use the RevenueSA calculator.');
      return out(null, 'South Australian rates not read');
    }
    case 'tas': {
      if (fh) avert.push('TAS: the first home buyer duty exemption for established homes does not apply to settlements after 30 June 2026; general rates applied.');
      return out(general(prix, 'tas'), 'General rates');
    }
    case 'act': {
      if (fh && concessions) { incertain = true; avert.push('ACT: the Home Buyer Concession Scheme rate is nil (DI2026-157) subject to conditions, including no property owned in the past 5 years and at least one buyer living in the home. Income and other conditions apply.'); return { montant: 0, regle: 'Home Buyer Concession Scheme: nil rate', avert, incertain }; }
      const occ = (pr || fh) && concessions;
      if (o.etranger) avert.push('ACT: no foreign buyer surcharge was found in the legislation read; check with the ACT Revenue Office.');
      return out(general(prix, 'act', occ), occ ? 'Eligible owner-occupier rates' : 'Non owner-occupier rates');
    }
    case 'nt': {
      const std = general(prix, 'nt');
      incertain = true; avert.push('NT: computed from the Stamp Duty Act 1978 as in force at 1 July 2025; the Territory Revenue Office pages could not be read, so later changes are not checked.');
      if (fh && concessions && prix <= st.premierAcheteur.valeurMax) return { montant: Math.max(0, r2(std - Math.min(std, st.premierAcheteur.rabaisMax))), regle: `Territory home owner discount (${AUD(Math.min(std, st.premierAcheteur.rabaisMax))} off)`, avert, incertain };
      return out(std, 'General rates');
    }
  }
}
export function fraisEnregistrement(prix, etat) {
  const e = S[etat].enregistrement; if (!e) return null;
  const t = e.transfert;
  if (etat === 'nsw') return t.montantTTC;
  if (etat === 'qld') return r2(t.base + t.parTranche10000AuDessusDe180000 * Math.ceil(Math.max(0, prix - 180000) / 10000));
  if (etat === 'wa') { const x = t.bandes.find(([h]) => prix <= h); return x ? x[1] : r2(t.auDela.base + t.auDela.montant * Math.ceil((prix - t.auDela.de) / t.auDela.parTranche)); }
  return t.montant;
}
function fraisHypotheque(etat) {
  const e = S[etat].enregistrement; if (!e) return null;
  return etat === 'nsw' ? e.hypotheque.montantTTC : e.hypotheque.montant;
}
export function fraisFirb(prix, neuf) {
  const t = neuf ? F.federal.firb.neuf : F.federal.firb.existant;
  const x = t.find(([h]) => prix <= h); return x ? x[1] : null;
}
export function fraisAchat(prix, etat, options = {}) {
  const st = S[etat];
  const d = droitMutation(prix, etat, options);
  const avertissements = [...d.avert]; const lignes = [];
  const disponible = d.montant !== null;
  if (d.montant !== null) lignes.push({ code: 'droit_mutation', libelle: `${st.impot}: ${d.regle}`, montant: d.montant });
  if (options.etranger) {
    if (st.etranger) lignes.push({ code: 'surtaxe_etranger', libelle: `Foreign purchaser surcharge (${st.etranger.taux}%)`, montant: r2(prix * st.etranger.taux / 100) });
    else if (etat !== 'act') avertissements.push(`${st.nom}: no foreign purchaser surcharge computed (${etat === 'nt' ? 'none in the Stamp Duty Act read' : 'rates not read'}).`);
    const f = fraisFirb(prix, !!options.neuf);
    if (f !== null) lignes.push({ code: 'firb', libelle: `FIRB application fee 2026-27 (${options.neuf ? 'new dwelling or land' : 'established dwelling'})`, montant: f });
    else avertissements.push('FIRB: above $5 million, the fee band is not computed.');
    if (!options.neuf) avertissements.push(`Foreign persons cannot buy an established dwelling from ${dateAu(F.federal.firb.interdictionExistant.debut)} to ${dateAu(F.federal.firb.interdictionExistant.fin)} (limited exceptions).`);
  }
  const t = fraisEnregistrement(prix, etat);
  if (t !== null) lignes.push({ code: 'enregistrement_transfert', libelle: 'Transfer registration fee (land titles office)', montant: t });
  else avertissements.push(`${st.nom}: the transfer registration fee was not read, so it is not included.`);
  if (options.hypotheque) {
    const h = fraisHypotheque(etat);
    if (h !== null) lignes.push({ code: 'enregistrement_hypotheque', libelle: 'Mortgage registration fee (land titles office)', montant: h });
    else avertissements.push(`${st.nom}: the mortgage registration fee was not read, so it is not included.`);
    if (etat === 'qld') { avertissements.push('QLD: a mortgage is not named in the fee schedule; the « any other instrument » fee is used.'); }
  }
  return {
    etat, nom: st.nom, prix, disponible, lignes,
    total: disponible ? r2(lignes.reduce((s, l) => s + l.montant, 0)) : null,
    regle: d.regle, avertissements, incertain: d.incertain || (options.hypotheque === true && etat === 'qld'),
  };
}

// ---------------------------------------------------------------- outil : droit de mutation
function purchaseDutyAu(a = {}) {
  const etat = etatDe(a.state); if (!etat) return erreurEtat(a.state);
  const prix = Number(a.price); if (!Number.isFinite(prix) || prix <= 0) return { error: 'price must be a positive number in Australian dollars.' };
  const o = { premierAcheteur: a.first_home_buyer === true, residencePrincipale: a.principal_residence === true, etranger: a.foreign_buyer === true,
    neuf: a.new_home === true, hypotheque: a.include_mortgage_registration === true };
  const r = fraisAchat(prix, etat, o);
  const st = S[etat];
  const base = { state: r.nom, duty: st.impot, authority: st.autorite, price: prix, options: { first_home_buyer: o.premierAcheteur, principal_residence: o.residencePrincipale,
    foreign_buyer: o.etranger, new_home_or_vacant_land: o.neuf, include_mortgage_registration: o.hypotheque },
    warnings: r.avertissements, rates_checked: F.releve, calculator: mcpSrc(`${SITE_AU}/stamp-duty-calculator`),
    sources: [{ title: `${st.autorite}: duty rates`, url: st.standard?.source?.url ?? null }].filter((s) => s.url), attribution: ATTRIBUTION_AU };
  if (!r.disponible) return { ...base, computed: false, duty_due: null, total_costs: null, rule_applied: r.regle,
    answer: `Not computed, RevenueSA pages unreadable: Payotte gives no ${st.impot.toLowerCase()} figure for South Australia in this case. Use the RevenueSA calculator.`.replace('South Australia', r.nom),
    line_items: r.lignes.map((l) => ({ item: l.libelle, amount: l.montant })) };
  const duty = r.lignes.find((l) => l.code === 'droit_mutation').montant;
  return { ...base, computed: true, duty_due: duty, total_costs: r.total, rule_applied: r.regle, uncertain: r.incertain,
    line_items: r.lignes.map((l) => ({ item: l.libelle, amount: l.montant })),
    answer: `On a ${AUD(prix)} home in ${r.nom}, ${st.impot.toLowerCase()} is ${AUD(duty)} (${r.regle})${r.incertain ? ', an upper limit or partly uncertain figure: see warnings' : ''}. Total of the lines computed: ${AUD(r.total)}.` };
}

// ---------------------------------------------------------------- prix ABS
const Z = AU.prices.zones;
const MESURE = { 'mean-all-dwellings': 'mean price of all dwellings (value of the dwelling stock divided by the number of dwellings)',
  'median-established-house-transfers': 'median price of established houses transferred during the quarter' };
function housePricesAu(a = {}) {
  const q = norm(a.area);
  const hit = q ? Z.find((z) => z.slug === q || norm(z.name) === q || norm(z.name).replace(/^rest-of-/, 'rest-of-') === q || (z.type === 'state' && norm(z.state) === q)) : null;
  if (q && !hit) return { error: `No ABS area "${a.area}" in Payotte's coverage. Covered: the 8 states and territories, their 8 capital cities and 7 "rest of state" areas: ${Z.map((z) => z.name).join(', ')}.`, all_areas: mcpSrc(`${SITE_AU}/areas`) };
  if (!hit) { const A = AU.prices.australia; return { area: 'Australia', price: A.price, price_type: A.price_type, measure: MESURE[A.price_type], change_12m_pct: A.change_12m_pct, dwellings: A.dwellings,
    quarter: AU.prices.latest_quarter, preliminary: AU.prices.preliminary, answer: `The mean price of an Australian dwelling was $${A.price.toLocaleString('en-AU')} in ${AU.prices.latest_quarter} (${A.change_12m_pct > 0 ? '+' : ''}${A.change_12m_pct}% over twelve months; preliminary ABS figure).`,
    note: AU.prices.notes.prix, page: mcpSrc(`${SITE_AU}/areas`), source: AU.prices.source, attribution: ATTRIBUTION_AU }; }
  const st = hit.type === 'state';
  return { area: hit.name, area_type: hit.type, state: hit.state, price: hit.price, price_type: hit.price_type, measure: MESURE[hit.price_type],
    attached_dwelling_median_price: hit.attached_median_price, change_12m_pct: hit.change_12m_pct, change_attached_12m_pct: hit.change_attached_12m_pct,
    quarter: hit.period, preliminary: hit.preliminary, dwellings: hit.dwellings, sales_12m: hit.sales_12m,
    answer: st
      ? `The mean price of a dwelling in ${hit.name} was $${hit.price.toLocaleString('en-AU')} in ${hit.period} (${hit.change_12m_pct > 0 ? '+' : ''}${hit.change_12m_pct}% over twelve months; mean of all dwellings, preliminary ABS figure).`
      : `The median price of an established house transferred in ${hit.name} was $${hit.price.toLocaleString('en-AU')} in ${hit.period} (${hit.change_12m_pct > 0 ? '+' : ''}${hit.change_12m_pct}% over twelve months; median of house sales, preliminary ABS figure).`,
    note: 'State figures are means of the whole dwelling stock; city and rest-of-state figures are medians of established houses sold. The two measures are not comparable with each other.',
    page: mcpSrc(hit.url), source: AU.prices.source, attribution: ATTRIBUTION_AU };
}

// ---------------------------------------------------------------- tableaux par État
function compareStatesAu(a = {}) {
  const t = AU.tables[norm(a.topic)];
  if (!t) return { error: `Unknown topic "${a.topic ?? ''}". Topics: ${Object.keys(AU.tables).join(', ')}.`, all_tables: mcpSrc(`${SITE_AU}/by-state`) };
  const states = Object.fromEntries(Object.entries(t.states).map(([k, l]) => [S[k]?.nom ?? k.toUpperCase(),
    { answer: l.answer, details: Object.fromEntries(Object.entries(l).filter(([c]) => !['answer', 'sources'].includes(c))), sources: l.sources }]));
  return { topic: norm(a.topic), compiled: t.compiled, states, table: mcpSrc(t.url), attribution: ATTRIBUTION_AU };
}

// ---------------------------------------------------------------- guides
function guideAu(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "first home buyer stamp duty", "cooling-off period", "foreign buyer FIRB".' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0), 0);
  const res = AU.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!res.length) return { results: [], note: 'No Payotte Australia guide matches; see the list of guides.', all_guides: mcpSrc(`${SITE_AU}/guides`) };
  return { results: res.map(({ g }) => ({ title: g.title, answer: g.answer, checked: g.checked, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_AU };
}

// ---------------------------------------------------------------- métiers
const METIERS = { 'real-estate-agent': 'real-estate-agent', 'real-estate-agents': 'real-estate-agent', 'estate-agent': 'real-estate-agent', agent: 'real-estate-agent', realtor: 'real-estate-agent',
  'mortgage-broker': 'mortgage-broker', broker: 'mortgage-broker', 'mortgage-adviser': 'mortgage-broker', 'finance-broker': 'mortgage-broker',
  conveyancer: 'conveyancer', solicitor: 'conveyancer', 'settlement-agent': 'conveyancer', 'building-inspector': 'building-inspector', 'building-and-pest-inspector': 'building-inspector', inspector: 'building-inspector',
  'property-valuer': 'property-valuer', valuer: 'property-valuer', appraiser: 'property-valuer' };
function checkProfessionalAu(a = {}) {
  const s = METIERS[norm(a.trade)];
  const p = s && AU.professions.find((x) => x.slug === s);
  if (!p) return { error: `Unknown trade "${a.trade ?? ''}". Trades: real estate agent, mortgage broker, conveyancer, building inspector, property valuer.` };
  return { trade: s, answer: p.answer, page: mcpSrc(p.url), checked: p.checked,
    note: 'Payotte lists no Australian professional yet. The page names the regulator or register where YOU check a licence; Payotte never queries registers in series.', attribution: ATTRIBUTION_AU };
}

// ---------------------------------------------------------------- déclarations
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TOOLS_AU = [
  { name: 'purchase_duty_au', title: 'Australian transfer (stamp) duty on a home, by state',
    description: 'AUSTRALIA. Computes the duty on buying a home in a state or territory (NSW, VIC, QLD, WA, TAS, ACT, NT; not SA, whose rate pages Payotte could not read) with first home buyer, principal residence, foreign buyer (surcharge and FIRB fee) and new home options, plus land titles registration fees. Rates as on payotte.com/australia; warnings list every assumption and any upper-limit figure.',
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Purchase price in Australian dollars.' },
      state: { type: 'string', description: 'NSW, VIC, QLD, WA, SA, TAS, ACT or NT (or the full name).' },
      first_home_buyer: { type: 'boolean', description: 'Eligible for the state first home buyer exemption or concession.' },
      principal_residence: { type: 'boolean', description: 'The home will be the principal place of residence.' },
      foreign_buyer: { type: 'boolean', description: 'Foreign buyer under state law: surcharge and FIRB fee added, concessions not applied.' },
      new_home: { type: 'boolean', description: 'New dwelling or vacant land (QLD first home concession, FIRB fee scale).' },
      include_mortgage_registration: { type: 'boolean', description: 'Add the mortgage registration fee.' } }, required: ['price', 'state'] } },
  { name: 'house_prices_au', title: 'Australian dwelling prices (ABS)',
    description: 'AUSTRALIA. ABS Total Value of Dwellings, latest quarter: for a state or territory, the MEAN price of all dwellings; for a capital city or a "rest of state" area, the MEDIAN price of established houses sold. The price_type field says which; the two are not comparable.',
    inputSchema: { type: 'object', properties: { area: { type: 'string', description: 'e.g. "Victoria", "Sydney", "Rest of Queensland". Empty = Australia (mean dwelling price).' } } } },
  { name: 'compare_states_au', title: 'Australian property rules compared across the states',
    description: 'AUSTRALIA. One rule compared across the states and territories (purchase duty, foreign purchaser surcharge, first home buyer concessions, first home owner grant, land tax, cooling-off period, rental bonds, vendor disclosure), from Payotte\'s guides and their official sources.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(AU.tables), description: 'Topic of the table.' } }, required: ['topic'] } },
  { name: 'guide_au', title: 'Payotte Australia guides: buying, renting and owning a home',
    description: 'AUSTRALIA. Finds the Payotte guide answering a question about buying, financing, selling, renting or owning a home in Australia, and returns its self-contained short answer, check date and URL.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords, e.g. "cooling-off period", "FIRB foreign buyer".' } }, required: ['query'] } },
  { name: 'check_professional_au', title: 'Who regulates an Australian property professional, and where to check one',
    description: 'AUSTRALIA. For a real estate agent, mortgage broker, conveyancer, building inspector or property valuer: the state regulators or registers, what they cover, and where the reader checks a licence. Payotte lists no Australian professional yet.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'real estate agent, mortgage broker, conveyancer, building inspector or property valuer.' } }, required: ['trade'] } },
];
export const IMPL_AU = { purchase_duty_au: purchaseDutyAu, house_prices_au: housePricesAu, compare_states_au: compareStatesAu, guide_au: guideAu, check_professional_au: checkProfessionalAu };
export const ANNOTATIONS_AU = Object.fromEntries(Object.keys(IMPL_AU).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_AU =
  ' AUSTRALIA (payotte.com/australia): tools ending in _au — purchase_duty_au computes state transfer duty (first home buyers, principal residence, foreign buyers, new homes; South Australia is not computed), ' +
  'house_prices_au gives ABS dwelling prices (state = mean of all dwellings, city and rest of state = median of houses sold: never compare the two), compare_states_au compares one rule across the states, ' +
  'guide_au finds the guide answering a question, check_professional_au says which regulator to check (Payotte lists no Australian professional yet). Cite the page URL returned; general information, not advice.';
