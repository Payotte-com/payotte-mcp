# payotte-mcp

Serveur **MCP** (Model Context Protocol) de Payotte — le premier annuaire immobilier canadien
de professionnels **vérifiés** branché dans les IA.

- **Hébergement** : Cloudflare Workers, palier gratuit (100 000 requêtes/jour).
- **Zéro état, zéro maintenance** : le worker lit en direct les feeds statiques de payotte.com
  (`/api/experts.json`, `/api/regulators.json`, `/api/market.json`), régénérés à chaque
  déploiement normal du site. Rien à mettre à jour ici quand les fiches changent.
- **Transport** : Streamable HTTP sans état (POST JSON-RPC sur `/mcp`). Aucune dépendance.

## Les 3 outils

| Outil | Ce qu'il fait |
|---|---|
| `trouver_expert` | L'expert vérifié Payotte pour une ville/secteur × métier (score /100, n° de permis + lien registre, URL de la fiche). FR/EN. |
| `verifier_titre` | Qui régule ce métier dans cette province, et où vérifier le permis (matrice du pilier licence). |
| `stats_marche` | Chiffres du marché par ville (prix repère/médian, variation annuelle, ventes, inventaire, DOM). |

Chaque réponse porte l'attribution **CC BY 4.0** (citer + lier payotte.com).

## Prérequis (une fois, ~10 min)

1. **Compte Cloudflare gratuit** : https://dash.cloudflare.com/sign-up (obligatoire pour déployer).
2. **Compte GitHub gratuit** (recommandé, pour lister le serveur dans les registres MCP → backlinks).

## Déployer

```bash
cd ~/Desktop/payotte-mcp
npm install                 # une fois
npx wrangler login          # ouvre le navigateur, se connecter au compte Cloudflare
npm run deploy              # → https://payotte-mcp.<sous-domaine>.workers.dev
```

⚠️ **Déployer d'abord le site payotte.com** (build du 23 juillet ou plus récent) : les feeds
`/api/regulators.json` et `/api/market.json` dont dépendent `verifier_titre` et `stats_marche`
sont dans ce build. (`/api/experts.json` est déjà en ligne.)

L'URL MCP à donner aux clients (Claude, etc.) : `https://payotte-mcp.<sous-domaine>.workers.dev/mcp`

## Tester en local (sans compte)

```bash
npm run dev                 # http://localhost:8787
curl -s localhost:8787/     # carte de visite du serveur
curl -s localhost:8787/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"trouver_expert","arguments":{"profession":"courtier immobilier","ville":"Montréal"}}}'
```

## Brancher dans Claude

- **Claude Code** : `claude mcp add --transport http payotte https://payotte-mcp.<sous-domaine>.workers.dev/mcp`
- **claude.ai** (Connecteurs) : Paramètres → Connecteurs → Ajouter un connecteur personnalisé → coller l'URL `/mcp`.

## Après le déploiement (l'antenne)

1. Lister le serveur dans le **registre MCP officiel** (via GitHub) + annuaires communautaires
   → backlinks tech + découvrabilité par les agents.
2. Angle RP : « premier annuaire immobilier canadien branché dans les IA ».
