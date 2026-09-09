#!/bin/bash
# essai-a-blanc.sh — montre QUI recevrait quoi au prochain cron, sans rien envoyer.
#
# POURQUOI CE SCRIPT EXISTE (8 sept. 2026). `/bulletin-dryrun` exige CONTACTS_TOKEN, qui
# n'existe que comme secret Cloudflare — illisible en local, par conception. Le passer sur
# une ligne de commande le grave dans l'historique du terminal et dans la transcription
# d'une session d'assistant. Il vit donc dans un fichier en 600, comme la clé Anthropic :
#
#     echo 'LE_JETON' > ~/.payotte-contacts-token && chmod 600 ~/.payotte-contacts-token
#
# Puis :  ./essai-a-blanc.sh
#
# `dryRun` bloque TOUS les envois en amont : le rapport est calculé, la file est montée,
# et rien ne part. C'est le seul moyen de voir la liste réelle avant qu'elle parte.
set -euo pipefail
JETON="$HOME/.payotte-contacts-token"
[ -f "$JETON" ] || { echo "✗ $JETON absent. Voir l'en-tête de ce script." >&2; exit 1; }
K=$(tr -d '[:space:]' < "$JETON")
[ -n "$K" ] || { echo "✗ jeton vide." >&2; exit 1; }

R=$(curl -s --get "https://payotte-mcp.payotte.workers.dev/bulletin-dryrun" --data-urlencode "key=$K")

# On n'affiche JAMAIS l'URL ni le jeton — seulement le rapport.
node --input-type=module -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try { j = JSON.parse(s); } catch { console.log("réponse illisible :", s.slice(0,300)); process.exit(1); }
  if (j.error) { console.log("✗", j.error); process.exit(1); }
  // ATTENTION : ce bloc est entre apostrophes simples dans le shell, aucune apostrophe ici.
  // Le champ ne s appelle pas daySoFar mais dayUsedBefore : le script affichait donc 0
  // tous les jours, y compris le 9 septembre ou le compteur KV valait 50.
  console.log("plafond effectif     :", j.capJourEffectif ?? "?", "(global", (j.dayCap ?? "?") + ")");
  console.log("déjà envoyé ce jour  :", j.dayUsedBefore ?? 0);
  console.log("part par passage     :", j.partPassage ?? "?", "×", j.passagesRestants ?? "?", "passage(s)");
  console.log("prospects            :", j.prospects ?? 0);
  console.log("experts              :", JSON.stringify(j.experts ?? {}));
  const r = j.recipients ?? [];
  console.log("destinataires        :", r.length);
  const parType = {};
  for (const x of r) parType[x.kind] = (parType[x.kind] || 0) + 1;
  console.log("par type             :", JSON.stringify(parType));
  console.log("\n— 10 premiers —");
  for (const x of r.slice(0,10)) console.log("  ", x.kind.padEnd(16), x.to);
});' <<< "$R"
