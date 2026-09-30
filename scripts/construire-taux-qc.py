"""Taux résidentiels de taxe foncière 2026 du Québec, par code géographique (30 sept. 2026).

Source : MAMH, Données prévisionnelles non auditées 2026, Simple occurrence (Données Québec, CC BY 4.0)
https://mamh.gouv.qc.ca/fichiersdonneesouvertes/Données-prévisionnelles-non-auditées-2026-SimpleOccurrence.csv
Sous-section S57, colonne « Taux adopté » (CPALB…), en $ par 100 $ d'évaluation.

Taux = taxe foncière générale (résiduelle si taux variés, sinon taux unique)
     + taxes spéciales sur la valeur foncière (dette, fonctionnement, investissement),
       résiduelles si présentes, sinon à taux unique.
Sans la taxe scolaire, ni les tarifs (eau, ordures), qui ne dépendent pas de l'évaluation
ou pas de la municipalité. Montréal : taux de la ville seulement, sans les taxes d'arrondissement.

Usage : python3 scripts/construire-taux-qc.py chemin/SimpleOccurrence.csv > src/data/efTauxQc2026.json
"""
import csv, json, sys
PAIRES = [('CPALB01726', 'CPALB01724'), ('CPALB01738', 'CPALB01736'), ('CPALB01749', 'CPALB01747'), ('CPALB01760', 'CPALB01758')]
def f(x):
    try: v = float(x); return v if v > 0 else None
    except (TypeError, ValueError): return None
out, rejet = {}, []
for r in csv.DictReader(open(sys.argv[1], encoding='utf-8-sig')):
    if r['type_org'] != 'Municipalité locale': continue
    parts = [f(r.get(a)) or f(r.get(b)) for a, b in PAIRES]
    if parts[0] is None: rejet.append(r['nom_organisme']); continue
    t = round(sum(p for p in parts if p), 4)
    if not 0.1 <= t <= 3: rejet.append(f"{r['nom_organisme']} ({t})"); continue
    out[r['cod_geo']] = t
print(json.dumps({'annee': 2026, 'source': 'MAMH, Données prévisionnelles non auditées 2026 (Données Québec, CC BY 4.0)', 'taux': dict(sorted(out.items()))}, ensure_ascii=False, separators=(',', ':')))
print(f'{len(out)} municipalités, {len(rejet)} écartées : {rejet[:15]}', file=sys.stderr)
