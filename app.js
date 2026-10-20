'use strict';

const PAGE_W = 794, M = 96;
const MARKS = { edit: '#1a56db', remove: '#c81e1e', fix: '#8a6d00' };
const FIX_BG = { red: 1, green: .882, blue: .478 };
const ZOOMS = [.5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPE_DOCS = SCOPE + ' https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.metadata.readonly';
const GDOC = 'application/vnd.google-apps.document';
const PUSH_EVERY = 120000;
const DOCS_EVERY = 5 * 60000;
const PULL_FOR = 10 * 60000; // how long the "up to date with Google" tick stands without a new check
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DATA_NAME = 'Io data.json.gz';
const dataName = b => b.id === 'main' ? DATA_NAME : `Io data ${b.id}.json.gz`;
const CLIENT_ID = '257581565054-a3i5pvi1akkcq2s9i7rt4jp140pdh7rm.apps.googleusercontent.com';

const $ = s => document.querySelector(s);
const el = {
  stage: $('#stage'), scroller: $('#scroller'), shell: $('.shell'),
  toc: $('#toc'), fixes: $('#fixes'), fixCount: $('#fixCount'), tabs: $('#tabs'),
  title: $('#title'), tools: $('#tools'), menu: $('#menu'),
  stEdited: $('#stEdited'), stWords: $('#stWords'), stPage: $('#stPage'),
  zoomVal: $('#zoomVal'), banner: $('#banner'),
};

const pref = {
  get(k, d) { try { const v = localStorage.getItem('io.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('io.' + k, JSON.stringify(v)); } catch {} },
};

const idb = new Promise((res, rej) => {
  const r = indexedDB.open('io', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function dbGet(k) {
  const d = await idb;
  return new Promise((res, rej) => {
    const q = d.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function dbPut(entries) {
  const d = await idb;
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    const s = tx.objectStore('kv');
    for (const [k, v] of entries) v === undefined ? s.delete(k) : s.put(v, k);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

const uid = () => Math.random().toString(36).slice(2, 10);
// Marks the Drive data files this device wrote, so it never mistakes its own upload for another device's.
const DEVICE = pref.get('device', '') || (d => (pref.set('device', d), d))(uid());
const timers = {};
function later(name, ms, fn) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(fn, ms);
}
const idle = fn => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 1));

let book, zoom = 1, layoutInfo = { heads: [], k: 1 };
const editors = {};
const dirty = new Set();

function newBook() {
  const ms = uid();
  return {
    id: uid(),
    title: 'Untitled book',
    active: ms,
    tabs: [
      { id: ms, name: 'Manuscript', kind: 'ms', updatedAt: 0, syncedAt: 0, fixes: 0 },
      { id: uid(), name: 'Characters', kind: 'notes', updatedAt: 0, syncedAt: 0, fixes: 0 },
      { id: uid(), name: 'Timeline', kind: 'notes', updatedAt: 0, syncedAt: 0, fixes: 0 },
    ],
  };
}
const starter = t => t.kind === 'ms' ? '<h1>Chapter One</h1><p><br></p>' : `<h1>${esc(t.name)}</h1><p><br></p>`;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tabById = id => book.tabs.find(t => t.id === id);
const curTab = () => tabById(book.active);
const curEd = () => editors[book.active];
const bookKey = (id = book.id) => 'book:' + id;

function serialize(ed) {
  return ed.innerHTML.replace(/ style="[^"]*"/g, '');
}

function saveBook() {
  later('book', 300, () => dbPut([[bookKey(), book]]));
}

async function flush() {
  clearTimeout(timers.save);
  if (!dirty.size) return;
  const entries = [];
  for (const id of dirty) {
    const ed = editors[id];
    if (!ed) continue;
    const html = serialize(ed);
    const t = tabById(id);
    if (t) t.fixes = (html.match(/color="#8a6d00"/gi) || []).length;
    entries.push(['tab:' + id, html]);
  }
  dirty.clear();
  entries.push([bookKey(), book]);
  await dbPut(entries);
  renderTabs();
  renderStatus();
}

async function openTab(id) {
  if (book.active !== id) await flush();
  book.active = id;
  let ed = editors[id];
  if (!ed) {
    const t = tabById(id);
    ed = document.createElement('div');
    ed.className = 'editor' + (t.kind === 'ms' ? ' ms' : '');
    ed.contentEditable = String(!book.viewOnly);
    ed.spellcheck = pref.get('spell', false) && !reading();
    ed.setAttribute('role', 'textbox');
    ed.setAttribute('aria-multiline', 'true');
    ed.setAttribute('aria-label', t.name);
    ed.innerHTML = (await dbGet('tab:' + id)) || starter(t);
    ed.addEventListener('input', onInput);
    ed.addEventListener('paste', onPaste);
    ed.addEventListener('beforeinput', e => { if (reading() && !e.inputType.startsWith('history')) e.preventDefault(); });
    if (reading()) ed.inputMode = 'none';
    ed.addEventListener('keydown', onKey);
    editors[id] = ed;
    el.stage.append(ed);
  }
  for (const k in editors) editors[k].hidden = k !== id;
  el.scroller.scrollTop = pref.get('scroll.' + id, 0);
  saveBook();
  renderTabs();
  layout();
  meta();
  renderStatus();
}

function onInput() {
  const ed = curEd(), t = curTab();
  normalise(ed);
  t.updatedAt = Date.now();
  typed = true;
  if (t.rev && t.rev === t.baseRev) addPast(t, t.rev);
  t.rev = uid();
  dirty.add(t.id);
  later('save', 800, flush);
  later('layout', 250, () => idle(layout));
  later('meta', 1500, () => idle(meta));
  renderEdited();
  renderSync();
}

function normalise(ed) {
  if (!ed.firstElementChild) {
    ed.innerHTML = '<p><br></p>';
    const r = document.createRange();
    r.setStart(ed.firstChild, 0);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return;
  }
  const n = getSelection().anchorNode;
  if (n && n.parentNode === ed && n.nodeType === 3) document.execCommand('formatBlock', false, 'p');
}

function onPaste(e) {
  e.preventDefault();
  if (reading()) return;
  pastePlain(e.clipboardData.getData('text/plain'));
}

function pastePlain(text) {
  if (!text) return;
  const parts = text.replace(/\r\n?/g, '\n').split(/\n/);
  if (parts.length === 1) return void document.execCommand('insertText', false, text);
  const html = parts.map(p => `<p>${esc(p) || '<br>'}</p>`).join('');
  document.execCommand('insertHTML', false, html);
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (reading() && !mod && !e.altKey && (e.key === ' ' || e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault();
    const s = el.scroller, up = e.key === 'PageUp' || e.shiftKey;
    return void s.scrollBy({ top: (up ? -1 : 1) * (s.clientHeight - 3 * parseFloat(getComputedStyle(curEd()).lineHeight)), behavior: 'smooth' });
  }
  const fk = { F1: 'red', F2: 'green', F3: 'blue' }[e.key];
  if (fk && !mod && !e.altKey && !e.shiftKey) { e.preventDefault(); return void run(fk); }
  if (!mod) return;
  let c = null;
  if (e.altKey && !e.shiftKey && e.code === 'Digit1') c = 'heading';
  else if (e.altKey && !e.shiftKey && e.code === 'Digit0') c = 'body';
  else if (e.shiftKey && !e.altKey && e.code === 'KeyE') c = 'edit';
  else if (e.shiftKey && !e.altKey && e.code === 'KeyX') c = 'remove';
  else if (e.shiftKey && !e.altKey && e.code === 'KeyF') c = 'fix';
  else if (!e.shiftKey && !e.altKey && e.key === '\\') c = 'clear';
  if (c) { e.preventDefault(); run(c); }
}

let lastRange = null;
function keepRange() {
  const sel = getSelection(), ed = curEd();
  if (sel.rangeCount && ed && ed.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
}

function selectWordAt(sel) {
  const n = sel.anchorNode, o = sel.anchorOffset;
  const f = markFont(sel);
  const r = document.createRange();
  if (f) r.selectNodeContents(f);
  else {
    if (!n || n.nodeType !== 3) return false;
    const t = n.data, w = /[\p{L}\p{N}'’-]/u;
    let a = o, b = o;
    while (a > 0 && w.test(t[a - 1])) a--;
    while (b < t.length && w.test(t[b])) b++;
    if (a === b) return false;
    r.setStart(n, a);
    r.setEnd(n, b);
  }
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

function run(c, v) {
  const ed = curEd();
  if (!ed || reading() && !(c in MARKS || c === 'clear')) return;
  const sel = getSelection();
  if (!sel.rangeCount || !ed.contains(sel.anchorNode)) {
    ed.focus();
    if (lastRange && ed.contains(lastRange.startContainer)) { sel.removeAllRanges(); sel.addRange(lastRange); }
  }
  switch (c) {
    case 'bold': case 'italic': case 'underline':
      document.execCommand(c); break;
    case 'heading':
      document.execCommand('formatBlock', false, 'h1'); break;
    case 'body':
      document.execCommand('formatBlock', false, 'p'); break;
    case 'chapter':
      document.execCommand('formatBlock', false, blockAt(sel)?.nodeName === 'H1' ? 'p' : 'h1'); break;
    case 'edit': case 'remove': case 'fix':
      if (sel.isCollapsed && !selectWordAt(sel)) return;
      if (markAt(sel) === c) clearMarks();
      else document.execCommand('foreColor', false, MARKS[c]);
      break;
    case 'red': case 'green': case 'blue':
      v = inkAt(sel) === COLORS[c] ? '' : COLORS[c];
    // falls through
    case 'color':
      document.execCommand('foreColor', false, v || INK);
      if (!v) unwrapInk(ed);
      break;
    case 'clear':
      clearMarks(); break;
  }
  updateTools();
  renderSelPop();
}

function blockAt(sel) {
  let n = sel.anchorNode;
  const ed = curEd();
  while (n && n.parentNode !== ed) n = n.parentNode;
  return n;
}

function markOf(font) {
  const col = (font.getAttribute('color') || '').toLowerCase();
  for (const k in MARKS) if (MARKS[k] === col) return k;
  return null;
}

function markFont(sel) {
  let n = sel.anchorNode;
  const ed = curEd();
  while (n && n !== ed) {
    if (n.nodeName === 'FONT' && markOf(n)) return n;
    n = n.parentNode;
  }
  return null;
}
const markAt = sel => { const f = markFont(sel); return f && markOf(f); };

const INK = '#1f1f1f';
const COLORS = { red: '#a4262c', green: '#1e6b34', blue: '#1e3a8a' };
const inkOf = font => {
  const c = (font.getAttribute('color') || '').toLowerCase();
  return /^#[0-9a-f]{6}$/.test(c) && c !== INK && !markOf(font) ? c : null;
};
function inkAt(sel) {
  for (let n = sel.anchorNode, ed = curEd(); n && n !== ed; n = n.parentNode) if (n.nodeName === 'FONT' && inkOf(n)) return inkOf(n);
  return null;
}
function unwrapInk(ed) {
  for (const f of ed.querySelectorAll('font')) if (!markOf(f) && !inkOf(f)) f.replaceWith(...f.childNodes);
}

function clearMarks() {
  const ed = curEd(), sel = getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const hit = [...ed.querySelectorAll('font')].filter(f => r.intersectsNode(f));
  if (!hit.length) return;
  const x = document.createRange();
  x.setStartBefore(hit[0]);
  x.setEndAfter(hit[hit.length - 1]);
  sel.removeAllRanges();
  sel.addRange(x);
  document.execCommand('foreColor', false, INK);
  unwrapInk(ed);
}

function updateTools() {
  const ed = curEd(), sel = getSelection();
  if (!ed || !sel.rangeCount || !ed.contains(sel.anchorNode)) return;
  const h = blockAt(sel)?.nodeName === 'H1';
  const m = markAt(sel), ink = inkAt(sel);
  const on = {
    heading: h, body: !h, chapter: h,
    red: ink === COLORS.red, green: ink === COLORS.green, blue: ink === COLORS.blue,
    bold: document.queryCommandState('bold'),
    italic: document.queryCommandState('italic'),
    underline: document.queryCommandState('underline'),
    edit: m === 'edit', remove: m === 'remove', fix: m === 'fix',
  };
  for (const b of document.querySelectorAll('#tools [data-cmd], #selPop [data-cmd]')) {
    if (b.dataset.cmd in on) b.setAttribute('aria-pressed', on[b.dataset.cmd] ? 'true' : 'false');
  }
}

// Cut, Copy, Paste and Select all for the phone menu (the system bar is suppressed).
async function clip(c) {
  const ed = curEd(), sel = getSelection();
  if (!ed) return;
  if (!sel.rangeCount || !ed.contains(sel.anchorNode)) {
    ed.focus();
    if (lastRange && ed.contains(lastRange.startContainer)) { sel.removeAllRanges(); sel.addRange(lastRange); }
  }
  if (c === 'all') { sel.selectAllChildren(ed); return; }
  if (c === 'copy' || c === 'cut' && !reading()) {
    const text = sel.toString();
    if (!document.execCommand(c)) {
      try { await navigator.clipboard.writeText(text); } catch { return void toast('Could not copy.'); }
      if (c === 'cut') document.execCommand('delete');
    }
    $('#selPop').hidden = true;
    return;
  }
  if (c === 'paste' && !reading()) {
    const r = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    let text;
    try { text = await navigator.clipboard.readText(); } catch { return void toast('Paste was blocked. Allow clipboard access for Io.'); }
    ed.focus();
    if (r) { sel.removeAllRanges(); sel.addRange(r); }
    pastePlain(text);
  }
}

// Touch only: Io's own menu for a selection, in place of the phone's Cut / Copy / Paste bar.
// In reading mode a caret (no selection) shows the menu only after a double tap or long press.
let touchy = false, wordTap = false;
function renderSelPop() {
  const p = $('#selPop'), sel = getSelection(), ed = curEd();
  const on = touchy && ed && sel.rangeCount && ed.contains(sel.anchorNode) && (!sel.isCollapsed || (reading() && wordTap)) && !document.querySelector('dialog[open]');
  const rects = on ? sel.getRangeAt(0).getClientRects() : [];
  const vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  const first = rects[0], last = rects[rects.length - 1];
  if (!first || last.bottom < vv.offsetTop || first.top > vv.offsetTop + vv.height) { p.hidden = true; return; }
  p.classList.toggle('marks-only', reading());
  p.hidden = false;
  const w = p.offsetWidth, h = p.offsetHeight, gap = 30;
  let top = last.bottom + gap;
  if (top + h > vv.offsetTop + vv.height - 8) top = Math.max(vv.offsetTop + 8, first.top - h - gap);
  p.style.left = Math.max(vv.offsetLeft + 8, Math.min(first.left, vv.offsetLeft + vv.width - w - 8)) + 'px';
  p.style.top = top + 'px';
}

function showPop(p, anchor) {
  hidePops();
  p.hidden = false;
  const r = anchor.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  p.style.top = (r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
}
function hidePops() { for (const p of document.querySelectorAll('.pop-menu')) p.hidden = true; }
const phone = () => matchMedia('(max-width: 600px)').matches;

function layout() {
  const ed = curEd();
  if (!ed || ed.hidden) return;
  const er = ed.getBoundingClientRect();
  const k = er.width / PAGE_W;
  if (!k) return;
  const heads = [];
  for (const b of ed.children) {
    if (b.nodeName === 'H1') heads.push({ el: b, y: (b.getBoundingClientRect().top - er.top) / k, text: b.textContent.trim() || 'Untitled' });
  }
  layoutInfo = { heads, k };
  renderToc();
  onScroll();
}

let tocKey = '';
function renderToc() {
  const { heads } = layoutInfo;
  const key = heads.map(h => h.text).join('\u0002');
  if (key === tocKey) return;
  tocKey = key;
  const f = document.createDocumentFragment();
  heads.forEach((h, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = i;
    b.innerHTML = '<span class="t"></span>';
    b.firstChild.textContent = h.text;
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'ch-sel';
    all.dataset.i = i;
    all.textContent = 'Select';
    all.title = 'Select the whole chapter';
    li.append(b, all);
    f.append(li);
  });
  if (!heads.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Use Chapter style for headings and they appear here.';
    f.append(li);
  }
  el.toc.replaceChildren(f);
  activeHead = -1;
}

let activeHead = -1, scrollQueued = false;
function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const { heads, k } = layoutInfo;
    const ed = curEd();
    if (!ed) return;
    const sr = el.scroller.getBoundingClientRect();
    const y = (sr.top - ed.getBoundingClientRect().top + sr.height / 3) / (k || 1);
    let lo = 0, hi = heads.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (heads[mid].y <= y) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx !== activeHead) {
      el.toc.children[activeHead]?.classList.remove('on');
      el.toc.children[idx]?.classList.add('on');
      el.toc.children[idx]?.scrollIntoView({ block: 'nearest' });
      activeHead = idx;
    }
    const ch = curTab().kind === 'ms' && idx >= 0 ? `Chapter ${idx + 1} of ${heads.length}` : '';
    const s = el.scroller, pct = Math.round(100 * s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight));
    el.stPage.textContent = reading() ? [ch, pct + '%'].filter(Boolean).join(' · ') : ch;
    later('scrollpos', 400, () => pref.set('scroll.' + book.active, el.scroller.scrollTop));
  });
}

let totalWords = 0;
const countWords = t => (t.match(/[^\s—–-]+/g) || []).length;
function renderWords() {
  const ed = curEd(), sel = getSelection(), fmt = n => n.toLocaleString('en-GB');
  const picked = ed && sel.rangeCount && !sel.isCollapsed && ed.contains(sel.anchorNode) ? countWords(sel.toString()) : 0;
  el.stWords.textContent = picked ? `${fmt(picked)} of ${fmt(totalWords)} words` : fmt(totalWords) + (totalWords === 1 ? ' word' : ' words');
}

function meta() {
  const ed = curEd(), t = curTab();
  if (!ed) return;
  let words = 0;
  for (const b of ed.children) words += ((b.querySelector('br') ? b.innerText : b.textContent).match(/[^\s—–-]+/g) || []).length;
  totalWords = words;
  renderWords();
  const fixes = [...ed.querySelectorAll('font')].filter(f => markOf(f) === 'fix');
  t.fixes = fixes.length;
  el.fixCount.textContent = fixes.length;
  const f = document.createDocumentFragment();
  fixes.forEach((n, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = i;
    b.innerHTML = '<span class="t"></span>';
    b.firstChild.textContent = n.textContent.trim().slice(0, 80) || '(empty)';
    li.append(b);
    f.append(li);
  });
  if (!fixes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing tagged. Select text and press Fix this!';
    f.append(li);
  }
  el.fixes.replaceChildren(f);
  fixNodes = fixes;
  renderTabs();
}
let fixNodes = [], fixIdx = -1;

function goTo(node, select, center) {
  const b = node.getBoundingClientRect(), sr = el.scroller.getBoundingClientRect();
  el.scroller.scrollTop += b.top - sr.top - (center ? (sr.height - b.height) / 2 : (M + 16) * layoutInfo.k);
  const ed = curEd();
  ed.focus({ preventScroll: true });
  const r = document.createRange();
  if (select) r.selectNodeContents(node);
  else { r.setStart(node, 0); r.collapse(true); }
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function selectChapter(i) {
  const { heads } = layoutInfo, ed = curEd();
  goTo(heads[i].el, false);
  const next = heads[i + 1]?.el;
  const r = document.createRange();
  r.setStartBefore(heads[i].el);
  if (next) r.setEndBefore(next); else r.setEndAfter(ed.lastChild);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

const reading = () => document.documentElement.classList.contains('reading');
const READ_THEME = { light: '#fbfaf7', sepia: '#f4ecd8', dark: '#111110' };

// Keeps the paragraph at the top of the screen in place while the text reflows.
function keepPlace(change) {
  const ed = curEd(), s = el.scroller, top = s.getBoundingClientRect().top;
  const kids = ed ? ed.children : [];
  let lo = 0, hi = kids.length - 1, a = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (kids[mid].getBoundingClientRect().bottom > top) { a = kids[mid]; hi = mid - 1; } else lo = mid + 1; }
  const off = a ? a.getBoundingClientRect().top - top : 0;
  change();
  if (a) s.scrollTop += a.getBoundingClientRect().top - top - off;
  layout();
}

// A view-only book is always in reading mode; that does not change the device's reading pref.
function setReading(on) {
  if (book.viewOnly) on = true;
  keepPlace(() => {
    document.documentElement.classList.toggle('reading', on);
    el.title.readOnly = on || !!book.viewOnly;
    for (const ed of Object.values(editors)) {
      if (on) ed.inputMode = 'none'; else ed.removeAttribute('inputmode');
      ed.spellcheck = !on && pref.get('spell', false);
    }
    el.shell.classList.toggle('nav-hidden', on || pref.get('navHidden', false));
    el.shell.classList.remove('nav-open');
    setReadTheme(pref.get('readTheme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  });
  if (!book.viewOnly) pref.set('reading', on);
  $('#colorPop').hidden = true;
  $('#readPop').hidden = true;
  renderSelPop();
}

function setReadTheme(t) {
  document.documentElement.dataset.read = t;
  for (const b of document.querySelectorAll('[data-read]')) if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', b.dataset.read === t);
  $('meta[name="theme-color"]').content = reading() ? READ_THEME[t] : '#f3f2f1';
}

function setReadSize(step) {
  const now = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--read-size')) || 19;
  const px = Math.min(32, Math.max(14, now + step * 2));
  keepPlace(() => document.documentElement.style.setProperty('--read-size', px + 'px'));
  pref.set('readSize', px);
}

function setSpell(on) {
  pref.set('spell', on);
  for (const ed of Object.values(editors)) ed.spellcheck = on && !reading();
  $('#spellBtn').setAttribute('aria-pressed', on);
  $('#mSpell').setAttribute('aria-pressed', on);
}

function flash(n) {
  n.classList.add('flash');
  setTimeout(() => { n.classList.remove('flash'); if (!n.className) n.removeAttribute('class'); }, 900);
}

function renderTabs() {
  const f = document.createDocumentFragment();
  for (const t of book.tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', t.id === book.active);
    b.dataset.id = t.id;
    b.title = t.updatedAt ? 'Last edited ' + when(t.updatedAt) : t.name;
    const name = document.createElement('span');
    name.textContent = t.name;
    b.append(name);
    if (t.fixes) {
      const s = document.createElement('span');
      s.className = 'badge';
      s.textContent = t.fixes;
      s.title = t.fixes + ' Fix this! tags';
      b.append(s);
    }
    if (t.id === book.active) {
      const x = document.createElement('span');
      x.className = 'x';
      x.dataset.menu = t.id;
      x.textContent = '▾';
      x.title = 'Rename or delete this sheet';
      b.append(x);
    }
    f.append(b);
  }
  el.tabs.replaceChildren(f);
}

function when(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'today ' + time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'yesterday ' + time;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + time;
}

function renderEdited() {
  const t = curTab();
  el.stEdited.textContent = t.updatedAt ? 'Last edited ' + when(t.updatedAt) : 'Not edited yet';
}

function renderStatus() {
  renderEdited();
  renderSync();
}

setInterval(renderStatus, 60000);

function setZoom(z, keep = true, save = true) {
  const s = el.scroller;
  const ratio = keep && s.scrollHeight ? (s.scrollTop + s.clientHeight / 2) / s.scrollHeight : 0;
  zoom = Math.min(2, Math.max(.3, Math.round(z * 100) / 100));
  document.documentElement.style.setProperty('--zoom', zoom);
  el.zoomVal.textContent = Math.round(zoom * 100) + '%';
  if (save) pref.set('zoom', zoom);
  if (keep) s.scrollTop = ratio * s.scrollHeight - s.clientHeight / 2;
  later('layout', 150, layout);
}
function stepZoom(dir) {
  const i = ZOOMS.findIndex(z => z >= zoom - .001);
  const next = dir > 0 ? ZOOMS.find(z => z > zoom + .001) : [...ZOOMS].reverse().find(z => z < zoom - .001);
  setZoom(next ?? ZOOMS[i] ?? zoom);
}
function fitZoom() {
  const w = el.scroller.clientWidth - 32;
  return w < PAGE_W ? Math.max(.3, w / PAGE_W) : 1;
}
function startZoom() {
  const z = pref.get('zoom', null), fit = fitZoom();
  return z === null ? fit : fit < 1 ? Math.min(z, fit) : z;
}


function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function backupData() {
  await flush();
  const tabs = {};
  for (const t of book.tabs) tabs[t.id] = editors[t.id] ? serialize(editors[t.id]) : (await dbGet('tab:' + t.id)) || '';
  return JSON.stringify({ io: 1, savedAt: Date.now(), book, tabs });
}
const fileBase = () => book.title.replace(/[^\w -]+/g, '').trim() || 'io';

async function backup() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  download(`${fileBase()}-${stamp}.json`, await backupData(), 'application/json');
}

const AUTO_EVERY = 60 * 60 * 1000, AUTO_KEEP = 30;
const autoSig = () => book.title + '|' + book.tabs.map(t => t.id + ':' + t.rev + ':' + t.name).join('|');
const day = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Backups live in Io's own storage on this device (the origin private file system): no folder to pick, phones too.
const backupDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('backups', { create: true });

async function autoBackupHere(dir, name) {
  const blob = await gzip(await backupData());
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(blob);
  await w.close();
  const old = [];
  for await (const [n, h] of dir.entries()) if (h.kind === 'file' && n.endsWith('.io.json.gz')) old.push(n);
  const mine = old.filter(n => n.slice(0, -21) === name.slice(0, -21)).sort((a, b) => b.slice(-21).localeCompare(a.slice(-21)));
  for (const n of mine.slice(AUTO_KEEP)) await dir.removeEntry(n).catch(() => {});
  return blob.size;
}

async function autoBackup(force = false) {
  if (!navigator.storage?.getDirectory || autoBackup.busy || book.viewOnly && !force) return;
  const last = pref.get('backupLast.' + book.id, null);
  if (!force && last && (Date.now() - last.at < AUTO_EVERY || last.sig === autoSig())) return;
  autoBackup.busy = true;
  try {
    const dir = await backupDir();
    if (!force) await new Promise(r => idle(r));
    await flush();
    const sig = autoSig(), name = `${book.id} ${day(new Date())}.io.json.gz`;
    let size = (await inBackground({ key: 'tabs', head: { io: 1, savedAt: Date.now(), book }, ids: book.tabs.map(t => t.id), fallback: {}, dir, name, keep: AUTO_KEEP }))?.size;
    if (size === undefined) size = await autoBackupHere(dir, name);
    pref.set('backupLast.' + book.id, { at: Date.now(), sig, size });
  } catch (e) {
    if (force) toast('Backup failed: ' + e.message);
  } finally {
    autoBackup.busy = false;
    renderBackup();
  }
}

const kb = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

function renderBackup() {
  const last = pref.get('backupLast.' + book.id, null);
  $('#autoText').textContent = !navigator.storage?.getDirectory ? 'This browser cannot keep backups. Your copy in Google is the backup. Download a copy to keep one yourself.'
    : `Io backs up this book on this device every hour while you write: one backup a day, the last ${AUTO_KEEP} days kept.`
      + (last ? ` Last backup ${when(last.at)}, ${kb(last.size)}.` : '');
}

async function openBackups() {
  const f = document.createDocumentFragment(), files = [];
  try {
    for await (const [n, h] of (await backupDir()).entries()) if (h.kind === 'file' && n.startsWith(book.id + ' ')) files.push([n, await h.getFile()]);
  } catch {}
  files.sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, file] of files) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="t"></span><span class="pg"></span>';
    b.firstChild.textContent = when(file.lastModified);
    b.lastChild.textContent = kb(file.size);
    b.addEventListener('click', () => { $('#backups').close(); restore(file); });
    li.append(b);
    f.append(li);
  }
  if (!files.length) f.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No backups of this book on this device yet.' }));
  $('#backupList').replaceChildren(f);
  if (!$('#backups').open) $('#backups').showModal();
}

async function restore(file) {
  let data;
  const notBackup = () => ask({ title: 'Not an Io backup', text: 'That file is not an Io backup.', cancel: null });
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    data = JSON.parse(head[0] === 0x1f && head[1] === 0x8b ? await gunzip(file) : await file.text());
  } catch { return notBackup(); }
  if (!data || data.io !== 1 || !data.book?.tabs) return notBackup();
  const id = data.book.id || book.id;
  const old = id === book.id ? book : await dbGet(bookKey(id));
  const text = old
    ? `Replace the book "${old.title}" with the backup from ${when(data.savedAt)}? Download a backup of it first if you might want it.`
    : `Add the book "${data.book.title}" from the backup of ${when(data.savedAt)}?`;
  if (!await ask({ title: 'Restore backup?', text, ok: 'Restore', danger: !!old })) return;
  const now = Date.now();
  const entries = [[bookKey(id), { ...data.book, id, tabs: data.book.tabs.map(t => ({ ...t, rev: uid(), updatedAt: now })) }]];
  for (const t of data.book.tabs) entries.push(['tab:' + t.id, data.tabs[t.id] || '']);
  for (const t of old?.tabs || []) if (!data.book.tabs.some(x => x.id === t.id)) entries.push(['tab:' + t.id, undefined]);
  if (id === book.id) { dirty.clear(); clearTimeout(timers.book); }
  await dbPut(entries);
  pref.set('bookId', id);
  location.reload();
}

const G = {
  token: null,
  exp: 0,
  busy: false,
  fresh: true,
  freshAt: 0,
  pulledAt: 0, // when Io last knew it had the Doc's latest (checked it, loaded it or wrote it)
  valid() { return this.token && Date.now() < this.exp - 60000; },
};
try {
  const s = JSON.parse(localStorage.getItem('io.token') || 'null');
  if (s && s.exp > Date.now()) { G.token = s.token; G.exp = s.exp; G.scope = s.scope || SCOPE; }
} catch {}
function dropToken() {
  G.token = null;
  try { localStorage.removeItem('io.token'); } catch {}
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(new Error('Could not reach Google. Are you online?'));
    document.head.append(s);
  });
}

const wantScope = () => pref.get('docsAccess', false) || book.linked ? SCOPE_DOCS : SCOPE;
const hasDocs = () => G.valid() && SCOPE_DOCS.split(' ').every(x => (G.scope || '').split(' ').includes(x));

function gotToken(r, scope) {
  G.token = r.access_token;
  G.exp = Date.now() + r.expires_in * 1000;
  G.scope = r.scope || scope;
  try { localStorage.setItem('io.token', JSON.stringify({ token: G.token, exp: G.exp, scope: G.scope })); } catch {}
  pref.set('signedIn', true);
  renderSync();
  renderAccount();
  gfetch('GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)').then(a => { pref.set('googleEmail', a.user.emailAddress); renderAccount(); }, () => {});
}

// Phones sign in by leaving the page and coming back (a popup there can lose its way back to Io).
const pageSignIn = () => matchMedia('(pointer: coarse)').matches;

async function signInByPage(scope, quiet) {
  const state = uid();
  try { sessionStorage.setItem('io.oauth', JSON.stringify({ state, scope, quiet })); } catch {}
  clearTimeout(timers.book);
  await dbPut([[bookKey(), book]]);
  await flush();
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: location.origin + location.pathname, response_type: 'token',
    scope, state, include_granted_scopes: 'true',
  });
  const hint = pref.get('googleEmail', '');
  if (hint) q.set('login_hint', hint);
  if (quiet) q.set('prompt', 'none');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q);
  return new Promise(() => {});
}

// Picks up the token Google puts in the address after signInByPage. Returns true if signed in.
function signInReturn() {
  if (!location.hash.includes('state=')) return null;
  const r = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  history.replaceState(null, '', location.pathname + location.search);
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('io.oauth') || 'null'); sessionStorage.removeItem('io.oauth'); } catch {}
  if (!saved || saved.state !== r.state) return null;
  if (r.error) {
    if (!saved.quiet) toast(r.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed: ' + r.error);
    return false;
  }
  gotToken({ access_token: r.access_token, expires_in: +r.expires_in, scope: r.scope }, saved.scope);
  if (!saved.quiet) toast('Signed in to Google.');
  return true;
}

function signIn(scope = wantScope()) {
  if (pageSignIn()) return signInByPage(scope);
  // One sign-in at a time: a second request replaces the first popup and neither one answers.
  if (G.signing) return G.signing;
  G.signing = (async () => {
    await loadGis();
    await new Promise((res, rej) => {
      const c = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope,
        hint: pref.get('googleEmail', ''),
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          gotToken(r, scope);
          res();
        },
        error_callback: e => rej(new Error(e.message || 'Sign-in was closed.')),
      });
      c.requestAccessToken({ prompt: '' });
    });
  })().finally(() => { G.signing = null; });
  return G.signing;
}

// Phones cannot renew from a click, so an expired sign-in is renewed by a quick trip to Google and back
// (prompt=none: no screen while the Google session lasts). At most once every 10 minutes.
function renewByPage() {
  if (!pageSignIn() || G.valid() || !pref.get('signedIn', false) || !navigator.onLine || book.viewOnly) return false;
  try {
    if (Date.now() - (+sessionStorage.getItem('io.renewAt') || 0) < 600000) return false;
    sessionStorage.setItem('io.renewAt', Date.now());
  } catch { return false; }
  signInByPage(wantScope(), true);
  return true;
}

function renewOnClick() {
  if (G.renewing || G.signing || G.busy || G.valid() || pageSignIn() || !pref.get('signedIn', false) || !navigator.onLine || !window.google?.accounts?.oauth2) return;
  G.renewing = true;
  signIn().then(() => pushAll(false), () => renderSync()).finally(() => { G.renewing = false; });
}

// Every request has a time limit: one that hangs on a weak connection would otherwise block every later save.
async function gsend(url, opts, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  const late = new Promise((_, rej) => c.signal.addEventListener('abort', () => rej(new Error('Google did not answer in time. Io will try again.'))));
  try { return await Promise.race([fetch(url, { ...opts, signal: c.signal }), late]); }
  finally { clearTimeout(t); }
}

async function gfetch(method, url, body) {
  const r = await gsend(url, {
    method,
    headers: { Authorization: 'Bearer ' + G.token, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }, 60000);
  if (r.status === 401) { dropToken(); throw Object.assign(new Error('Google sign-in expired.'), { status: 401 }); }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error.message; } catch {}
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.json();
}

async function gblob(method, url, body, type) {
  const r = await gsend(url, { method, headers: { Authorization: 'Bearer ' + G.token, ...(type && { 'Content-Type': type }) }, body }, 180000);
  if (r.status === 401) { dropToken(); throw Object.assign(new Error('Google sign-in expired.'), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(r.statusText || 'Drive error ' + r.status), { status: r.status });
  return r;
}
const gzip = str => new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const gunzip = blob => new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

const PACKER = `
const db = new Promise((res, rej) => { const r = indexedDB.open('io'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const get = async k => { const d = await db; return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
onmessage = async ({ data: j }) => {
  try {
    const tabs = {};
    for (const id of j.ids) tabs[id] = (await get('tab:' + id)) || j.fallback[id] || '';
    const str = JSON.stringify({ ...j.head, [j.key]: tabs });
    const blob = await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    if (!j.dir) return postMessage({ n: j.n, blob });
    const fh = await j.dir.getFileHandle(j.name, { create: true });
    if (fh.createWritable) { const w = await fh.createWritable(); await w.write(blob); await w.close(); }
    else { const h = await fh.createSyncAccessHandle(); h.truncate(0); h.write(new Uint8Array(await blob.arrayBuffer()), { at: 0 }); h.flush(); h.close(); }
    const old = [], pre = j.name.slice(0, -21);
    for await (const [n, h] of j.dir.entries()) if (h.kind === 'file' && n.endsWith('.io.json.gz') && n.slice(0, -21) === pre) old.push(n);
    old.sort((a, b) => b.slice(-21).localeCompare(a.slice(-21)));
    for (const n of old.slice(j.keep)) await j.dir.removeEntry(n).catch(() => {});
    postMessage({ n: j.n, size: blob.size });
  } catch (e) { postMessage({ n: j.n, error: e.message }); }
};`;
let packer = null, packN = 0;
function inBackground(job) {
  try { packer ||= new Worker(URL.createObjectURL(new Blob([PACKER], { type: 'text/javascript' }))); }
  catch { return null; }
  const n = ++packN;
  return new Promise((res, rej) => {
    const on = ({ data }) => {
      if (data.n !== n) return;
      packer.removeEventListener('message', on);
      data.error ? rej(new Error(data.error)) : res(data);
    };
    packer.addEventListener('message', on);
    packer.postMessage({ ...job, n });
  });
}
const pack = async (key, head, fallback) => {
  await flush();
  const ids = book.tabs.map(t => t.id), fb = {};
  for (const t of book.tabs) fb[t.id] = fallback(t);
  return inBackground({ key, head, ids, fallback: fb });
};

const SHARED = ['id', 'name', 'nameAt', 'kind', 'rev', 'past', 'updatedAt', 'fixes', 'docTab', 'tabTitle', 'syncedAt', 'pushedAt'];
// A sheet's earlier synced revs. Tells an out-of-date copy in the data file (left by two devices
// uploading at once) from a newer one.
const addPast = (t, ...revs) => { t.past = [...new Set([...(t.past || []), ...revs.filter(Boolean)])].slice(-200); };
const DOC_KEYS = ['docId', 'docTitle', 'revisionId', 'docSig', 'docModified', 'pushedAt', 'linked'];
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k] ?? null]));
const shareBook = () => ({
  title: book.title, titleAt: book.titleAt || 0, deleted: book.deleted || {}, delRevs: book.delRevs || {}, dropTabs: book.dropTabs || [],
  ...pick(book, DOC_KEYS),
  tabs: book.tabs.map(t => pick(t, SHARED)),
});
const sigOf = b => JSON.stringify([b.title, Object.keys(b.deleted || {}).sort(), b.docId || null, b.pushedAt || 0, b.dropTabs || [], b.tabs.map(t => [t.id, t.rev || null, t.name, t.pushedAt || 0])]);
const tabHtml = async t => editors[t.id] ? serialize(editors[t.id]) : (await dbGet('tab:' + t.id)) || starter(t);

async function mergeData(remote) {
  const rb = remote.book, puts = [];
  // This device wrote the file last (its upload landed but the sync stopped before it was noted here):
  // the file holds this device's own earlier state, so its revs become the base and nothing is copied.
  if (remote.by === DEVICE) {
    const revs = new Map(rb.tabs.map(t => [t.id, t.rev]));
    for (const t of book.tabs) if (revs.has(t.id)) {
      t.baseRev = revs.get(t.id);
      if (t.rev !== t.baseRev) addPast(t, t.baseRev);
    }
    return;
  }
  let shown = false;
  const drop = id => {
    const d = tabById(id)?.docTab;
    if (d && !book.linked) book.dropTabs = [...new Set([...(book.dropTabs || []), d])];
    editors[id]?.remove();
    delete editors[id];
    dirty.delete(id);
    book.tabs = book.tabs.filter(t => t.id !== id);
    puts.push(['tab:' + id, undefined]);
  };
  if (!book.dataSig) for (const t of [...book.tabs]) if (!t.rev && !t.docTab) drop(t.id);
  const fresh = { linked: null, docTab: null, tabTitle: null, syncedAt: 0, pushedAt: 0, baseRev: null };
  book.deleted = { ...rb.deleted, ...book.deleted };
  book.delRevs = { ...rb.delRevs, ...book.delRevs };
  for (const id in book.deleted) {
    const t = tabById(id);
    if (!t) continue;
    // It goes only if the deleting device had seen this version (older files: unchanged here since the last sync).
    const seen = book.delRevs[id];
    if (seen ? seen.includes(t.rev) : t.rev === t.baseRev) { drop(id); continue; }
    const html = await tabHtml(t), c = { ...t, ...fresh, id: uid(), name: t.name + ' (deleted on other device)' };
    drop(id);
    book.tabs.push(c);
    puts.push(['tab:' + c.id, html]);
  }
  if ((rb.titleAt || 0) > (book.titleAt || 0) || !book.dataSig) {
    book.title = rb.title;
    book.titleAt = rb.titleAt;
    el.title.value = book.title;
    document.title = book.title + ' - Io';
  }
  // A Doc save since the other device wrote its list has already removed those tabs.
  if ((rb.pushedAt || 0) >= (book.pushedAt || 0)) book.dropTabs = [...new Set([...(book.dropTabs || []), ...(rb.dropTabs || [])])];
  // Two devices saving the Doc at once: the one whose read-back caught the other's writes has docSig '?', and the
  // other one's fingerprint is the Doc as it ended. Keep a real fingerprint over '?', whichever save ended last.
  const real = b => b.docSig && b.docSig !== '?' && b.docId === book.docId;
  if ((rb.pushedAt || 0) > (book.pushedAt || 0)) Object.assign(book, pick(rb, DOC_KEYS), rb.docSig === '?' && real(book) ? pick(book, ['revisionId', 'docSig']) : {});
  else if (book.docSig === '?' && real(rb)) Object.assign(book, pick(rb, ['revisionId', 'docSig']));
  for (const r0 of rb.tabs) {
    if (book.deleted[r0.id]) continue;
    const r = pick(r0, SHARED);
    const html = remote.html[r.id] ?? '';
    const t = tabById(r.id);
    if (!t) {
      const name = book.tabs.some(x => x.name === r.name) ? r.name + ' (other device)' : r.name;
      book.tabs.push({ ...r, name, kind: r.kind === 'ms' && book.tabs.some(x => x.kind === 'ms') ? 'notes' : r.kind, baseRev: r.rev });
      puts.push(['tab:' + r.id, html]);
      continue;
    }
    const mine = t.rev !== t.baseRev;
    const theirs = r.rev !== t.baseRev && r.rev !== t.rev && !(t.past || []).includes(r.rev);
    // This device's last synced version never reached the other device (its upload was overwritten):
    // keep it as a copy and take theirs, so both devices end up with the same sheets.
    const lost = theirs && !mine && t.baseRev && r.past && !r.past.includes(t.baseRev);
    if (lost) {
      const c = { ...t, ...fresh, id: uid(), kind: 'notes', name: t.name + ' (conflict copy)', rev: uid() };
      book.tabs.push(c);
      puts.push(['tab:' + c.id, await tabHtml(t)]);
    }
    if (theirs && !mine) {
      addPast(t, t.rev, ...(r.past || []));
      Object.assign(t, { rev: r.rev, baseRev: r.rev, updatedAt: r.updatedAt, fixes: r.fixes });
      puts.push(['tab:' + t.id, html]);
      if (editors[t.id]) { editors[t.id].innerHTML = html || starter(t); shown ||= t.id === book.active; }
    } else if (theirs) {
      addPast(t, r.rev);
      const c = { ...r, ...fresh, id: uid(), kind: 'notes', name: r.name + ' (other device)' };
      book.tabs.push(c);
      puts.push(['tab:' + c.id, html]);
    }
    if ((r.nameAt || 0) > (t.nameAt || 0)) { t.name = r.name; t.nameAt = r.nameAt; }
    if ((r.pushedAt || 0) > (t.pushedAt || 0)) {
      // Both devices gave this sheet a Doc tab: keep theirs, remove ours from the Doc.
      if (t.docTab && r.docTab && t.docTab !== r.docTab) book.dropTabs = [...new Set([...(book.dropTabs || []), t.docTab])];
      for (const k of ['docTab', 'tabTitle', 'syncedAt', 'pushedAt']) t[k] = r[k];
    }
  }
  if (!book.tabs.length) book.tabs = newBook().tabs;
  await dbPut(puts);
  if (!tabById(book.active)) await openTab(book.tabs[0].id);
  else if (shown) { layout(); meta(); renderStatus(); }
  renderTabs();
}

// A file this book had is gone (deleted, or signed in to another Google account). Making a new one
// would start a second copy, so the automatic save stops and a manual one asks first.
async function missing(what, interactive) {
  const who = pref.get('googleEmail', '') || 'this Google account';
  const text = `Io cannot find this book's ${what} in ${who}. If you signed in with a different Google account, sign out in Settings and sign in with the right one.`;
  if (interactive && await ask({ title: 'Not found in Google', text: text + ' Or make a new one now.', ok: 'Make a new one' })) return;
  throw new Error(text);
}

async function syncData(interactive) {
  await flush();
  let id = book.dataId, version = null, base = book.dataSig;
  const byName = async () => {
    const q = encodeURIComponent(`name='${dataName(book)}' and trashed=false`);
    return (await gfetch('GET', `${DRIVE}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id)`)).files[0]?.id || null;
  };
  if (!id) id = await byName();
  if (id) {
    try { version = (await gfetch('GET', `${DRIVE}/files/${id}?fields=version`)).version; }
    catch (e) {
      if (e.status !== 404) throw e;
      // Another device may have replaced the file: look for it by name before calling it missing.
      id = id === book.dataId ? await byName() : null;
      if (id) version = (await gfetch('GET', `${DRIVE}/files/${id}?fields=version`)).version;
    }
  }
  if (!id && book.dataAt) await missing('copy in Google Drive', interactive);
  if (id && version !== book.dataVersion) {
    const remote = JSON.parse(await gunzip(await (await gblob('GET', `${DRIVE}/files/${id}?alt=media`)).blob()));
    if (remote?.io === 1) { await mergeData(remote); base = sigOf(remote.book); }
  }
  const snap = shareBook();
  let sent = null;
  if (!id || sigOf(snap) !== base) {
    const head = { io: 1, savedAt: Date.now(), by: DEVICE, book: snap };
    sent = snap;
    let body = (await pack('html', head, starter))?.blob;
    if (!body) {
      const html = {};
      for (const t of book.tabs) html[t.id] = await tabHtml(t);
      body = await gzip(JSON.stringify({ ...head, html }));
    }
    if (!id) id = (await gfetch('POST', `${DRIVE}/files?fields=id`, { name: dataName(book), mimeType: 'application/gzip' })).id;
    version = (await (await gblob('PATCH', `${UPLOAD}/${id}?uploadType=media&fields=version`, body, 'application/gzip')).json()).version;
  }
  if (book.dataTitle !== book.title) {
    await gfetch('PATCH', `${DRIVE}/files/${id}?fields=id`, { appProperties: { ioBook: book.id, title: book.title } });
    book.dataTitle = book.title;
  }
  // Revs as they were when packed: an edit typed while the upload ran still counts as unsent.
  const revs = new Map(snap.tabs.map(t => [t.id, t.rev]));
  for (const t of book.tabs) if (revs.has(t.id)) {
    t.baseRev = revs.get(t.id);
    if (t.rev !== t.baseRev) addPast(t, t.baseRev);
  }
  Object.assign(book, { dataId: id, dataVersion: version, dataSig: sent ? sigOf(sent) : base, dataAt: Date.now() });
  clearTimeout(timers.book);
  await dbPut([[bookKey(), book]]);
}

function hexRgb(h) {
  return { red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 };
}

function docModel(root) {
  let text = '';
  const paras = [], runs = [];
  const add = (s, st) => {
    const start = text.length;
    text += s;
    const last = runs[runs.length - 1];
    if (last && last.end === start && last.b === st.b && last.i === st.i && last.u === st.u && last.m === st.m && last.c === st.c) last.end = text.length;
    else if (st.b || st.i || st.u || st.m || st.c) runs.push({ start, end: text.length, ...st });
  };
  const walk = (node, st) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const s = n.data.replace(/[\n\r]+/g, ' '); if (s) add(s, st); continue; }
      if (n.nodeType !== 1) continue;
      if (n.nodeName === 'BR') { if (n.nextSibling) add('\u000b', st); continue; }
      const s = { ...st };
      if (n.nodeName === 'B' || n.nodeName === 'STRONG') s.b = true;
      else if (n.nodeName === 'I' || n.nodeName === 'EM') s.i = true;
      else if (n.nodeName === 'U') s.u = true;
      else if (n.nodeName === 'FONT') { s.m = markOf(n) || st.m; s.c = inkOf(n) || st.c; }
      walk(n, s);
    }
  };
  for (const b of root.children) {
    const start = text.length;
    walk(b, { b: false, i: false, u: false, m: null, c: null });
    text += '\n';
    paras.push({ start, end: text.length, h: b.nodeName === 'H1' });
  }
  return { text, paras, runs };
}

function docRequests(m, docEnd, tabId, clean) {
  const reqs = [], at = (startIndex, endIndex) => ({ startIndex, endIndex, tabId });
  if (docEnd - 1 > 1) reqs.push({ deleteContentRange: { range: at(1, docEnd - 1) } });
  const ins = m.text.slice(0, -1);
  const L = ins.length;
  if (L) reqs.push({ insertText: { location: { index: 1, tabId }, text: ins } });
  reqs.push({ updateParagraphStyle: { range: at(1, L + 2), paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
  if (clean) reqs.push({ deleteParagraphBullets: { range: at(1, L + 2) } });
  for (const p of m.paras) {
    if (p.h) reqs.push({ updateParagraphStyle: { range: at(p.start + 1, p.end + 1), paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } });
  }
  if (L) reqs.push({ updateTextStyle: { range: at(1, L + 1), textStyle: {}, fields: 'bold,italic,underline,foregroundColor,backgroundColor' } });
  for (const r of m.runs) {
    const ts = {}, fields = [];
    if (r.b) { ts.bold = true; fields.push('bold'); }
    if (r.i) { ts.italic = true; fields.push('italic'); }
    if (r.u) { ts.underline = true; fields.push('underline'); }
    if (r.m) {
      ts.foregroundColor = { color: { rgbColor: hexRgb(r.m === 'fix' ? '#6b4f00' : MARKS[r.m]) } };
      fields.push('foregroundColor');
      if (r.m === 'fix') { ts.backgroundColor = { color: { rgbColor: FIX_BG } }; fields.push('backgroundColor'); }
    }
    else if (r.c) { ts.foregroundColor = { color: { rgbColor: hexRgb(r.c) } }; fields.push('foregroundColor'); }
    reqs.push({ updateTextStyle: { range: at(r.start + 1, r.end + 1), textStyle: ts, fields: fields.join(',') } });
  }
  return reqs;
}

// One Google Doc per book, one Doc tab per sheet (sheet.docTab is the Doc's tabId).
const docName = () => book.linked ? book.docTitle : book.title;
// A Doc tab no sheet uses, named like a sheet that has its own tab: a duplicate left when two devices
// both added a tab for the same new sheet.
const dupTab = (id, title) => !book.tabs.some(t => t.docTab === id) && book.tabs.some(t => t.docTab && t.docTab !== id && t.name === title);
const tabNeeds = t => !t.docTab || t.updatedAt > (t.syncedAt || 0) || t.tabTitle !== t.name;
const needsDoc = () => !book.docId || book.tabs.some(tabNeeds) || !!book.dropTabs?.length || book.docTitle !== docName();

const TAB_FIELDS = 'tabProperties(tabId,title),documentTab(body(content(endIndex)))';
const flatTabs = ts => (ts || []).flatMap(t => [t, ...flatTabs(t.childTabs)]);
const getDoc = (id, fields = `revisionId,tabs(${TAB_FIELDS},childTabs(${TAB_FIELDS},childTabs(${TAB_FIELDS})))`) =>
  gfetch('GET', `${DOCS}/${id}?includeTabsContent=true&fields=${encodeURIComponent(fields)}`);

async function findDoc() {
  const q = encodeURIComponent(`appProperties has { key='ioDoc' and value='${book.id}' } and trashed=false`);
  return (await gfetch('GET', `${DRIVE}/files?q=${q}&fields=files(id,name)`)).files[0] || null;
}

// A Doc shared with this account as view only: the book is read-only in Io and is never saved to Google or backed up.
function setViewOnly(on) {
  book.viewOnly = on;
  book.conflict = false;
  document.documentElement.classList.toggle('view-only', on);
  for (const ed of Object.values(editors)) ed.contentEditable = String(!on);
  setReading(on || pref.get('reading', false));
}
const canEditDoc = async id => (await gfetch('GET', `${DRIVE}/files/${id}?fields=capabilities(canEdit)&supportsAllDrives=true`)).capabilities?.canEdit !== false;

// A fingerprint of what Io can see of the Doc (each tab's id, name, text and styles), taken after every save
// and load. Google can move the revisionId with no edit, so a moved revisionId is checked against it. Drive's
// modified time cannot tell: with real Google it lagged minutes behind edits (15 Oct 2026).
async function docSig(doc) {
  // Duplicate tabs left by two devices are not an edit: Io removes them itself.
  const s = JSON.stringify(docSheets(doc, {}).filter(x => !dupTab(x.tabId, x.title)).map(x => [x.tabId, x.title, x.html]));
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
}
// Was the Doc changed in Google since Io last saved or loaded it? Reads the whole Doc and returns it too.
// `other`: another Io device is saving it and its data file has not arrived yet (see otherSave).
async function docChanged() {
  const doc = await fullDoc(book.docId);
  let changed;
  if (book.docSig) changed = await docSig(doc) !== book.docSig;
  else {
    // A book last saved before fingerprints: Drive's modified time, as before, this once.
    const t = (await gfetch('GET', `${DRIVE}/files/${book.docId}?fields=modifiedTime&supportsAllDrives=true`)).modifiedTime;
    changed = !book.docModified || Date.parse(t) - Date.parse(book.docModified) > 60000;
  }
  return { changed, other: changed && await otherSave(), doc };
}
// Io marks its own Doc before writing to it (appProperty ioBusy = device:time). Another device's save shows in
// the Doc before its data file (with the new revisionId and docSig) arrives: that is not an edit in Google.
const BUSY_FOR = 5 * 60000;
async function otherSave() {
  if (book.linked) return false;
  const p = (await gfetch('GET', `${DRIVE}/files/${book.docId}?fields=appProperties&supportsAllDrives=true`)).appProperties || {};
  const [by, at] = (p.ioBusy || '').split(':');
  // docSig '?': another device wrote during this device's last save, so its mark can be older than that save's end.
  return !!by && by !== DEVICE && (+at > (book.pushedAt || 0) || book.docSig === '?') && Date.now() - +at < BUSY_FOR;
}
const markBusy = () => gfetch('PATCH', `${DRIVE}/files/${book.docId}?fields=id`, { appProperties: { ioBusy: DEVICE + ':' + Date.now() } }).catch(() => {});

async function pushDoc(interactive) {
  const snapAt = Date.now();
  let doc = null, made = false;
  if (!book.docId && !book.linked) book.docId = (await findDoc())?.id || null;
  if (book.docId) {
    try { doc = await getDoc(book.docId); }
    catch (e) {
      if (e.status !== 404) throw e;
      await missing(`Google Doc "${docName()}"`, interactive);
      book.docId = null; book.revisionId = null; book.docSig = null;
    }
  }
  // Google can change a revisionId with no edit, so a change is confirmed by the Doc's content.
  const c = doc && book.revisionId && doc.revisionId !== book.revisionId && await docChanged();
  if (c?.other) {
    await syncData(interactive);
    if (book.revisionId !== doc.revisionId) {
      if (interactive) toast('Another device is saving this book to Google. Io will save it in a moment.');
      return 'wait';
    }
  } else if (c?.changed) {
    G.pulledAt = 0;
    if (!interactive) { book.conflict = true; return; }
    if (!await ask({ title: 'Changed in Google Docs', text: `"${docName()}" was changed in Google Docs since Io last saved it. Overwrite it with Io's version? Google keeps the changed version in its version history. To take the changes instead, use Load from Google in Settings.`, ok: 'Overwrite', danger: true })) return;
  }
  if (doc) book.revisionId = doc.revisionId;
  if (!doc) {
    if (book.linked) book.title = book.docTitle || book.title;
    book.linked = false;
    const d = await gfetch('POST', DOCS, { title: book.title });
    book.docId = d.documentId;
    book.docTitle = book.title;
    await gfetch('PATCH', `${DRIVE}/files/${book.docId}?fields=id`, { appProperties: { ioDoc: book.id } });
    for (const t of book.tabs) t.docTab = null;
    doc = await getDoc(book.docId);
    made = true;
  }
  if (book.docTitle !== docName()) {
    await gfetch('PATCH', `${DRIVE}/files/${book.docId}?fields=id`, { name: book.title });
    book.docTitle = book.title;
    if (book.revisionId) book.revisionId = (await getDoc(book.docId, 'revisionId')).revisionId;
  }
  const have = new Map(flatTabs(doc.tabs).map(t => [t.tabProperties.tabId, {
    title: t.tabProperties.title, end: (c => c.length ? c[c.length - 1].endIndex : 2)(t.documentTab?.body?.content || []),
  }]));
  for (const t of book.tabs) if (t.docTab && !have.has(t.docTab)) t.docTab = null;
  // A new Doc comes with one empty tab: the first sheet takes it.
  if (made) { const spare = [...have.keys()].find(id => !book.tabs.some(t => t.docTab === id)), t = book.tabs.find(x => !x.docTab); if (spare && t) t.docTab = spare; }
  // A sheet with no tab yet takes an unused tab of its name (another device may have just added it).
  for (const t of book.tabs) if (!t.docTab) {
    const id = [...have.keys()].find(id => have.get(id).title === t.name && !book.tabs.some(x => x.docTab === id) && !(book.dropTabs || []).includes(id));
    if (id) { t.docTab = id; t.syncedAt = 0; }
  }
  const adds = book.tabs.filter(t => !t.docTab);
  const reqs = adds.map(t => ({ addDocumentTab: { tabProperties: { title: t.name } } }));
  if (!book.linked) for (const [id, v] of have) if (dupTab(id, v.title) && !(book.dropTabs || []).includes(id)) book.dropTabs = [...(book.dropTabs || []), id];
  for (const t of book.tabs) {
    if (t.docTab && have.get(t.docTab).title !== t.name) reqs.push({ updateDocumentTabProperties: { tabProperties: { tabId: t.docTab, title: t.name }, fields: 'title' } });
  }
  for (const id of book.dropTabs || []) if (have.has(id) && !book.tabs.some(t => t.docTab === id)) reqs.push({ deleteTab: { tabId: id } });
  let marked = book.linked;
  const write = async requests => {
    if (!marked) { marked = true; await markBusy(); }
    const r = await gfetch('POST', `${DOCS}/${book.docId}:batchUpdate`, { requests });
    book.revisionId = r.writeControl?.requiredRevisionId || null;
    return r;
  };
  if (reqs.length) {
    const r = await write(reqs);
    adds.forEach((t, i) => { t.docTab = r.replies[i].addDocumentTab.tabProperties.tabId; have.set(t.docTab, { title: t.name, end: 2 }); t.syncedAt = 0; });
  } else if (!book.revisionId) book.revisionId = doc.revisionId;
  book.dropTabs = [];
  for (const t of book.tabs) {
    if (t.updatedAt > (t.syncedAt || 0) || !t.pushedAt) {
      const tpl = document.createElement('template');
      tpl.innerHTML = await tabHtml(t);
      await write(docRequests(docModel(tpl.content), have.get(t.docTab).end, t.docTab, book.linked));
      t.syncedAt = snapAt;
    }
    t.tabTitle = t.name;
    t.pushedAt = Date.now();
  }
  // The Doc as Io left it. If anything but Io's own writes came in meanwhile, '?' leaves it for the next check.
  const after = await fullDoc(book.docId);
  book.docSig = after.revisionId === book.revisionId ? await docSig(after) : '?';
  book.pushedAt = Date.now();
  book.conflict = false;
  G.pulledAt = book.docSig === '?' ? 0 : Date.now();
}

// Coming back to Io: sync, then load the Doc if it was changed in Google (pullDoc). At most every 15 s.
function checkDoc() {
  if (Date.now() - G.freshAt < 15000) return false;
  G.freshAt = Date.now();
  G.fresh = true;
  pushAll(false);
  return true;
}

function pushAll(interactive) {
  // A check of the Doc asked for during a save runs straight after it, not at the next 2-minute round.
  if (G.job) return G.job.then(() => interactive ? pushAll(true) : G.fresh && pushAll(false));
  G.job = pushNow(interactive).finally(() => { G.job = null; });
  return G.job;
}

async function pushNow(interactive) {
  if (!navigator.onLine) { if (interactive) toast('Offline. Io will save to Google when you are back online.'); return; }
  if (!interactive && !G.valid()) return renderSync();
  G.busy = true;
  renderSync();
  try {
    await flush();
    if (!G.valid()) await signIn();
    G.error = null;
    if (book.linked && hasDocs() && (book.viewOnly === undefined || book.viewOnly && interactive)) {
      const was = book.viewOnly;
      setViewOnly(!await canEditDoc(book.docId));
      if (was && !book.viewOnly) return toast(`You can now edit "${docName()}". Press Sync now first to get the latest version.`);
    }
    let pulled;
    // Only while Io is on screen: a question about the Doc must not wait unseen and hold up every later save.
    if (G.fresh && !document.hidden) {
      G.fresh = false;
      if (!book.viewOnly) await syncData(interactive);
      pulled = await pullDoc();
    }
    if (book.viewOnly) {
      if (interactive && pulled !== 'loaded') toast(pulled === 'same' ? 'Io has the latest version from Google Docs.' : `You can only view "${docName()}" in Google Docs, so Io keeps it read-only and does not save it. Sync now gets the latest version.`);
      return;
    }
    await syncData(interactive);
    const docsDue = interactive || Date.now() - (book.docsAt || 0) >= DOCS_EVERY;
    if (book.linked && !hasDocs()) { if (interactive) toast('Allow access to your Google Docs (Settings, Sign in) to save this book back to its Doc.'); }
    else if (docsDue && needsDoc() && (interactive || !book.conflict)) {
      if (book.linked && !await canEditDoc(book.docId)) {
        setViewOnly(true);
        if (interactive) toast(`You can now only view "${docName()}" in Google Docs, so Io did not save to it.`);
      } else {
        const wait = await pushDoc(interactive) === 'wait';
        if (!wait) book.docsAt = Date.now();
        await syncData(interactive);
        if (interactive && !wait && !book.conflict && pulled !== 'loaded') toast('Saved to Google.');
      }
    } else if (interactive && pulled !== 'loaded') toast(pulled === 'same' ? 'Io has the latest version from Google Docs.' : 'Saved to Google. The Google Doc is up to date.');
  } catch (e) {
    G.error = e.message;
    if (interactive) toast('Saving to Google failed: ' + e.message);
  } finally {
    G.busy = false;
    saveBook();
    renderSync();
    renderDocLinks();
  }
}

function renderSync() {
  const conflict = book.conflict, on = G.valid(), was = pref.get('signedIn', false);
  // Tick: Io has the Doc's latest (checked on open and on coming back to Io). Otherwise a button to get it.
  const ok = G.pulledAt && Date.now() - G.pulledAt < PULL_FOR && !G.error && !conflict && on && navigator.onLine;
  const waiting = book.tabs.filter(tabNeeds).length;
  const saved = book.dataAt ? 'Saved to Google ' + when(book.dataAt) + '.' : '';
  let txt, state, title;
  if (G.busy) { txt = 'Saving…'; state = 'busy'; title = 'Saving to Google.'; }
  else if (!navigator.onLine) { txt = 'Offline'; state = ''; title = 'Offline. Saved on this device; Io saves to Google when you are back online.'; }
  else if (!on) { txt = was ? 'Sign in again' : 'Sign in'; state = was ? 'warn' : 'out'; title = was ? 'Google sign-in has expired. Click to sign in again.' : 'Sign in to Google to save this book to Google Docs and your other devices.'; }
  else if (conflict) { txt = 'Changed in Google'; state = 'warn'; title = 'The Google Doc was changed in Google Docs. Click to choose which version to keep.'; }
  else if (G.error) { txt = 'Not saved'; state = 'warn'; title = 'Saving to Google failed: ' + G.error + ' Click to try again.'; }
  else if (book.viewOnly) { txt = 'View only'; state = ok ? 'ok' : ''; title = 'You can only view this Doc, so Io does not save it. Click to get the latest.'; }
  else if (ok) { txt = 'Up to date'; state = 'ok'; title = `Up to date with Google Docs (checked ${when(G.pulledAt)}). ${waiting ? 'New edits save to Google within 5 minutes. ' : ''}Click to check again.`; }
  else { txt = 'Sync now'; state = ''; title = [saved, 'Click to get the latest from Google Docs and save.'].filter(Boolean).join(' '); }
  const p = $('#pullBtn');
  p.hidden = on && !book.docId && !G.busy && !G.error;
  p.dataset.state = state;
  p.title = title;
  $('#pullTxt').textContent = txt;
}

function renderDocLinks() {
  const f = document.createDocumentFragment();
  if (book.docId) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://docs.google.com/document/d/${book.docId}/edit`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open "' + docName() + '" in Google Docs';
    li.append(a);
    f.append(li);
  }
  $('#docLinks').replaceChildren(f);
}

// Old books had one Doc per sheet (sheet.docId). Those Docs stop being updated; the book gets one Doc with tabs.
function migrateDocs() {
  if (book.docVer === 2) return;
  const old = book.tabs.filter(t => t.docId && !t.linked).map(t => ({ id: t.docId, title: t.docTitle || t.name }));
  if (old.length) book.oldDocs = [...(book.oldDocs || []), ...old];
  for (const t of book.tabs) {
    for (const k of ['docId', 'docTitle', 'revisionId', 'linked', 'conflict']) delete t[k];
    t.syncedAt = 0;
    t.pushedAt = 0;
  }
  book.docVer = 2;
  saveBook();
}

function hexOf(c) {
  const r = c?.color?.rgbColor;
  return r ? '#' + ['red', 'green', 'blue'].map(k => Math.round((r[k] || 0) * 255).toString(16).padStart(2, '0')).join('') : null;
}
function markFromStyle(ts) {
  const fg = hexOf(ts.foregroundColor), bg = hexOf(ts.backgroundColor);
  if (fg === '#6b4f00' || bg === '#ffe17a') return 'fix';
  for (const k in MARKS) if (MARKS[k] === fg) return k;
  return null;
}

function docHtml(content, lost) {
  const out = [];
  const note = k => { lost[k] = (lost[k] || 0) + 1; };
  const para = p => {
    const st = p.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
    const h = st === 'TITLE' || st.startsWith('HEADING_');
    if (h && st !== 'HEADING_1') note('sub');
    if (p.bullet) note('list');
    let html = '';
    for (const e of p.elements || []) {
      if (e.inlineObjectElement || e.positionedObjectElement) { note('image'); continue; }
      if (e.footnoteReference) { note('footnote'); continue; }
      const r = e.textRun;
      if (!r) continue;
      const s = r.content.replace(/\n$/, '');
      if (!s) continue;
      const ts = r.textStyle || {};
      let x = esc(s).replace(/\u000b/g, '<br>');
      if (ts.link) note('link');
      if (ts.underline && !ts.link) x = `<u>${x}</u>`;
      if (ts.italic) x = `<i>${x}</i>`;
      if (ts.bold) x = `<b>${x}</b>`;
      const m = markFromStyle(ts);
      const fg = !m && hexOf(ts.foregroundColor);
      if (m) x = `<font color="${MARKS[m]}">${x}</font>`;
      else if (fg && fg !== '#000000' && fg !== INK) x = `<font color="${fg}">${x}</font>`;
      html += x;
    }
    const tag = h ? 'h1' : 'p';
    out.push(`<${tag}>${html || '<br>'}</${tag}>`);
  };
  const walk = content => {
    for (const c of content || []) {
      if (c.paragraph) para(c.paragraph);
      else if (c.table) { note('table'); for (const row of c.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content); }
      else if (c.tableOfContents) note('toc');
    }
  };
  walk(content);
  return out.join('') || '<p><br></p>';
}

// Every tab of a Doc, flattened, as { tabId, title, html }.
function docSheets(doc, lost) {
  return flatTabs(doc.tabs).map(t => ({ tabId: t.tabProperties.tabId, title: t.tabProperties.title || 'Untitled', html: docHtml(t.documentTab?.body?.content, lost) }));
}

const LOST = {
  table: 'tables (their text comes in as plain paragraphs)',
  image: 'pictures', list: 'list bullets', sub: 'subheadings and titles (they become chapter headings)',
  link: 'links', footnote: 'footnotes', toc: 'the table of contents',
};
const fullDoc = id => gfetch('GET', `${DOCS}/${id}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`);

async function openDocFile(f) {
  try {
    const mine = (await localBooks()).find(b => b.docId === f.id);
    if (mine && mine.id !== book.id) return switchBook(mine.id);
    if (mine) return reloadFromDoc();
    const [doc, canEdit] = await Promise.all([fullDoc(f.id), canEditDoc(f.id)]), lost = {};
    const sheets = docSheets(doc, lost);
    const kinds = Object.keys(lost);
    if (kinds.length && !await ask({
      title: 'Some of this Doc will not come across',
      text: `Io cannot show ${kinds.map(k => LOST[k]).join(', ')}. ` + (canEdit
        ? 'Saving from Io rewrites the Doc, so these would be removed from it. Google keeps the old version in its version history. Open it anyway?'
        : 'You can only view this Doc, so Io will not change it. Open it anyway?'),
      ok: 'Open', danger: canEdit,
    })) return;
    const now = Date.now();
    const tabs = sheets.map((s, i) => ({
      id: uid(), name: s.title.slice(0, 60), kind: i ? 'notes' : 'ms', rev: uid(), updatedAt: now, nameAt: now, fixes: 0,
      docTab: s.tabId, tabTitle: s.title.slice(0, 60), syncedAt: now, pushedAt: now,
    }));
    const b = {
      id: uid(), title: doc.title.slice(0, 80) || 'Untitled', titleAt: now, active: tabs[0].id, tabs, docVer: 2,
      linked: true, docId: f.id, docTitle: doc.title, revisionId: doc.revisionId, docSig: await docSig(doc), pushedAt: now, viewOnly: !canEdit,
    };
    await dbPut([[bookKey(b.id), b], ...tabs.map((t, i) => ['tab:' + t.id, sheets[i].html])]);
    toast(`Opened "${doc.title}" as a new book, ${tabs.length} sheet${tabs.length === 1 ? '' : 's'}${canEdit ? '' : '. You can only view it, so it is read-only here'}.`);
    switchBook(b.id);
  } catch (e) {
    toast('Could not open the Doc: ' + e.message);
  }
}

// Takes the Google Doc's version of every tab: matching sheets are replaced, new tabs become sheets.
// Replaces the sheets with the Doc's tabs. Sheets in `keep` (Io edits not yet in the Doc) stay as "(Io version)" copies.
async function loadDoc(keep = [], doc) {
  await flush();
  doc ||= await fullDoc(book.docId);
  const now = Date.now(), puts = [];
  for (const t of keep) {
    const c = { ...t, id: uid(), kind: 'notes', name: t.name + ' (Io version)', rev: uid(), baseRev: null, docTab: null, tabTitle: null, syncedAt: 0, pushedAt: 0 };
    puts.push(['tab:' + c.id, await tabHtml(t)]);
    book.tabs.push(c);
  }
  for (const s of docSheets(doc, {})) {
    if ((book.dropTabs || []).includes(s.tabId)) continue;
    if (dupTab(s.tabId, s.title)) { if (!book.linked) book.dropTabs = [...(book.dropTabs || []), s.tabId]; continue; }
    let t = book.tabs.find(x => x.docTab === s.tabId);
    if (!t) { t = { id: uid(), kind: 'notes', fixes: 0, docTab: s.tabId }; book.tabs.push(t); }
    addPast(t, t.rev, t.baseRev);
    Object.assign(t, { name: s.title.slice(0, 60), tabTitle: s.title.slice(0, 60), nameAt: now, rev: uid(), updatedAt: now, syncedAt: now, pushedAt: now });
    puts.push(['tab:' + t.id, s.html]);
    editors[t.id]?.remove();
    delete editors[t.id];
  }
  Object.assign(book, { revisionId: doc.revisionId, docSig: await docSig(doc), conflict: false, pushedAt: now });
  G.pulledAt = now;
  await dbPut([...puts, [bookKey(), book]]);
  await openTab(book.active);
  renderSync();
  renderDocLinks();
}

// First thing on open (and on coming back to Io): if the Doc was changed in Google, load it.
// Returns 'same' (Io has the latest), 'loaded', or nothing (not checked, or Io's version kept).
async function pullDoc() {
  G.pulledAt = 0;
  if (!book.docId || !book.revisionId || book.linked && !hasDocs()) return;
  let doc;
  try { doc = await getDoc(book.docId, 'revisionId'); }
  catch (e) { if (e.status === 404) return; throw e; }
  const c = doc.revisionId !== book.revisionId && await docChanged();
  // Another device's save: its data file brings the Doc's new state, now or at the next sync.
  if (c?.other) {
    await syncData(false);
    if (book.revisionId === c.doc.revisionId) { G.pulledAt = Date.now(); return 'same'; }
    return;
  }
  if (!c || !c.changed) {
    // Not changed (Google can move the revisionId with no edit): note it, and clear an old warning.
    if (c) Object.assign(book, { revisionId: c.doc.revisionId, docSig: await docSig(c.doc) });
    book.conflict = false;
    G.pulledAt = Date.now();
    return 'same';
  }
  const mine = book.viewOnly ? [] : book.tabs.filter(t => t.docTab && t.updatedAt > (t.syncedAt || 0));
  if (mine.length && !await ask({
    title: 'Changed in Google Docs',
    text: `"${docName()}" was changed in Google Docs, and ${mine.length === 1 ? `the sheet "${mine[0].name}" has` : `${mine.length} sheets have`} edits here not yet saved to it. Load from Google? Io's version${mine.length === 1 ? ' is' : 's are'} kept as "(Io version)" sheets. Or keep Io's, and Save overwrites the Doc.`,
    ok: 'Load from Google', cancel: "Keep Io's",
  })) { book.conflict = true; return; }
  await loadDoc(mine, mine.length ? null : c.doc);
  toast('Loaded the latest from Google Docs.');
  return 'loaded';
}

async function reloadFromDoc() {
  if (!book.docId) return;
  if (!await ask({ title: 'Load from Google?', text: `Replace this book's sheets with what is in "${docName()}" now? Edits made in Io since it was last saved to Google will be lost. Sheets with no tab in the Doc stay.`, ok: 'Load from Google', danger: true })) return;
  try {
    if (!G.valid() || book.linked && !hasDocs()) await signIn(book.linked ? SCOPE_DOCS : wantScope());
    await loadDoc();
    toast('Loaded from Google.');
  } catch (e) {
    toast('Could not load the Doc: ' + e.message);
  }
}

const emptyLi = text => Object.assign(document.createElement('li'), { className: 'empty', textContent: text });
let listSeq = 0;
async function listDocs(q) {
  const list = $('#openList'), seq = ++listSeq;
  list.replaceChildren(emptyLi('Loading…'));
  let query = `mimeType='${GDOC}' and trashed=false`;
  if (q) query += ` and name contains '${q.replace(/[\\']/g, '\\$&')}'`;
  try {
    const r = await gfetch('GET', `${DRIVE}/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&pageSize=100&fields=files(id,name,modifiedTime)`);
    const mine = await localBooks();
    if (seq !== listSeq) return;
    const f = document.createDocumentFragment();
    for (const d of r.files) {
      const t = mine.find(x => x.docId === d.id);
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span class="t"></span><span class="pg"></span>';
      b.firstChild.textContent = d.name;
      b.lastChild.textContent = t ? (t.id === book.id ? 'open now' : 'Io book') : when(Date.parse(d.modifiedTime));
      b.addEventListener('click', () => { $('#open').close(); openDocFile(d); });
      li.append(b);
      f.append(li);
    }
    if (!r.files.length) f.append(emptyLi(q ? 'No Docs match.' : 'No Google Docs found.'));
    list.replaceChildren(f);
  } catch (e) {
    if (seq === listSeq) list.replaceChildren(emptyLi('Could not list your Docs: ' + e.message));
  }
}

async function openDocs() {
  if (!navigator.onLine) return toast('Offline. Opening a Google Doc needs a connection.');
  if (!hasDocs()) {
    pref.set('docsAccess', true);
    try { await signIn(SCOPE_DOCS); } catch (e) { return toast(e.message); }
    if (!hasDocs()) return toast('Io needs permission to see and edit your Google Docs. Tick both boxes when Google asks.');
  }
  $('#openQ').value = '';
  $('#open').showModal();
  listDocs('');
}

async function localBooks() {
  const d = await idb;
  const all = await new Promise((res, rej) => {
    const q = d.transaction('kv').objectStore('kv').getAll(IDBKeyRange.bound('book:', 'book:\uffff'));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  return all.map(b => b.id === book?.id ? book : b)
    .map(b => ({ id: b.id, title: b.title, dataId: b.dataId, docId: b.docId, at: Math.max(0, ...b.tabs.map(t => t.updatedAt || 0)) }))
    .sort((a, b) => b.at - a.at);
}

async function switchBook(id) {
  if (id === book.id) return $('#books').close();
  $('#books').close();
  toast('Saving…');
  await flush();
  clearTimeout(timers.book);
  await dbPut([[bookKey(), book]]);
  if (G.valid() && navigator.onLine) await pushAll(false);
  pref.set('bookId', id);
  location.reload();
}

async function newBookCmd() {
  const title = await ask({ title: 'New book', text: 'It gets its own sheets: Manuscript, Characters and Timeline.', value: 'Untitled book', ok: 'Create' });
  if (!title) return;
  const b = newBook();
  Object.assign(b, { title, titleAt: Date.now() });
  await dbPut([[bookKey(b.id), b]]);
  switchBook(b.id);
}

async function openDriveBook(f, id) {
  const b = newBook();
  Object.assign(b, { id, title: f.appProperties?.title || 'Io book', dataId: f.id });
  await dbPut([[bookKey(id), b]]);
  switchBook(id);
}

async function deleteBook(b) {
  const text = b.dataId
    ? `Delete "${b.title}" from this device? Its copy in Google Drive and its Google Doc stay, and it can be opened again from this list.`
    : `Delete "${b.title}"? It was never saved to Google, so this cannot be undone. Download a backup first if you might want it.`;
  if (!await ask({ title: 'Delete book?', text, ok: 'Delete', danger: true })) return;
  const full = await dbGet(bookKey(b.id));
  await dbPut([[bookKey(b.id), undefined], ...(full?.tabs || []).map(t => ['tab:' + t.id, undefined])]);
  openBooks();
}

function bookRow(label, note, onOpen, onDelete) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = '<span class="t"></span><span class="pg"></span>';
  b.firstChild.textContent = label;
  b.lastChild.textContent = note;
  b.addEventListener('click', onOpen);
  li.append(b);
  if (onDelete) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'book-del';
    x.textContent = '×';
    x.title = 'Delete ' + label;
    x.setAttribute('aria-label', x.title);
    x.addEventListener('click', onDelete);
    li.append(x);
  }
  return li;
}

let booksSeq = 0;
async function renderBooks() {
  const list = $('#bookList'), seq = ++booksSeq;
  const mine = await localBooks();
  const f = document.createDocumentFragment();
  for (const b of mine) f.append(bookRow(b.title, b.id === book.id ? 'open now' : b.at ? when(b.at) : 'new', () => switchBook(b.id), b.id !== book.id && (() => deleteBook(b))));
  list.replaceChildren(f);
  if (!G.valid() || !navigator.onLine) return;
  try {
    const q = encodeURIComponent(`name contains 'Io data' and trashed=false`);
    const r = await gfetch('GET', `${DRIVE}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,appProperties,modifiedTime)`);
    if (seq !== booksSeq) return;
    for (const d of r.files) {
      const id = d.appProperties?.ioBook || (d.name === DATA_NAME ? 'main' : null);
      if (!id || mine.some(b => b.id === id || b.dataId === d.id)) continue;
      list.append(bookRow(d.appProperties?.title || 'Io book', 'on Google Drive', () => openDriveBook(d, id)));
    }
  } catch {}
}

function openBooks() {
  renderBooks();
  if (!$('#books').open) $('#books').showModal();
}

function ask({ title, text = '', value = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const d = $('#ask'), inp = $('#askInput'), okb = $('#askOk'), cb = $('#askCancel');
  $('#askTitle').textContent = title;
  $('#askText').textContent = text;
  $('#askText').hidden = !text;
  inp.hidden = value === null;
  inp.value = value ?? '';
  okb.textContent = ok;
  okb.classList.toggle('danger', danger);
  cb.textContent = cancel || '';
  cb.hidden = !cancel;
  d.returnValue = '';
  d.showModal();
  if (value !== null) inp.select(); else okb.focus();
  return new Promise(res => d.addEventListener('close', () => {
    const yes = d.returnValue === 'ok';
    res(value === null ? yes : (yes && inp.value.trim()) || null);
  }, { once: true }));
}

function toast(msg) {
  el.banner.textContent = msg;
  el.banner.hidden = false;
  later('toast', 4000, () => { if (!el.banner.dataset.sticky) el.banner.hidden = true; });
}

function renderAccount() {
  const on = G.valid(), was = pref.get('signedIn', false), who = pref.get('googleEmail', '');
  const more = wantScope() === SCOPE_DOCS && !hasDocs();
  const b = $('#connectBtn');
  b.hidden = on && !more;
  b.textContent = on ? 'Allow access to your Google Docs' : was ? 'Sign in to Google again' : 'Sign in to Google';
  $('#gWho').textContent = on ? 'Signed in' + (who ? ' as ' + who : '') + '.' : was ? 'Google sign-in has expired.' : 'Not signed in.';
}

function openMenu() {
  renderAccount();
  renderDocLinks();
  renderBackup();
  el.menu.showModal();
}

function wire() {
  el.tools.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  el.tools.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (b) run(b.dataset.cmd); });
  document.addEventListener('selectionchange', () => { keepRange(); later('tools', 80, () => { updateTools(); renderWords(); renderSelPop(); }); });
  el.scroller.addEventListener('scroll', onScroll, { passive: true });
  el.scroller.addEventListener('scroll', () => { if (!$('#selPop').hidden) later('selpop', 50, renderSelPop); }, { passive: true });
  window.visualViewport?.addEventListener('resize', () => later('selpop', 50, renderSelPop));
  document.addEventListener('pointerdown', e => { touchy = e.pointerType !== 'mouse'; }, true);
  el.stage.addEventListener('contextmenu', e => { if (touchy) e.preventDefault(); });
  let lastTap = null, press = null;
  const endPress = () => { clearTimeout(press?.timer); press = null; };
  el.stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const t = { x: e.clientX, y: e.clientY, at: e.timeStamp };
    wordTap = !!lastTap && t.at - lastTap.at < 400 && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 30;
    lastTap = wordTap ? null : t;
    endPress();
    press = { x: t.x, y: t.y, timer: setTimeout(() => { wordTap = true; renderSelPop(); }, 500) };
    later('selpop', 150, renderSelPop);
  });
  el.stage.addEventListener('pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) endPress(); });
  for (const ev of ['pointerup', 'pointercancel']) el.stage.addEventListener(ev, endPress);
  const selPop = $('#selPop');
  for (const t of ['pointerdown', 'mousedown']) selPop.addEventListener(t, e => { if (e.target.closest('button')) e.preventDefault(); });
  selPop.addEventListener('click', e => { const b = e.target.closest('[data-cmd], [data-clip]'); if (b) b.dataset.clip ? clip(b.dataset.clip) : run(b.dataset.cmd); });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.pop-menu, [data-menu], #menuBtn')) hidePops(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePops(); });
  const more = $('#morePop');
  more.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    hidePops();
    ({ mRead: () => setReading(!reading()), mBooks: openBooks, mSpell: () => setSpell(!pref.get('spell', false)), mSettings: openMenu })[b.id]?.();
  });

  el.toc.addEventListener('click', e => {
    const b = e.target.closest('button');
    const h = b && layoutInfo.heads[b.dataset.i];
    if (h && b.classList.contains('ch-sel')) { selectChapter(+b.dataset.i); closeNavOnPhone(); }
    else if (h) { goTo(h.el, false); closeNavOnPhone(); }
  });
  el.fixes.addEventListener('click', e => {
    const b = e.target.closest('button');
    const n = b && fixNodes[b.dataset.i];
    if (n) { fixIdx = +b.dataset.i; goTo(n, true, true); flash(n); closeNavOnPhone(); }
  });
  $('#nextFix').addEventListener('click', () => {
    if (!fixNodes.length) return;
    fixIdx = (fixIdx + 1) % fixNodes.length;
    const n = fixNodes[fixIdx];
    if (n.isConnected) { goTo(n, true, true); flash(n); }
  });

  $('#readBtn').addEventListener('click', () => setReading(true));
  $('#readDone').addEventListener('click', () => setReading(false));
  const rpop = $('#readPop'), aa = $('#readAa');
  const showRead = on => {
    rpop.hidden = !on;
    aa.setAttribute('aria-expanded', on);
    if (!on) return;
    const r = aa.getBoundingClientRect();
    rpop.style.left = Math.max(8, Math.min(r.right - rpop.offsetWidth, innerWidth - rpop.offsetWidth - 8)) + 'px';
    rpop.style.top = r.bottom + 4 + 'px';
  };
  aa.addEventListener('click', () => showRead(rpop.hidden));
  rpop.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  document.addEventListener('pointerdown', e => { if (!rpop.hidden && !rpop.contains(e.target) && !aa.contains(e.target)) showRead(false); });
  $('#readSmaller').addEventListener('click', () => setReadSize(-1));
  $('#readBigger').addEventListener('click', () => setReadSize(1));
  for (const b of document.querySelectorAll('button[data-read]')) b.addEventListener('click', () => { pref.set('readTheme', b.dataset.read); setReadTheme(b.dataset.read); });
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === 'KeyR') { e.preventDefault(); setReading(!reading()); }
    else if (e.key === 'Escape' && !rpop.hidden) showRead(false);
    else if (e.key === 'Escape' && reading() && $('#colorPop').hidden && !document.querySelector('dialog[open]')) setReading(false);
  });
  $('#navToggle').addEventListener('click', () => {
    if (matchMedia('(max-width: 900px)').matches) el.shell.classList.toggle('nav-open');
    else { el.shell.classList.toggle('nav-hidden'); if (!reading()) pref.set('navHidden', el.shell.classList.contains('nav-hidden')); later('layout', 50, layout); }
  });

  const tabPop = $('#tabPop');
  const tabMenu = (id, anchor) => { if (book.viewOnly || reading()) return; tabPop.dataset.id = id; showPop(tabPop, anchor); };
  el.tabs.addEventListener('click', e => {
    const m = e.target.closest('[data-menu]');
    if (m) return tabMenu(m.dataset.menu, m);
    const b = e.target.closest('.tab');
    if (b && b.dataset.id !== book.active) openTab(b.dataset.id);
  });
  el.tabs.addEventListener('dblclick', e => { const b = e.target.closest('.tab'); if (b && !e.target.closest('[data-menu]') && !book.viewOnly && !reading()) renameTab(b.dataset.id); });
  el.tabs.addEventListener('contextmenu', e => { const b = e.target.closest('.tab'); if (b) { e.preventDefault(); tabMenu(b.dataset.id, b); } });
  $('#tabRename').addEventListener('click', () => { hidePops(); renameTab(tabPop.dataset.id); });
  $('#tabDelete').addEventListener('click', () => { hidePops(); deleteTab(tabPop.dataset.id); });
  $('#addTab').addEventListener('click', async () => {
    const name = await ask({ title: 'New sheet', value: 'Notes', ok: 'Add' });
    if (!name) return;
    const t = { id: uid(), name: name.slice(0, 60), kind: 'notes', rev: uid(), updatedAt: Date.now(), syncedAt: 0, fixes: 0 };
    book.tabs.push(t);
    openTab(t.id);
  });

  el.title.addEventListener('input', () => { book.title = el.title.value.trim() || 'Untitled book'; book.titleAt = Date.now(); document.title = book.title + ' - Io'; saveBook(); later('sync', 500, renderSync); });

  $('#zoomIn').addEventListener('click', () => stepZoom(1));
  $('#zoomOut').addEventListener('click', () => stepZoom(-1));
  el.zoomVal.addEventListener('click', () => setZoom(1));
  el.scroller.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    if (e.key.toLowerCase() === 's') { e.preventDefault(); flush().then(() => pushAll(true)); }
    else if (e.key.toLowerCase() === 'o') { e.preventDefault(); openDocs(); }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(1); }
    else if (e.key === '-') { e.preventDefault(); stepZoom(-1); }
    else if (e.key === '0' && !e.shiftKey) { e.preventDefault(); setZoom(1); }
  });

  $('#booksBtn').addEventListener('click', openBooks);
  $('#newBookBtn').addEventListener('click', () => { $('#books').close(); newBookCmd(); });
  $('#openDocBtn').addEventListener('click', () => { $('#books').close(); openDocs(); });
  $('#openQ').addEventListener('input', e => later('openq', 300, () => listDocs(e.target.value.trim())));
  $('#openQ').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  document.addEventListener('click', renewOnClick, true);
  $('#askInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#ask').close('ok'); } });
  $('#menuBtn').addEventListener('click', e => {
    if (!phone()) return openMenu();
    if (!more.hidden) return hidePops();
    $('#mRead').textContent = reading() ? 'Back to writing' : 'Read';
    showPop(more, e.currentTarget);
  });
  $('#spellBtn').addEventListener('click', () => setSpell(!pref.get('spell', false)));
  const pop = $('#colorPop'), cbtn = $('#colorBtn');
  const showColors = on => {
    pop.hidden = !on;
    cbtn.setAttribute('aria-expanded', on);
    if (!on) return;
    const r = cbtn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = r.bottom + 4 + 'px';
  };
  const paint = c => { showColors(false); c ? run(c) : run('color', ''); };
  cbtn.addEventListener('click', () => showColors(pop.hidden));
  pop.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  pop.addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) paint(b.dataset.color); });
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && !cbtn.contains(e.target)) showColors(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) showColors(false); });
  $('#connectBtn').addEventListener('click', () => { signIn().then(() => toast('Signed in to Google.'), e => toast(e.message)); });
  $('#pullBtn').addEventListener('click', () => {
    if (!G.valid()) return signIn().then(() => pushAll(false), e => toast(e.message));
    G.fresh = true; G.freshAt = Date.now(); pushAll(true);
  });
  $('#updateBtn').addEventListener('click', checkUpdate);
  $('#backupBtn').addEventListener('click', backup);
  $('#restoreBtn').addEventListener('click', openBackups);
  document.addEventListener('click', () => autoBackup(), true);
  $('#restoreFile').addEventListener('change', e => { $('#backups').close(); if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });

  addEventListener('online', () => { renderSync(); pushAll(false); });
  addEventListener('offline', renderSync);
  addEventListener('resize', () => later('layout', 200, () => {
    const z = startZoom();
    if (Math.abs(z - zoom) > .005 && (pref.get('zoom', null) === null || z < zoom)) setZoom(z, true, false);
    layout();
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timers.book); book.docsAt = 0; dbPut([[bookKey(), book]]).then(flush).then(() => { pushAll(false); autoBackup(); }); }
    else if (!renewByPage()) { if (!checkDoc()) pushAll(false); autoBackup(); }
  });
  // Coming back from another window (Google Docs side by side) fires focus but not visibilitychange.
  addEventListener('focus', () => { if (!document.hidden) checkDoc(); });
  addEventListener('pagehide', flush);
  setInterval(() => { if (!document.hidden) pushAll(false); autoBackup(); }, PUSH_EVERY);
}

function closeNavOnPhone() { el.shell.classList.remove('nav-open'); }

async function deleteTab(id) {
  const t = tabById(id);
  if (!t) return;
  if (book.tabs.length === 1) return void ask({ title: 'Last sheet', text: 'A book needs at least one sheet. Add another first, or delete the whole book from Books.', cancel: null });
  if (!await ask({ title: 'Delete sheet?', text: `Delete the sheet "${t.name}" from this book, on every device? This cannot be undone in Io.${t.docTab ? ' Its tab is removed from the Google Doc at the next save; Google keeps it in the version history.' : ''}`, ok: 'Delete', danger: true })) return;
  const i = book.tabs.indexOf(t);
  dirty.delete(id);
  editors[id]?.remove();
  delete editors[id];
  book.tabs = book.tabs.filter(x => x.id !== id);
  book.deleted = { ...book.deleted, [id]: Date.now() };
  book.delRevs = { ...book.delRevs, [id]: [t.rev, ...(t.past || []).slice(-49)].filter(Boolean) };
  if (t.docTab) book.dropTabs = [...(book.dropTabs || []), t.docTab];
  if (t.kind === 'ms' && !book.tabs.some(x => x.kind === 'ms')) book.tabs[0].kind = 'ms';
  await dbPut([['tab:' + id, undefined]]);
  await openTab(book.active === id ? book.tabs[Math.max(0, i - 1)].id : book.active);
  renderSync();
}

async function renameTab(id) {
  const t = tabById(id);
  const name = t && await ask({ title: 'Rename sheet', value: t.name, ok: 'Rename' });
  if (!name) return;
  t.name = name.slice(0, 60);
  t.nameAt = Date.now();
  editors[t.id]?.setAttribute('aria-label', t.name);
  saveBook();
  renderTabs();
  renderSync();
}

// App updates. sw.js installs a new version in the background (skipWaiting + claim), then the page
// reloads into it: by itself in the first 20 seconds if nothing was typed, otherwise from the banner
// or Settings > Check for updates. Saves first.
let typed = false, swReg = null, updateReady = false, updateWanted = false;
const openedAt = Date.now();
async function applyUpdate() {
  el.stage.inert = true;
  clearTimeout(timers.book);
  await flush();
  await dbPut([[bookKey(), book]]);
  location.reload();
}
function askVersion() { navigator.serviceWorker?.controller?.postMessage('version'); }
function wireUpdates() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.version) $('#ioVersion').textContent = e.data.version.replace('io-shell-', 'Version '); });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    askVersion();
    if (!had && !updateWanted) return;
    if (updateWanted || Date.now() - openedAt < 20000 && !typed) return applyUpdate();
    updateReady = true;
    renderUpdate();
    el.banner.textContent = 'A new version of Io is ready. Click here to update.';
    el.banner.dataset.sticky = '1';
    el.banner.dataset.update = '1';
    el.banner.hidden = false;
  });
  el.banner.addEventListener('click', () => { if (el.banner.dataset.update) applyUpdate(); });
  navigator.serviceWorker.register('sw.js').then(r => {
    swReg = r;
    askVersion();
    if (navigator.onLine) r.update().catch(() => {});
  });
}
function renderUpdate(note = '') {
  $('#updateBtn').textContent = updateReady ? 'Update now' : 'Check for updates';
  $('#updateText').textContent = note;
}
async function checkUpdate() {
  if (updateReady) return applyUpdate();
  if (!swReg) return renderUpdate('Updates need Io to be opened from its web address.');
  if (!navigator.onLine) return renderUpdate('Offline. Check again when you are online.');
  renderUpdate('Checking…');
  updateWanted = true;
  try { await swReg.update(); } catch { updateWanted = false; return renderUpdate('Could not reach the Io website.'); }
  if (swReg.installing || swReg.waiting) return renderUpdate('Updating…');
  updateWanted = false;
  renderUpdate('Io is up to date.');
}

function singleWindow() {
  if (!navigator.locks) return;
  navigator.locks.request('io-main', { ifAvailable: true }, lock => {
    if (lock) return new Promise(() => {});
    el.banner.textContent = 'Io is already open in another window. Write in one window only, or one will overwrite the other.';
    el.banner.dataset.sticky = '1';
    el.banner.hidden = false;
  });
}

async function init() {
  document.execCommand('defaultParagraphSeparator', false, 'p');
  document.execCommand('styleWithCSS', false, false);
  book = await dbGet(bookKey(pref.get('bookId', 'main')));
  const old = await dbGet('book');
  if (old && await dbGet(bookKey('main'))) await dbPut([['book', undefined]]);
  else if (old && !book) {
    book = { ...old, id: 'main' };
    await dbPut([[bookKey(), book], ['book', undefined]]);
  }
  if (!book) {
    const first = (await localBooks())[0];
    book = first && await dbGet(bookKey(first.id));
  }
  if (!book) { book = { ...newBook(), id: 'main' }; await dbPut([[bookKey(), book]]); }
  pref.set('bookId', book.id);
  if (!tabById(book.active)) book.active = book.tabs[0].id;
  migrateDocs();
  el.title.value = book.title;
  el.title.readOnly = !!book.viewOnly;
  document.documentElement.classList.toggle('view-only', !!book.viewOnly);
  document.title = book.title + ' - Io';
  setSpell(pref.get('spell', false));
  if (pref.get('navHidden', false)) el.shell.classList.add('nav-hidden');
  setZoom(startZoom(), false, false);
  wire();
  singleWindow();
  await openTab(book.active);
  if (pref.get('readSize', 0)) document.documentElement.style.setProperty('--read-size', pref.get('readSize', 20) + 'px');
  if (pref.get('reading', false) || book.viewOnly) setReading(true);
  navigator.storage?.persist?.();
  wireUpdates();
  if (signInReturn() === null && renewByPage()) return;
  if (navigator.onLine && pref.get('signedIn', false) && !pageSignIn()) loadGis().catch(() => {});
  if (navigator.onLine && G.valid()) pushAll(false);
  renderSync();
  autoBackup();
}

init();
