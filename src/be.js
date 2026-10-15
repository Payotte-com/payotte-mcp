/**
 * be.js — les outils MCP de Payotte Belgique (décision 8 du council d'harmonisation, 15 oct. 2026, branche decision/mcp-be).
 * NE PAS DÉPLOYER avant la mise en ligne de payotte.com/belgique, /belgie et /belgium : chaque réponse renvoie vers une page du site,
 * qui doit exister.
 *
 * Données GÉNÉRÉES par scripts/export-be.mjs (be.json), depuis payotte-astro (main) : barèmes des droits d'enregistrement des trois
 * Régions et tarif du notaire (frais-achat.json), prix Statbel des communes, provinces et Régions, guides et pages métier FR, NL, EN.
 * Les calculs sont une COPIE FIDÈLE de src/lib/be/fraisAchat.ts et de src/lib/be/capacite.ts, recontrôlée par scripts/check-be.mjs
 * (cas calculés à part, puis comparaison avec le module du site compilé à la volée quand le site est présent).
 *
 * Vocabulaire : ces outils ne nomment AUCUN professionnel. Ils disent QUI régit un métier et OÙ le lecteur vérifie un titre ;
 * jamais « verified by Payotte ». La Belgique n'a pas de régulateur unique : un organisme par métier.
 */
import BE from './data/be.json' with { type: 'json' };

const SITE_BE = 'https://payotte.com';
const ATTRIBUTION_BE =
  'Data: Payotte Belgium (https://payotte.com/belgium), CC BY 4.0 — cite Payotte with a link to the page given. Registration duties from the Regions\' codes ' +
  '(Brussels, Wallonia, Flanders), notary tariff from notaire.be / notaris.be, prices from Statbel (CC BY 4.0, deeds of sale recorded by the FPS Finance). ' +
  'General information, not legal or tax advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const eur = (n) => '€' + Math.round(n).toLocaleString('en-GB');
const eur2 = (n) => '€' + (Math.round(n * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- Régions
const F = BE.costs;
const REGIONS = { bruxelles: 'Brussels-Capital Region', wallonie: 'Wallonia', flandre: 'Flanders' };
const ALIAS_REGION = {
  bruxelles: 'bruxelles', brussels: 'bruxelles', 'brussels-capital': 'bruxelles', 'brussels-capital-region': 'bruxelles', 'bruxelles-capitale': 'bruxelles',
  'region-de-bruxelles-capitale': 'bruxelles', brussel: 'bruxelles', 'brussels-hoofdstedelijk-gewest': 'bruxelles', bhg: 'bruxelles', 'rbc': 'bruxelles',
  wallonie: 'wallonie', wallonia: 'wallonie', walloon: 'wallonie', 'walloon-region': 'wallonie', 'region-wallonne': 'wallonie', wallonie2: 'wallonie', waals: 'wallonie', 'waals-gewest': 'wallonie',
  flandre: 'flandre', flanders: 'flandre', vlaanderen: 'flandre', vlaams: 'flandre', 'vlaams-gewest': 'flandre', 'vlaamse-gewest': 'flandre', flemish: 'flandre', 'flemish-region': 'flandre', 'region-flamande': 'flandre',
};
const COMMUNES = [...BE.prices.wallonia_brussels.communes, ...BE.prices.flanders.communes];
const PROVINCES = [...BE.prices.wallonia_brussels.provinces, ...BE.prices.flanders.provinces];
const regionDe = (a) => {
  const n = norm(a.region);
  if (n) return ALIAS_REGION[n] ?? null;
  const c = COMMUNES.find((x) => x.slug === norm(a.municipality));
  return c ? c.region : null;
};
const erreurRegion = (a) => ({ error: `Unknown Region: "${a.region ?? a.municipality ?? ''}". Use Brussels-Capital, Wallonia or Flanders (or a municipality Payotte covers).` });

// ---------------------------------------------------------------- frais d'achat (même calcul que src/lib/be/fraisAchat.ts)
export function droitsEnregistrement(prix, region, hpu, centreFlamand = false) {
  if (region === 'bruxelles') {
    const R = F.regions.bruxelles;
    const base = hpu && prix <= R.abattement.plafondBase ? Math.max(0, prix - R.abattement.montant) : prix;
    return r2(base * R.tauxNormal / 100);
  }
  if (region === 'wallonie') {
    const R = F.regions.wallonie;
    return r2(prix * (hpu ? R.tauxHpu : R.tauxNormal) / 100);
  }
  const R = F.regions.flandre;
  if (!hpu) return r2(prix * R.tauxNormal / 100);
  const d = prix * R.tauxHpu / 100;
  const plafond = centreFlamand ? R.reductionModeste.plafondBaseCentre : R.reductionModeste.plafondBase;
  return r2(prix <= plafond ? Math.max(0, d - R.reductionModeste.montant) : d);
}
export function honoraires(prix, hpu, bareme = 'vente') {
  const N = F.notaire;
  const B = bareme === 'credit' ? (hpu ? N.Gbis : N.G) : (hpu ? N.Jbis : N.J);
  let reste = Math.round(prix), total = 0;
  N.tranches.forEach((largeur, i) => { const t = Math.min(reste, largeur); total += t * B.taux[i] / 100; reste -= t; });
  if (reste > 0) total += reste * B.surplus / 100;
  return r2(total + B.fixe);
}
export function fraisCredit(capital, hpu, lie = true) {
  const C = F.credit, N = F.notaire;
  const base = capital * (1 + C.accessoires / 100);
  const enregistrement = r2(base * C.droitEnregistrement / 100), hypotheque = r2(base * C.droitHypotheque / 100);
  const retribution = base <= C.retribution.seuil ? C.retribution.estime[0] : C.retribution.estime[1];
  const hon = honoraires(capital, hpu, 'credit');
  const admin = lie ? N.fraisAdministratifsActeLie : N.fraisAdministratifs;
  const tva = r2((hon + admin) * N.tva / 100);
  const total = r2(enregistrement + hypotheque + retribution + hon + admin + tva + C.droitEcriture);
  return { base, enregistrement, hypotheque, retribution, honoraires: hon, admin, tva, ecriture: C.droitEcriture, total };
}
export function fraisAchat(prix, region, hpu, centreFlamand = false) {
  const droits = droitsEnregistrement(prix, region, hpu, centreFlamand);
  const hon = honoraires(prix, hpu);
  const admin = F.notaire.fraisAdministratifs;
  const tva = r2((hon + admin) * F.notaire.tva / 100);
  const A = F.autresFrais;
  const autres = r2(A.debours + A.transcription + A.ecritureEtAnnexes[region] + (A.debours + A.droitEcriture) * F.notaire.tva / 100);
  const total = r2(droits + hon + admin + tva + autres);
  return { droits, honoraires: hon, admin, tva, autres, total, pourcentage: prix > 0 ? total / prix * 100 : 0 };
}

const PAGE_COUTS = BE.pages.costs, PAGE_CAPACITE = BE.pages.capacity;
const prixValide = (v) => { const p = Number(v); return Number.isFinite(p) && p >= 1000 ? p : null; };
const notesRegion = (region, hpu, prix, centre) => {
  const R = F.regions[region], n = [];
  if (region === 'bruxelles' && hpu) n.push(prix <= R.abattement.plafondBase
    ? `Brussels abatement: the first ${eur(R.abattement.montant)} of the price are exempt (sole and own home, price up to ${eur(R.abattement.plafondBase)}).`
    : `Above ${eur(R.abattement.plafondBase)} the Brussels abatement is lost entirely: the full price is taxed at ${R.tauxNormal}%.`);
  if (region === 'wallonie' && hpu) n.push(`Wallonia: reduced rate of ${R.tauxHpu}% for a sole and own home, with no price ceiling.`);
  if (region === 'flandre' && hpu) {
    const plafond = centre ? R.reductionModeste.plafondBaseCentre : R.reductionModeste.plafondBase;
    n.push(`Flanders: reduced rate of ${R.tauxHpu}% for a sole and own home${prix <= plafond ? `, less a ${eur(R.reductionModeste.montant)} reduction because the price is at most ${eur(plafond)}` : `, no further reduction above ${eur(plafond)}`}. ` +
      `The 2% rate applies to deeds signed in 2026; an increase is announced for 2027 and was not yet voted when Payotte checked.`);
  }
  if (!hpu) n.push(`Not a sole and own home: the normal rate of ${R.tauxNormal}% applies to the whole price.`);
  n.push('"Sole and own home" means you will live there and own no other home. Notary fees follow the legal tariff (scale Jbis for a sole home, J otherwise); the line "other costs" is an estimate from notaire.be / notaris.be fact sheets and varies with the file.');
  return n;
};
function purchaseCostsBe(a = {}) {
  const region = regionDe(a); if (!region) return erreurRegion(a);
  const prix = prixValide(a.price); if (prix == null) return { error: 'price must be a number of at least 1,000 euros.' };
  const hpu = a.sole_home !== false, centre = a.flemish_core_city === true;
  const o = fraisAchat(prix, region, hpu, centre);
  const cap = Number(a.loan_amount);
  const c = Number.isFinite(cap) && cap > 0 ? fraisCredit(cap, hpu) : null;
  const R = F.regions[region];
  return {
    region: REGIONS[region], price: prix, sole_home: hpu,
    registration_duty: o.droits, notary_fees: r2(o.honoraires + o.admin + o.tva),
    notary_fees_detail: { tariff_fee: o.honoraires, administrative_costs: o.admin, vat_21_pct: o.tva },
    other_costs_estimated: o.autres, total_purchase_costs: o.total, total_pct_of_price: Math.round(o.pourcentage * 100) / 100,
    mortgage_deed_costs: c ? c.total : null, mortgage_deed_detail: c ? { registration: c.enregistrement, mortgage_duty: c.hypotheque, registration_of_mortgage_estimated: c.retribution, notary_fee: c.honoraires, administrative_costs: c.admin, vat: c.tva, writing_duty: c.ecriture } : null,
    total_with_mortgage_deed: c ? r2(o.total + c.total) : null,
    answer: `On a ${eur(prix)} home in ${REGIONS[region]}${hpu ? ' (sole and own home)' : ''}, the purchase costs are ${eur(o.total)} (${(Math.round(o.pourcentage * 10) / 10)}% of the price): ` +
      `registration duty ${eur(o.droits)}, notary ${eur(o.honoraires + o.admin + o.tva)}, other costs ${eur(o.autres)}.` +
      (c ? ` The mortgage deed on a ${eur(cap)} loan adds about ${eur(c.total)}, so ${eur(o.total + c.total)} in all.` : ''),
    notes: notesRegion(region, hpu, prix, centre), rates_checked: F.releve,
    calculator: mcpSrc(PAGE_COUTS.en), pages: { en: mcpSrc(PAGE_COUTS.en), fr: mcpSrc(PAGE_COUTS.fr), nl: mcpSrc(PAGE_COUTS.nl) },
    sources: [{ title: R.source, url: R.url }, { title: F.notaire.source, url: F.notaire.url }, { title: F.autresFrais.source, url: F.autresFrais.url }],
    attribution: ATTRIBUTION_BE,
  };
}

// ---------------------------------------------------------------- capacité d'emprunt (même calcul que src/lib/be/capacite.ts)
const im = (taux) => taux / 100 / 12;
export function mensualite(capital, taux, ans) { const i = im(taux), n = ans * 12; return i === 0 ? capital / n : capital * i / (1 - Math.pow(1 + i, -n)); }
export function capitalPour(mens, taux, ans) { const i = im(taux), n = ans * 12; return i === 0 ? mens * n : mens * (1 - Math.pow(1 + i, -n)) / i; }
export function prixMax(budget, region, hpu) {
  let bas = 0, haut = budget;
  while (haut - bas > 1) { const m = (bas + haut) / 2; if (m + fraisAchat(m, region, hpu).total <= budget) bas = m; else haut = m; }
  let p = Math.floor(bas);
  while (p + 1 + fraisAchat(p + 1, region, hpu).total <= budget) p++;
  return p;
}
function borrowingCapacityBe(a = {}) {
  const region = regionDe(a); if (!region) return erreurRegion(a);
  const rev = Number(a.net_monthly_income);
  if (!Number.isFinite(rev) || rev <= 0) return { error: 'net_monthly_income is required (household net income per month, in euros).' };
  const part = a.share_of_income_pct == null ? 33 : Number(a.share_of_income_pct), cred = a.monthly_credits == null ? 0 : Number(a.monthly_credits);
  const ans = a.years == null ? 25 : Number(a.years), taux = a.interest_rate_pct == null ? 3.5 : Number(a.interest_rate_pct), apport = a.own_funds == null ? 0 : Number(a.own_funds);
  if (![part, cred, ans, taux, apport].every(Number.isFinite) || part <= 0 || part > 100 || cred < 0 || ans < 1 || ans > 30 || taux < 0 || taux > 20 || apport < 0)
    return { error: 'Check the inputs: share_of_income_pct 1-100, years 1-30, interest_rate_pct 0-20, monthly_credits and own_funds not negative.' };
  const hpu = a.sole_home !== false;
  const mens = Math.max(0, rev * part / 100 - cred);
  const capital = capitalPour(mens, taux, ans);
  const prix = prixMax(capital + apport, region, hpu);
  const f = fraisAchat(prix, region, hpu);
  return {
    region: REGIONS[region], monthly_payment: r2(mens), borrowable_capital: Math.round(capital), total_interest: Math.round(mens * ans * 12 - capital),
    budget: Math.round(capital + apport), max_purchase_price: prix, purchase_costs_included: Math.round(f.total),
    assumptions: { share_of_income_pct: part, monthly_credits: cred, years: ans, interest_rate_pct: taux, own_funds: apport, sole_home: hpu },
    answer: `With ${eur(rev)} of net monthly income, ${part}% of it going to a fixed-rate loan at ${taux}% over ${ans} years${cred ? ` (after ${eur(cred)} of other monthly credits)` : ''}, you can borrow about ${eur(capital)}. ` +
      `With ${eur(apport)} of own funds, the budget is ${eur(capital + apport)}: a home of up to ${eur(prix)} in ${REGIONS[region]} once the ${eur(f.total)} of purchase costs are paid.`,
    notes: ['Belgium has no legal rule on the share of income a loan may take: the share (33% by default) and the rate (3.5% by default) are EXAMPLE assumptions you set, not a bank\'s decision.',
      'Fixed-rate loan with constant monthly payments; the maximum price includes the Region\'s registration duty and notary costs but not the mortgage deed, renovation or moving costs. A lender decides on its own criteria.'],
    calculator: mcpSrc(PAGE_CAPACITE.en), pages: { en: mcpSrc(PAGE_CAPACITE.en), fr: mcpSrc(PAGE_CAPACITE.fr), nl: mcpSrc(PAGE_CAPACITE.nl) }, attribution: ATTRIBUTION_BE,
  };
}

// ---------------------------------------------------------------- prix Statbel
const zonesPrix = () => {
  const jeux = [BE.prices.wallonia_brussels, BE.prices.flanders];
  return jeux.flatMap((J) => [
    ...J.regions.map((r) => ({ kind: 'region', name: REGIONS[r.region], slug: r.region, years: r.years, url: r.url, url_en: r.url_en, last: J.last_year })),
    ...J.provinces.map((p) => ({ kind: 'province', name: p.name, slug: p.slug, years: p.years, url: p.url, last: J.last_year })),
    ...J.communes.map((c) => ({ kind: 'municipality', name: c.name, slug: c.slug, years: c.years, url: c.url, url_en: c.url_en, region: c.region, province: c.province, sales: c.sales_last_4_quarters, quarters: c.quarters, last: J.last_year })),
  ]);
};
const bloc = (b) => (b && b.med != null ? { median: b.med, sales: b.n, q1: b.q1, q3: b.q3 } : { median: null, sales: b?.n ?? 0, note: `fewer than ${BE.prices.wallonia_brussels.threshold} sales: Statbel publishes no median` });
const variation = (zone, type, annee, ref) => { const a = zone.years[annee]?.[type]?.med, b = zone.years[ref]?.[type]?.med; return a != null && b != null ? Math.round((a / b - 1) * 1000) / 10 : null; };
const NOMS_REGION = new Set(['brussels', 'brussel', 'brussels-capital', 'brussels-capital-region', 'bruxelles-capitale', 'region-de-bruxelles-capitale', 'brussels-hoofdstedelijk-gewest',
  'wallonia', 'wallonie', 'walloon-region', 'region-wallonne', 'flanders', 'flandre', 'vlaanderen', 'flemish-region', 'vlaams-gewest', 'vlaamse-gewest', 'region-flamande']);
const ALIAS_VILLE = { ghent: 'gent', bruges: 'brugge', antwerp: 'antwerpen', anvers: 'antwerpen', louvain: 'leuven', ostend: 'oostende', ostende: 'oostende', courtrai: 'kortrijk', malines: 'mechelen', gand: 'gent', 'brussels-city': 'bruxelles', 'city-of-brussels': 'bruxelles' };
function housePricesBe(a = {}) {
  const q = norm(a.area);
  if (!q) return { error: 'area is required: a municipality (e.g. "Liège", "Gent", "Ixelles"), a province or a Region (Brussels-Capital, Wallonia, Flanders).', all_areas: mcpSrc(BE.pages.home.en) };
  const z = zonesPrix();
  // « Brussels » / « Bruxelles-Capitale » = la Région ; « Bruxelles » = la commune (Ville de Bruxelles).
  const parRegion = () => { const r = ALIAS_REGION[q]; return r ? z.find((x) => x.kind === 'region' && x.slug === r) : null; };
  const hit = (NOMS_REGION.has(q) ? parRegion() : null)
    ?? z.find((x) => x.kind === 'municipality' && (x.slug === (ALIAS_VILLE[q] ?? q) || norm(x.name) === q))
    ?? z.find((x) => x.kind === 'province' && (x.slug === q || norm(x.name) === q || norm(x.name).replace(/^(province-de-|province-|provincie-)/, '') === q))
    ?? parRegion();
  if (!hit) return { error: `No Statbel area "${a.area}" in Payotte's coverage. Covered: ${COMMUNES.length} municipalities (19 Brussels municipalities, 15 in Wallonia, 20 in Flanders...), the 10 provinces and the 3 Regions.`,
    municipalities: COMMUNES.map((c) => c.name), regions: ['Brussels-Capital', 'Wallonia', 'Flanders'], all_areas: mcpSrc(BE.pages.home.en) };
  const wb = BE.prices.wallonia_brussels, dern = hit.last;
  const prec = String(Number(dern) - 1), dix = String(Number(dern) - 10);
  const d = hit.years[dern]; if (!d) return { error: `No ${dern} data for ${hit.name}.` };
  const h = bloc(d.houses), ap = bloc(d.apartments);
  const dire = (nom, b, t) => (b.median != null ? `${nom} ${eur(b.median)} (${b.sales.toLocaleString('en-GB')} sales${variation(hit, t, dern, prec) != null ? `, ${variation(hit, t, dern, prec) > 0 ? '+' : ''}${variation(hit, t, dern, prec)}% on ${prec}` : ''})` : `${nom}: fewer than ${wb.threshold} sales, no median published`);
  return {
    area: hit.name, kind: hit.kind, region: hit.region ? REGIONS[hit.region] : undefined, province: hit.province, year: Number(dern),
    houses: { ...h, change_1y_pct: variation(hit, 'houses', dern, prec), change_10y_pct: variation(hit, 'houses', dern, dix) },
    apartments: { ...ap, change_1y_pct: variation(hit, 'apartments', dern, prec), change_10y_pct: variation(hit, 'apartments', dern, dix) },
    last_quarters: hit.quarters?.map((t) => ({ period: t.period, houses_median: t.houses?.med ?? null, apartments_median: t.apartments?.med ?? null })),
    answer: `In ${hit.name}, median prices in ${dern}: ${dire('houses', h, 'houses')}; ${dire('apartments', ap, 'apartments')}. Median of resale deeds recorded by Statbel.`,
    notes: ['Median of recorded resale deeds, not an asking price or a valuation. Statbel publishes no median under 16 sales.'],
    page: mcpSrc(hit.url), ...(hit.url_en ? { page_en: mcpSrc(hit.url_en) } : {}),
    source: { title: BE.prices.wallonia_brussels.source, url: BE.prices.wallonia_brussels.source_url }, attribution: ATTRIBUTION_BE,
  };
}

// ---------------------------------------------------------------- comparaison des trois Régions
function compareRegionsBe(a = {}) {
  const prix = a.price == null ? 300000 : prixValide(a.price); if (prix == null) return { error: 'price must be a number of at least 1,000 euros.' };
  const hpu = a.sole_home !== false;
  const lignes = Object.keys(REGIONS).map((r) => {
    const o = fraisAchat(prix, r, hpu, a.flemish_core_city === true), R = F.regions[r];
    const zone = r === 'flandre' ? BE.prices.flanders.regions[0] : BE.prices.wallonia_brussels.regions.find((x) => x.region === r);
    const dern = (r === 'flandre' ? BE.prices.flanders : BE.prices.wallonia_brussels).last_year;
    return { region: REGIONS[r], registration_duty: o.droits, notary_fees: r2(o.honoraires + o.admin + o.tva), other_costs_estimated: o.autres, total_purchase_costs: o.total, total_pct_of_price: Math.round(o.pourcentage * 100) / 100,
      normal_rate_pct: R.tauxNormal, sole_home_rate_pct: r === 'bruxelles' ? `${R.tauxNormal} on the price above ${eur(R.abattement.montant)} (abatement)` : R.tauxHpu,
      median_price_year: Number(dern), median_house: zone.years[dern]?.houses?.med ?? null, median_apartment: zone.years[dern]?.apartments?.med ?? null, source: R.source, source_url: R.url };
  });
  const ord = [...lignes].sort((x, y) => x.total_purchase_costs - y.total_purchase_costs);
  return {
    price: prix, sole_home: hpu, regions: lignes,
    answer: `On a ${eur(prix)} home${hpu ? ' (sole and own home)' : ''}, purchase costs are ${lignes.map((l) => `${eur(l.total_purchase_costs)} in ${l.region}`).join(', ')}: ${ord[0].region} is the cheapest, ${ord[2].region} the dearest (${eur(ord[2].total_purchase_costs - ord[0].total_purchase_costs)} apart).`,
    notes: ['Real estate taxation is a regional matter in Belgium: each Region sets its own registration duty. The notary tariff is federal and identical everywhere.',
      'Median prices are Statbel medians of recorded resale deeds in the latest full year; they are not asking prices.', ...notesRegion('flandre', hpu, prix, a.flemish_core_city === true).slice(0, 1)],
    rates_checked: F.releve, calculator: mcpSrc(PAGE_COUTS.en), pages: { en: mcpSrc(PAGE_COUTS.en), fr: mcpSrc(PAGE_COUTS.fr), nl: mcpSrc(PAGE_COUTS.nl) }, attribution: ATTRIBUTION_BE,
  };
}

// ---------------------------------------------------------------- guides (FR, NL, EN)
const LANGUES = ['en', 'fr', 'nl'];
const langueDe = (v) => { const n = norm(v); return { en: 'en', english: 'en', fr: 'fr', french: 'fr', francais: 'fr', nl: 'nl', dutch: 'nl', nederlands: 'nl' }[n] ?? null; };
// Pour chaque guide, ses équivalents dans les autres langues (champ equivalent_fr de chaque guide).
const cleEquiv = (l, g) => (l === 'fr' ? g.slug : g.fr);
const EQUIV = {};
for (const l of LANGUES) for (const g of BE.guides[l]) { const k = cleEquiv(l, g); if (k) (EQUIV[k] ??= {})[l] = g.url; }
const autresLangues = (l, g) => { const e = { ...(EQUIV[cleEquiv(l, g)] ?? {}) }; delete e[l]; return e; };
const tousGuides = LANGUES.flatMap((l) => BE.guides[l].map((g) => ({ ...g, lang: l })));
function guideBe(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "registration duties Brussels", "notary fees", "huurwaarborg", "certificat PEB".' };
  const lang = a.language == null || a.language === '' ? null : langueDe(a.language);
  if (a.language && !lang) return { error: 'language must be "en", "fr" or "nl" (or omitted to search all three).' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0) + (norm(g.answer).includes(m) ? 1 : 0), 0);
  const res = tousGuides.filter((g) => !lang || g.lang === lang).map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || LANGUES.indexOf(x.g.lang) - LANGUES.indexOf(y.g.lang)).slice(0, 3);
  const all = { en: mcpSrc(`${SITE_BE}/belgium/guides`), fr: mcpSrc(`${SITE_BE}/belgique/guides`), nl: mcpSrc(`${SITE_BE}/belgie/gidsen`) };
  if (!res.length) return { results: [], note: 'No Payotte Belgium guide matches; see the lists of guides.', all_guides: lang ? all[lang] : all };
  return { results: res.map(({ g }) => ({ title: g.title, language: g.lang, answer: g.answer, checked: g.checked, url: mcpSrc(g.url), same_guide_in_other_languages: Object.fromEntries(Object.entries(autresLangues(g.lang, g)).map(([l, u]) => [l, mcpSrc(u)])) })),
    guides_available: { en: BE.guides.en.length, fr: BE.guides.fr.length, nl: BE.guides.nl.length }, all_guides: all, attribution: ATTRIBUTION_BE };
}

// ---------------------------------------------------------------- métiers (régulateur et registre, sans nommer aucun professionnel)
const METIERS = {
  'agent-immobilier': ['agent-immobilier', 'estate-agent', 'real-estate-agent', 'agent', 'realtor', 'makelaar', 'vastgoedmakelaar', 'immobilienmakler', 'ipi', 'biv'],
  'courtier-credit': ['courtier-credit', 'courtier-en-credit-hypothecaire', 'courtier', 'credit-broker', 'mortgage-broker', 'mortgage-adviser', 'mortgage-advisor', 'kredietbemiddelaar', 'hypotheekmakelaar', 'fsma'],
  notaire: ['notaire', 'notary', 'notaris', 'notariat'],
  'geometre-expert': ['geometre-expert', 'geometre', 'surveyor', 'land-surveyor', 'landmeter', 'landmeter-expert'],
  'certificateur-peb': ['certificateur-peb', 'peb', 'epb', 'epb-assessor', 'epc', 'energy-certifier', 'certificateur', 'energiedeskundige', 'energy-performance-certificate'],
};
const metierDe = (v) => { const n = norm(v); return Object.keys(METIERS).find((k) => METIERS[k].includes(n)) ?? null; };
function checkProfessionalBe(a = {}) {
  const k = metierDe(a.trade);
  if (!k) return { error: `Unknown trade "${a.trade ?? ''}". Trades: estate agent, mortgage (credit) broker, notary, land surveyor (géomètre-expert), EPB/EPC energy assessor.` };
  const reg = BE.professions.regulators.find((x) => x.slug === k);
  const page = (l) => BE.professions[l].find((p) => (l === 'fr' ? p.slug : p.fr) === k);
  const lang = langueDe(a.language) ?? 'en';
  const p = page(lang) ?? page('en');
  return {
    trade: reg.nom, regulator_or_register: reg.organisme, where_to_check: reg.lien, ...(reg.wallonieSeulement ? { scope: 'Wallonia only: the Flemish and Brussels regions have their own energy-certificate rules.' } : {}),
    answer: p.answer, language: lang, checked: p.checked, page: mcpSrc(p.url),
    pages: Object.fromEntries(LANGUES.map((l) => [l, mcpSrc(page(l)?.url)])),
    note: 'Belgium has no single regulator: each trade has its own body. This tool names no professional and checks no register on your behalf — the page tells YOU what to check and where.',
    attribution: ATTRIBUTION_BE,
  };
}

// ---------------------------------------------------------------- déclarations
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const P_REGION = {
  region: { type: 'string', enum: ['Brussels-Capital', 'Wallonia', 'Flanders'], description: 'Region of the home. Registration duties are regional. May be omitted if municipality is given.' },
  municipality: { type: 'string', description: 'Optional: a municipality Payotte covers (e.g. "Liège", "Gent", "Ixelles"), used to find the Region when region is omitted.' },
  sole_home: { type: 'boolean', description: 'Sole and own home (you will live there and own no other home). Default true. False = normal rates.' },
  flemish_core_city: { type: 'boolean', description: 'Flanders only: the home is in a core city (centrumstad) or the Flemish Periphery (Vlaamse Rand). Default false.' },
};
export const TOOLS_BE = [
  { name: 'purchase_costs_be', title: 'Belgian home purchase costs: registration duty, notary, other costs',
    description: 'BELGIUM. Computes the costs of buying an existing home in Brussels-Capital, Wallonia or Flanders: the Region\'s registration duty (12.5% / 12% or the sole-home reduced rate and abatements), the notary fees from the legal tariff plus VAT, the estimated other costs, and optionally the mortgage deed. Same figures as the calculator on payotte.com/belgium/purchase-costs (FR: /belgique/frais-achat, NL: /belgie/aankoopkosten).',
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Purchase price in euros.' }, ...P_REGION,
      loan_amount: { type: 'number', description: 'Optional: mortgage amount in euros, to add the cost of the mortgage deed.' } }, required: ['price'] } },
  { name: 'borrowing_capacity_be', title: 'Belgian borrowing capacity and maximum home price',
    description: 'BELGIUM. From a net monthly income, computes the capital a fixed-rate loan allows and the highest home price once the Region\'s purchase costs are paid. Belgium has no legal debt-to-income rule: the share of income (default 33%) and the rate (default 3.5%) are example assumptions you can change. As on payotte.com/belgium/borrowing-capacity (FR: /belgique/capacite-emprunt, NL: /belgie/leencapaciteit).',
    inputSchema: { type: 'object', properties: { net_monthly_income: { type: 'number', description: 'Household net income per month, in euros.' },
      share_of_income_pct: { type: 'number', description: 'Share of that income going to the loan, in percent (default 33).' }, monthly_credits: { type: 'number', description: 'Other monthly credit repayments, in euros (default 0).' },
      years: { type: 'number', description: 'Loan term in years, 1 to 30 (default 25).' }, interest_rate_pct: { type: 'number', description: 'Annual interest rate in percent (default 3.5).' },
      own_funds: { type: 'number', description: 'Own funds (savings) in euros (default 0).' }, region: P_REGION.region, municipality: P_REGION.municipality, sole_home: P_REGION.sole_home }, required: ['net_monthly_income'] } },
  { name: 'house_prices_be', title: 'Belgian house and apartment prices (Statbel medians)',
    description: 'BELGIUM. Median price of houses and of apartments, with the number of sales, the change over one and ten years and the latest quarters, for a municipality (55 covered: the 19 Brussels municipalities, Wallonian and Flemish cities), a province or a Region. Statbel medians of recorded resale deeds (FPS Finance), no median under 16 sales.',
    inputSchema: { type: 'object', properties: { area: { type: 'string', description: 'e.g. "Liège", "Gent", "Ixelles", "Provincie Antwerpen", "Wallonia". "Brussels" = the Region; "Bruxelles" = the City of Brussels.' } }, required: ['area'] } },
  { name: 'compare_regions_be', title: 'Belgian purchase costs and prices compared across the three Regions',
    description: 'BELGIUM. The same purchase compared across Brussels-Capital, Wallonia and Flanders: registration duty, notary, other costs, total and its share of the price, with each Region\'s median house and apartment price (Statbel). Registration duties are regional; the notary tariff is federal.',
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Purchase price in euros (default 300,000).' },
      sole_home: P_REGION.sole_home, flemish_core_city: P_REGION.flemish_core_city } } },
  { name: 'guide_be', title: 'Payotte Belgium guides: buying, financing, selling, renting and owning (FR, NL, EN)',
    description: 'BELGIUM. Finds the Payotte guide answering a question about buying, financing, selling, renting or owning a home in Belgium, in English, French or Dutch, and returns its self-contained short answer, check date and URL (and the same guide in the other languages when it exists). The page URL is returned for citation.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords, e.g. "registration duties Brussels", "droits d\'enregistrement", "huurwaarborg".' },
      language: { type: 'string', enum: ['en', 'fr', 'nl'], description: 'Optional: restrict to one language. Omitted = search all three.' } }, required: ['query'] } },
  { name: 'check_professional_be', title: 'Who regulates a Belgian property professional, and where to check one',
    description: 'BELGIUM. For an estate agent, mortgage (credit) broker, notary, land surveyor or EPB/EPC energy assessor: the regulatory body or register, what the title means and where the reader checks it (IPI/BIV, FSMA, notaire.be, the surveyors\' Order, the Walloon energy administration). Names no professional.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'estate agent, mortgage broker, notary, surveyor or EPB assessor (French and Dutch names accepted).' },
      language: { type: 'string', enum: ['en', 'fr', 'nl'], description: 'Language of the page to return (default en).' } }, required: ['trade'] } },
];
export const IMPL_BE = { purchase_costs_be: purchaseCostsBe, borrowing_capacity_be: borrowingCapacityBe, house_prices_be: housePricesBe, compare_regions_be: compareRegionsBe, guide_be: guideBe, check_professional_be: checkProfessionalBe };
export const ANNOTATIONS_BE = Object.fromEntries(Object.keys(IMPL_BE).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_BE =
  ' BELGIUM (payotte.com/belgium, /belgique, /belgie): tools ending in _be — purchase_costs_be computes the registration duty of the Region, the notary fees and the other costs of buying a home in Brussels-Capital, Wallonia or Flanders (same figures as the site), ' +
  'borrowing_capacity_be gives the loan and the maximum price from an income (example assumptions, no legal ratio in Belgium), house_prices_be gives Statbel median prices by municipality, province or Region, ' +
  'compare_regions_be compares the three Regions on one purchase, guide_be finds the guide answering a question in English, French or Dutch, ' +
  'check_professional_be says which body regulates a trade and where to check a title (it names no professional). Cite the page URL returned; general information, not legal advice.';
