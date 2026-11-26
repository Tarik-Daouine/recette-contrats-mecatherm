/* Recette des contrats de services — tableau façon gestion de projet, stocké dans Supabase.
   Journal en ajout seul (table entries) :
   - kind "statut"  : une carte (cas) change de colonne ; la colonne courante = le dernier déplacement ;
   - kind "retour"  : commentaire, anomalie, question ou validation sur un cas et/ou une exigence ;
   - kind "reponse" : réponse Be-Cloud à un retour (parent), avec un état de suivi (admins uniquement). */
(() => {
"use strict";
const D = window.RECETTE_DATA, CFG = window.RECETTE_CONFIG || {};
const $ = id => document.getElementById(id);
const mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

const COLS = [
  ["atester", "À tester", "var(--todo)"],
  ["encours", "En cours", "var(--warn)"],
  ["ok", "Validé", "var(--ok)"],
  ["anomalie", "Anomalie", "var(--bad)"],
  ["corrige", "Corrigé – à retester", "var(--accent)"]
];
const COL = Object.fromEntries(COLS.map(c => [c[0], { lbl: c[1], c: c[2] }]));
const KIND = { ok: "Conforme", anomalie: "Anomalie", question: "Question", remarque: "Commentaire" };
const ETAT = { encours: "Pris en charge", corrige: "Corrigé", rejete: "Non retenu" };
const TC = D.tc, EXS = D.exs;
const EXI = Object.fromEntries(EXS.map(e => [e.ex, e]));

let api, me = null, myName = "", admin = false;
let entries = [], byId = new Map();
let view = "board", q = "", grp = "", onlyOpen = false, openCas = null, jFilter = "", exFilter = "";

/* ---------- utilitaires ---------- */
const fmt = iso => { try { return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }); } catch (e) { return iso; } };
const ago = iso => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "à l'instant"; if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
  if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h"; return fmt(iso);
};
const initials = n => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const hue = n => { let h = 0; for (const ch of n || "") h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 42% 42%)`; };
function avatar(name, cls) { const a = mk("span", "av" + (cls ? " " + cls : ""), initials(name)); a.style.background = hue(name); a.title = name || ""; return a; }
function tag(cls, txt) { return mk("span", "tag " + cls, txt); }
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); }
function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || "";
  if (/row-level security|permission|not allowed|403/i.test(m)) return "Enregistrement refusé : votre compte n'a pas ce droit.";
  if (/fetch|network/i.test(m)) return "Connexion impossible. Vérifiez votre réseau et réessayez ; votre texte est conservé.";
  return "Enregistrement impossible (" + (m || "erreur") + "). Votre texte est conservé.";
}

/* ---------- état dérivé ---------- */
function addLocal(row) {
  if (!row || byId.has(row.id)) return false;
  byId.set(row.id, row); entries.push(row);
  entries.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return true;
}
const colOf = cas => { for (let i = entries.length - 1; i >= 0; i--) { const e = entries[i]; if (e.kind === "statut" && e.cas === cas) return e.col; } return "atester"; };
const retours = () => entries.filter(e => e.kind === "retour");
const repliesOf = id => entries.filter(e => e.kind === "reponse" && e.parent === id);
const etatOf = r => { const rs = repliesOf(r.id).filter(x => x.etat); return rs.length ? rs[rs.length - 1].etat : null; };
const isOpen = r => r.statut === "anomalie" && !["corrige", "rejete"].includes(etatOf(r));
const casItems = cas => entries.filter(e => e.cas === cas && e.kind !== "reponse");
const lastAct = cas => { const es = entries.filter(e => e.cas === cas || (e.kind === "reponse" && byId.get(e.parent) && byId.get(e.parent).cas === cas)); return es[es.length - 1]; };

/* ---------- accès aux données ---------- */
function supabaseApi() {
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const urls = new Map();
  return {
    async session() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
    async signInAnon() { const { data, error } = await sb.auth.signInAnonymously(); if (error) throw error; return data.user; },
    async sendMagicLink(email) { const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split("#")[0], shouldCreateUser: false } }); if (error) throw error; },
    async signOut() { await sb.auth.signOut(); },
    async setProfile(full_name, email) { const { data, error } = await sb.auth.updateUser({ data: { full_name, email } }); if (error) throw error; return data.user; },
    async isAdmin() { const { data } = await sb.rpc("is_admin"); return data === true; },
    async list() {
      const out = []; const step = 1000;
      for (let from = 0; ; from += step) {
        const { data, error } = await sb.from("entries").select("*").order("created_at", { ascending: true }).range(from, from + step - 1);
        if (error) throw error; out.push(...data); if (data.length < step) break;
      }
      return out;
    },
    async insert(row) { const { data, error } = await sb.from("entries").insert(row).select().single(); if (error) throw error; return data; },
    async upload(file) {
      const safe = file.name.normalize("NFD").replace(/[^\w.-]+/g, "_").slice(-60);
      const path = me.id + "/" + Date.now().toString(36) + "-" + safe;
      const { error } = await sb.storage.from("captures").upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error; return path;
    },
    async url(path) {
      if (urls.has(path)) return urls.get(path);
      const { data, error } = await sb.storage.from("captures").createSignedUrl(path, 3600);
      if (error) return null; urls.set(path, data.signedUrl); return data.signedUrl;
    },
    subscribe(onRow, onState) {
      sb.channel("entries").on("postgres_changes", { event: "INSERT", schema: "public", table: "entries" }, p => onRow(p.new))
        .subscribe(s => onState(s === "SUBSCRIBED"));
    }
  };
}
// Mode démonstration (aucune donnée envoyée) : ?demo dans l'adresse, utile pour prévisualiser sans base.
function demoApi() {
  const KEY = "recette-demo-rows"; let rows = []; try { rows = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (e) {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {} };
  const u = { id: "demo-user", email: "demo@exemple.fr", user_metadata: { full_name: store.get("demo-name") || "" } };
  return {
    async session() { return sessionStorage.getItem("demo-in") ? u : null; },
    async signInAnon() { sessionStorage.setItem("demo-in", "1"); return u; },
    async sendMagicLink() { sessionStorage.setItem("demo-in", "1"); },
    async signOut() { sessionStorage.removeItem("demo-in"); },
    async setProfile(n, e) { store.set("demo-name", n); u.user_metadata.full_name = n; u.user_metadata.email = e; return u; },
    async isAdmin() { return /admin/.test(location.search); },
    async list() { return rows.slice(); },
    async insert(r) { const row = { ...r, id: crypto.randomUUID(), created_at: new Date().toISOString(), user_id: u.id, user_email: (u.user_metadata && u.user_metadata.email) || u.email }; rows.push(row); save(); return row; },
    async upload(f) { return URL.createObjectURL(f); },
    async url(p) { return p; },
    subscribe(_, onState) { onState(true); }
  };
}

async function add(row) {
  const r = await api.insert({ ...row, auteur: myName, user_email: myEmail || null });
  if (addLocal(r)) renderAll();
  return r;
}
async function move(cas, col) {
  if (colOf(cas) === col) return true;
  try { await add({ kind: "statut", cas, col }); toast(cas + " → " + COL[col].lbl); return true; }
  catch (e) { toast(errMsg(e)); return false; }
}

/* ---------- avancement ---------- */
function renderProgress() {
  const n = Object.fromEntries(COLS.map(c => [c[0], 0]));
  TC.forEach(t => n[colOf(t.c)]++);
  const P = $("progress"); P.replaceChildren();
  const pct = mk("div", "pct", Math.round(n.ok / TC.length * 100) + " %"); pct.appendChild(mk("small", null, n.ok + " / " + TC.length + " cas validés"));
  const bar = mk("div", "bar"); bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", COLS.map(c => c[1] + " " + n[c[0]]).join(", "));
  for (const [k, , c] of COLS) { if (!n[k]) continue; const i = mk("i"); i.style.width = (n[k] / TC.length * 100) + "%"; i.style.background = c; bar.appendChild(i); }
  const lg = mk("div", "legend");
  for (const [k, l, c] of COLS) { const s = mk("span"); const i = mk("i"); i.style.background = c; s.append(i, l + " " + n[k]); lg.appendChild(s); }
  const open = retours().filter(isOpen).length;
  if (open) { const s = mk("span"); s.appendChild(tag("anomalie", open + " anomalie" + (open > 1 ? "s" : "") + " ouverte" + (open > 1 ? "s" : ""))); lg.appendChild(s); }
  P.append(pct, bar, lg);
}

/* ---------- filtres ---------- */
function visibleTC() {
  const s = q.trim().toLowerCase();
  return TC.filter(t => (!grp || t.g === grp)
    && (!s || (t.c + " " + t.t + " " + t.a + " " + t.r + " " + t.g + " " + t.ex.join(" ")).toLowerCase().includes(s))
    && (!onlyOpen || retours().some(r => r.cas === t.c && isOpen(r))));
}
function cardFoot(t) {
  const f = mk("div", "foot");
  const rs = retours().filter(r => r.cas === t.c);
  if (rs.length) f.appendChild(mk("span", null, "💬 " + rs.length));
  const open = rs.filter(isOpen);
  if (open.length) {
    const g = open.some(r => r.gravite === "bloquante") ? "bloquante" : "anomalie";
    f.appendChild(tag(g, open.length + " anomalie" + (open.length > 1 ? "s" : "") + (g === "bloquante" ? " · bloquante" : "")));
  }
  const ppl = [...new Set(casItems(t.c).map(e => e.auteur))].slice(-3);
  if (ppl.length) { const avs = mk("span", "avs"); ppl.forEach(p => avs.appendChild(avatar(p, "sm"))); f.appendChild(avs); }
  return f;
}

/* ---------- vue tableau ---------- */
let dragCas = null;
function renderBoard() {
  const host = $("board"); host.replaceChildren();
  const list = visibleTC();
  for (const [key, lbl, c] of COLS) {
    const col = mk("section", "col"); col.style.setProperty("--c", c); col.setAttribute("aria-label", lbl);
    const items = list.filter(t => colOf(t.c) === key);
    const h = mk("div", "col-h"); h.append(mk("span", "dot"), mk("span", null, lbl), mk("span", "n", String(items.length)));
    const cards = mk("div", "cards");
    if (!items.length) cards.appendChild(mk("div", "empty", key === "atester" ? "Rien à tester ici" : "Glissez une carte ici"));
    for (const t of items) {
      const b = mk("button", "card"); b.type = "button"; b.draggable = true; b.dataset.cas = t.c;
      const r1 = mk("div", "row"); r1.append(mk("span", "code", t.c), mk("span", "grp", t.g));
      b.append(r1, mk("div", "ttl", t.t));
      if (t.ex.length) { const r2 = mk("div", "row"); t.ex.slice(0, 3).forEach(x => r2.appendChild(tag("exr", x))); if (t.ex.length > 3) r2.appendChild(tag("", "+" + (t.ex.length - 3))); b.appendChild(r2); }
      b.appendChild(cardFoot(t));
      b.addEventListener("click", () => openDrawer(t.c));
      b.addEventListener("dragstart", e => { dragCas = t.c; b.classList.add("dragging"); e.dataTransfer.setData("text/plain", t.c); e.dataTransfer.effectAllowed = "move"; });
      b.addEventListener("dragend", () => { b.classList.remove("dragging"); dragCas = null; });
      cards.appendChild(b);
    }
    col.append(h, cards);
    col.addEventListener("dragover", e => { if (dragCas) { e.preventDefault(); col.classList.add("over"); } });
    col.addEventListener("dragleave", e => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
    col.addEventListener("drop", e => { e.preventDefault(); col.classList.remove("over"); const cas = dragCas || e.dataTransfer.getData("text/plain"); dragCas = null; if (cas) move(cas, key); });
    host.appendChild(col);
  }
}

/* ---------- vue liste ---------- */
const listOpen = {};
function renderList() {
  const host = $("list"); host.replaceChildren();
  const list = visibleTC();
  for (const [key, lbl, c] of COLS) {
    const items = list.filter(t => colOf(t.c) === key);
    const d = mk("details", "lgroup"); d.open = listOpen[key] !== false; d.style.setProperty("--c", c);
    d.addEventListener("toggle", () => { listOpen[key] = d.open; });
    const s = mk("summary"); s.append(mk("span", "dot"), mk("span", null, lbl), mk("span", "n", String(items.length))); d.appendChild(s);
    if (items.length) {
      const tw = mk("div", "ltw"); const tb = mk("table", "ltable");
      tb.innerHTML = "<thead><tr><th>Cas</th><th>Intitulé</th><th>Thème</th><th>Exigences</th><th>Retours</th><th>Dernière activité</th></tr></thead>";
      const body = mk("tbody");
      for (const t of items) {
        const tr = mk("tr", "lrow"); tr.tabIndex = 0;
        const rs = retours().filter(r => r.cas === t.c), open = rs.filter(isOpen).length, la = lastAct(t.c);
        const td = (x, cls) => { const e = mk("td", cls); if (x instanceof Node) e.appendChild(x); else e.textContent = x; return e; };
        const exd = mk("span"); t.ex.forEach(x => exd.append(tag("exr", x), " "));
        const rd = mk("span"); if (rs.length) rd.append(rs.length + " "); if (open) rd.appendChild(tag("anomalie", open + " ouverte" + (open > 1 ? "s" : "")));
        tr.append(td(t.c, "code"), td(t.t), td(t.g), td(exd), td(rd), td(la ? la.auteur + " · " + ago(la.created_at) : "—"));
        tr.addEventListener("click", () => openDrawer(t.c));
        tr.addEventListener("keydown", e => { if (e.key === "Enter") openDrawer(t.c); });
        body.appendChild(tr);
      }
      tb.appendChild(body); tw.appendChild(tb); d.appendChild(tw);
    }
    host.appendChild(d);
  }
}

/* ---------- entrée de retour (journal et panneau) ---------- */
function captureEl(path) {
  const a = mk("a"); a.target = "_blank"; a.rel = "noopener"; const im = mk("img"); im.alt = "Capture jointe"; im.loading = "lazy"; a.appendChild(im);
  api.url(path).then(u => { if (u && /^(https:|blob:)/.test(u)) { a.href = u; im.src = u; } else a.replaceWith(mk("span", "muted", "Capture indisponible")); });
  return a;
}
function entryEl(r, withCtx) {
  const box = mk("article", "entry"); box.appendChild(avatar(r.auteur));
  const b = mk("div", "body");
  const hd = mk("div", "hd"); hd.append(mk("b", null, r.auteur || "Anonyme"), tag(r.statut, KIND[r.statut] || r.statut));
  if (r.statut === "anomalie" && r.gravite) hd.appendChild(tag(r.gravite, r.gravite));
  const et = etatOf(r); if (et) hd.appendChild(tag(et, ETAT[et]));
  const tm = mk("time", null, ago(r.created_at)); tm.dateTime = r.created_at; tm.title = fmt(r.created_at); hd.appendChild(tm);
  b.appendChild(hd);
  if (withCtx) {
    const ctx = mk("div", "ctx");
    if (r.cas) { const a = mk("a", null, "Cas " + r.cas); a.addEventListener("click", () => openDrawer(r.cas)); const t = TC.find(x => x.c === r.cas); ctx.append(a, t ? " · " + t.t : ""); }
    if (r.ex && r.ex !== "GEN") ctx.append((r.cas ? " · " : "") + r.ex + (EXI[r.ex] ? " " + EXI[r.ex].lib : ""));
    if (!r.cas && (!r.ex || r.ex === "GEN")) ctx.append("Général");
    b.appendChild(ctx);
  }
  if (r.commentaire) b.appendChild(mk("div", "txt", r.commentaire));
  if (r.capture) b.appendChild(captureEl(r.capture));
  for (const rep of repliesOf(r.id)) {
    const rp = mk("div", "resp"); const h = mk("div", "hd");
    h.append(mk("b", null, "Be-Cloud · " + (rep.auteur || "")));
    if (rep.etat) h.appendChild(tag(rep.etat, ETAT[rep.etat]));
    const t2 = mk("time", null, ago(rep.created_at)); t2.title = fmt(rep.created_at); h.appendChild(t2);
    rp.appendChild(h); if (rep.commentaire) rp.appendChild(mk("div", "txt", rep.commentaire)); b.appendChild(rp);
  }
  if (admin) {
    const open = mk("button", "linkbtn", "Répondre / changer le suivi"); open.type = "button";
    open.addEventListener("click", () => {
      open.hidden = true;
      const f = mk("div", "reply"); const sel = mk("select");
      [["", "Suivi…"], ["encours", "Pris en charge"], ["corrige", "Corrigé"], ["rejete", "Non retenu"]].forEach(([v, l]) => { const o = mk("option", null, l); o.value = v; sel.appendChild(o); });
      sel.value = et || "";
      const ta = mk("textarea"); ta.placeholder = "Réponse au client"; ta.maxLength = 4000;
      const ok = mk("button", "btn sm", "Envoyer"); ok.type = "button";
      ok.addEventListener("click", async () => {
        if (!sel.value && !ta.value.trim()) { ta.focus(); return; }
        ok.disabled = true;
        try {
          await add({ kind: "reponse", parent: r.id, cas: null, ex: r.ex, etat: sel.value || null, commentaire: ta.value.trim() || null });
          if (sel.value === "corrige" && r.cas && colOf(r.cas) === "anomalie") await move(r.cas, "corrige");
          toast("Réponse enregistrée");
        } catch (e) { toast(errMsg(e)); ok.disabled = false; }
      });
      f.append(sel, ta, ok); b.appendChild(f); ta.focus();
    });
    b.appendChild(open);
  }
  box.appendChild(b);
  return box;
}

/* ---------- panneau d'un cas ---------- */
COLS.forEach(([k, l]) => { const o = mk("option", null, l); o.value = k; $("dCol").appendChild(o); });
function openDrawer(cas) {
  openCas = cas; $("dForm").reset(); $("dGrav").hidden = true; $("dErr").textContent = ""; $("dCapL").textContent = "📎 Joindre une capture";
  fillDrawer(); $("scrim").hidden = false; $("drawer").hidden = false; $("dScroll").scrollTop = 0; $("dCom").focus({ preventScroll: true });
  if (location.hash !== "#cas-" + cas) history.replaceState(null, "", "#cas-" + cas);
}
function closeDrawer() {
  openCas = null; $("drawer").hidden = true; $("scrim").hidden = true;
  history.replaceState(null, "", "#" + ({ board: "tableau", list: "liste", ex: "exigences", journal: "journal" })[view]);
}
function fillDrawer() {
  const t = TC.find(x => x.c === openCas); if (!t) return;
  const col = colOf(t.c);
  $("dCol").value = col; $("drawer").style.setProperty("--c", COL[col].c);
  $("dCode").textContent = t.c; $("dTitle").textContent = t.t; $("dGrp").textContent = t.g;
  $("dAct").textContent = t.a; $("dAtt").textContent = t.r;
  const ex = $("dEx"); ex.replaceChildren();
  if (!t.ex.length) ex.textContent = "—";
  t.ex.forEach(x => { const a = mk("a", "tag exr", x); a.href = "#exigences"; a.title = EXI[x] ? EXI[x].lib : ""; a.addEventListener("click", ev => { ev.preventDefault(); closeDrawer(); gotoEx(x); }); ex.appendChild(a); });
  const la = lastAct(t.c); $("dLast").textContent = la ? la.auteur + " · " + fmt(la.created_at) : "Aucune";
  const f = $("dFeed"); f.replaceChildren();
  const items = casItems(t.c);
  if (!items.length) f.appendChild(mk("div", "ev", "Pas encore d'activité. Testez le cas puis publiez votre résultat ci-dessous."));
  for (const e of items) {
    if (e.kind === "statut") {
      const ev = mk("div", "ev"); ev.style.setProperty("--c", COL[e.col] ? COL[e.col].c : "var(--todo)");
      ev.append(mk("i"), (e.auteur || "Quelqu'un") + " a déplacé la carte vers « " + (COL[e.col] ? COL[e.col].lbl : e.col) + " » · " + ago(e.created_at));
      f.appendChild(ev);
    } else f.appendChild(entryEl(e, false));
  }
}
$("dCol").addEventListener("change", async e => { const ok = await move(openCas, e.target.value); if (!ok) e.target.value = colOf(openCas); });
$("dClose").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("drawer").hidden && !document.querySelector("dialog[open]")) closeDrawer(); });
$("dKind").addEventListener("change", () => { $("dGrav").hidden = (document.querySelector("#dKind input:checked") || {}).value !== "anomalie"; });
$("dCap").addEventListener("change", () => { const f = $("dCap").files[0]; $("dCapL").textContent = f ? "📎 " + f.name : "📎 Joindre une capture"; });
$("dForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const st = (document.querySelector("#dKind input:checked") || {}).value || "remarque", com = $("dCom").value.trim();
  if (!com && st !== "ok") { $("dErr").textContent = "Écrivez un commentaire."; return; }
  const btn = $("dOk"); btn.disabled = true; $("dErr").textContent = "";
  const cas = openCas, t = TC.find(x => x.c === cas), file = $("dCap").files[0];
  try {
    let capture = null;
    if (file) { try { capture = await api.upload(file); } catch (e) { toast("La capture n'a pas pu être jointe."); } }
    await add({ kind: "retour", cas, ex: (t && t.ex[0]) || "GEN", statut: st, gravite: st === "anomalie" ? $("dGrav").value : null, commentaire: com || null, capture });
    if (st === "anomalie" && colOf(cas) !== "anomalie") await move(cas, "anomalie");
    else if (st === "ok" && colOf(cas) !== "ok") await move(cas, "ok");
    else toast("Publié");
    $("dForm").reset(); $("dGrav").hidden = true; $("dCapL").textContent = "📎 Joindre une capture";
    $("dScroll").scrollTop = $("dScroll").scrollHeight;
  } catch (e) { $("dErr").textContent = errMsg(e); }
  finally { btn.disabled = false; }
});

/* ---------- vue exigences ---------- */
const EXF = [["", "Toutes"], ["Fait", "Fait"], ["Adapté", "Adapté"], ["Partiel", "Partiel"], ["V2", "V2"], ["Attente", "En attente"], ["Recette", "À vérifier"], ["retour", "Avec retour"]];
function buildEx() {
  $("docTitle").textContent = D.title; $("docSub").textContent = D.sub;
  $("docIntro").innerHTML = D.intro; // contenu généré par Be-Cloud (échappé à la génération)
  const toc = $("exToc"), body = $("exBody");
  for (const s of D.sections) {
    const a = mk("a", null, s.short); a.href = "#" + s.id; a.addEventListener("click", e => { e.preventDefault(); $(s.id).scrollIntoView({ behavior: "smooth" }); }); toc.appendChild(a);
    const sec = mk("section", "docsec"); sec.id = s.id; sec.appendChild(mk("h2", null, s.title));
    const c = mk("div"); c.innerHTML = s.html; sec.appendChild(c); body.appendChild(sec);
  }
  // synthèse en tuiles
  const syn = body.querySelector("#s1 table");
  if (syn) {
    const rows = [...syn.querySelectorAll("tbody tr")]; const d = mk("div", "stats");
    rows.forEach((r, k) => { const s = mk("div", "stat" + (k === rows.length - 1 ? " hot" : "")); s.append(mk("b", null, r.cells[1].textContent), mk("span", null, r.cells[0].textContent)); d.appendChild(s); });
    syn.closest(".tw").replaceWith(d);
  }
  // colonne retour
  body.querySelectorAll("table").forEach(t => {
    if (!t.querySelector("tr[data-ex]")) return;
    t.querySelector("thead tr").appendChild(mk("th", null, "Retour"));
    t.querySelectorAll("tbody tr").forEach(r => {
      const td = mk("td", "rcell");
      if (r.dataset.ex) { const s = mk("span"); s.dataset.badge = r.dataset.ex; const b = mk("button", "btn sec sm", "Retour"); b.type = "button"; b.addEventListener("click", () => openExDlg(r.dataset.ex)); td.append(s, b); }
      r.appendChild(td);
    });
  });
  const fl = $("exFilters");
  for (const [v, l] of EXF) {
    const b = mk("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", String(v === exFilter));
    b.addEventListener("click", () => { exFilter = v; fl.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); applyExFilter(); });
    fl.appendChild(b);
  }
}
function applyExFilter() {
  const withRet = new Set(retours().map(r => r.ex));
  document.querySelectorAll("#exBody tr[data-ex]").forEach(r => { r.hidden = exFilter === "retour" ? !withRet.has(r.dataset.ex) : !!exFilter && r.dataset.st !== exFilter; });
  document.querySelectorAll("#exBody .docsec").forEach(c => { const rs = c.querySelectorAll("tr[data-ex]"); c.hidden = !!exFilter && (rs.length === 0 || [...rs].every(r => r.hidden)); });
}
function renderExBadges() {
  const rs = retours();
  document.querySelectorAll("[data-badge]").forEach(s => {
    const mine = rs.filter(r => r.ex === s.dataset.badge);
    s.replaceChildren();
    if (!mine.length) return;
    const open = mine.filter(isOpen).length, last = mine[mine.length - 1];
    s.appendChild(open ? tag("anomalie", open + " ouverte" + (open > 1 ? "s" : "")) : tag(etatOf(last) || last.statut, (ETAT[etatOf(last)] || KIND[last.statut]) + (mine.length > 1 ? " · " + mine.length : "")));
  });
  if (exFilter === "retour") applyExFilter();
}
function gotoEx(ex) {
  setView("ex"); exFilter = ""; $("exFilters").querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(i === 0))); applyExFilter();
  const r = document.querySelector('#exBody tr[data-ex="' + ex + '"]');
  if (r) { r.scrollIntoView({ behavior: "smooth", block: "center" }); r.style.transition = "background 1.2s"; r.style.background = "var(--accent-soft)"; setTimeout(() => { r.style.background = ""; }, 1600); }
}

/* ---------- dialogue retour sur exigence ---------- */
{ const o = mk("option", null, "Général (hors exigence)"); o.value = "GEN"; $("xEx").appendChild(o); }
EXS.forEach(x => { const o = mk("option", null, x.ex + " · " + x.lib); o.value = x.ex; $("xEx").appendChild(o); });
function fillCasOptions(ex) {
  const s = $("xCas"); s.replaceChildren(); const o = mk("option", null, "Aucun cas précis"); o.value = ""; s.appendChild(o);
  const list = ex && EXI[ex] && EXI[ex].cas.length ? EXI[ex].cas : TC.map(t => t.c);
  list.forEach(c => { const t = TC.find(x => x.c === c); const op = mk("option", null, c + (t ? " · " + t.t : "")); op.value = c; s.appendChild(op); });
  if (ex && EXI[ex] && EXI[ex].cas.length) s.value = EXI[ex].cas[0];
}
$("xEx").addEventListener("change", () => { fillCasOptions($("xEx").value); $("xLib").textContent = ""; });
function openExDlg(ex) {
  $("xForm").reset(); $("xErr").textContent = ""; $("xEx").value = ex || "GEN"; fillCasOptions(ex);
  $("xTitle").textContent = ex ? "Retour sur " + ex : "Nouveau retour"; $("xLib").textContent = ex && EXI[ex] ? EXI[ex].lib : "";
  $("xGravL").hidden = true; $("exDlg").showModal();
}
$("xKind").addEventListener("change", () => { $("xGravL").hidden = (document.querySelector("#xKind input:checked") || {}).value !== "anomalie"; });
$("xCancel").addEventListener("click", () => $("exDlg").close());
$("xForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const st = (document.querySelector("#xKind input:checked") || {}).value || "remarque", com = $("xCom").value.trim(), cas = $("xCas").value || null;
  if (!com && st !== "ok") { $("xErr").textContent = "Décrivez ce que vous avez constaté."; return; }
  const btn = $("xOk"); btn.disabled = true; $("xErr").textContent = "";
  try {
    let capture = null; const file = $("xCap").files[0];
    if (file) { try { capture = await api.upload(file); } catch (e) { toast("La capture n'a pas pu être jointe."); } }
    await add({ kind: "retour", cas, ex: $("xEx").value, statut: st, gravite: st === "anomalie" ? $("xGrav").value : null, commentaire: com || null, capture });
    if (cas && st === "anomalie" && colOf(cas) !== "anomalie") await move(cas, "anomalie");
    $("exDlg").close(); toast("Retour enregistré");
  } catch (e) { $("xErr").textContent = errMsg(e); }
  finally { btn.disabled = false; }
});

/* ---------- journal ---------- */
const JF = [["", "Tous"], ["ouvert", "Anomalies ouvertes"], ["question", "Questions"], ["ok", "Conformes"], ["traite", "Traités"]];
JF.forEach(([v, l]) => {
  const b = mk("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", String(v === jFilter));
  b.addEventListener("click", () => { jFilter = v; $("jFilters").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); renderJournal(); });
  $("jFilters").appendChild(b);
});
function renderJournal() {
  const R = retours();
  const n = [[R.length, "Retours"], [R.filter(r => r.statut === "ok").length, "Conformes"], [R.filter(isOpen).length, "Anomalies ouvertes"],
    [R.filter(r => r.statut === "question" && !repliesOf(r.id).length).length, "Questions sans réponse"], [R.filter(r => etatOf(r) === "corrige").length, "Corrigés"]];
  const st = $("jStats"); st.replaceChildren();
  n.forEach(([v, l], k) => { const d = mk("div", "stat" + (k === 2 && v ? " hot" : "")); d.append(mk("b", null, String(v)), mk("span", null, l)); st.appendChild(d); });
  let rows = R.slice().reverse();
  const s = q.trim().toLowerCase();
  if (jFilter === "ouvert") rows = rows.filter(isOpen);
  else if (jFilter === "question") rows = rows.filter(r => r.statut === "question");
  else if (jFilter === "ok") rows = rows.filter(r => r.statut === "ok");
  else if (jFilter === "traite") rows = rows.filter(r => etatOf(r));
  if (s) rows = rows.filter(r => [r.cas, r.ex, r.auteur, r.commentaire].join(" ").toLowerCase().includes(s));
  if (grp) rows = rows.filter(r => { const t = TC.find(x => x.c === r.cas); return t && t.g === grp; });
  const L = $("jList"); L.replaceChildren();
  if (!rows.length) L.appendChild(mk("p", "muted", R.length ? "Aucun retour pour ce filtre." : "Aucun retour pour l'instant. Ouvrez une carte du tableau ou utilisez « Nouveau retour »."));
  rows.forEach(r => L.appendChild(entryEl(r, true)));
}
$("jNew").addEventListener("click", () => openExDlg(""));
$("jCsv").addEventListener("click", () => {
  const qv = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [["Date", "Type", "Cas", "Exigence", "Résultat / colonne", "Gravité", "Auteur", "Courriel", "Commentaire", "Suivi Be-Cloud", "Capture"].map(qv).join(";")];
  for (const e of entries) {
    const what = e.kind === "statut" ? "Déplacé vers " + (COL[e.col] ? COL[e.col].lbl : e.col) : e.kind === "reponse" ? "Réponse Be-Cloud" : (KIND[e.statut] || e.statut);
    const parent = e.kind === "reponse" ? byId.get(e.parent) : null;
    lines.push([fmt(e.created_at), e.kind, e.cas || (parent && parent.cas) || "", e.ex || "", what, e.gravite, e.auteur, e.user_email, e.commentaire, e.etat ? ETAT[e.etat] : "", e.capture ? "oui" : ""].map(qv).join(";"));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = mk("a"); a.href = URL.createObjectURL(blob); a.download = "recette-contrats-mecatherm-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
});

/* ---------- navigation ---------- */
const HASH = { tableau: "board", liste: "list", exigences: "ex", journal: "journal" };
function setView(v) {
  view = v;
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-selected", String(a.dataset.v === v)));
  ["board", "list", "ex", "journal"].forEach(k => { $("v-" + k).hidden = k !== v; });
  $("toolbar").hidden = v === "ex";
  store.set("recette-view", v);
  renderView();
}
function renderView() { if (view === "board") renderBoard(); else if (view === "list") renderList(); else if (view === "journal") renderJournal(); else renderExBadges(); }
function renderAll() { renderProgress(); renderView(); if (view !== "ex") renderExBadges(); if (openCas) fillDrawer(); }
function route() {
  const h = location.hash.slice(1);
  if (h.startsWith("cas-")) { const c = h.slice(4); if (TC.some(t => t.c === c)) { if (!HASH[view]) setView("board"); openDrawer(c); return; } }
  if (openCas) { openCas = null; $("drawer").hidden = true; $("scrim").hidden = true; }
  if (HASH[h]) setView(HASH[h]);
}
document.querySelectorAll(".tabs a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); history.replaceState(null, "", a.getAttribute("href")); if (openCas) closeDrawer(); setView(a.dataset.v); }));
window.addEventListener("hashchange", route);
$("q").addEventListener("input", e => { q = e.target.value; renderView(); });
[...new Set(TC.map(t => t.g))].forEach(g => { const o = mk("option", null, g); o.value = g; $("grp").appendChild(o); });
$("grp").addEventListener("change", e => { grp = e.target.value; renderView(); });
$("onlyOpen").addEventListener("change", e => { onlyOpen = e.target.checked; renderView(); });

/* ---------- compte ---------- */
$("meBtn").addEventListener("click", () => { const m = $("meMenu"); m.hidden = !m.hidden; $("meBtn").setAttribute("aria-expanded", String(!m.hidden)); });
document.addEventListener("click", e => { if (!$("meMenu").hidden && !e.target.closest(".me")) { $("meMenu").hidden = true; $("meBtn").setAttribute("aria-expanded", "false"); } });
$("mOut").addEventListener("click", async () => { await api.signOut(); location.hash = ""; location.reload(); });

/* ---------- démarrage ---------- */
let myEmail = "";
function showGate(which) { $("gate").hidden = false; $("app").hidden = true; $("clientForm").hidden = which !== "client"; $("adminForm").hidden = which !== "admin"; ($(which === "admin" ? "aEmail" : "cName")).focus(); }
const validMail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
$("toAdmin").addEventListener("click", () => { $("aErr").textContent = ""; $("aMsg").hidden = true; showGate("admin"); });
$("toClient").addEventListener("click", () => { $("cErr").textContent = ""; showGate("client"); });
$("clientForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("cName").value.trim(), email = $("cEmail").value.trim();
  if (name.length < 3) { $("cErr").textContent = "Indiquez votre prénom et votre nom."; return; }
  if (!validMail(email)) { $("cErr").textContent = "Indiquez une adresse e-mail valide."; return; }
  $("cBtn").disabled = true; $("cErr").textContent = "";
  try {
    let u = await api.session().catch(() => null);
    if (!u) u = await api.signInAnon();
    u = await api.setProfile(name, email);
    store.set("recette-nom", name);
    await start(u);
  } catch (err) { $("cErr").textContent = "Connexion impossible pour l'instant. Réessayez."; $("cBtn").disabled = false; }
});
$("adminForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("aEmail").value.trim();
  if (!validMail(email)) { $("aErr").textContent = "Indiquez votre e-mail."; return; }
  $("aBtn").disabled = true; $("aErr").textContent = "";
  try { await api.sendMagicLink(email); $("aMsg").hidden = false; $("aMsg").textContent = "Lien envoyé. Ouvrez l'e-mail reçu pour vous connecter (pensez aux indésirables)."; }
  catch (err) { $("aErr").textContent = "Envoi impossible pour l'instant. Réessayez dans un moment."; }
  finally { $("aBtn").disabled = false; }
});

async function start(user) {
  me = user;
  const md = user.user_metadata || {};
  myName = (md.full_name || "").trim();
  if (!myName && user.email) myName = user.email.split("@")[0];
  myEmail = (md.email || user.email || "").trim();
  if (!myName) { showGate("client"); return; }
  $("gate").hidden = true; $("app").hidden = false;
  $("meAv").textContent = initials(myName); $("meAv").style.background = hue(myName);
  $("meName").textContent = myName; $("meMail").textContent = myEmail;
  admin = await api.isAdmin().catch(() => false);
  $("meRole").textContent = admin ? "Administrateur Be-Cloud" : "Testeur";
  try { (await api.list()).forEach(addLocal); }
  catch (e) { toast("Les retours n'ont pas pu être chargés. Rechargez la page."); }
  api.subscribe(row => { if (addLocal(row)) renderAll(); }, on => $("live").classList.toggle("on", on));
  const saved = store.get("recette-view");
  setView(saved && ["board", "list", "ex", "journal"].includes(saved) ? saved : "board");
  renderAll();
  route();
}

buildEx();
(async () => {
  const demo = /[?&]demo\b/.test(location.search);
  if (demo) api = demoApi();
  else if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) api = supabaseApi();
  else { showGate("client"); $("cErr").textContent = "Le site est en cours de mise en service : l'accès sera ouvert très prochainement."; $("cBtn").disabled = true; return; }
  const u = await api.session().catch(() => null);
  if (u && ((u.user_metadata && u.user_metadata.full_name) || u.email)) start(u); else showGate("client");
})();
})();
