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
const DOCS_EVERY = 15 * 60000;
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DATA_NAME = 'Io data.json.gz';
const CLIENT_ID = '257581565054-a3i5pvi1akkcq2s9i7rt4jp140pdh7rm.apps.googleusercontent.com';

const $ = s => document.querySelector(s);
const el = {
  stage: $('#stage'), scroller: $('#scroller'), shell: $('.shell'),
  toc: $('#toc'), fixes: $('#fixes'), fixCount: $('#fixCount'), tabs: $('#tabs'),
  title: $('#title'), tools: $('#tools'), syncBtn: $('#syncBtn'), menu: $('#menu'),
  stEdited: $('#stEdited'), stWords: $('#stWords'), stPage: $('#stPage'), stSync: $('#stSync'),
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

function serialize(ed) {
  return ed.innerHTML.replace(/ style="[^"]*"/g, '');
}

function saveBook() {
  later('book', 300, () => dbPut([['book', book]]));
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
  entries.push(['book', book]);
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
    ed.contentEditable = 'true';
    ed.spellcheck = true;
    ed.setAttribute('role', 'textbox');
    ed.setAttribute('aria-multiline', 'true');
    ed.setAttribute('aria-label', t.name);
    ed.innerHTML = (await dbGet('tab:' + id)) || starter(t);
    ed.addEventListener('input', onInput);
    ed.addEventListener('paste', onPaste);
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
  const text = e.clipboardData.getData('text/plain');
  if (!text) return;
  const parts = text.replace(/\r\n?/g, '\n').split(/\n/);
  if (parts.length === 1) return void document.execCommand('insertText', false, text);
  const html = parts.map(p => `<p>${esc(p) || '<br>'}</p>`).join('');
  document.execCommand('insertHTML', false, html);
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
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
  const f = markAt(sel) && n.parentNode.closest?.('font');
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

function run(c) {
  const ed = curEd();
  if (!ed) return;
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
    case 'edit': case 'remove': case 'fix':
      if (sel.isCollapsed && !selectWordAt(sel)) return;
      if (markAt(sel) === c) clearMarks();
      else document.execCommand('foreColor', false, MARKS[c]);
      break;
    case 'clear':
      clearMarks(); break;
  }
  updateTools();
}

function markOf(font) {
  const col = (font.getAttribute('color') || '').toLowerCase();
  for (const k in MARKS) if (MARKS[k] === col) return k;
  return null;
}

function markAt(sel) {
  let n = sel.anchorNode;
  const ed = curEd();
  while (n && n !== ed) {
    if (n.nodeName === 'FONT') return markOf(n);
    n = n.parentNode;
  }
  return null;
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
  document.execCommand('foreColor', false, getComputedStyle(ed).color);
}

function updateTools() {
  const ed = curEd(), sel = getSelection();
  if (!ed || !sel.rangeCount || !ed.contains(sel.anchorNode)) return;
  let n = sel.anchorNode;
  while (n && n.parentNode !== ed) n = n.parentNode;
  const h = n && n.nodeName === 'H1';
  const m = markAt(sel);
  const on = {
    heading: h, body: !h,
    bold: document.queryCommandState('bold'),
    italic: document.queryCommandState('italic'),
    underline: document.queryCommandState('underline'),
    edit: m === 'edit', remove: m === 'remove', fix: m === 'fix',
  };
  for (const b of el.tools.querySelectorAll('[data-cmd]')) {
    if (b.dataset.cmd in on) b.setAttribute('aria-pressed', on[b.dataset.cmd] ? 'true' : 'false');
  }
}

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
    li.append(b);
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
    el.stPage.textContent = curTab().kind === 'ms' && idx >= 0 ? `Chapter ${idx + 1} of ${heads.length}` : '';
    later('scrollpos', 400, () => pref.set('scroll.' + book.active, el.scroller.scrollTop));
  });
}

function meta() {
  const ed = curEd(), t = curTab();
  if (!ed) return;
  let words = 0;
  for (const b of ed.children) words += ((b.querySelector('br') ? b.innerText : b.textContent).match(/[^\s—–-]+/g) || []).length;
  el.stWords.textContent = words.toLocaleString('en-GB') + (words === 1 ? ' word' : ' words');
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
    if (t.kind !== 'ms' && t.id === book.active) {
      const x = document.createElement('span');
      x.className = 'x';
      x.dataset.del = t.id;
      x.textContent = '×';
      x.title = 'Delete this sheet';
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

const FONTS = { aptos: 'var(--font-aptos)', calibri: 'var(--font-calibri)', whitney: 'var(--font-whitney)' };
function setFont(f) {
  if (!FONTS[f]) f = 'aptos';
  document.documentElement.style.setProperty('--font', FONTS[f]);
  pref.set('font', f);
  $('#fontSel').value = f;
  later('layout', 100, layout);
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

async function autoDir(ask) {
  const dir = await dbGet('backupDir');
  if (!dir) return null;
  let p = await dir.queryPermission({ mode: 'readwrite' });
  if (p === 'prompt' && ask && !autoDir.asked) {
    autoDir.asked = true;
    p = await dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
  }
  return p === 'granted' ? dir : null;
}

async function autoBackup(force = false, gesture = false) {
  if (!window.showDirectoryPicker || autoBackup.busy) return;
  const last = pref.get('autoLast', null);
  if (!force && last && (Date.now() - last.at < AUTO_EVERY || last.sig === autoSig())) return;
  autoBackup.busy = true;
  try {
    if (force) autoDir.asked = false;
    const dir = await autoDir(gesture || force);
    if (!dir) { renderBackup(); return; }
    const sig = autoSig(), blob = await gzip(await backupData());
    const name = `${fileBase()} ${day(new Date())}.io.json.gz`;
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob);
    await w.close();
    pref.set('autoLast', { at: Date.now(), sig, size: blob.size, name });
    const old = [];
    for await (const [n, h] of dir.entries()) if (h.kind === 'file' && n.endsWith('.io.json.gz')) old.push(n);
    old.sort((a, b) => b.slice(-21).localeCompare(a.slice(-21)));
    for (const n of old.slice(AUTO_KEEP)) await dir.removeEntry(n).catch(() => {});
    if (force) toast(`Backed up to ${dir.name}/${name} (${kb(blob.size)}).`);
  } catch (e) {
    if (force) toast('Backup failed: ' + e.message);
  } finally {
    autoBackup.busy = false;
    renderBackup();
  }
}

const kb = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

async function chooseBackupDir() {
  try {
    const dir = await showDirectoryPicker({ id: 'io-backup', mode: 'readwrite', startIn: 'documents' });
    await dbPut([['backupDir', dir]]);
    pref.set('autoLast', null);
    autoBackup(true, true);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
}

async function stopBackups() {
  await dbPut([['backupDir', undefined]]);
  pref.set('autoLast', null);
  renderBackup();
}

async function renderBackup() {
  const box = $('#autoBackup');
  if (!window.showDirectoryPicker) { box.innerHTML = '<p class="hint">Automatic backups to a folder work in Chrome or Edge on a computer. On this device, your copy in Google is the backup.</p>'; return; }
  const dir = await dbGet('backupDir');
  const last = pref.get('autoLast', null);
  const ok = dir && await dir.queryPermission({ mode: 'readwrite' }) === 'granted';
  $('#autoText').textContent = !dir ? 'Io can save a backup to a folder you pick (OneDrive, a USB stick) every hour while you write. One file a day, the last 30 days kept.'
    : `Backing up to the folder "${dir.name}" every hour while you write. One file a day, the last ${AUTO_KEEP} days kept.`
      + (last ? ` Last backup ${when(last.at)}, ${kb(last.size)}.` : '')
      + (ok ? '' : ' Click anywhere in Io to let it write there again.');
  $('#backupDirBtn').textContent = dir ? 'Change folder' : 'Choose backup folder';
  $('#backupNowBtn').hidden = $('#backupStopBtn').hidden = !dir;
}

async function restore(file) {
  let data;
  const notBackup = () => ask({ title: 'Not an Io backup', text: 'That file is not an Io backup.', cancel: null });
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    data = JSON.parse(head[0] === 0x1f && head[1] === 0x8b ? await gunzip(file) : await file.text());
  } catch { return notBackup(); }
  if (!data || data.io !== 1 || !data.book?.tabs) return notBackup();
  if (!await ask({ title: 'Restore backup?', text: `Replace everything in Io with the backup from ${when(data.savedAt)}? Download a backup of the current version first if you might want it.`, ok: 'Restore', danger: true })) return;
  const entries = [['book', data.book]];
  for (const t of data.book.tabs) entries.push(['tab:' + t.id, data.tabs[t.id] || '']);
  for (const t of book.tabs) if (!data.book.tabs.some(x => x.id === t.id)) entries.push(['tab:' + t.id, undefined]);
  dirty.clear();
  await dbPut(entries);
  location.reload();
}

const G = {
  token: null,
  exp: 0,
  busy: false,
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

const wantScope = () => pref.get('docsAccess', false) || book.tabs.some(t => t.linked) ? SCOPE_DOCS : SCOPE;
const hasDocs = () => G.valid() && SCOPE_DOCS.split(' ').every(x => (G.scope || '').split(' ').includes(x));

async function signIn(scope = wantScope()) {
  await loadGis();
  return new Promise((res, rej) => {
    const c = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope,
      hint: pref.get('googleEmail', ''),
      callback: r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        G.token = r.access_token;
        G.exp = Date.now() + r.expires_in * 1000;
        G.scope = r.scope || scope;
        try { localStorage.setItem('io.token', JSON.stringify({ token: G.token, exp: G.exp, scope: G.scope })); } catch {}
        pref.set('signedIn', true);
        renderSync();
        res();
        if (!pref.get('googleEmail', '')) gfetch('GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)').then(a => pref.set('googleEmail', a.user.emailAddress), () => {});
      },
      error_callback: e => rej(new Error(e.message || 'Sign-in was closed.')),
    });
    c.requestAccessToken({ prompt: '' });
  });
}

function renewOnClick() {
  if (G.renewing || G.busy || G.valid() || !pref.get('signedIn', false) || !navigator.onLine || !window.google?.accounts?.oauth2) return;
  G.renewing = true;
  signIn().then(() => pushAll(false), () => renderSync()).finally(() => { G.renewing = false; });
}

async function gfetch(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + G.token, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (r.status === 401) { dropToken(); throw Object.assign(new Error('Google sign-in expired.'), { status: 401 }); }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error.message; } catch {}
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.json();
}

async function gblob(method, url, body, type) {
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + G.token, ...(type && { 'Content-Type': type }) }, body });
  if (r.status === 401) { dropToken(); throw Object.assign(new Error('Google sign-in expired.'), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(r.statusText || 'Drive error ' + r.status), { status: r.status });
  return r;
}
const gzip = str => new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const gunzip = blob => new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

const SHARED = ['id', 'name', 'nameAt', 'kind', 'rev', 'updatedAt', 'fixes', 'docId', 'docTitle', 'revisionId', 'syncedAt', 'pushedAt', 'linked'];
const shareBook = () => ({
  title: book.title, titleAt: book.titleAt || 0, deleted: book.deleted || {},
  tabs: book.tabs.map(t => Object.fromEntries(SHARED.map(k => [k, t[k] ?? null]))),
});
const sigOf = b => JSON.stringify([b.title, Object.keys(b.deleted || {}).sort(), b.tabs.map(t => [t.id, t.rev || null, t.name, t.pushedAt || 0])]);
const tabHtml = async t => editors[t.id] ? serialize(editors[t.id]) : (await dbGet('tab:' + t.id)) || starter(t);

async function mergeData(remote) {
  const rb = remote.book, puts = [];
  let shown = false;
  const drop = id => {
    editors[id]?.remove();
    delete editors[id];
    dirty.delete(id);
    book.tabs = book.tabs.filter(t => t.id !== id);
    puts.push(['tab:' + id, undefined]);
  };
  if (!book.dataSig) for (const t of [...book.tabs]) if (!t.rev && !t.docId) drop(t.id);
  book.deleted = { ...rb.deleted, ...book.deleted };
  for (const id in book.deleted) {
    const t = tabById(id);
    if (!t) continue;
    if (t.rev === t.baseRev) { drop(id); continue; }
    const html = await tabHtml(t), c = { ...t, id: uid(), name: t.name + ' (deleted on other device)', linked: null, docId: null, docTitle: null, revisionId: null, syncedAt: 0, pushedAt: 0, baseRev: null };
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
  for (const r of rb.tabs) {
    if (book.deleted[r.id]) continue;
    const html = remote.html[r.id] ?? '';
    const t = tabById(r.id);
    if (!t) {
      const name = book.tabs.some(x => x.name === r.name) ? r.name + ' (other device)' : r.name;
      book.tabs.push({ ...r, name, baseRev: r.rev });
      puts.push(['tab:' + r.id, html]);
      continue;
    }
    const mine = t.rev !== t.baseRev, theirs = r.rev !== t.baseRev && r.rev !== t.rev;
    if (theirs && !mine) {
      Object.assign(t, { rev: r.rev, baseRev: r.rev, updatedAt: r.updatedAt, fixes: r.fixes });
      puts.push(['tab:' + t.id, html]);
      if (editors[t.id]) { editors[t.id].innerHTML = html || starter(t); shown ||= t.id === book.active; }
    } else if (theirs) {
      const c = { ...r, id: uid(), kind: 'notes', name: r.name + ' (other device)', linked: null, docId: null, docTitle: null, revisionId: null, syncedAt: 0, pushedAt: 0, baseRev: null };
      book.tabs.push(c);
      puts.push(['tab:' + c.id, html]);
    }
    if ((r.nameAt || 0) > (t.nameAt || 0)) { t.name = r.name; t.nameAt = r.nameAt; }
    if ((r.pushedAt || 0) > (t.pushedAt || 0)) for (const k of ['docId', 'docTitle', 'revisionId', 'syncedAt', 'pushedAt', 'linked']) t[k] = r[k];
  }
  if (!book.tabs.length) book.tabs = newBook().tabs;
  await dbPut(puts);
  if (!tabById(book.active)) await openTab(book.tabs[0].id);
  else if (shown) { layout(); meta(); renderStatus(); }
  renderTabs();
}

async function syncData() {
  await flush();
  let id = book.dataId, version = null, base = book.dataSig;
  if (!id) {
    const q = encodeURIComponent(`name='${DATA_NAME}' and trashed=false`);
    id = (await gfetch('GET', `${DRIVE}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id)`)).files[0]?.id || null;
  }
  if (id) {
    try { version = (await gfetch('GET', `${DRIVE}/files/${id}?fields=version`)).version; }
    catch (e) { if (e.status !== 404) throw e; id = null; }
  }
  if (id && version !== book.dataVersion) {
    const remote = JSON.parse(await gunzip(await (await gblob('GET', `${DRIVE}/files/${id}?alt=media`)).blob()));
    if (remote?.io === 1) { await mergeData(remote); base = sigOf(remote.book); }
  }
  if (!id || sigOf(book) !== base) {
    const html = {};
    for (const t of book.tabs) html[t.id] = await tabHtml(t);
    const body = await gzip(JSON.stringify({ io: 1, savedAt: Date.now(), book: shareBook(), html }));
    if (!id) id = (await gfetch('POST', `${DRIVE}/files?fields=id`, { name: DATA_NAME, mimeType: 'application/gzip' })).id;
    version = (await (await gblob('PATCH', `${UPLOAD}/${id}?uploadType=media&fields=version`, body, 'application/gzip')).json()).version;
  }
  for (const t of book.tabs) t.baseRev = t.rev;
  Object.assign(book, { dataId: id, dataVersion: version, dataSig: sigOf(book), dataAt: Date.now() });
  clearTimeout(timers.book);
  await dbPut([['book', book]]);
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
    if (last && last.end === start && last.b === st.b && last.i === st.i && last.u === st.u && last.m === st.m) last.end = text.length;
    else if (st.b || st.i || st.u || st.m) runs.push({ start, end: text.length, ...st });
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
      else if (n.nodeName === 'FONT') s.m = markOf(n) || st.m;
      walk(n, s);
    }
  };
  for (const b of root.children) {
    const start = text.length;
    walk(b, { b: false, i: false, u: false, m: null });
    text += '\n';
    paras.push({ start, end: text.length, h: b.nodeName === 'H1' });
  }
  return { text, paras, runs };
}

function docRequests(m, docEnd, linked) {
  const reqs = [];
  if (docEnd - 1 > 1) reqs.push({ deleteContentRange: { range: { startIndex: 1, endIndex: docEnd - 1 } } });
  const ins = m.text.slice(0, -1);
  const L = ins.length;
  if (L) reqs.push({ insertText: { location: { index: 1 }, text: ins } });
  reqs.push({ updateParagraphStyle: { range: { startIndex: 1, endIndex: L + 2 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
  if (linked) reqs.push({ deleteParagraphBullets: { range: { startIndex: 1, endIndex: L + 2 } } });
  for (const p of m.paras) {
    if (p.h) reqs.push({ updateParagraphStyle: { range: { startIndex: p.start + 1, endIndex: p.end + 1 }, paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } });
  }
  if (L) reqs.push({ updateTextStyle: { range: { startIndex: 1, endIndex: L + 1 }, textStyle: {}, fields: 'bold,italic,underline,foregroundColor,backgroundColor' } });
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
    reqs.push({ updateTextStyle: { range: { startIndex: r.start + 1, endIndex: r.end + 1 }, textStyle: ts, fields: fields.join(',') } });
  }
  return reqs;
}

const docTitle = t => t.linked ? t.docTitle : `${book.title} - ${t.name}`;
const needsPush = t => !t.docId || t.updatedAt > t.syncedAt || t.docTitle !== docTitle(t);

async function pushTab(t, interactive) {
  const snapAt = Date.now();
  const html = editors[t.id] ? serialize(editors[t.id]) : (await dbGet('tab:' + t.id)) || starter(t);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const m = docModel(tpl.content);
  let doc = null;
  if (t.docId) {
    try { doc = await gfetch('GET', `${DOCS}/${t.docId}?fields=revisionId,body(content(endIndex))`); }
    catch (e) { if (e.status === 404) { t.docId = null; t.linked = null; } else throw e; }
  }
  if (doc && t.revisionId && doc.revisionId !== t.revisionId) {
    if (!interactive) { t.conflict = true; return; }
    if (!await ask({ title: 'Changed in Google Docs', text: `"${docTitle(t)}" was changed in Google Docs since Io last pushed it. Push anyway? Google keeps the changed version in its version history.`, ok: 'Push anyway', danger: true })) return;
  }
  if (!doc) {
    const d = await gfetch('POST', DOCS, { title: docTitle(t) });
    t.docId = d.documentId;
    t.docTitle = docTitle(t);
    doc = { body: { content: [{ endIndex: 2 }] } };
  }
  if (t.docTitle !== docTitle(t)) {
    await gfetch('PATCH', `https://www.googleapis.com/drive/v3/files/${t.docId}?fields=id`, { name: docTitle(t) });
    t.docTitle = docTitle(t);
  }
  const content = doc.body.content || [];
  const end = content.length ? content[content.length - 1].endIndex : 2;
  const res = await gfetch('POST', `${DOCS}/${t.docId}:batchUpdate`, { requests: docRequests(m, end, t.linked) });
  t.revisionId = res.writeControl?.requiredRevisionId || null;
  t.syncedAt = snapAt;
  t.pushedAt = Date.now();
  t.conflict = false;
}

async function pushAll(interactive) {
  if (G.busy) return;
  if (!navigator.onLine) { if (interactive) toast('Offline. Io will push when you are back online.'); return; }
  if (!interactive && !G.valid()) return renderSync();
  G.busy = true;
  renderSync();
  try {
    await flush();
    if (!G.valid()) await signIn();
    await syncData();
    const docsDue = interactive || Date.now() - (book.docsAt || 0) >= DOCS_EVERY;
    const todo = docsDue ? book.tabs.filter(t => needsPush(t) && (interactive || !t.conflict) && (!t.linked || hasDocs())) : [];
    if (interactive && !hasDocs() && book.tabs.some(t => t.linked && needsPush(t))) toast('Sign in to Google again (Settings) to save the Docs you opened from Google.');
    if (todo.length) {
      for (const t of todo) await pushTab(t, interactive);
      book.docsAt = Date.now();
      await syncData();
    } else if (interactive) toast('Saved to Google. Google Docs are up to date.');
    G.error = null;
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
  const b = el.syncBtn;
  const tabs = book.tabs;
  const waiting = tabs.filter(needsPush).length;
  const conflict = tabs.some(t => t.conflict);
  const last = Math.max(0, ...tabs.map(t => t.pushedAt || 0));
  let label, state, note = '';
  if (G.busy) { label = 'Pushing…'; state = 'pending'; }
  else if (G.error || conflict) {
    label = 'Push to Google'; state = 'warn';
    note = conflict ? 'Changed in Google Docs. Press Push to overwrite.' : G.error;
  }
  else if (!G.valid() && pref.get('signedIn', false)) { label = 'Sign in to push'; state = waiting ? 'pending' : ''; }
  else if (waiting) { label = 'Push to Google'; state = 'pending'; }
  else { label = 'Google Doc'; state = 'ok'; }
  b.textContent = label;
  b.dataset.state = state;
  if (!note && !G.valid() && !G.busy) note =pref.get('signedIn', false) ? 'Google sign-in expired. Click to renew.' : 'Not connected to Google. Click to sign in.';
  const warn = !!note;
  if (!navigator.onLine) note = 'Offline. Saved on this computer.';
  const lastTxt = book.dataAt ? 'Saved to Google ' + when(book.dataAt) : last ? 'Pushed ' + when(last) : '';
  el.stSync.textContent = note || lastTxt;
  el.stSync.className = warn && navigator.onLine ? 'st-sync warn' : 'st-sync';
  b.title = [lastTxt || 'Not pushed yet', waiting ? waiting + ' sheet(s) waiting' : ''].filter(Boolean).join('. ');
}

function renderDocLinks() {
  const f = document.createDocumentFragment();
  for (const t of book.tabs) {
    if (!t.docId) continue;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://docs.google.com/document/d/${t.docId}/edit`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = docTitle(t);
    li.append(a);
    if (t.pushedAt) li.append(' (pushed ' + when(t.pushedAt) + ')');
    f.append(li);
  }
  $('#docLinks').replaceChildren(f);
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

function docHtml(doc) {
  const tabs = [], lost = {};
  const note = k => { lost[k] = (lost[k] || 0) + 1; };
  const allTabs = ts => { for (const t of ts || []) { tabs.push(t); allTabs(t.childTabs); } };
  allTabs(doc.tabs);
  if (tabs.length > 1) lost.tabs = tabs.length - 1;
  const out = [];
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
      if (m) x = `<font color="${MARKS[m]}">${x}</font>`;
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
  walk((tabs[0]?.documentTab || doc).body?.content);
  return { html: out.join('') || '<p><br></p>', lost };
}

const LOST = {
  tabs: 'its other tabs (Io opens the first tab only)', table: 'tables (their text comes in as plain paragraphs)',
  image: 'pictures', list: 'list bullets', sub: 'subheadings and titles (they become chapter headings)',
  link: 'links', footnote: 'footnotes', toc: 'the table of contents',
};

async function openDocFile(f) {
  try {
    const doc = await gfetch('GET', `${DOCS}/${f.id}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`);
    const { html, lost } = docHtml(doc);
    const t = book.tabs.find(x => x.docId === f.id);
    if (t) {
      if (t.id !== book.active) await openTab(t.id);
      if (!t.linked) return;
      if (!await ask({ title: 'Already open', text: `"${t.name}" is this Doc. Load it again from Google? Edits made in Io since it was last saved to Google will be lost.`, ok: 'Load from Google', cancel: 'Keep Io\'s version', danger: true })) return;
      Object.assign(t, { rev: uid(), updatedAt: Date.now(), syncedAt: Date.now(), revisionId: doc.revisionId, conflict: false });
      if (editors[t.id]) editors[t.id].innerHTML = html;
      else await dbPut([['tab:' + t.id, html]]);
      dirty.add(t.id);
      await flush();
      layout();
      meta();
      renderSync();
      return toast('Loaded from Google.');
    }
    const kinds = Object.keys(lost);
    if (kinds.length && !await ask({
      title: 'Some of this Doc will not come across',
      text: `Io cannot show ${kinds.map(k => LOST[k]).join(', ')}. Saving from Io rewrites the whole Doc, so these would be removed from it. Google keeps the old version in its version history. Open it anyway?`,
      ok: 'Open', danger: true,
    })) return;
    const now = Date.now();
    const name = doc.title.slice(0, 60) || 'Untitled';
    const n = {
      id: uid(), name: book.tabs.some(x => x.name === name) ? name + ' (Google)' : name, kind: 'notes', linked: true, rev: uid(), updatedAt: now, nameAt: now,
      docId: f.id, docTitle: doc.title, revisionId: doc.revisionId, syncedAt: now, pushedAt: now, fixes: 0,
    };
    book.tabs.push(n);
    await dbPut([['tab:' + n.id, html]]);
    await openTab(n.id);
    renderSync();
    toast(`Opened "${doc.title}". Ctrl+S saves it back to the Doc.`);
  } catch (e) {
    toast('Could not open the Doc: ' + e.message);
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
    if (seq !== listSeq) return;
    const f = document.createDocumentFragment();
    for (const d of r.files) {
      const t = book.tabs.find(x => x.docId === d.id);
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span class="t"></span><span class="pg"></span>';
      b.firstChild.textContent = d.name;
      b.lastChild.textContent = t ? (t.linked ? 'open in Io' : 'Io copy of ' + t.name) : when(Date.parse(d.modifiedTime));
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

function openMenu() {
  $('#autoPush').checked = pref.get('autoPush', true);
  renderDocLinks();
  renderBackup();
  el.menu.showModal();
}

function wire() {
  el.tools.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  el.tools.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (b) run(b.dataset.cmd); });
  document.addEventListener('selectionchange', () => { keepRange(); later('tools', 80, updateTools); });
  el.scroller.addEventListener('scroll', onScroll, { passive: true });

  el.toc.addEventListener('click', e => {
    const b = e.target.closest('button');
    const h = b && layoutInfo.heads[b.dataset.i];
    if (h) { goTo(h.el, false); closeNavOnPhone(); }
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

  $('#navToggle').addEventListener('click', () => {
    if (matchMedia('(max-width: 900px)').matches) el.shell.classList.toggle('nav-open');
    else { el.shell.classList.toggle('nav-hidden'); pref.set('navHidden', el.shell.classList.contains('nav-hidden')); later('layout', 50, layout); }
  });

  el.tabs.addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (del) return deleteTab(del.dataset.del);
    const b = e.target.closest('.tab');
    if (b && b.dataset.id !== book.active) openTab(b.dataset.id);
  });
  el.tabs.addEventListener('dblclick', async e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    const t = tabById(b.dataset.id);
    const name = await ask({ title: 'Rename sheet', value: t.name, ok: 'Rename' });
    if (name) { t.name = name.slice(0, 60); t.nameAt = Date.now(); editors[t.id]?.setAttribute('aria-label', t.name); saveBook(); renderTabs(); renderSync(); }
  });
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

  el.syncBtn.addEventListener('click', () => pushAll(true));
  $('#openBtn').addEventListener('click', openDocs);
  $('#openQ').addEventListener('input', e => later('openq', 300, () => listDocs(e.target.value.trim())));
  $('#openQ').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  el.stSync.addEventListener('click', () => {
    if (!G.valid()) signIn().then(() => pushAll(false), e => toast(e.message));
    else pushAll(true);
  });
  document.addEventListener('click', renewOnClick, true);
  $('#askInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#ask').close('ok'); } });
  $('#menuBtn').addEventListener('click', openMenu);
  $('#fontSel').addEventListener('change', e => setFont(e.target.value));
  $('#autoPush').addEventListener('change', e => pref.set('autoPush', e.target.checked));
  $('#connectBtn').addEventListener('click', () => { signIn().then(() => toast('Signed in to Google.'), e => toast(e.message)); });
  $('#pushBtn').addEventListener('click', () => pushAll(true));
  $('#backupBtn').addEventListener('click', backup);
  $('#backupDirBtn').addEventListener('click', chooseBackupDir);
  $('#backupNowBtn').addEventListener('click', () => autoBackup(true));
  $('#backupStopBtn').addEventListener('click', stopBackups);
  document.addEventListener('click', () => autoBackup(false, true), true);
  $('#restoreFile').addEventListener('change', e => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });

  addEventListener('online', () => { renderSync(); pushAll(false); });
  addEventListener('offline', renderSync);
  addEventListener('resize', () => later('layout', 200, () => {
    const z = startZoom();
    if (Math.abs(z - zoom) > .005 && (pref.get('zoom', null) === null || z < zoom)) setZoom(z, true, false);
    layout();
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timers.book); dbPut([['book', book]]).then(flush).then(() => { pushAll(false); autoBackup(); }); }
    else { pushAll(false); autoBackup(); }
  });
  addEventListener('pagehide', flush);
  setInterval(() => { if (!document.hidden && pref.get('autoPush', true)) pushAll(false); autoBackup(); }, PUSH_EVERY);
}

function closeNavOnPhone() { el.shell.classList.remove('nav-open'); }

async function deleteTab(id) {
  const t = tabById(id);
  if (!t || t.kind === 'ms') return;
  if (!await ask({ title: 'Delete sheet?', text: `Delete the sheet "${t.name}"? This cannot be undone in Io.${t.docId ? ' Its Google Doc stays in your Drive.' : ''}`, ok: 'Delete', danger: true })) return;
  dirty.delete(id);
  editors[id]?.remove();
  delete editors[id];
  book.tabs = book.tabs.filter(x => x.id !== id);
  book.deleted = { ...book.deleted, [id]: Date.now() };
  await dbPut([['tab:' + id, undefined]]);
  openTab(book.tabs[0].id);
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
  book = (await dbGet('book')) || newBook();
  if (!tabById(book.active)) book.active = book.tabs[0].id;
  el.title.value = book.title;
  document.title = book.title + ' - Io';
  setFont(pref.get('font', 'aptos'));
  if (pref.get('navHidden', false)) el.shell.classList.add('nav-hidden');
  setZoom(startZoom(), false, false);
  wire();
  singleWindow();
  await openTab(book.active);
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
  if (navigator.onLine && pref.get('signedIn', false)) loadGis().catch(() => {});
  if (navigator.onLine && G.valid()) pushAll(false);
  renderSync();
  autoBackup();
}

init();
