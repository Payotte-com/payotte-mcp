#!/usr/bin/env node
// Construit ef-donnees/ : les fichiers que le worker lit (binding ASSETS) pour la réponse
// immédiate du bandeau d'évaluation foncière (29 sept. 2026).
//
// Entrée : ~/Payotte/donnees-evaluation-fonciere/unites/<prov>.ndjson.gz (+ <prov>-ventes.ndjson.gz),
// au format de unites/SPEC.md, produits par les scripts extraire-<prov>.mjs du dépôt du site.
//
// Sortie (NON versionnée : le dépôt est public et ces fichiers pèsent des centaines de Mo) :
//   ef-donnees/<prov>/index.json                 municipalités : [code, nom, nbTranches, dateValeur, facteur|null, dateFacteur|null]
//   ef-donnees/<prov>/<muni>/<tranche>.json      unités dont num % nbTranches == tranche
//   ef-donnees/<prov>/<muni>/stats.json          statistiques des groupes de comparables (n ≥ 30)
//
// Rien de personnel : les fichiers source n'en contiennent pas (voir SPEC.md).
// Usage : node scripts/construire-ef-donnees.mjs [qc ns …]   (toutes les provinces présentes par défaut)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { USAGES, groupe, SEUIL_GROUPE } from '../src/efAdresse.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const UNITES = process.env.EF_UNITES || path.join(os.homedir(), 'Payotte/donnees-evaluation-fonciere/unites');
const SORTIE = path.resolve(ICI, '../ef-donnees');
const PAR_TRANCHE = 2000;
// Unités écartées volontairement. Manitoba hors Winnipeg : ROLL_ENTRY ne publie aucune classe,
// une « maison » peut être une ferme dont la valeur inclut la terre — la comparer mentirait.
const EXCLURE = { mb: (u) => u.muni !== 'winnipeg' };
const QUANT = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

const lignes = async function* (f) {
  const rl = readline.createInterface({ input: fs.createReadStream(f).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) yield JSON.parse(l);
};
function quantiles(v) {
  if (!v.length) return null;
  const a = Float64Array.from(v).sort();
  return QUANT.map((p) => { const x = (a.length - 1) * p / 100, lo = Math.floor(x), hi = Math.ceil(x); return +(a[lo] + (a[hi] - a[lo]) * (x - lo)).toFixed(4); });
}
const mode = (arr) => { const c = {}; let best = null; for (const x of arr) { c[x] = (c[x] ?? 0) + 1; if (best === null || c[x] > c[best]) best = x; } return best; };

async function province(prov) {
  const f = path.join(UNITES, `${prov}.ndjson.gz`);
  const ff = path.join(UNITES, `${prov}-facteurs.json`);
  const { facteurs = {}, date: dateFacteur = null } = fs.existsSync(ff) ? JSON.parse(fs.readFileSync(ff, 'utf8')) : {};

  // 1. Tout en mémoire, par municipalité (2,6 M unités au Québec : ~1,5 Go de tas, passe avec --max-old-space-size).
  const munis = new Map();
  const parCle = new Map();
  for await (const u of lignes(f)) {
    if (!Number.isInteger(u.num) || !u.valeur || !USAGES.includes(u.usage) || EXCLURE[prov]?.(u)) continue;
    let m = munis.get(u.muni);
    if (!m) munis.set(u.muni, (m = { nom: u.muniNom, unites: [] }));
    m.unites.push(u);
    if (u.cle) parCle.set(u.cle, u);
  }

  // 2. Ventes (N.-É., N.-B.) : rapport prix / valeur au rôle, par municipalité et usage, sur 24 mois.
  const ratios = new Map();
  const fv = path.join(UNITES, `${prov}-ventes.ndjson.gz`);
  let periode = null;
  if (fs.existsSync(fv)) {
    const ventes = [];
    for await (const v of lignes(fv)) ventes.push(v);
    const fin = ventes.reduce((m, v) => (v.date > m ? v.date : m), '');
    const debut = new Date(new Date(fin).getTime() - 730 * 86400e3).toISOString().slice(0, 10);
    periode = [debut, fin];
    for (const v of ventes) {
      if (v.date < debut) continue;
      const u = parCle.get(v.cle);
      if (!u || !u.valeur) continue;
      const r = v.prix / u.valeur;
      if (r < 0.3 || r > 3) continue;                         // ventes aberrantes (lot partiel, erreur de saisie)
      for (const k of [`${u.muni}|${u.usage}`, `${u.muni}|tous`]) (ratios.get(k) ?? ratios.set(k, []).get(k)).push(r);
    }
  }

  fs.rmSync(path.join(SORTIE, prov), { recursive: true, force: true });
  const index = [];
  let fichiers = 0;
  for (const [code, m] of munis) {
    const dossier = path.join(SORTIE, prov, code.replace(/[^A-Za-z0-9_-]/g, '_'));
    fs.mkdirSync(dossier, { recursive: true });
    const dateValeur = mode(m.unites.map((u) => u.dateValeur));
    const dateValeurAnt = mode(m.unites.map((u) => u.dateValeurAnt));
    const n = Math.max(1, Math.ceil(m.unites.length / PAR_TRANCHE));
    const tranches = Array.from({ length: n }, () => []);
    const groupes = new Map();
    const ajoute = (k, u) => {
      let g = groupes.get(k);
      if (!g) groupes.set(k, (g = { m2: [], hausse: [], valeur: [] }));
      if (u.aireM2) g.m2.push(u.valeur / u.aireM2);
      if (u.valeurAnt) g.hausse.push(u.valeur / u.valeurAnt);
      g.valeur.push(u.valeur);
    };
    for (const u of m.unites) {
      // [num, numSup, suffixe, rue, rueNorm, apt, usage, annee, aireM2, valeur, valeurAnt, dateValeur si ≠ municipale]
      tranches[u.num % n].push([u.num, u.numSup ?? 0, u.suffixe ?? '', u.rue, u.rueNorm, u.apt ?? '', USAGES.indexOf(u.usage),
        u.annee ?? 0, u.aireM2 ?? 0, u.valeur, u.valeurAnt ?? 0, u.dateValeur !== dateValeur ? u.dateValeur : 0]);
      for (const k of groupe(u)) ajoute(k, u);
    }
    tranches.forEach((t, i) => { fs.writeFileSync(path.join(dossier, `${i}.json`), JSON.stringify(t)); fichiers++; });
    const stats = {};
    for (const [k, g] of groupes) {
      if (g.valeur.length < SEUIL_GROUPE) continue;
      stats[k] = {
        n: g.valeur.length,
        m2: g.m2.length >= SEUIL_GROUPE ? quantiles(g.m2) : null,
        hausse: g.hausse.length >= SEUIL_GROUPE ? quantiles(g.hausse) : null,
        valeur: quantiles(g.valeur),
      };
    }
    const ventes = {};
    for (const us of [...USAGES, 'tous']) {
      const r = ratios.get(`${code}|${us}`);
      if (r && r.length >= 20) ventes[us] = { n: r.length, q: quantiles(r), periode };
    }
    fs.writeFileSync(path.join(dossier, 'stats.json'), JSON.stringify({ dateValeur, dateValeurAnt, groupes: stats, ventes }));
    fichiers++;
    // Nom inconnu du répertoire (3 codes au Québec en 2026) : on n'invente pas de nom.
    const nom = !m.nom || m.nom === code ? `Municipalité (code ${code})` : m.nom;
    index.push([code, nom, n, dateValeur, facteurs[code] ?? null, facteurs[code] ? dateFacteur : null]);
  }
  index.sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  fs.writeFileSync(path.join(SORTIE, prov, 'index.json'), JSON.stringify(index));
  const nU = [...munis.values()].reduce((s, m) => s + m.unites.length, 0);
  console.log(`✓ ${prov} : ${nU} unités, ${munis.size} municipalités, ${fichiers + 1} fichiers, ${ratios.size ? 'ventes ' + periode.join('→') : 'sans ventes'}`);
}

const demandees = process.argv.slice(2);
const presentes = fs.readdirSync(UNITES).filter((f) => /^[a-z]{2}\.ndjson\.gz$/.test(f)).map((f) => f.slice(0, 2));
for (const p of demandees.length ? demandees : presentes) await province(p);
