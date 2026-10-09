#!/usr/bin/env node
/* stdio.mjs — lance le serveur MCP de Payotte en local, sur stdin/stdout.
   Le serveur de production tourne sur Cloudflare Workers (src/index.js). Ce lanceur
   appelle le même gestionnaire `fetch` sans Cloudflare : une ligne JSON-RPC lue sur
   stdin devient un POST /mcp, et sa réponse sort sur stdout. Aucune liaison KV ni
   clé : les outils qui en dépendent (contacter_expert) restent en mode simulation. */
import readline from 'node:readline';
import worker from './src/index.js';

const env = {};
const ctx = { waitUntil() {}, passThroughOnException() {} };

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (ligne) => {
  if (!ligne.trim()) return;
  try {
    const reponse = await worker.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: ligne,
    }), env, ctx);
    const texte = await reponse.text();
    if (texte.trim()) process.stdout.write(JSON.stringify(JSON.parse(texte)) + '\n');
  } catch (err) {
    let id = null; try { id = JSON.parse(ligne).id ?? null; } catch {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } }) + '\n');
  }
});
