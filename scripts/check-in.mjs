// check-in.mjs — les outils MCP Inde (src/in.js) contre les 14 cas déjà contrôlés sur le site (payotte-astro-inde/scripts/in/
// check-frais-achat.mjs, résultats recalculés à la main depuis les extraits officiels). Sortie 1 si un montant dérive.
// Usage : node scripts/check-in.mjs
import { IMPL_IN } from '../src/in.js';
const d = (price, state, o = {}) => IMPL_IN.stamp_duty_in({ price, state, ...o });
const cas = [
  ['K1 Kerala', d(5000000, 'Kerala', { reference_value: 6000000 }).total, 600000], ['K2 Kerala', d(8000000, 'KL', { reference_value: 7000000 }).total, 800000],
  ['C1 Chandigarh', d(10000000, 'Chandigarh').total, 510020], ['C2 Chandigarh', d(500000, 'ch').total, 30020],
  ['O1 Odisha', d(4000000, 'Odisha').total, 280000], ['O2 Odisha', d(2500000, 'Bhubaneswar').total, 175000],
  ['P1 Puducherry', d(5000000, 'Puducherry', { reference_value: 6000000 }).total, 690000], ['P2 Puducherry femme', d(5000000, 'py', { reference_value: 6000000, woman_buyer: true }).total, 390000],
  ['U1 Uttarakhand', d(4000000, 'Uttarakhand').total, 225000], ['U2 Uttarakhand femme', d(2000000, 'ut', { woman_buyer: true }).total, 100000],
  ['R1 Rajasthan', d(5000000, 'Rajasthan').total, 350300], ['R2 Rajasthan femme', d(5000000, 'Jaipur', { woman_buyer: true }).total, 300300],
  ['M1 Mumbai', d(10000000, 'Mumbai', { mumbai: true }).total, 600000], ['M2 Maharashtra GP', d(5000000, 'Maharashtra', { maharashtra_area: 'gram-panchayat' }).total, 200000],
  ['Delhi non calculé', d(5000000, 'Delhi').computed, false],
  ['EMI 40 lakh 20 ans 7,61 %', IMPL_IN.home_loan_emi_in({ loan_amount: 4000000, interest_rate: 7.61, tenure_years: 20 }).emi, 32493],
];
let ko = 0;
for (const [n, got, att] of cas) { if (got !== att) { ko++; console.log(`✗ ${n} : attendu ${att}, obtenu ${got}`); } else console.log(`✓ ${n}`); }
if (ko) { console.log(`\n✗ ${ko} écart(s).`); process.exit(1); }
console.log(`\n✓ ${cas.length} cas conformes.`);
