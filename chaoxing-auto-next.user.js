// ==UserScript==
// @name         超星学习通 · 任务点自动跳转
// @namespace    https://local/cx-auto-next
// @version      1.4.1
// @description  任务点被标记完成或视频播完（ended / 进度≥99%）后自动进入下一个未完成任务点并起播；事件驱动，后台可用；只读页面状态、只模拟点击，不伪造进度。
// @author       local
// @match        *://*.chaoxing.com/*
// @match        *://chaoxing.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

/*
 * 设计边界（重要）
 *   1. 只读：所有判断都来自页面已有的 DOM（任务点列表、完成图标、video 状态）。
 *   2. 只模拟点击：用 pointerdown/mouseup/click 走页面自己的事件处理。
 *   3. 不伪造进度：不构造 XHR/fetch，不发心跳，不改平台数据。
 *   4. 真播放：视频必须真的播到 ended 或 ≥99%，才认为这一节点完成。
 *   5. 验证码/人脸识别：立即停住并提示，不做任何绕过；测验/文档不代答、不点。
 *
 * 触发链路（全部事件驱动）
 *   · 任务点被标记“已完成”  → 约 1 秒后跳到下一个未完成任务点
 *   · 视频 ended 或进度 ≥99% → 立即开始等平台写状态
 *   · 平台迟迟不写          → 超过 forceAdvanceMs（默认 6 秒）强制往下走
 *   · 站点自己换片          → 直接接管播放，不再重复点击
 *   · 被页面暂停（切屏/失焦/防挂机）→ 1.2 秒内没有你的真实点击，就自动拉起
 *   推进的“心跳”来自 media 事件和 MutationObserver，不靠轮询定时器；
 *   页面里只保留一个 5 秒的低频兜底检查。
 */

(function () {
  'use strict';

  /* ================================================================== *
   * 0. 运行环境
   * ================================================================== */

  var IS_TOP = true;
  try { IS_TOP = window.top === window.self; } catch (e) { IS_TOP = true; }

  var PAGE = window;
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) PAGE = unsafeWindow;
  } catch (e) { PAGE = window; }

  var HOST_RE = /(^|\.)chaoxing\.com$/i;
  try {
    if (!HOST_RE.test(location.hostname)) return;
  } catch (e) { return; }

  var NOW = function () { return Date.now(); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ================================================================== *
   * 1. 配置
   * ================================================================== */

  var DEFAULTS = {
    enabled: true,
    autoStartOnLoad: false,   // 打开页面时是否自动点第一个未完成项
    settleMs: 1000,           // 触发后等多久再切（“完成即跳”的 1 秒）
    forceAdvanceMs: 6000,     // 平台迟迟不标记完成时的强制超时
    verifyVideoMs: 16000,     // 点击后等播放器出现的时间
    endProgress: 0.99,        // 进度达到多少算播完
    autoResume: true,         // 后台被暂停时恢复播放
    resumeGraceMs: 1200,
    onNonVideo: 'skip',       // skip=跳过测验/文档并提示；stop=原地停住
    notify: true,
    panel: true,              // 悬浮面板
    debug: false,
    recentFinishedMs: 10 * 60 * 1000,
    pointSelectors: [
      '.prev_ul .posCatalog_select',
      '.posCatalog_select',
      '.prev_ul li',
      '.chapter_item',
      '.catalog_item',
      '[data-taskid]',
      '[data-pointid]'
    ],
    playSelectors: [
      '.vjs-big-play-button',
      '.vjs-play-control.vjs-paused',
      '.prism-big-play-btn',
      '.prism-play-btn',
      '.xgplayer-start',
      '[class*="big-play"]',
      '[class*="play-btn"]',
      '[class*="playButton"]',
      '[aria-label*="播放"]',
      '[title*="播放"]'
    ]
  };

  var STORE_CFG = 'cxauto:cfg:v2';
  var STORE_STATE = 'cxauto:state:v2';

  var hasGM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');

  function rawGet(k, d) {
    try {
      if (hasGM) {
        var v = GM_getValue(k);
        return (v === undefined || v === null) ? d : v;
      }
      var s = localStorage.getItem(k);
      return s === null ? d : JSON.parse(s);
    } catch (e) { return d; }
  }

  function rawSet(k, v) {
    try {
      if (hasGM) GM_setValue(k, v);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { /* ignore */ }
  }

  var CFG = (function () {
    var saved = rawGet(STORE_CFG, {}) || {};
    var out = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    for (var s in saved) if (Object.prototype.hasOwnProperty.call(saved, s)) out[s] = saved[s];
    for (var a in DEFAULTS) {
      if (Array.isArray(DEFAULTS[a]) && Array.isArray(out[a])) {
        var set = {};
        var merged = [];
        DEFAULTS[a].concat(out[a]).forEach(function (x) {
          if (x && !set[x]) { set[x] = 1; merged.push(x); }
        });
        out[a] = merged;
      }
    }
    return out;
  })();

  function saveCfg() { rawSet(STORE_CFG, CFG); }

  /* ================================================================== *
   * 2. 日志
   * ================================================================== */

  var LOG_MAX = 60;
  var logLines = [];

  function log(msg, force) {
    var t = new Date();
    var pad = function (v) { return v < 10 ? '0' + v : '' + v; };
    var line = pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '  ' + msg;
    logLines.push(line);
    if (logLines.length > LOG_MAX) logLines.shift();
    if (CFG.debug || force) {
      try { console.log('[CX自动跳转] ' + msg); } catch (e) { /* ignore */ }
    }
    if (panel.ready) renderLog();
  }

  /* ================================================================== *
   * 3. 文档与视频发现
   * ================================================================== */

  function sameOriginDocs(root, depth) {
    var out = [];
    root = root || document;
    depth = depth || 0;
    out.push(root);
    if (depth >= 3) return out;
    var frames;
    try { frames = root.querySelectorAll('iframe, frame'); } catch (e) { return out; }
    for (var i = 0; i < frames.length; i++) {
      var d = null;
      try { d = frames[i].contentDocument; } catch (e) { d = null; }
      if (d && d.documentElement && d !== root) {
        var kids = sameOriginDocs(d, depth + 1);
        for (var k = 0; k < kids.length; k++) out.push(kids[k]);
      }
    }
    return out;
  }

  function visibleArea(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      return r.width * r.height;
    } catch (e) { return 0; }
  }

  function pickVideo() {
    var docs = sameOriginDocs(document, 0);
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < docs.length; i++) {
      var vs;
      try { vs = docs[i].querySelectorAll('video'); } catch (e) { continue; }
      for (var j = 0; j < vs.length; j++) {
        var v = vs[j];
        var area = visibleArea(v);
        var score = area + (v.readyState > 0 ? 1e6 : 0) + (!v.paused && !v.ended ? 5e6 : 0);
        if (score > bestScore) { bestScore = score; best = v; }
      }
    }
    return best;
  }

  function sigOf(v) {
    if (!v) return '';
    try { return v.currentSrc || v.getAttribute('src') || ''; } catch (e) { return ''; }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      return true;
    } catch (e) { return false; }
  }

  function styleVisible(el) {
    try {
      var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (!cs) return true;
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
    } catch (e) { return true; }
  }

  function inDoc(el) {
    if (!el) return false;
    try {
      if (typeof el.isConnected === 'boolean') return el.isConnected;
      return el.ownerDocument.documentElement.contains(el);
    } catch (e) { return false; }
  }

  /* ================================================================== *
   * 4. 任务点扫描（只读）
   * ================================================================== */

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function textOf(el) { return norm(el && el.textContent); }
  function classOf(el) {
    try { return String((el && el.getAttribute && el.getAttribute('class')) || ''); } catch (e) { return ''; }
  }

  function attrBag(el) {
    var parts = [];
    if (!el || !el.getAttribute) return '';
    var names = ['class', 'id', 'src', 'href', 'title', 'alt', 'aria-label', 'data-type', 'data-status', 'data-state'];
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute(names[i]);
      if (v) parts.push(v);
    }
    return parts.join(' ').toLowerCase();
  }

  function statusOf(row) {
    if (!row) return 'unknown';
    var text = textOf(row);
    if (/未完成|未学习|未观看|待完成|未开始/.test(text)) return 'undone';
    if (/已完成|已学完|已看完|已通过/.test(text)) return 'done';

    var nodes;
    try { nodes = row.querySelectorAll('[class],[src],[data-status],[data-state]'); } catch (e) { nodes = []; }
    var limit = Math.min(nodes.length, 80);
    for (var i = 0; i < limit; i++) {
      var bag = attrBag(nodes[i]);
      if (!bag) continue;
      if (/not.?complete|uncomplete|incomplete|undone|not.?start|not.?study|未完成/.test(bag)) return 'undone';
      if (/completed|finished|icon_ok|icon_success|icon_done|task_done|study_done/.test(bag)) {
        if (!styleVisible(nodes[i])) continue;
        return 'done';
      }
    }

    var own = attrBag(row);
    if (/not.?complete|uncomplete|incomplete|undone/.test(own)) return 'undone';
    if (/completed|finished/.test(own)) return 'done';
    return 'unknown';
  }

  function typeOf(row) {
    var bag = classOf(row) + ' ' + attrBag(row);
    try {
      var imgs = row.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) bag += ' ' + (imgs[i].getAttribute('src') || '');
    } catch (e) { /* ignore */ }
    bag = bag.toLowerCase();
    if (/video|shipin|bofang/.test(bag)) return 'video';
    if (/(^|[^a-z])(work|exam|quiz|homework|doc|docx|pdf|discuss|live|test)([^a-z]|$)/.test(bag)) return 'other';
    var t = textOf(row);
    if (/测验|作业|考试|讨论|文档|直播|阅读|PPT|课件/.test(t)) return 'other';
    return 'unknown';
  }

  function rowKey(row) {
    if (row.id) return '#' + row.id;
    var names = ['data-taskid', 'data-pointid', 'data-id', 'data-chapterid', 'data-knowledgeid', 'chapterid'];
    for (var i = 0; i < names.length; i++) {
      var v = row.getAttribute(names[i]);
      if (v) return names[i] + ':' + v;
    }
    var t = textOf(row).slice(0, 48);
    if (t) return 't:' + t;
    return 'x:' + (row.className || '') + ':' + (row.getAttribute('onclick') || '');
  }

  function isLeafRows(nodes) {
    var keep = [];
    for (var i = 0; i < nodes.length; i++) {
      var contained = false;
      for (var j = 0; j < nodes.length; j++) {
        if (i !== j && nodes[i] !== nodes[j] && nodes[i].contains(nodes[j])) { contained = true; break; }
      }
      if (!contained) keep.push(nodes[i]);
    }
    return keep;
  }

  function bySelector(sel) {
    var docs = sameOriginDocs(document, 0);
    var best = null;
    for (var d = 0; d < docs.length; d++) {
      var nodes;
      try { nodes = Array.prototype.slice.call(docs[d].querySelectorAll(sel)); } catch (e) { continue; }
      var rows = nodes.filter(function (n) {
        if (!n || !n.getClientRects) return false;
        var t = textOf(n);
        return t.length > 0 && t.length < 400;
      });
      rows = isLeafRows(rows);
      if (!rows.length) continue;
      if (!best || rows.length > best.rows.length) best = { rows: rows, doc: docs[d], sel: sel };
    }
    return best;
  }

  function guessList() {
    var docs = sameOriginDocs(document, 0);
    var best = null;
    for (var d = 0; d < docs.length; d++) {
      var all = docs[d].querySelectorAll('div, li, a');
      var byParent = new Map();
      for (var i = 0; i < all.length && i < 4000; i++) {
        var el = all[i];
        if (!el.parentNode || el.parentNode === docs[d].body) continue;
        var t = textOf(el);
        if (t.length < 2 || t.length > 120) continue;
        var arr = byParent.get(el.parentNode);
        if (!arr) { arr = []; byParent.set(el.parentNode, arr); }
        arr.push(el);
      }
      byParent.forEach(function (arr) {
        if (arr.length < 3) return;
        if (best && best.rows.length >= arr.length) return;
        best = { rows: arr, doc: docs[d], sel: 'guess' };
      });
    }
    return best;
  }

  function scan() {
    var best = null;
    var sels = Array.isArray(CFG.pointSelectors) ? CFG.pointSelectors : DEFAULTS.pointSelectors;
    for (var i = 0; i < sels.length; i++) {
      var got = bySelector(sels[i]);
      if (got) { best = got; break; }
    }
    if (!best && IS_TOP && !document.querySelector('video')) best = guessList();
    if (!best) return { ok: false, rows: [], done: 0, total: 0, activeKey: '', sel: '' };

    var rows = [];
    var doneCount = 0;
    var activeKey = '';
    for (var j = 0; j < best.rows.length; j++) {
      var el = best.rows[j];
      var st = statusOf(el);
      if (st === 'done') doneCount++;
      rows.push({
        el: el,
        key: rowKey(el),
        done: st === 'done',
        uncertain: st === 'unknown',
        active: false,
        type: typeOf(el),
        text: textOf(el).slice(0, 80),
        visible: visibleArea(el) > 0
      });
    }

    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var own = classOf(row.el) + ' ' + (row.el.getAttribute('aria-current') || '');
      var marked = /(^|[-_ ])(active|current|selected|playing|cur)([-_ ]|$)/i.test(own);
      if (!marked) {
        try {
          marked = !!row.el.querySelector('[class*="active"],[class*="current"],[aria-current="true"]');
        } catch (e) { marked = false; }
      }
      if (marked) { row.active = true; if (!activeKey) activeKey = row.key; }
    }
    if (!activeKey && state.currentKey) {
      for (var m = 0; m < rows.length; m++) {
        if (rows[m].key === state.currentKey) { rows[m].active = true; activeKey = rows[m].key; break; }
      }
    }

    return { ok: true, rows: rows, done: doneCount, total: rows.length, activeKey: activeKey, sel: best.sel || 'guess' };
  }

  function findRow(s, key) {
    if (!s || !s.ok || !key) return null;
    for (var i = 0; i < s.rows.length; i++) if (s.rows[i].key === key) return s.rows[i];
    return null;
  }

  // 用播放器标题去匹配任务点文字；匹配不上返回空
  function matchByTitle(s) {
    if (!s || !s.ok) return '';
    var hay = '';
    var v = pickVideo();
    if (v) {
      try {
        var d = v.ownerDocument;
        hay = norm((d.title || '') + ' ' + (d.body ? String(d.body.innerText || '').slice(0, 300) : ''));
      } catch (e) { hay = ''; }
    }
    if (!hay) return '';
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < s.rows.length; i++) {
      var t = s.rows[i].text;
      if (!t || t.length < 2) continue;
      var score = 0;
      if (hay.indexOf(t) >= 0) score = t.length;
      else {
        var probe = t.slice(0, Math.min(8, t.length));
        if (probe.length >= 3 && hay.indexOf(probe) >= 0) score = probe.length;
      }
      if (score > bestScore) { bestScore = score; best = s.rows[i]; }
    }
    return (best && bestScore >= 4) ? best.key : '';
  }

  function inferCurrent(s, force) {
    if (!s || !s.ok) return '';
    if (!force && state.currentKey && findRow(s, state.currentKey)) return state.currentKey;
    if (s.activeKey) return s.activeKey;
    var byTitle = matchByTitle(s);
    if (byTitle) return byTitle;
    for (var j = 0; j < s.rows.length; j++) if (!s.rows[j].done) return s.rows[j].key;
    return '';
  }

  /* ================================================================== *
   * 5. 点击
   * ================================================================== */

  function clickTarget(row) {
    var inner = null;
    try { inner = row.querySelector('a[href], .posCatalog_name, [onclick], [class*="title"], span'); } catch (e) { inner = null; }
    return inner || row;
  }

  function realClick(el) {
    if (!el) return;
    var doc = el.ownerDocument || document;
    var win = doc.defaultView || window;
    var opt = { bubbles: true, cancelable: true, view: win, button: 0, buttons: 1 };

    function fire(type, Ctor) {
      try {
        var ev = Ctor ? new Ctor(type, opt) : new win.MouseEvent(type, opt);
        el.dispatchEvent(ev);
      } catch (e) { /* ignore */ }
    }

    try {
      if (typeof win.PointerEvent === 'function') {
        fire('pointerdown', win.PointerEvent);
        fire('pointerup', win.PointerEvent);
      }
    } catch (e) { /* ignore */ }
    fire('mousedown', win.MouseEvent);
    fire('mouseup', win.MouseEvent);
    try { el.click(); } catch (e) { fire('click', win.MouseEvent); }
  }

  /* ================================================================== *
   * 6. 状态与持久化
   * ================================================================== */

  var state = {
    mode: 'idle',
    currentKey: '',
    playedKey: '',
    currentEl: null,
    video: null,
    busy: false,
    advanceScheduled: false,
    triggerAt: 0,
    mediaEndedFor: '',
    wantPlay: false,
    lastInputAt: 0,
    resumeCount: 0,
    resumeWindow: 0,
    resumeCoolUntil: 0,
    resumeGaveUp: false,
    autoMuted: false,
    blurAt: 0,
    lastScan: null,
    lastScanAt: 0,
    started: false,
    startAt: 0,
    tookOver: false
  };

  var MEM = { finished: {}, skipped: {} };

  function courseKey() {
    try {
      var p = new URLSearchParams(location.search);
      var ck = [p.get('courseId') || p.get('courseid') || '', p.get('clazzid') || '', p.get('cpi') || '']
        .filter(Boolean).join('-');
      if (ck) return ck;
    } catch (e) { /* ignore */ }
    return location.pathname;
  }

  function loadPersisted() {
    var all = rawGet(STORE_STATE, {}) || {};
    var mine = all[courseKey()];
    if (!mine) return;
    if (mine.currentKey) state.currentKey = mine.currentKey;
    if (mine.finished && typeof mine.finished === 'object') {
      for (var k in mine.finished) if (Object.prototype.hasOwnProperty.call(mine.finished, k)) MEM.finished[k] = mine.finished[k];
    }
  }

  function persist() {
    var all = rawGet(STORE_STATE, {}) || {};
    all[courseKey()] = { currentKey: state.currentKey, finished: MEM.finished, at: NOW() };
    var keys = Object.keys(all);
    if (keys.length > 20) {
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
      for (var i = 0; i < keys.length - 20; i++) delete all[keys[i]];
    }
    rawSet(STORE_STATE, all);
  }

  function markFinished(key) {
    if (!key) return;
    MEM.finished[key] = NOW();
    var keys = Object.keys(MEM.finished);
    if (keys.length > 200) {
      keys.sort(function (a, b) { return MEM.finished[a] - MEM.finished[b]; });
      for (var i = 0; i < keys.length - 200; i++) delete MEM.finished[keys[i]];
    }
    persist();
  }

  function isRecentlyFinished(key) {
    var ts = MEM.finished[key];
    if (!ts) return false;
    if (NOW() - ts > CFG.recentFinishedMs) { delete MEM.finished[key]; return false; }
    return true;
  }

  function markSkipped(key, why) {
    if (!key) return;
    MEM.skipped[key] = NOW();
    log('跳过 ' + key + (why ? '（' + why + '）' : ''));
  }

  function isSkipped(key) {
    var ts = MEM.skipped[key];
    if (!ts) return false;
    if (NOW() - ts > 30 * 60 * 1000) { delete MEM.skipped[key]; return false; }
    return true;
  }

  /* ================================================================== *
   * 7. 列表变化通知（MutationObserver 总线）
   * ================================================================== */

  var listWaiters = [];

  function notifyListChange() {
    if (!listWaiters.length) return;
    var ws = listWaiters;
    listWaiters = [];
    for (var i = 0; i < ws.length; i++) {
      try { ws[i](); } catch (e) { /* ignore */ }
    }
  }

  function waitListChange(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        resolve('timeout');
      }, Math.max(0, ms));
      listWaiters.push(function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve('change');
      });
    });
  }

  var currentDoneFlag = false;
  var mutationTimer = 0;

  function quickDone() {
    if (!state.currentEl || !inDoc(state.currentEl)) return null;
    var st = statusOf(state.currentEl);
    if (st === 'unknown') return null;
    return st === 'done';
  }

  function onMutationRaw() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(function () {
      mutationTimer = 0;
      onMutation();
    }, 120);
  }

  function onMutation() {
    if (!CFG.enabled) return;
    var doneNow = quickDone();
    if (doneNow === null && state.currentKey) {
      var s = scan();
      state.lastScan = s;
      state.lastScanAt = NOW();
      var row = findRow(s, state.currentKey);
      if (row) { state.currentEl = row.el; doneNow = row.done; }
    }
    if (doneNow === true && !currentDoneFlag) {
      currentDoneFlag = true;
      onCompleted('marked-done');
    } else if (doneNow === false) {
      currentDoneFlag = false;
    }
    notifyListChange();
    schedulePanelRefresh();
  }

  /* ================================================================== *
   * 8. 播放控制（四级降级）
   * ================================================================== */

  var boundVideos = new WeakSet();

  function bindVideo(v) {
    if (!v || boundVideos.has(v)) return;
    boundVideos.add(v);
    state.mediaEndedFor = '';

    v.addEventListener('ended', function () { onMediaEnd(v, 'ended'); });

    v.addEventListener('timeupdate', function () {
      if (state.mediaEndedFor === state.currentKey) return;
      var d = v.duration;
      if (!d || !isFinite(d) || d <= 0) {
        // 有些流式视频 duration 是 Infinity/NaN，用已缓冲的末尾当总长
        try {
          if (v.buffered && v.buffered.length) d = v.buffered.end(v.buffered.length - 1);
        } catch (e) { d = 0; }
      }
      if (!d || !isFinite(d) || d <= 0) return;
      if (v.currentTime / d >= (CFG.endProgress || 0.99)) onMediaEnd(v, 'progress');
    });

    v.addEventListener('play', function () {
      state.wantPlay = true;
      state.resumeGaveUp = false;
      if (state.mode !== 'advancing') state.mode = 'playing';
      updatePanel();
    });

    v.addEventListener('pause', function () {
      if (v.ended) return;
      // 1.2 秒内有过真实点击 = 你主动暂停，尊重你的操作
      var userPause = (NOW() - (state.lastInputAt || 0)) < 1200;
      if (userPause) {
        state.wantPlay = false;
        if (!state.busy && state.mode === 'playing') {
          state.mode = 'idle';
          updatePanel();
        }
        return;
      }
      // 否则是页面/站点自己把它暂停了（切屏、失焦、防挂机）→ 拉起来
      state.wantPlay = true;
      setTimeout(function () { maybeResume(v, '页面暂停'); }, CFG.resumeGraceMs || 1200);
    });

    v.addEventListener('error', function () {
      if (v.error) notify('视频加载出错（' + (v.error.code || '?') + '）');
    });
  }

  var RESUME_MAX_PER_MIN = 20;

  function maybeResume(v, why) {
    if (!CFG.enabled || !CFG.autoResume) return;
    if (!v || v !== state.video) return;
    if (v.ended || !v.paused) return;
    if (state.busy) return;
    var now = NOW();
    if (now - state.resumeWindow > 60000) { state.resumeWindow = now; state.resumeCount = 0; }
    if (state.resumeCount >= RESUME_MAX_PER_MIN) {
      // 不彻底放弃：退避 15 秒再来，保证切到全屏应用后还能自己接上
      if (now < (state.resumeCoolUntil || 0)) return;
      state.resumeCoolUntil = now + 15000;
      state.resumeCount = 0;
      log('站点反复暂停，放慢恢复频率（每 15 秒再试一次）', true);
    }
    state.resumeCount++;
    log('被暂停（' + why + '），恢复播放');
    ensurePlay('resume');
  }

  function clickPlayButton(doc) {
    var sels = CFG.playSelectors || DEFAULTS.playSelectors;
    for (var i = 0; i < sels.length; i++) {
      var nodes;
      try { nodes = doc.querySelectorAll(sels[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length && j < 3; j++) {
        if (!isVisible(nodes[j])) continue;
        try {
          realClick(nodes[j]);
          log('点击播放按钮 ' + sels[i]);
          return true;
        } catch (e) { /* next */ }
      }
    }
    return false;
  }

  function tryPlayerApi(v) {
    var win = v.ownerDocument.defaultView || window;
    var cands = [];
    try { if (v.player_) cands.push(v.player_); } catch (e) { /* ignore */ }
    try { if (win.player) cands.push(win.player); } catch (e) { /* ignore */ }
    try { if (win.videoPlayer) cands.push(win.videoPlayer); } catch (e) { /* ignore */ }
    try { if (win.playerObj) cands.push(win.playerObj); } catch (e) { /* ignore */ }
    try { if (win.cxPlayer && win.cxPlayer.play) cands.push(win.cxPlayer); } catch (e) { /* ignore */ }
    try {
      if (win.videojs && typeof win.videojs.getPlayer === 'function') {
        try { cands.push(win.videojs.getPlayer()); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }

    for (var i = 0; i < cands.length; i++) {
      var p = cands[i];
      if (!p || typeof p.play !== 'function') continue;
      try {
        p.play();
        log('播放器 API 起播');
        return true;
      } catch (e) { /* next */ }
    }
    return false;
  }

  async function ensurePlay(reason) {
    var v = pickVideo();
    if (!v) { log('未找到 video（' + (reason || '') + '）'); return false; }
    bindVideo(v);
    state.video = v;
    state.wantPlay = true;

    if (!v.paused && !v.ended) { state.mode = 'playing'; updatePanel(); return true; }
    if (v.ended) return false;

    var doc = v.ownerDocument;

    if (tryPlayerApi(v)) {
      await sleep(200);
      if (!v.paused) { state.mode = 'playing'; updatePanel(); return true; }
    }

    if (clickPlayButton(doc)) {
      await sleep(200);
      if (!v.paused) { state.mode = 'playing'; updatePanel(); return true; }
    }

    try {
      await v.play();
      state.mode = 'playing';
      updatePanel();
      return true;
    } catch (err) {
      log('play() 被拒：' + (err && err.name), true);
    }

    var wasMuted = v.muted;
    v.muted = true;
    try {
      await v.play();
    } catch (e2) {
      v.muted = wasMuted;
      state.mode = 'blocked';
      updatePanel();
      notify('浏览器拦截了自动播放，请手动点一下播放键');
      return false;
    }

    state.mode = 'playing';
    state.autoMuted = true;
    updatePanel();
    await sleep(500);

    if (!wasMuted && !v.paused) {
      v.muted = false;
      state.autoMuted = false;
      await sleep(400);
      if (v.paused) {
        v.muted = true;
        state.autoMuted = true;
        try { await v.play(); } catch (e3) { /* ignore */ }
        notify('已静音播放（浏览器自动播放限制），点一下页面就恢复声音');
      }
    }
    log('静音兜底起播', true);
    return true;
  }

  /* ================================================================== *
   * 9. 触发与推进
   * ================================================================== */

  function onMediaEnd(v, reason) {
    if (!CFG.enabled) return;
    var key = state.currentKey || state.playedKey;
    if (!key) return;
    if (state.mediaEndedFor === key) return;
    state.mediaEndedFor = key;
    state.triggerAt = NOW();
    state.wantPlay = false;
    log(reason === 'ended' ? '视频 ended' : '进度 ≥ ' + Math.round((CFG.endProgress || 0.99) * 100) + '%');
    scheduleAdvance(reason);
  }

  function onCompleted(reason) {
    if (!CFG.enabled || !state.currentKey) return;
    if (state.advanceScheduled || state.busy) return;
    state.triggerAt = NOW();
    log('任务点已标记完成');
    scheduleAdvance(reason);
  }

  function scheduleAdvance(reason) {
    if (!CFG.enabled) return;
    if (state.advanceScheduled || state.busy) return;
    state.advanceScheduled = true;
    if (state.mode !== 'advancing') state.mode = 'settling';
    updatePanel();
    var delay = Math.max(200, CFG.settleMs || 1000);
    setTimeout(function () {
      state.advanceScheduled = false;
      advance(reason);
    }, delay);
  }

  function pickNext(s) {
    if (!s || !s.ok || !s.rows.length) return null;
    var idx = -1;
    if (state.currentKey) {
      for (var i = 0; i < s.rows.length; i++) if (s.rows[i].key === state.currentKey) { idx = i; break; }
    }
    if (idx < 0) {
      for (var a = 0; a < s.rows.length; a++) if (s.rows[a].active) { idx = a; break; }
    }
    var start = idx >= 0 ? idx + 1 : 0;
    var order = s.rows.slice(start).concat(start > 0 ? s.rows.slice(0, start) : []);
    for (var j = 0; j < order.length; j++) {
      var r = order[j];
      if (r.done) continue;
      if (isRecentlyFinished(r.key)) continue;
      if (isSkipped(r.key)) continue;
      return r;
    }
    return null;
  }

  function adoptActive(s) {
    if (!s || !s.activeKey) return false;
    var row = findRow(s, s.activeKey);
    if (!row) return false;
    if (state.currentKey !== row.key) {
      log('页面当前项变为 ' + row.key);
      state.currentKey = row.key;
      state.currentEl = row.el;
    }
    return true;
  }

  function videoChanged(oldVideo) {
    var v = pickVideo();
    return !!(v && v !== oldVideo);
  }

  async function advance(reason) {
    if (!CFG.enabled) return;
    if (state.busy) return;
    state.busy = true;
    state.mode = 'advancing';
    updatePanel();

    try {
      var oldVideo = state.video;
      var oldSig = sigOf(oldVideo);
      // 自动触发时给平台 6 秒写状态；手动点“下一个”不等
      var triggerAt = state.triggerAt || 0;
      var deadline = triggerAt ? triggerAt + (CFG.forceAdvanceMs || 6000) : NOW();

      var s = scan();
      state.lastScan = s;
      state.lastScanAt = NOW();

      // A. 页面自己换片了 → 接管播放
      if (oldVideo && videoChanged(oldVideo)) {
        adoptActive(s);
        var nv0 = pickVideo();
        state.video = nv0;
        bindVideo(nv0);
        await ensurePlay('site-advanced');
        state.mode = 'playing';
        updatePanel();
        persist();
        return;
      }

      // B. 等平台把“已完成”写进 DOM（事件驱动，到点强制推进）
      while (NOW() < deadline) {
        var q = quickDone();
        if (q === true) break;
        if (q === null) {
          s = scan();
          state.lastScan = s;
          state.lastScanAt = NOW();
          var r0 = findRow(s, state.currentKey);
          if (r0) {
            state.currentEl = r0.el;
            if (r0.done) break;
          }
        }
        if (oldVideo && videoChanged(oldVideo)) {
          var nv1 = pickVideo();
          state.video = nv1;
          bindVideo(nv1);
          adoptActive(scan());
          await ensurePlay('site-advanced');
          state.mode = 'playing';
          updatePanel();
          return;
        }
        await waitListChange(Math.min(500, Math.max(0, deadline - NOW())));
      }

      s = scan();
      state.lastScan = s;
      state.lastScanAt = NOW();
      var curRow = findRow(s, state.currentKey);
      if (curRow && !curRow.done) log('平台迟迟未标记完成，超时强制推进', true);

      // C. 本地记为已完成，保证不会再挑中它
      if (state.currentKey) markFinished(state.currentKey);

      // D. 挑下一个（已完成的自动跳过）
      for (var attempt = 0; attempt < 3; attempt++) {
        s = scan();
        state.lastScan = s;
        state.lastScanAt = NOW();
        if (!s.ok) break;

        var next = pickNext(s);
        if (!next) {
          state.mode = 'done';
          updatePanel();
          notify('没有可继续的视频任务点了（未完成项可能需要手动处理）');
          persist();
          return;
        }

        if (next.type === 'other') {
          if (CFG.onNonVideo === 'stop') {
            state.mode = 'blocked';
            updatePanel();
            notify('下一个任务点不是视频（' + next.text.slice(0, 14) + '），已停住');
            return;
          }
          markSkipped(next.key, next.text.slice(0, 12));
          continue;
        }

        log('进入 ' + next.key + ' · ' + next.text.slice(0, 20));
        state.currentKey = next.key;
        state.playedKey = next.key;
        state.currentEl = next.el;
        state.mediaEndedFor = '';
        currentDoneFlag = false;
        persist();

        try { next.el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        realClick(clickTarget(next.el));

        state.mode = 'waiting';
        updatePanel();

        var nv = await waitForNewVideo(oldVideo, oldSig, CFG.verifyVideoMs || 16000);
        if (!nv) {
          markSkipped(next.key, '没等到播放器');
          if (attempt >= 2) {
            state.mode = 'blocked';
            updatePanel();
            notify('连续几个任务点都没等到播放器，已停住');
            return;
          }
          continue;
        }

        state.video = nv;
        bindVideo(nv);
        var ok = await ensurePlay('advanced');
        state.mode = ok ? 'playing' : 'blocked';
        updatePanel();
        if (ok) notify('已进入下一个任务点：' + next.text.slice(0, 16));
        persist();
        return;
      }

      state.mode = 'blocked';
      updatePanel();
    } catch (e) {
      log('advance 异常：' + (e && e.message), true);
      state.mode = 'blocked';
      updatePanel();
    } finally {
      state.busy = false;
    }
  }

  async function waitForNewVideo(oldVideo, oldSig, timeoutMs) {
    var t0 = NOW();
    await sleep(150);
    for (;;) {
      if (!CFG.enabled) return null;
      var v = pickVideo();
      if (v && v !== oldVideo) {
        var sig = sigOf(v);
        if (sig || v.readyState > 0) return v;
      }
      if (NOW() - t0 > timeoutMs) return null;
      await waitListChange(300);
    }
  }

  /* ================================================================== *
   * 10. 拦截检查
   * ================================================================== */

  var lastBlockerCheck = 0;
  var blockerShown = false;

  function checkBlockers() {
    var t = NOW();
    if (t - lastBlockerCheck < 4000) return false;
    lastBlockerCheck = t;

    var docs = sameOriginDocs(document, 0);
    for (var i = 0; i < docs.length; i++) {
      var nodes;
      try {
        nodes = docs[i].querySelectorAll('[role="dialog"],[class*="dialog"],[class*="modal"],[class*="popup"],[class*="verify"]');
      } catch (e) { continue; }
      for (var j = 0; j < nodes.length && j < 20; j++) {
        var el = nodes[j];
        if (!isVisible(el)) continue;
        var txt = textOf(el);
        if (!txt || txt.length > 200) continue;
        if (/验证码|人脸识别|滑块|请完成验证|拖动.*验证|录制|拍照/.test(txt)) {
          if (!blockerShown) {
            blockerShown = true;
            CFG.enabled = false;
            saveCfg();
            state.mode = 'off';
            updatePanel();
            notify('检测到验证码/人脸识别，已自动停止，请手动完成后在面板点“继续”');
            log('发现拦截弹窗：' + txt.slice(0, 50), true);
          }
          return true;
        }
      }
    }
    return false;
  }

  /* ================================================================== *
   * 11. 低频兜底
   * ================================================================== */

  function ensurePanel() {
    if (!CFG.panel) return;
    if (panel.host && inDoc(panel.host)) return;
    // 面板被页面重渲染弄丢了就补回来
    panel.host = null;
    panel.root = null;
    panel.els = null;
    panel.ready = false;
    mountPanel();
    if (panel.ready) { state.lastScan = null; updatePanel(); }
  }

  function safetyTick() {
    if (!CFG.enabled || state.busy) return;
    ensurePanel();
    if (!state.tookOver) { initialTakeover(); return; }
    var v = pickVideo();
    if (!v) return;
    bindVideo(v);
    if (v !== state.video) state.video = v;

    if (v.ended && state.mode === 'playing' && !state.advanceScheduled) onMediaEnd(v, 'ended');
    // 被页面暂停了（切屏/失焦/防挂机）→ 兜底拉起
    if (v.paused && !v.ended && state.wantPlay && state.mode === 'playing') {
      maybeResume(v, '兜底检查');
    }
    if (!state.currentKey || !inDoc(state.currentEl)) {
      var s = scan();
      if (s.ok && s.rows.length) {
        state.lastScan = s;
        state.lastScanAt = NOW();
        if (!state.currentKey) state.currentKey = inferCurrent(s);
        var r = findRow(s, state.currentKey);
        if (r) state.currentEl = r.el;
        if (state.mode === 'idle') {
          state.mode = (!v.paused && !v.ended) ? 'playing' : 'idle';
        }
        updatePanel();
      }
    }
  }

  /* ================================================================== *
   * 12. 悬浮面板
   * ================================================================== */

  var panel = {
    ready: false,
    host: null,
    root: null,
    els: null,
    pos: null,
    collapsed: false,
    timer: 0
  };

  var MODE_LABEL = {
    idle: '待机',
    playing: '播放中',
    settling: '等待标记',
    advancing: '切换中',
    waiting: '等待播放器',
    blocked: '已停住',
    done: '全部完成',
    off: '已暂停'
  };

  var MODE_COLOR = {
    idle: '#94a3b8',
    playing: '#4ade80',
    settling: '#fbbf24',
    advancing: '#60a5fa',
    waiting: '#60a5fa',
    blocked: '#f87171',
    done: '#4ade80',
    off: '#94a3b8'
  };

  var PANEL_CSS = [
    ':host{all:initial}',
    '.panel{width:300px;box-sizing:border-box;font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'color:#e8eaed;background:rgba(23,25,30,.96);border:1px solid rgba(255,255,255,.10);border-radius:12px;',
    'box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden;backdrop-filter:blur(10px);-webkit-user-select:none;user-select:none}',
    '.hdr{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:grab;background:rgba(255,255,255,.045);',
    'border-bottom:1px solid rgba(255,255,255,.06);touch-action:none}',
    '.hdr:active{cursor:grabbing}',
    '.dot{width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px currentColor;flex:none}',
    '.title{font-weight:600;font-size:12.5px;letter-spacing:.3px}',
    '.badge{margin-left:2px;padding:1px 6px;border-radius:99px;background:rgba(96,165,250,.16);color:#93c5fd;',
    'font-size:10.5px;font-variant-numeric:tabular-nums}',
    '.spacer{flex:1}',
    'button{font:inherit;color:#e8eaed;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.10);',
    'border-radius:8px;padding:6px 8px;cursor:pointer;transition:background .12s}',
    'button:hover{background:rgba(255,255,255,.15)}',
    'button:active{transform:translateY(1px)}',
    '.icon{padding:1px 8px;line-height:1.1;font-size:14px;background:transparent;border-color:transparent;color:#9aa0a6}',
    '.body{padding:10px 12px 12px}',
    '.stats{display:flex;gap:6px;margin-bottom:8px}',
    '.stat{flex:1;background:rgba(255,255,255,.05);border-radius:8px;padding:5px 2px;text-align:center}',
    '.stat b{display:block;font-size:15px;line-height:1.3;font-variant-numeric:tabular-nums}',
    '.stat span{color:#9aa0a6;font-size:10px}',
    '.bar{height:5px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin-bottom:8px}',
    '.bar i{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#38bdf8,#4ade80);',
    'transition:width .25s ease}',
    '.now{color:#9aa0a6;font-size:11px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.now b{color:#e8eaed;font-weight:500}',
    '.row{display:flex;gap:6px;margin-bottom:6px}',
    '.row button{flex:1;padding:7px 4px}',
    '.row button.on{border-color:#f59e0b;color:#fbbf24}',
    '.log{max-height:96px;overflow:auto;font:10.5px/1.55 ui-monospace,Consolas,monospace;color:#9aa0a6;',
    'background:rgba(0,0,0,.26);border-radius:8px;padding:6px 8px;margin-top:2px}',
    '.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.foot{margin-top:8px;color:#6b7280;font-size:9.5px;text-align:center;letter-spacing:.2px}',
    '.panel.collapsed .body{display:none}'
  ].join('');

  var PANEL_HTML = [
    '<div class="panel" id="panel">',
    '  <div class="hdr" id="hdr" title="拖动移动 · 双击复位">',
    '    <span class="dot" id="dot"></span>',
    '    <span class="title">任务点</span>',
    '    <span class="badge" id="badge">–</span>',
    '    <span class="spacer"></span>',
    '    <button class="icon" id="fold" type="button">–</button>',
    '  </div>',
    '  <div class="body">',
    '    <div class="stats">',
    '      <div class="stat"><b id="v-cur">–</b><span>当前</span></div>',
    '      <div class="stat"><b id="v-done">–</b><span>已完成</span></div>',
    '      <div class="stat"><b id="v-total">–</b><span>节点</span></div>',
    '    </div>',
    '    <div class="bar"><i id="fill"></i></div>',
    '    <div class="now" id="now">未定位</div>',
    '    <div class="row">',
    '      <button id="btn-pause" type="button">暂停</button>',
    '      <button id="btn-next" type="button">下一个</button>',
    '    </div>',
    '    <div class="row">',
    '      <button id="btn-rescan" type="button">重扫</button>',
    '      <button id="btn-diag" type="button">诊断</button>',
    '    </div>',
    '    <div class="log" id="log"></div>',
    '    <div class="foot">v1.4.1 · 只读状态 · 模拟点击 · 不伪造进度</div>',
    '  </div>',
    '</div>'
  ].join('\n');

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function mountPanel() {
    if (!CFG.panel || panel.host || !document.documentElement) return;
    try {
      var host = document.createElement('div');
      host.id = 'cxauto-panel-host';
      host.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;';
      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
      document.documentElement.appendChild(host);

      panel.host = host;
      panel.root = root;
      panel.els = {
        panel: root.querySelector('#panel'),
        hdr: root.querySelector('#hdr'),
        dot: root.querySelector('#dot'),
        badge: root.querySelector('#badge'),
        fold: root.querySelector('#fold'),
        cur: root.querySelector('#v-cur'),
        done: root.querySelector('#v-done'),
        total: root.querySelector('#v-total'),
        fill: root.querySelector('#fill'),
        now: root.querySelector('#now'),
        pause: root.querySelector('#btn-pause'),
        next: root.querySelector('#btn-next'),
        rescan: root.querySelector('#btn-rescan'),
        diag: root.querySelector('#btn-diag'),
        log: root.querySelector('#log')
      };
      panel.ready = true;
      var saved = rawGet('cxauto:panel:v1', {}) || {};
      panel.collapsed = !!saved.collapsed;
      // 位置要在视口内，否则面板会“消失”（拖到过界 / 换过窗口尺寸）
      var sp = saved.pos;
      if (sp && isFinite(sp.x) && isFinite(sp.y) &&
          sp.x >= 0 && sp.y >= 0 &&
          sp.x < window.innerWidth - 80 && sp.y < window.innerHeight - 40) {
        panel.pos = { x: sp.x, y: sp.y };
      } else {
        panel.pos = null;
      }
      applyPanelPos();
      wirePanel();
      renderLog();
      updatePanel();
    } catch (e) {
      panel.ready = false;
    }
  }

  function applyPanelPos() {
    if (!panel.host) return;
    if (panel.collapsed) {
      panel.host.style.left = '';
      panel.host.style.top = '';
      panel.host.style.bottom = '14px';
      return;
    }
    if (panel.pos) {
      panel.host.style.left = panel.pos.x + 'px';
      panel.host.style.top = panel.pos.y + 'px';
      panel.host.style.bottom = '';
    } else {
      panel.host.style.left = '14px';
      panel.host.style.top = '';
      panel.host.style.bottom = '14px';
    }
  }

  function savePanelPos() {
    if (!panel.host) return;
    var r = panel.host.getBoundingClientRect();
    rawSet('cxauto:panel:v1', { pos: { x: Math.round(r.left), y: Math.round(r.top) }, collapsed: panel.collapsed });
  }

  function wirePanel() {
    var e = panel.els;

    e.fold.addEventListener('click', function () {
      panel.collapsed = !panel.collapsed;
      e.panel.classList.toggle('collapsed', panel.collapsed);
      e.fold.textContent = panel.collapsed ? '+' : '–';
      applyPanelPos();
      savePanelPos();
    });

    e.pause.addEventListener('click', function () { toggleEnabled(); });

    e.next.addEventListener('click', function () {
      state.triggerAt = 0;
      advance('manual');
    });

    e.rescan.addEventListener('click', function () {
      var s = scan();
      state.lastScan = s;
      state.lastScanAt = NOW();
      if (!state.currentKey && s.ok) state.currentKey = inferCurrent(s);
      var r = findRow(s, state.currentKey);
      if (r) state.currentEl = r.el;
      updatePanel();
      log('已重扫：' + (s.ok ? s.total + ' 个节点，' + s.done + ' 个已完成' : '没找到任务点'));
    });

    e.diag.addEventListener('click', function () { diagnose(); });

    var drag = null;
    e.hdr.addEventListener('pointerdown', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('button')) return;
      var r = panel.host.getBoundingClientRect();
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: r.left, oy: r.top, moved: false };
      panel.host.style.bottom = '';
      panel.host.style.top = r.top + 'px';
      panel.host.style.left = r.left + 'px';
      try { e.hdr.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
      ev.preventDefault();
    });

    window.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.sx;
      var dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      var x = Math.min(Math.max(8, drag.ox + dx), window.innerWidth - 120);
      var y = Math.min(Math.max(8, drag.oy + dy), window.innerHeight - 60);
      panel.host.style.left = x + 'px';
      panel.host.style.top = y + 'px';
    }, true);

    window.addEventListener('pointerup', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      drag = null;
      savePanelPos();
    }, true);

    e.hdr.addEventListener('dblclick', function () {
      panel.pos = null;
      panel.host.style.left = '';
      panel.host.style.top = '';
      panel.host.style.bottom = '14px';
      savePanelPos();
    });
  }

  function renderLog() {
    if (!panel.ready) return;
    var html = '';
    for (var i = logLines.length - 1; i >= 0 && i > logLines.length - 41; i--) {
      html += '<div>' + esc(logLines[i]) + '</div>';
    }
    panel.els.log.innerHTML = html;
  }

  function schedulePanelRefresh() {
    if (!panel.ready || panel.timer) return;
    panel.timer = setTimeout(function () {
      panel.timer = 0;
      updatePanel();
    }, 250);
  }

  function renderPanel(s) {
    if (!panel.ready) return;
    var e = panel.els;
    if (!s || !s.ok) {
      e.cur.textContent = '–';
      e.done.textContent = '–';
      e.total.textContent = '–';
      e.fill.style.width = '0%';
      e.now.textContent = '未找到任务点列表';
      return;
    }
    var idx = -1;
    for (var i = 0; i < s.rows.length; i++) if (s.rows[i].key === state.currentKey) { idx = i; break; }
    e.cur.textContent = idx >= 0 ? String(idx + 1) : '–';
    e.done.textContent = String(s.done);
    e.total.textContent = String(s.total);
    e.fill.style.width = Math.round((s.done / Math.max(1, s.total)) * 100) + '%';
    e.now.innerHTML = idx >= 0 ? '<b>' + esc(s.rows[idx].text.slice(0, 22)) + '</b>' : '未定位';
  }

  function updatePanel() {
    if (!panel.ready) return;
    var e = panel.els;
    if (!state.lastScan || NOW() - state.lastScanAt > 1000) {
      state.lastScan = scan();
      state.lastScanAt = NOW();
      if (state.lastScan.ok && !state.currentKey) state.currentKey = inferCurrent(state.lastScan);
    }
    var s = state.lastScan;
    var label = MODE_LABEL[state.mode] || state.mode;
    var color = MODE_COLOR[state.mode] || '#94a3b8';
    e.dot.style.background = color;
    e.dot.style.color = color;
    e.pause.textContent = CFG.enabled ? '暂停' : '继续';
    e.pause.classList.toggle('on', !CFG.enabled);
    renderPanel(s);
    e.badge.textContent = (s && s.ok ? s.done + '/' + s.total : '–') + ' · ' + label;
  }

  /* ================================================================== *
   * 13. 通知 / 诊断 / 开关
   * ================================================================== */

  function notify(msg) {
    log(msg);
    if (!CFG.notify) return;
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: '超星自动跳转', text: msg, timeout: 5000, silent: true });
        return;
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('超星自动跳转', { body: msg, silent: true });
      }
    } catch (e) { /* ignore */ }
  }

  function diagnose() {
    var s = scan();
    state.lastScan = s;
    state.lastScanAt = NOW();
    var v = pickVideo();
    try {
      console.log('%c[超星自动跳转] 诊断', 'color:#60a5fa;font-weight:bold');
      console.log('选择器：', s.sel, '| 任务点：', s.total, '| 已完成：', s.done);
      if (console.table) {
        console.table(s.rows.map(function (r, i) {
          return { i: i, key: r.key, done: r.done, active: r.active, type: r.type, text: r.text };
        }));
      }
      console.log('video：', v ? {
        src: sigOf(v).slice(0, 80), paused: v.paused, ended: v.ended,
        currentTime: v.currentTime, duration: v.duration, muted: v.muted, readyState: v.readyState
      } : null);
      console.log('状态：', state.mode, '| currentKey：', state.currentKey, '| 已处理结束：', state.mediaEndedFor);
    } catch (e) { /* ignore */ }
    log('诊断已输出到控制台');
    return { scan: s, video: v, state: state };
  }

  function toggleEnabled() {
    CFG.enabled = !CFG.enabled;
    saveCfg();
    if (!CFG.enabled) {
      state.mode = 'off';
      state.advanceScheduled = false;
    } else {
      state.mode = state.video && !state.video.paused ? 'playing' : 'idle';
    }
    updatePanel();
    log(CFG.enabled ? '已继续' : '已暂停', true);
  }

  /* ================================================================== *
   * 14. 启动
   * ================================================================== */

  function shouldOrchestrate() {
    var s = scan();
    state.lastScan = s;
    state.lastScanAt = NOW();
    if (!s.ok || !s.rows.length) return false;
    if (s.total >= 2) return true;
    try { return /studentstudy|knowledge/i.test(location.pathname); } catch (e) { return false; }
  }

  function isStudyUrl() {
    try {
      return /(studentstudy|mycourse|knowledge|chapter|ananas|course\/)/i.test(location.pathname + location.search);
    } catch (e) { return false; }
  }

  // 接管入口：超星的目录是异步渲染的，没出来就等，不直接退出
  function initialTakeover() {
    if (state.tookOver) return;

    var s0 = scan();
    state.lastScan = s0;
    state.lastScanAt = NOW();

    if (!s0.ok || !s0.rows.length) {
      // 目录还没出来：先把已经在页面上的视频管起来，等目录出现再接管任务点
      var vv = pickVideo();
      if (vv) {
        bindVideo(vv);
        state.video = vv;
        if (state.mode === 'idle' || state.mode === 'waiting') {
          state.mode = 'playing';
          updatePanel();
          ensurePlay('startup-no-list');
        }
      }
      if (NOW() - state.startAt < 3 * 60 * 1000) setTimeout(initialTakeover, 1500);
      return;
    }

    state.tookOver = true;

    var v = pickVideo();
    if (v) {
      bindVideo(v);
      state.video = v;
      state.mediaEndedFor = '';
      // 先按页面真实情况重新定位（active 标记 / 播放器标题），避免沿用上次的旧记录
      var located = s0.activeKey || matchByTitle(s0);
      if (located) state.currentKey = located;
      else if (!state.currentKey) state.currentKey = inferCurrent(s0);
      var r0 = findRow(s0, state.currentKey);
      state.currentEl = r0 ? r0.el : null;
      var doneAtStart = !!(r0 && r0.done);
      currentDoneFlag = doneAtStart;
      // 打开页面时当前点已完成、而且没在播：直接排下一个
      if (doneAtStart && (v.paused || v.ended)) {
        state.mode = 'idle';
        updatePanel();
        state.triggerAt = NOW();
        scheduleAdvance('startup-done');
        return;
      }
      state.mode = 'playing';
      updatePanel();
      if (v.ended) { onMediaEnd(v, 'ended'); return; }
      ensurePlay('startup');
      return;
    }
    if (CFG.autoStartOnLoad) advance('startup');
    updatePanel();
  }

  function start() {
    if (window.__cxAutoNext || (PAGE && PAGE.__cxAutoNext)) return;
    window.__cxAutoNext = { version: '1.4.1' };
    try { PAGE.__cxAutoNext = window.__cxAutoNext; } catch (e) { /* ignore */ }

    if (IS_TOP) {
      if (!isStudyUrl() && !shouldOrchestrate()) return;
    } else {
      // 子框架：只有自己真的有任务点列表才接管；外层同源已经跑起来就跳过
      try { if (window.top.__cxAutoNext) return; } catch (e) { /* 跨域父页面，忽略 */ }
      if (!shouldOrchestrate()) return;
    }

    state.startAt = NOW();
    loadPersisted();
    mountPanel();
    state.started = true;

    setTimeout(initialTakeover, 1200);

    document.addEventListener('load', function (ev) {
      var t = ev.target;
      if (!t || !t.tagName || t.tagName.toLowerCase() !== 'iframe') return;
      setTimeout(function () {
        var v = pickVideo();
        if (!v) return;
        bindVideo(v);
        if (state.mode === 'waiting' || state.mode === 'idle') {
          state.video = v;
          ensurePlay('iframe-load');
        }
      }, 600);
    }, true);

    // 记录真实用户输入：只有“刚点过页面”的暂停才算你主动暂停
    document.addEventListener('pointerdown', function (e) {
      if (!e.isTrusted) return;
      state.lastInputAt = NOW();
      // 之前因为自动播放限制被静音的，用户一点就恢复声音
      var v = state.video;
      if (state.autoMuted && v && !v.paused && !v.ended) {
        state.autoMuted = false;
        try {
          v.muted = false;
          setTimeout(function () {
            if (v.paused) { state.autoMuted = true; v.muted = true; try { v.play(); } catch (x) { /* ignore */ } }
          }, 400);
        } catch (x) { /* ignore */ }
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.isTrusted) state.lastInputAt = NOW();
    }, true);

    window.addEventListener('blur', function () {
      state.blurAt = NOW();
      log('窗口失焦');
    });

    window.addEventListener('focus', function () {
      state.blurAt = 0;
      var v = state.video || pickVideo();
      if (v && v.paused && !v.ended && state.wantPlay) {
        setTimeout(function () { maybeResume(v, '回到页面'); }, 300);
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        updatePanel();
        var v = state.video || pickVideo();
        if (v && v.paused && !v.ended && state.wantPlay) {
          setTimeout(function () { maybeResume(v, '页面重新可见'); }, 500);
        }
      }
    });

    try {
      var mo = new MutationObserver(function () {
        if (!state.started) return;
        onMutationRaw();
      });
      mo.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'data-status', 'data-state']
      });
    } catch (e) { /* ignore */ }

    setInterval(safetyTick, 5000);
  }

  /* ================================================================== *
   * 15. 对外接口 / 菜单 / 入口
   * ================================================================== */

  var API = null;

  if (IS_TOP) {
    API = {
      version: '1.4.1',
      cfg: CFG,
      state: state,
      scan: scan,
      diagnose: diagnose,
      advance: function () { state.triggerAt = 0; return advance('manual'); },
      ensurePlay: function () { return ensurePlay('manual'); },
      toggle: toggleEnabled,
      enable: function (on) {
        if (!!on !== CFG.enabled) toggleEnabled();
        return CFG.enabled;
      },
      rows: function () {
        var s = scan();
        return s.rows.map(function (r) { return { key: r.key, done: r.done, type: r.type, text: r.text }; });
      },
      set: function (k, v) { CFG[k] = v; saveCfg(); return CFG[k]; },
      save: function () { saveCfg(); return CFG; },
      showPanel: function () { CFG.panel = true; saveCfg(); mountPanel(); updatePanel(); },
      hidePanel: function () {
        CFG.panel = false;
        saveCfg();
        if (panel.host) { panel.host.remove(); panel.host = null; panel.ready = false; }
      }
    };
    window.__cxauto = API;
    try { PAGE.__cxauto = API; } catch (e) { /* ignore */ }
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function' || !API) return;
    try {
      GM_registerMenuCommand(CFG.enabled ? '⏸ 暂停自动跳转' : '▶ 继续自动跳转', function () { toggleEnabled(); });
      GM_registerMenuCommand('⏭ 立即进入下一个未完成', function () { state.triggerAt = 0; advance('manual'); });
      GM_registerMenuCommand('🔄 重扫任务点', function () {
        state.lastScan = scan();
        state.lastScanAt = NOW();
        if (!state.currentKey && state.lastScan.ok) state.currentKey = inferCurrent(state.lastScan);
        updatePanel();
      });
      GM_registerMenuCommand('🔎 诊断', function () { diagnose(); });
      GM_registerMenuCommand('👁 显示/隐藏面板', function () {
        if (CFG.panel) API.hidePanel(); else API.showPanel();
      });
      GM_registerMenuCommand('🧹 重置本课程记录', function () {
        var all = rawGet(STORE_STATE, {}) || {};
        delete all[courseKey()];
        rawSet(STORE_STATE, all);
        state.currentKey = '';
        MEM.finished = {};
        MEM.skipped = {};
        log('已重置本课程记录', true);
      });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); registerMenu(); });
  } else {
    start();
    registerMenu();
  }
})();
