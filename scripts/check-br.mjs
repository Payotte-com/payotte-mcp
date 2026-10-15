// check-br.mjs — les outils MCP Brésil (src/br.js) contre les MÊMES cas que le site (br.json « checks » = payotte-astro-bresil/src/data/br/
// cas-frais-achat.json, recalculés à la main depuis les relevés de phase 0), plus la plus-value et le prêt. Sortie 1 si un montant dérive.
// Usage : node scripts/check-br.mjs
import { IMPL_BR, CAS_BR, fraisAchatBr } from '../src/br.js';
const cas = [];
for (const c of CAS_BR) {
  const r = fraisAchatBr(c.prix, c.ville, c.options), got = { total: r.total, minimum: r.minimum };
  for (const l of r.lignes) got[l.code] = l.montant;
  for (const [k, v] of Object.entries(c.attendu)) cas.push([`${c.nom} · ${k}`, got[k], v]);
}
const pv = IMPL_BR.capital_gains_tax_br;
cas.push(['PV non-résident, gain 400 000 (15 %)', pv({ sale_price: 1200000, purchase_cost: 800000, purchase_year: 2018 }).tax, 60000]);
cas.push(['PV juridiction listée, 25 %', pv({ sale_price: 1200000, purchase_cost: 800000, purchase_year: 2018, seller: 'non-resident-listed-jurisdiction' }).tax, 100000]);
cas.push(['PV non-résident, gain 6 M (barème)', pv({ sale_price: 7000000, purchase_cost: 1000000, purchase_year: 2010 }).tax, 925000]);
cas.push(['PV résident, bien unique 400 000', pv({ sale_price: 400000, purchase_cost: 100000, purchase_year: 2010, seller: 'resident', only_property: true }).tax, 0]);
cas.push(['PV avant 1996 non calculée', pv({ sale_price: 400000, purchase_cost: 100000, purchase_year: 1990 }).tax, null]);
cas.push(['Prêt 400 000, 11,28 %, 30 ans, Price', IMPL_BR.mortgage_payment_br({ loan_amount: 400000, interest_rate: 11.28, term_years: 30 }).price.monthly_payment, 3730]);
cas.push(['Ville inconnue', !!IMPL_BR.purchase_costs_br({ price: 500000, city: 'Atlantis' }).error, true]);
let ko = 0;
for (const [n, got, att] of cas) { if (got !== att) { ko++; console.log(`✗ ${n} : attendu ${att}, obtenu ${got}`); } else console.log(`✓ ${n}`); }
if (ko) { console.log(`\n✗ ${ko} écart(s).`); process.exit(1); }
console.log(`\n✓ ${cas.length} cas conformes.`);
