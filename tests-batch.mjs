// Épreuve de sendPulseBatch : la fonction est recopiée telle quelle depuis src/index.js
// (extraction automatique ci-dessous) et exercée contre un fetch simulé. Ce qu'on vérifie :
// alignement des réponses sur les envois, refus partiel, refus total, panne réseau,
// et présence du List-Unsubscribe un clic dans la charge utile.
import { readFileSync } from 'node:fs';

import { homedir } from 'node:os';
const src = readFileSync(`${homedir()}/Desktop/Payotte/payotte-mcp/src/index.js`, 'utf8');
const debut = src.indexOf('async function sendPulseBatch');
const fin = src.indexOf('\n}', src.indexOf('return envois.map((_e, i)', debut)) + 2;
const corpsFn = src.slice(debut, fin);

const RESEND_MIN_GAP_MS = 0;
let lastPulseAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendPulseBatch = new Function('RESEND_MIN_GAP_MS', 'lastPulseAt', 'sleep', 'fetchRef',
  `const fetch = fetchRef; ${corpsFn}; return sendPulseBatch;`
)(RESEND_MIN_GAP_MS, lastPulseAt, sleep, (...a) => globalThis.fetch(...a));

const env = { RESEND_API_KEY: 'test', MAIL_FROM_BULLETIN: 'Payotte <bulletin@payotte.com>' };
const envois = [
  { to: 'a@x.ca', subject: 'S1', html: '<p>1</p>', unsubUrl: 'https://p/u?a=1' },
  { to: 'b@x.ca', subject: 'S2', html: '<p>2</p>', unsubUrl: 'https://p/u?a=2' },
  { to: 'c@x.ca', subject: 'S3', html: '<p>3</p>' },
];
let dernierCorps = null;
const simuler = (reponse) => {
  globalThis.fetch = async (_url, opts) => {
    dernierCorps = JSON.parse(opts.body);
    if (reponse.jette) throw new Error('réseau coupé');
    return {
      ok: reponse.ok, status: reponse.status,
      json: async () => reponse.corps,
    };
  };
};

let echecs = 0;
const verifier = (nom, condition) => {
  console.log(`${condition ? '  ✓' : '  ✗'} ${nom}`);
  if (!condition) echecs++;
};

// 1. Tout accepté
simuler({ ok: true, status: 200, corps: { data: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }] } });
let r = await sendPulseBatch(env, envois);
verifier('3 réponses pour 3 envois', r.length === 3);
verifier('toutes ok', r.every((x) => x.ok));
verifier('List-Unsubscribe un clic présent', dernierCorps[0].headers['List-Unsubscribe'] === '<https://p/u?a=1>'
  && dernierCorps[0].headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
verifier('sans unsubUrl : aucun en-tête forgé', dernierCorps[2].headers === undefined);
verifier('un destinataire par courriel', dernierCorps.every((e, i) => e.to.length === 1 && e.to[0] === envois[i].to));
verifier('reply_to conservé', dernierCorps[0].reply_to === 'gregory@payotte.com');

// 2. Refus partiel : le 2e n'a pas d'id → lui seul doit échouer, aux bons index
simuler({ ok: true, status: 200, corps: { data: [{ id: 'i1' }, {}, { id: 'i3' }] } });
r = await sendPulseBatch(env, envois);
verifier('refus partiel : seul le 2e échoue', r[0].ok && !r[1].ok && r[2].ok);

// 3. Réponse tronquée (moins d'entrées que d'envois)
simuler({ ok: true, status: 200, corps: { data: [{ id: 'i1' }] } });
r = await sendPulseBatch(env, envois);
verifier('réponse tronquée : les manquants comptent comme ratés', r[0].ok && !r[1].ok && !r[2].ok);

// 4. Refus global (4xx) — rien n'est parti
simuler({ ok: false, status: 422, corps: { message: 'invalid' } });
r = await sendPulseBatch(env, envois);
verifier('refus global : aucun ok', r.every((x) => !x.ok && x.status === 422));

// 5. Panne réseau
simuler({ jette: true });
r = await sendPulseBatch(env, envois);
verifier('panne réseau : aucun ok, status 0', r.every((x) => !x.ok && x.status === 0));

// 6. Réponse 200 sans data (erreur silencieuse)
simuler({ ok: true, status: 200, corps: { error: 'oops' } });
r = await sendPulseBatch(env, envois);
verifier('200 sans data : aucun succès supposé', r.every((x) => !x.ok));

// 7. Sans clé API : simulation, aucun envoi réputé réussi
r = await sendPulseBatch({}, envois);
verifier('sans RESEND_API_KEY : simulé, aucun ok', r.every((x) => !x.ok && x.simulated));

// 8. File vide
verifier('file vide : aucun appel', (await sendPulseBatch(env, [])).length === 0);

console.log(echecs ? `\n${echecs} épreuve(s) en échec` : '\nToutes les épreuves passent.');
process.exit(echecs ? 1 : 0);
