"""Génère data.js (contenu du site) à partir du récapitulatif des exigences et du plan de recette.

Usage : python tools/build-data.py <recapitulatif-exigences-realisees.md> <plan-recette.md>
Le site est public : les liens vers le CRM et les noms de personnes sont retirés.
"""
import html, json, re, sys
from pathlib import Path

recap_path, plan_path = sys.argv[1], sys.argv[2]
L = Path(recap_path).read_text(encoding="utf8").splitlines()
P = Path(plan_path).read_text(encoding="utf8").splitlines()

def strip_private(t):
    t = re.sub(r"https?://\S+", "", t)
    if t.startswith("- Qui :"):
        t = "- Qui : les utilisateurs Mecatherm désignés pour la recette (rôles « 07 - Service » et « Contrats - Gestion »)."
    return t.rstrip(" :")

def inl(t):
    t = html.escape(t, quote=False)
    return re.sub(r"\*\*(.+?)\*\*", lambda m: "<b>" + m.group(1) + "</b>", t)

def plain(t):
    return re.sub(r"\*\*(.+?)\*\*", lambda m: m.group(1), t)

ST = {"Fait": "Fait", "Adapté": "Adapté", "Partiel": "Partiel", "V2": "V2", "En attente": "Attente", "Recette": "Recette"}
title, sub = L[0][2:], L[2]
intro, sections, exs = [], [], []
cur = None
i = 3
while i < len(L):
    l = L[i]
    if l.startswith("## "):
        h = l[3:]
        cur = {"id": "s%d" % (len(sections) + 1), "title": h, "short": re.sub(r"\s*\(EX.*\)", "", h), "html": []}
        sections.append(cur)
        i += 1
        continue
    out = cur["html"] if cur else intro
    if l.startswith("|"):
        rows = []
        while i < len(L) and L[i].startswith("|"):
            c = [x.strip() for x in L[i].strip().strip("|").split("|")]
            if not all(re.fullmatch(r"-+", x) for x in c):
                rows.append(c)
            i += 1
        hdr, body = rows[0], rows[1:]
        isex = hdr[0] == "Exigence"
        si = hdr.index("Statut") if "Statut" in hdr else -1
        ti = hdr.index("Test") if "Test" in hdr else -1
        t = ['<div class="tw"><table><thead><tr>' + "".join("<th>%s</th>" % inl(x) for x in hdr) + "</tr></thead><tbody>"]
        for r in body:
            st = ST.get(r[si], "") if isex and si >= 0 else ""
            attr, cells = "", []
            m = re.match(r"(EX-\d+)\s+(.*)", r[0]) if isex else None
            for k, v in enumerate(r):
                if k == si and st:
                    v = '<span class="st %s">%s</span>' % (st, html.escape(r[si]))
                elif k == 0 and m:
                    v = '<span class="ex">%s</span> %s' % (m.group(1), inl(m.group(2)))
                else:
                    v = inl(v)
                cells.append("<td>%s</td>" % v)
            if m:
                cas = r[ti] if ti >= 0 else ""
                exs.append({"ex": m.group(1), "lib": plain(m.group(2)), "st": st, "cas": [x for x in re.split(r"[ ,;]+", cas) if re.fullmatch(r"[CTDVAP]\d+", x)], "sec": cur["id"] if cur else ""})
                attr = ' data-ex="%s" data-st="%s"' % (m.group(1), st)
            t.append("<tr%s>%s</tr>" % (attr, "".join(cells)))
        out.append("".join(t) + "</tbody></table></div>")
        continue
    if l.startswith("- "):
        items = []
        while i < len(L) and L[i].startswith("- "):
            s = strip_private(L[i])
            if s.strip("- "):
                items.append("<li>%s</li>" % inl(s[2:]))
            i += 1
        out.append("<ul>" + "".join(items) + "</ul>")
        continue
    if re.match(r"^\d+\. ", l):
        items = []
        while i < len(L) and re.match(r"^\d+\. ", L[i]):
            items.append("<li>%s</li>" % inl(re.sub(r"^\d+\. ", "", L[i])))
            i += 1
        out.append("<ol>" + "".join(items) + "</ol>")
        continue
    if l.strip():
        out.append("<p>%s</p>" % inl(strip_private(l)))
    i += 1

for s in sections:
    s["html"] = "\n".join(s["html"])

# cas de test : groupe = titre de section du plan de recette
inv = {}
for e in exs:
    for c in e["cas"]:
        inv.setdefault(c, []).append(e["ex"])
tc, group = [], ""
for l in P:
    if l.startswith("## "):
        group = re.sub(r"^\d+\.\s*", "", l[3:]).strip()
        continue
    m = re.match(r"^\| ([CTDVAP]\d+) \| (.+?) \| (.+?) \|", l)
    if m:
        code, act, att = m.groups()
        t = plain(act)
        short = t if len(t) <= 72 else t[:69].rsplit(" ", 1)[0] + "…"
        tc.append({"c": code, "t": short, "a": plain(act), "r": plain(att), "g": group, "ex": inv.get(code, [])})

data = {"title": title, "sub": plain(sub), "intro": "\n".join(intro), "sections": sections, "exs": exs, "tc": tc}
js = "window.RECETTE_DATA=" + json.dumps(data, ensure_ascii=False).replace("<", "\\u003c") + ";\n"
Path(__file__).resolve().parent.parent.joinpath("data.js").write_text(js, encoding="utf8")
print("data.js :", len(sections), "sections,", len(exs), "exigences,", len(tc), "cas de test")
