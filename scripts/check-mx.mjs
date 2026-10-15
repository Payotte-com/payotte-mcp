// check-mx.mjs — les outils MCP Mexique (src/mx.js) contre les cas déjà contrôlés sur le site (payotte-astro-mexique/scripts/mx/
// check-frais-achat.mjs, résultats recalculés à la main depuis les lois 2026 lues). Sortie 1 si un montant dérive. Tolérance : 1 peso.
// Usage : node scripts/check-mx.mjs
import { IMPL_MX } from '../src/mx.js';
const c = (price, municipality) => IMPL_MX.closing_costs_mx({ price, municipality });
const cas = [
  ['Cancún 3 M impôt', c(3e6, 'Cancún').acquisition_tax, 90000], ['Cancún registre', c(3e6, 'cancun').recording_fee, 7625.15],
  ['Playa del Carmen 8 M', c(8e6, 'Playa del Carmen').acquisition_tax, 320000], ['Tulum 3 M', c(3e6, 'Tulum').acquisition_tax, 120000],
  ['Nuevo Vallarta (Bahía de Banderas)', c(3e6, 'Nuevo Vallarta').acquisition_tax, 60000], ['Cabo San Lucas (Los Cabos)', c(3e6, 'Cabo San Lucas').acquisition_tax, 83577.28],
  ['Puerto Vallarta 8 M', c(8e6, 'Puerto Vallarta').acquisition_tax, 243670.4], ['Guadalajara 3 M', c(3e6, 'Guadalajara').acquisition_tax, 85649.99],
  ['Mérida 8 M', c(8e6, 'Mérida').acquisition_tax, 322000], ['San Miguel de Allende 3 M', c(3e6, 'San Miguel de Allende').acquisition_tax, 82007.14],
  ['Querétaro 3 M', c(3e6, 'Querétaro').acquisition_tax, 170305.91], ['Guanajuato 3 M', c(3e6, 'Guanajuato').acquisition_tax, 24144.08],
  ['Tijuana 8 M', c(8e6, 'Tijuana').acquisition_tax, 304955.45], ['Ensenada 3 M (surtaxe)', c(3e6, 'Ensenada').acquisition_tax, 76500],
  ['Mazatlán 3 M (10 %)', c(3e6, 'Mazatlán').acquisition_tax, 66000], ['Chihuahua 3 M (4 % + 3,2 UMA)', c(3e6, 'Chihuahua').acquisition_tax, 62775.39],
  ['Durango 8 M', c(8e6, 'Durango').acquisition_tax, 311679.13], ['Oaxaca de Juárez 8 M', c(8e6, 'Oaxaca de Juárez').acquisition_tax, 210708.53],
  ['Tamaulipas registre plafonné', c(8e6, 'Tampico').recording_fee, 58655], ['Colima registre 8 M', c(8e6, 'Manzanillo').recording_fee, 24234.62],
  ['Puebla 3 M (tranche)', c(3e6, 'Puebla').acquisition_tax, 54000], ['Pachuca 3 M (abattement)', c(3e6, 'Pachuca').acquisition_tax, 55720.54],
  ['Monterrey non calculé', c(3e6, 'Monterrey').computed, false], ['Acapulco non calculé', c(3e6, 'Acapulco').computed, false],
  ['Paiement 2,4 M 20 ans 11,31 %', IMPL_MX.mortgage_payment_mx({ loan_amount: 2400000, interest_rate: 11.31, term_years: 20 }).monthly_payment, null],
];
let ko = 0;
for (const [n, got, att] of cas) {
  const ok = att === null ? Number.isFinite(got) && got > 0 : typeof att === 'number' ? Math.abs(got - att) <= 1 : got === att;
  if (!ok) { ko++; console.log(`✗ ${n} : attendu ${att}, obtenu ${got}`); } else console.log(`✓ ${n}${att === null ? ` (${got})` : ''}`);
}
if (ko) { console.log(`\n✗ ${ko} écart(s).`); process.exit(1); }
console.log(`\n✓ ${cas.length} cas conformes.`);
