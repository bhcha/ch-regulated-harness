/* =============================================================================
   web-diagram engine — text/mermaid 모델을 Cytoscape.js + dagre 로 렌더링하고
   document-refer/diagram 규칙(1~14)을 좌표 라우팅으로 강제한다.

   입력: window.DIAGRAM_MODEL = {
     nodes: [{ id, label, type }],            // type: terminal|decision|process|outcome|aux
     edges: [{ source, target, label, dashed?, feedback?, color? }],
     outcomeColors: { <nodeId>: 'go'|'nogo'|'handoff'|'hold' }  // 결과 노드 의미색
     title?: string
   }
   기능: 줌/맞춤·클릭 하이라이트(선 추적: 노드/선 클릭→연결선 강조)·접근성 텍스트대체·폴백
   배치: 주 흐름 체인을 단일 중앙 x(척추)로 고정 + 결정 노드를 분기 대상 가운데로 정렬
         → 규칙 2·7·9 를 '라우팅'이 아니라 '배치'로 보장(dagre 가 못 지키는 부분).
   검사: window.verifyDiagram() → 규칙 4/5/7/8/9/13/14 좌표 위반 목록 (규칙을 '코드로 검사')
   ============================================================================= */
(function () {
  "use strict";
  var M = window.DIAGRAM_MODEL;
  var mount = document.getElementById("flow-diagram");
  if (!mount || !M) return;
  if (typeof cytoscape === "undefined" || typeof dagre === "undefined") {
    mount.classList.add("is-fallback");
    var fb = document.querySelector(".diagram-fallback"); if (fb) fb.style.display = "block";
    var ta = document.getElementById("flow-textalt"); if (ta) ta.open = true;
    return;
  }

  /* ---------- 상수 (규칙 공통 정의·상수 블록과 일치) ---------- */
  var K = {
    forkGap: 24, minStub: 24, sidePortGap: 14, clearance: 8, railOffset: 24,
    endpointTol: 4, axisTol: 3, xTol: 8, labelInflate: 6, labelGap: 8, ownLabelDist: 6,
    minTraceGap: 28, maxSharedBus: 18, dashPeriod: 16, minLabelClear: 10,
    rankSep: 150, nodeSep: 58, rankTol: 32, cornerSafeGap: 10, minBranchSep: 80
  };
  /* 의미색 — 규칙 10/11 (결과 유형 인코딩, 색맹 안전·대비 고려) */
  var COLOR = {
    go:      { line: "#2e7d32", bg: "#e8f5ea", border: "#7cbe84", text: "#2e7d32" },
    nogo:    { line: "#c0392b", bg: "#fbeae8", border: "#e09a90", text: "#c0392b" },
    handoff: { line: "#006f80", bg: "#e2f1f3", border: "#7cbdc7", text: "#006f80" },
    hold:    { line: "#8a5b00", bg: "#fbf2dd", border: "#dcc079", text: "#8a5b00" }
  };
  var T = { ink: "#1f2123", muted: "#6b7074", line: "#c5c9cc", orange: "#e98300",
            accent: "#9a5400", dark: "#565a5c", process: "#fdf1e2", processBd: "#e98300" };

  /* ---------- 라벨 폭 사전계산 (한글 폭 반영) ---------- */
  function measure(label) {
    var lines = String(label).split("\n"), maxw = 0;
    for (var i = 0; i < lines.length; i++) {
      var w = 0, s = lines[i];
      for (var j = 0; j < s.length; j++) w += s.charCodeAt(j) < 128 ? 7.7 : 14.2;
      if (w > maxw) maxw = w;
    }
    return { w: Math.max(100, Math.min(250, Math.round(maxw) + 32)), h: Math.max(54, lines.length * 21 + 22) };
  }

  /* ---------- 라벨 줄바꿈 (단어 맥락 기준 — 긴 분기 라벨을 좁은 여러 줄로) ----------
     이미 \n 이 있으면 존중. 공백·'·' 를 끊는 지점으로 보고 줄당 target(시각폭) 이내로 그리디 패킹.
     좁아져서 선 사이 빈 틈에 더 잘 들어가고(겹침↓), 세로로 읽기 편해진다.                      */
  function vlen(t) { var w = 0; for (var i = 0; i < t.length; i++) w += t.charCodeAt(i) < 128 ? 0.55 : 1; return w; }
  function wrapLabel(s, maxLine) {
    s = String(s == null ? "" : s);
    if (!s || s.indexOf("\n") >= 0 || vlen(s) <= maxLine) return s;
    // ① '·'(의미 구분자)가 있으면 그 경계에서 줄을 나눈다(부호는 줄바꿈으로 대체).
    var segs = s.indexOf("·") >= 0 ? s.split("·").map(function (x) { return x.trim(); }).filter(Boolean) : [s];
    var out = [];
    segs.forEach(function (seg) {
      if (vlen(seg) <= maxLine) { out.push(seg); return; }
      // ② 여전히 길면 공백(단어) 경계 중 '중앙에 가장 가까운' 곳에서 2줄로(단어 안 자름).
      var words = seg.split(/\s+/).filter(Boolean);
      if (words.length < 2) { out.push(seg); return; }
      var total = vlen(seg), best = 1, bestDiff = 1e9;
      for (var i = 1; i < words.length; i++) { var left = vlen(words.slice(0, i).join(" ")); var diff = Math.abs(left - total / 2); if (diff <= bestDiff) { bestDiff = diff; best = i; } }
      out.push(words.slice(0, best).join(" ")); out.push(words.slice(best).join(" "));
    });
    return out.join("\n");
  }

  /* ---------- 결과 노드 판정 (규칙 9): type=outcome 또는 outdegree 0 terminal ---------- */
  var outdeg = {};
  M.edges.forEach(function (e) { outdeg[e.source] = (outdeg[e.source] || 0) + 1; });
  function isOutcome(n) {
    if (n.type === "outcome") return true;
    if (n.type === "terminal" && !outdeg[n.id]) return true;   // 흐름 종착
    return false;
  }
  var RESULT = {}, OCOL = M.outcomeColors || {};
  M.nodes.forEach(function (n) { if (isOutcome(n)) RESULT[n.id] = true; });

  /* 긴 분기 라벨을 단어 단위로 줄바꿈(좁은 여러 줄) — 렌더·측정·배치 모두 이 라벨을 쓴다 */
  M.edges.forEach(function (e) { e.label = wrapLabel(e.label || "", 6.5); });

  /* ---------- cytoscape elements ---------- */
  var elements = [];
  M.nodes.forEach(function (n) {
    var m = measure(n.label);
    elements.push({ data: { id: n.id, label: n.label, w: m.w, h: m.h }, classes: nodeClass(n) });
  });
  M.edges.forEach(function (e, i) {
    elements.push({ data: { id: "e" + i, source: e.source, target: e.target, label: e.label || "",
      dashed: !!e.dashed, feedback: !!e.feedback }, classes: (e.feedback ? "feedback " : "") + (e.dashed ? "aux " : "") });
  });
  function nodeClass(n) {
    if (RESULT[n.id] && OCOL[n.id]) return "outcome o-" + OCOL[n.id];
    if (n.type === "terminal") return "terminal";
    if (n.type === "decision") return "decision";
    if (n.type === "aux") return "aux";
    return "process";
  }

  function nodeStyle(bg, bd, tx, r) {
    return { "background-color": bg, "border-color": bd, "border-width": 1.6, "color": tx, "corner-radius": r || 10 };
  }
  var style = [
    { selector: "node", style: {
        "label": "data(label)", "text-wrap": "wrap", "text-max-width": 230, "text-valign": "center", "text-halign": "center",
        "font-family": "Pretendard, system-ui, sans-serif", "font-size": 14, "font-weight": 600, "line-height": 1.3,
        "shape": "round-rectangle", "width": "data(w)", "height": "data(h)" } },
    { selector: "node.terminal", style: { "background-color": T.dark, "border-color": T.dark, "color": "#fff", "font-weight": 700, "corner-radius": 22, "border-width": 1.6 } },
    { selector: "node.decision", style: nodeStyle("#ffffff", T.dark, T.ink, 10) },
    { selector: "node.process", style: nodeStyle(T.process, T.processBd, T.ink, 10) },
    { selector: "node.aux", style: { "background-color": "#f4f5f6", "border-color": "#b8bcc0", "border-width": 1.4, "border-style": "dashed", "color": T.muted, "font-weight": 500, "corner-radius": 10 } },
    { selector: "edge", style: {
        "width": 1.8, "line-color": T.line, "target-arrow-color": T.line, "target-arrow-shape": "triangle", "arrow-scale": 1.05,
        "curve-style": "taxi", "taxi-direction": "downward", "taxi-turn": "50%", "taxi-turn-min-distance": 8, "taxi-radius": 0,
        "label": "data(label)", "edge-text-rotation": "none", "font-family": "Pretendard, system-ui, sans-serif",
        "font-size": 11.5, "font-weight": 700, "color": T.muted, "text-wrap": "wrap", "text-max-width": 200, "line-height": 1.25,
        "text-background-color": "#ffffff", "text-background-opacity": 0.94, "text-background-padding": 3, "text-background-shape": "round-rectangle" } },
    { selector: "node.wp", style: { "width": 1, "height": 1, "opacity": 0, "background-opacity": 0, "border-width": 0, "label": "", "events": "no" } },
    { selector: "node.wp.editing", style: { "width": 12, "height": 12, "opacity": 1, "background-opacity": 0.95, "background-color": T.orange, "border-width": 2, "border-color": "#fff", "shape": "ellipse" } },
    { selector: "node.handle", style: { "width": 12, "height": 12, "shape": "round-rectangle", "background-color": T.orange, "background-opacity": 0.95, "border-width": 2, "border-color": "#fff", "label": "", "events": "yes", "z-index": 999 } },
    { selector: "edge.feedback", style: { "line-style": "dashed", "line-color": T.orange, "target-arrow-color": T.orange, "color": T.accent, "curve-style": "straight", "target-arrow-shape": "none" } },
    { selector: "edge.fbseg-arrow", style: { "target-arrow-shape": "triangle", "arrow-scale": 1.05 } },
    { selector: "edge.route", style: { "curve-style": "straight" } }
  ];
  Object.keys(COLOR).forEach(function (k) {
    var c = COLOR[k];
    style.push({ selector: "node.o-" + k, style: { "background-color": c.bg, "border-color": c.border, "border-width": 2, "color": c.text, "font-weight": 700, "corner-radius": 16 } });
  });
  // 클릭 하이라이트(선 추적): 강조 선/노드는 진하게, 나머지는 흐리게
  style.push({ selector: ".dimmed", style: { "opacity": 0.16 } });
  style.push({ selector: "edge.hl", style: { "opacity": 1, "width": 3.4, "text-opacity": 1, "z-index": 900 } });
  style.push({ selector: "node.hl", style: { "opacity": 1, "z-index": 900 } });

  // 적응형 rank 간격(규칙 13: 라벨이 들어갈 만큼만, 과한 세로 여백은 가독성↓). 라벨 높이로 하한 보장.
  (function () {
    var maxLH = 54; M.edges.forEach(function (e) { if (e.label) { var h = measure(e.label).h; if (h > maxLH) maxLH = h; } });
    K.rankSep = Math.max(110, Math.min(140, maxLH + 2 * K.minLabelClear + K.forkGap + K.cornerSafeGap));
  })();

  var cy;
  try {
    cy = cytoscape({ container: mount, elements: elements, minZoom: 0.3, maxZoom: 2.2,
      userZoomingEnabled: false, userPanningEnabled: true, boxSelectionEnabled: false,
      autoungrabify: false, autounselectify: false, style: style,
      layout: { name: "dagre", rankDir: "TB", nodeSep: K.nodeSep, edgeSep: 22, rankSep: K.rankSep, ranker: "network-simplex", padding: 24 } });
  } catch (err) { mount.classList.add("is-fallback"); var t = document.getElementById("flow-textalt"); if (t) t.open = true; return; }

  /* ============================ 라우팅 헬퍼 ============================ */
  // CURLG: 현재 만들고 있는 '논리 선'의 출발/도착 실노드(클릭 하이라이트용). seg 들이 태깅을 물려받는다.
  // ('*' = 공유 구간 — 여러 원인/분기가 함께 쓰는 스텁·버스, 어느 쪽 클릭에도 함께 강조)
  var _c = 0, CURLG = { s: "", t: "" };
  function lg(s, t) { CURLG = { s: s, t: t }; }
  function wp(x, y) { var id = "_w" + (_c++); cy.add({ group: "nodes", data: { id: id }, classes: "wp", position: { x: x, y: y } }); return id; }
  function box(id) { var n = cy.getElementById(id), p = n.position(), w = n.width() / 2, h = n.height() / 2;
    return { cx: p.x, cy: p.y, lft: p.x - w, rgt: p.x + w, top: p.y - h, bot: p.y + h }; }
  function lineStyle(col, wd, dash) { var s = { "line-color": col, "color": col, "width": wd, "curve-style": "straight", "target-arrow-shape": "none" }; if (dash) s["line-style"] = "dashed"; return s; }
  function arrowStyle(col, wd, dash) { var s = { "line-color": col, "target-arrow-color": col, "color": col, "width": wd, "curve-style": "straight", "target-arrow-shape": "triangle", "arrow-scale": 1.1 }; if (dash) s["line-style"] = "dashed"; return s; }
  function seg(s, t, label, st) { var id = "_s" + (_c++); var e = cy.add({ group: "edges", classes: "route", data: { id: id, source: s, target: t, label: label || "", logical: 1, lsrc: CURLG.s, ltgt: CURLG.t } }); if (st) e.style(st); return e; }
  // src → 경유점들 → tgt; labelAt 인덱스 세그먼트에 라벨; endArrow는 마지막 세그먼트.
  function polyline(srcId, pts, tgtId, label, labelAt, st, endArrow) {
    var prev = srcId;
    for (var i = 0; i < pts.length; i++) { var w = wp(pts[i][0], pts[i][1]); seg(prev, w, (i === labelAt ? label : ""), st); prev = w; }
    seg(prev, tgtId, (labelAt === pts.length ? label : ""), endArrow || st);
  }
  function realNodes() { return cy.nodes().filter(function (n) { return !n.hasClass("wp") && !n.hasClass("handle"); }); }
  function colColumnBlocked(colX, y0, y1, exceptIds) {
    return realNodes().some(function (nd) {
      if (exceptIds.indexOf(nd.id()) >= 0) return false;
      var p = nd.position(), hw = nd.width() / 2 + K.clearance, hh = nd.height() / 2;
      return colX > p.x - hw && colX < p.x + hw && (p.y + hh) > y0 + 4 && (p.y - hh) < y1 - 4;
    });
  }

  /* ============================ 규칙 기반 레이아웃 ============================
     1) 결과 노드를 하단 행으로(규칙 9)  2) 결과별 원인 분리 레인 + 공통버스 단일화살표
     (규칙 10·11·14)  3) 피드백 외곽 레인(다른 면, 규칙 12)  4) 나머지 forward 직교(taxi).
     dagre 좌표를 기반으로 일반 그래프에 동작.                                       */
  /* ---------- 주 흐름(척추) 식별 — 규칙 7·9 의 배치 강제 ----------
     dagre 는 교차·폭 최소화로 x 를 정할 뿐 "결정 노드를 분기 대상 가운데"에 두지 않는다.
     그래서 결정이 한쪽 끝에 놓이면 분기선이 한쪽으로 쏠리고(규칙 2·7 위반), 주 흐름이
     가운데를 곧게 통과하지 못한다(규칙 9). → 주 흐름 체인을 찾아 단일 spineX 로 고정하고,
     비-척추 결정은 분기 대상 가운데로 옮겨 라우팅이 아니라 '배치'로 규칙을 보장한다.       */
  var SPINE = [], onSpine = {}, spineX = 0, HAS_LOCAL = {};   // HAS_LOCAL: 옆으로 가는 지역분기가 있는 결정(이탈 측면출발 판정용)
  function fwdAdj() {
    var f = {}; M.nodes.forEach(function (n) { f[n.id] = []; });
    M.edges.forEach(function (e) {
      if (e.feedback || e.dashed) return;                                   // 되돌림·보조선은 주 흐름 아님
      if (cy.getElementById(e.source).empty() || cy.getElementById(e.target).empty()) return;
      f[e.source].push(e.target);
    });
    return f;
  }
  function buildSpine() {
    var fwd = fwdAdj(), lenMemo = {}, goMemo = {};
    function dfs(id, seen) {                                                 // 앞으로 가장 긴 체인 + GO 도달 여부
      if (lenMemo[id] != null) return lenMemo[id];
      if (seen[id]) return 0; seen[id] = 1;
      var best = 0, rgo = (RESULT[id] && OCOL[id] === "go");
      fwd[id].forEach(function (t) { var s2 = {}; for (var k in seen) s2[k] = 1; var l = dfs(t, s2);
        if (l + 1 > best) best = l + 1; if (goMemo[t] || (RESULT[t] && OCOL[t] === "go")) rgo = true; });
      lenMemo[id] = best; goMemo[id] = rgo; return best;
    }
    M.nodes.forEach(function (n) { dfs(n.id, {}); });
    var indeg = {}; M.nodes.forEach(function (n) { indeg[n.id] = 0; });
    Object.keys(fwd).forEach(function (s) { fwd[s].forEach(function (t) { indeg[t]++; }); });
    var roots = M.nodes.filter(function (n) { return indeg[n.id] === 0; }).map(function (n) { return n.id; });
    var root = roots[0] || M.nodes[0].id;
    var spine = [root], cur = root, on = {}, guard = 0; on[root] = 1;
    while (guard++ < M.nodes.length + 2) {                                   // 매 단계 'GO 도달·더 긴 체인' 후속을 따라감
      var nexts = fwd[cur].filter(function (t) { return !on[t]; });
      if (!nexts.length) break;
      nexts.sort(function (a, b) { var ga = goMemo[a] ? 1 : 0, gb = goMemo[b] ? 1 : 0;
        if (ga !== gb) return gb - ga; return (lenMemo[b] || 0) - (lenMemo[a] || 0); });
      var nx = nexts[0]; spine.push(nx); on[nx] = 1; cur = nx;
      if (RESULT[nx]) break;                                                 // 척추는 결과(GO)에서 끝
    }
    return spine;
  }
  function semTargets(id) {
    var t = []; M.edges.forEach(function (e) { if (e.source !== id || e.feedback || e.dashed) return;
      if (!cy.getElementById(e.target).empty()) t.push(e.target); }); return t;
  }
  function branchSep() {
    var w = K.minBranchSep; M.edges.forEach(function (e) { if (e.label) { var m = measure(e.label); if (m.w + 24 > w) w = m.w + 24; } });
    return Math.min(w, 220);
  }

  function relayout() {
    SPINE = buildSpine(); onSpine = {}; SPINE.forEach(function (id) { onSpine[id] = 1; });
    var rb = realNodes().boundingBox();
    spineX = Math.round(rb.x1 + rb.w / 2);
    var minBS = branchSep();
    // ① 척추(결과 아님)를 중앙 x 로 고정 — 주 흐름이 가운데를 곧게 통과(규칙 7·9), 분기 쏠림 제거(규칙 2)
    SPINE.forEach(function (id) { if (!RESULT[id]) { var nd = cy.getElementById(id); nd.position({ x: spineX, y: nd.position("y") }); } });
    // ② 비-척추 비-결과 노드: 척추 칼럼과 안 겹치게 dagre 가 정한 쪽으로 minBranchSep 만큼 비켜 둠(규칙 5·6)
    realNodes().forEach(function (nd) {
      var id = nd.id(); if (onSpine[id] || RESULT[id]) return;
      var p = nd.position(), side = p.x < spineX ? -1 : 1, minDx = nd.width() / 2 + minBS;
      if (Math.abs(p.x - spineX) < minDx) nd.position({ x: spineX + side * minDx, y: p.y });
    });
    // ③ 비-척추 결정 노드를 분기 대상(비-결과)의 가운데로(규칙 7) — 양쪽 대칭 분기
    realNodes().forEach(function (nd) {
      var id = nd.id(); if (onSpine[id] || RESULT[id] || !nd.hasClass("decision")) return;
      var ts = semTargets(id).map(function (t) { return cy.getElementById(t); })
        .filter(function (t) { return !t.empty() && !RESULT[t.id()]; });
      if (ts.length < 2) return;
      var xs = ts.map(function (t) { return t.position("x"); });
      nd.position({ x: Math.round((Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2), y: nd.position("y") });
    });
    // ④ 결과 노드 하단 행(규칙 9). 주 흐름 결과(GO)는 중앙, 나머지는 좌우 대칭 분산.
    //    Rec 류 sink(기록 노드: 출력 0)는 결과 행보다 더 아래 중앙에 둔다(결과를 가리지 않게, 규칙 5·9).
    // 하단 중앙 sink = 결과 노드에서만 들어오는 '기록' 노드(Rec). 중간 보조노트(Caug, 결정에서 들어옴)는 제외 → ② 측면 배치.
    var sinks = M.nodes.filter(function (n) {
      if (RESULT[n.id] || outdeg[n.id]) return false;
      var srcs = M.edges.filter(function (e) { return e.target === n.id; });
      return srcs.length > 0 && srcs.every(function (e) { return RESULT[e.source]; });
    }).map(function (n) { return n.id; });
    var isSink = {}; sinks.forEach(function (id) { isSink[id] = 1; });
    var nb = realNodes().filter(function (n) { return !RESULT[n.id()] && !isSink[n.id()]; }).boundingBox();
    var outH = 0; M.nodes.forEach(function (n) { if (RESULT[n.id]) { var h = measure(n.label).h; if (h > outH) outH = h; } });
    var bottomY = nb.y2 + Math.max(outH / 2 + 70, 100);   // 결과 행을 결정부에 조금 더 가깝게(규칙 9: top ≥ +40 여유 유지)
    var outs = M.nodes.filter(function (n) { return RESULT[n.id]; }).map(function (n) { return n.id; });
    // ③ 의미순 좌→우(원본과 동일: 중단·보류·진행·다른방법). 미지정 색은 등장 순서로 뒤에.
    var SEMO = { nogo: 0, hold: 1, go: 2, handoff: 3 };
    var eord = {}; M.edges.forEach(function (e, i) { if (RESULT[e.target] && eord[e.target] === undefined) eord[e.target] = i; });
    outs.sort(function (a, b) {
      var sa = SEMO[OCOL[a]], sb2 = SEMO[OCOL[b]];
      if (sa != null && sb2 != null && sa !== sb2) return sa - sb2;
      if (sa != null && sb2 == null) return -1; if (sa == null && sb2 != null) return 1;
      return (eord[a] == null ? 1e9 : eord[a]) - (eord[b] == null ? 1e9 : eord[b]);
    });
    // ① 결과 간격 = 결과 노드 폭 기준(겹침 방지). nb.w(보조노트 outlier 포함)와 분리 → 과한 폭 방지.
    var nn = outs.length, maxOW = 0, pos = {};
    outs.forEach(function (id) { var w = cy.getElementById(id).width(); if (w > maxOW) maxOW = w; });
    var gap = Math.max(220, maxOW + 36);
    outs.forEach(function (id, i) { pos[id] = i * gap; });                    // 좌→우 등간격
    var spineOut = outs.filter(function (id) { return onSpine[id]; })[0];     // 주 흐름 결과(GO)
    var anchor = spineOut != null ? pos[spineOut] : (nn - 1) * gap / 2;
    outs.forEach(function (id) { pos[id] = spineX + (pos[id] - anchor); });   // GO 가 spineX 에 오도록 행 평행이동
    outs.forEach(function (id) { cy.getElementById(id).position({ x: Math.round(pos[id]), y: bottomY }); });
    var oH = outs.length ? (cy.getElementById(outs[0]).height() / 2) : 30;
    sinks.forEach(function (id) { cy.getElementById(id).position({ x: spineX, y: bottomY + oH + 90 }); });
    return { rb: rb, bottomY: bottomY };
  }

  function classifyEdges() {
    var pass = [], local = [], exitByTgt = {}, feedback = [], aux = [];
    M.edges.forEach(function (e) {
      if (e.feedback) { feedback.push(e); return; }
      if (cy.getElementById(e.source).empty() || cy.getElementById(e.target).empty()) return;
      var sb = box(e.source), tb = box(e.target);
      if (e.dashed && !RESULT[e.target]) { aux.push(e); return; }                 // 보조 점선
      var spineEdge = onSpine[e.source] && onSpine[e.target];                      // 척추 간선 = 주 흐름(가운데 직진)
      if (RESULT[e.target]) {
        if (spineEdge && Math.abs(tb.cx - sb.cx) <= K.xTol && tb.cy > sb.cy) pass.push(e);  // 척추 종착(GO) = 통과
        else (exitByTgt[e.target] = exitByTgt[e.target] || []).push(e);            // 그 외 결과 = 이탈 레일(규칙 10)
      } else if (spineEdge && tb.cy > sb.cy) pass.push(e);                         // 척추→척추 = 주 흐름 직진
      else local.push(e);                                                         // 지역 분기(규칙 6)
    });
    return { pass: pass, local: local, exitByTgt: exitByTgt, feedback: feedback, aux: aux };
  }

  function greenFor(tgt) { return (RESULT[tgt] && OCOL[tgt] === "go") || passGoChain[tgt]; }
  var passGoChain = {};   // 진행 GO 로 이어지는 통과선(규칙: 주 흐름 색)

  function route() {
    var cls = classifyEdges();
    HAS_LOCAL = {}; cls.local.forEach(function (e) { HAS_LOCAL[e.source] = 1; });   // 옆 지역분기가 있는 결정 표시
    // 통과선 중 결국 GO 로 가는 체인을 초록으로(주 흐름 강조). 간단히 GO 로 끝나는 pass 우선.
    var goId = M.nodes.filter(function (x) { return RESULT[x.id] && OCOL[x.id] === "go"; }).map(function (x) { return x.id; })[0];

    // 원 논리 엣지 제거 후 재구성
    cy.remove(cy.edges().filter(function (e) { return !e.hasClass("route"); }));

    // (A) 통과/지역 분기 — 단일 분기점 F(규칙 6). 같은 source 의 pass+local 묶기
    var bySrc = {};
    cls.pass.forEach(function (e) { (bySrc[e.source] = bySrc[e.source] || []).push({ e: e, kind: "pass" }); });
    cls.local.forEach(function (e) { (bySrc[e.source] = bySrc[e.source] || []).push({ e: e, kind: "local" }); });
    var GREEN = lineStyle(COLOR.go.line, 2.2, false), GRAY = lineStyle(T.line, 1.8, false), LOCAL = lineStyle(T.muted, 2.0, false);
    Object.keys(bySrc).forEach(function (sid) {
      var brs = bySrc[sid], sb = box(sid);
      // 주 흐름=초록, 지역 분기=회색. 결과 노드로 종착하는 분기는 화살표를 단다(규칙 14).
      function brStyle(b) { var col = b.kind === "pass" ? COLOR.go.line : T.muted, wd = b.kind === "pass" ? 2.2 : 2.0;
        return RESULT[b.e.target] ? arrowStyle(col, wd, false) : lineStyle(col, wd, false); }
      if (brs.length === 1) {
        var b = brs[0], tb = box(b.e.target);
        lg(sid, b.e.target);
        if (Math.abs(tb.cx - sb.cx) <= K.xTol) seg(sid, b.e.target, b.e.label, brStyle(b));
        else polyline(sid, [[sb.cx, sb.bot + K.forkGap], [tb.cx, sb.bot + K.forkGap]], b.e.target, b.e.label, 1, brStyle(b));
        return;
      }
      var hasPass = brs.some(function (b) { return b.kind === "pass"; });
      var Fy = sb.bot + K.forkGap, F = wp(sb.cx, Fy);
      lg(sid, "*"); seg(sid, F, "", hasPass ? GREEN : LOCAL);    // 공유 분기 스텁(어느 분기 클릭에도 함께 강조)
      brs.forEach(function (b) {
        var tb = box(b.e.target);
        lg(sid, b.e.target);
        if (Math.abs(tb.cx - sb.cx) <= K.xTol) seg(F, b.e.target, b.e.label, brStyle(b));
        else polyline(F, [[tb.cx, Fy]], b.e.target, b.e.label, 0, brStyle(b));   // F→대상 풀폭 수평(라벨 슬라이드 여유)
      });
    });

    // (B) 이탈 레일 — 결과별 원인 분리 레인 + 공통버스 단일 화살표(규칙 10·11·14)
    Object.keys(cls.exitByTgt).forEach(function (tid) { buildExitRail(tid, cls.exitByTgt[tid]); });

    // (C) 피드백 — 외곽 레인, 서로 다른 면 진입(규칙 12)
    buildFeedback(cls.feedback);

    // (D) aux 점선
    cls.aux.forEach(function (e) {
      var sb = box(e.source), tb = box(e.target), st = lineStyle(T.line, 1.6, true);
      lg(e.source, e.target);
      if (Math.abs(sb.cx - tb.cx) <= K.xTol || Math.abs(sb.cy - tb.cy) <= K.xTol) seg(e.source, e.target, e.label, st);  // 수직·수평 정렬: 직선(중복 wp 방지)
      else polyline(e.source, [[sb.cx, sb.bot + 20], [tb.cx, sb.bot + 20]], e.target, e.label, 1, st);                   // 그 외: ㄱ자 직교
    });
    cy.nodes(".wp").ungrabify();
  }

  function buildExitRail(tid, edges) {
    var tb = box(tid), c = COLOR[OCOL[tid]] || { line: T.line }, col = c.line, wd = 2.2;
    edges.sort(function (a, b) { var ya = box(a.source).cy, yb = box(b.source).cy; return ya !== yb ? ya - yb : (a.label < b.label ? -1 : 1); });
    var rb = realNodes().boundingBox();
    var busY = tb.top - K.forkGap, stub = wp(tb.cx, busY), g = K.minTraceGap;
    lg("*", tid); seg(stub, tid, "", arrowStyle(col, wd, false));    // 규칙 14 단일 화살표(공유 버스)
    // 레인 x 배정:
    //   ① 결과 노드 '중앙'(tb.cx)에 맞춰 곧장 수직으로 내린다(깔끔한 2꺾임). 같은 결과로 가는 다른
    //      원인선은 결과 박스 폭 안(nearBound)에서 ±minTraceGap 슬롯으로만 분리(규칙 11).
    //   ② 중앙~근처 슬롯이 무관 노드에 가리면(규칙 5) — 억지로 두면 노드를 피하느라 여러 번 꺾여
    //      복잡해진다 — 그 선은 '외곽 레일'로 깔끔히 뺀다(끝단에서 빈 컬럼으로 직하).
    var leftSide = tb.cx < spineX, dir = leftSide ? -1 : 1;
    var edgeBase = leftSide ? (rb.x1 - K.railOffset) : (rb.x2 + K.railOffset);
    var nearBound = (tb.rgt - tb.cx) + 2;                            // 결과 박스에 '얹히는' 범위까지만 중앙정렬로 인정
    var usedNear = [], usedEdge = [], lane = {};
    // ① 레인 x 배정(세로 레인은 소스 중앙 높이~busY 구간). 중앙 우선, 막히면 외곽.
    edges.forEach(function (e) {
      var sb = box(e.source), y0 = Math.min(sb.cy, busY) - 4, y1 = Math.max(sb.cy, busY) + 4, lx = null;
      for (var s = 0; s < 12 && lx === null; s++) {
        var off = (s % 2 === 1 ? 1 : -1) * Math.ceil(s / 2) * g;
        if (Math.abs(off) > nearBound) break;
        var cand = tb.cx + off;
        if (usedNear.some(function (u) { return Math.abs(u - cand) < g - 1; })) continue;
        if (!colColumnBlocked(cand, y0, y1, [e.source, tid])) { lx = cand; usedNear.push(lx); }
      }
      if (lx === null) { var ex = edgeBase, guard = 0;
        while ((usedEdge.some(function (u) { return Math.abs(u - ex) < g - 1; }) || colColumnBlocked(ex, y0, y1, [e.source, tid])) && guard++ < 80) ex += dir * g;
        lx = ex; usedEdge.push(lx); }
      lane[e.source + "|" + e.target] = lx;
    });
    // ② 소스·방향별 포트 분배(규칙 10: 결과 방향 변에서, 같은 변 다중 이탈은 sidePortGap 으로 분리)
    function sideOf(e) { return lane[e.source + "|" + e.target] >= box(e.source).cx ? 1 : -1; }
    var grp = {}; edges.forEach(function (e) { var k = e.source + "|" + sideOf(e); (grp[k] = grp[k] || []).push(e); });
    // 측면 출발 경로(노드 중앙 높이의 가로구간)가 무관 노드를 안 지나는가(규칙 5)
    function sidePathClear(sb, lx, srcId) {
      var x0 = Math.min(sb.cx, lx), x1 = Math.max(sb.cx, lx), y = sb.cy;
      return !realNodes().some(function (nd) { var id = nd.id(); if (id === srcId || id === tid) return false;
        var p = nd.position(), hw = nd.width() / 2 + K.clearance, hh = nd.height() / 2 + 4;
        return (p.x + hw) > x0 && (p.x - hw) < x1 && (p.y + hh) > y && (p.y - hh) < y; });
    }
    // ③ 라우팅: '지역분기가 있는 결정(바닥 fork와 충돌)'이고 측면 경로가 깨끗하면 → 노드 측면(중앙 높이)에서
    //    출발(규칙 10)해 바닥 밴드와 분리. 그 외는 기존 바닥 출발(규칙 5 우선) 유지.
    edges.forEach(function (e) {
      var sb = box(e.source), lx = lane[e.source + "|" + e.target], side = sideOf(e);
      var centered = Math.abs(lx - tb.cx) <= K.axisTol, m = measure(e.label), pts, labelAt;
      if (HAS_LOCAL[e.source] && sidePathClear(sb, lx, e.source)) {   // 측면 포트 출발(규칙 10)
        var ext = side > 0 ? sb.rgt + 14 : sb.lft - 14;
        var sibs = grp[e.source + "|" + side], idx = sibs.indexOf(e), k2 = sibs.length;
        var portY = Math.max(sb.top + 8, Math.min(sb.bot - 8, sb.cy + (idx - (k2 - 1) / 2) * K.sidePortGap)), jog = Math.abs(portY - sb.cy) > 1;
        if (centered) { pts = jog ? [[ext, sb.cy], [ext, portY], [tb.cx, portY]] : [[tb.cx, sb.cy]]; labelAt = pts.length; }
        else { pts = jog ? [[ext, sb.cy], [ext, portY], [lx, portY], [lx, busY]] : [[lx, sb.cy], [lx, busY]]; labelAt = pts.length - 1; }
      } else {                                                       // 바닥 출발(기존, 규칙 5 우선)
        var exitY = sb.bot + 26, laneLen = Math.abs(busY - exitY), horizLen = Math.abs(lx - sb.cx);
        if (centered) { pts = [[sb.cx, exitY], [tb.cx, exitY]]; labelAt = (laneLen >= m.h + 2 * K.minLabelClear) ? 2 : 1; }
        else { pts = [[sb.cx, exitY], [lx, exitY], [lx, busY]]; labelAt = (laneLen >= m.h + 2 * K.minLabelClear) ? 2 : (horizLen >= m.w + 2 * K.minLabelClear ? 1 : (laneLen >= horizLen ? 2 : 1)); }
      }
      lg(e.source, tid);
      polyline(e.source, pts, stub, e.label, labelAt, lineStyle(col, wd, false));
    });
  }

  function buildFeedback(edges) {
    if (!edges.length) return;
    var rb = realNodes().boundingBox(), belowY = rb.y2 + 44, mid = (rb.y1 + rb.y2) / 2;
    function fseg(s, t, label, arrow) {
      var ed = cy.add({ group: "edges", classes: "feedback fbseg" + (arrow ? " fbseg-arrow" : ""), data: { id: "fb" + (_c++), source: s, target: t, label: label || "", lsrc: CURLG.s, ltgt: CURLG.t } });
      ed.style(arrow ? { "line-style": "dashed", "line-color": T.orange, "target-arrow-color": T.orange, "curve-style": "straight", "target-arrow-shape": "triangle", "arrow-scale": 1.05 }
                     : { "line-style": "dashed", "line-color": T.orange, "color": T.accent, "curve-style": "straight", "target-arrow-shape": "none" });
    }
    // 점선이 겹쳐 실선처럼 보이지 않게: 상단 소스→target 왼쪽 면, 하단 소스→target 아래 면(서로 다른 면, 규칙 12)
    edges.forEach(function (e, i) {
      lg(e.source, e.target);
      var sb = box(e.source), tg = box(e.target), laneX = rb.x1 - (44 + i * 30), prev = e.source, pts, labelK;
      if (sb.cy > mid) { pts = [[sb.cx, belowY], [laneX, belowY], [laneX, tg.bot + 34], [tg.cx, tg.bot + 34]]; labelK = 2; }
      else { pts = [[laneX, sb.cy], [laneX, tg.cy]]; labelK = 1; }   // 왼쪽 면 수평 출발(경계 wp 불필요)
      for (var k = 0; k < pts.length; k++) { var w = wp(pts[k][0], pts[k][1]); fseg(prev, w, (k === labelK ? e.label : ""), false); prev = w; }
      fseg(prev, e.target, "", true);   // 마지막: 다른 면 수직/수평 진입(겹침 0, 대각선 0)
    });
  }

  /* ============================ 라벨 자동 배치 (규칙 8·13) ============================
     각 라벨을 '자기 선의 충분히 긴 직선 구간'에서 노드/다른선/다른라벨과 안 겹치는 곳으로 슬라이드.
     text-rotation:none 이라 text-margin 은 평행이동만 → 1회 측정·주입으로 보정.                 */
  function labelBox(ed) {
    var bb = ed.boundingBox({ includeNodes: false, includeEdges: false, includeLabels: true, includeMainLabels: true,
      includeSourceLabels: false, includeTargetLabels: false, includeOverlays: false, includeUnderlays: false, useCache: false });
    return { x1: bb.x1, x2: bb.x2, y1: bb.y1, y2: bb.y2, w: bb.w, h: bb.h, cx: (bb.x1 + bb.x2) / 2, cy: (bb.y1 + bb.y2) / 2 };
  }
  function polyPts(ed) { var pts = [ed.sourceEndpoint()]; var sp = ed.segmentPoints && ed.segmentPoints(); if (sp && sp.length) pts = [ed.sourceEndpoint()].concat(sp); pts.push(ed.targetEndpoint()); return pts; }
  function straightSegs(pts) { var s = []; for (var i = 0; i < pts.length - 1; i++) { var a = pts[i], b = pts[i + 1];
    if (!a || !b || a.x == null || b.x == null || a.y == null || b.y == null) continue;                 // 좌표 미정(중복 노드 등) 세그먼트 무시
    if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1) continue;
    s.push({ a: a, b: b, vert: Math.abs(a.x - b.x) <= K.axisTol, horiz: Math.abs(a.y - b.y) <= K.axisTol }); } return s; }

  // 라벨 소속 판정: seg 가 라벨 L 의 '자기 선'인가(같은 논리선·공유 '*' 포함). 자기 선엔 얹혀도 됨.
  function sameLine(s, L) { return (s.ls === L.ls || s.ls === "*" || L.ls === "*") && (s.lt === L.lt || s.lt === "*" || L.lt === "*"); }
  function placeLabels() {
    var nodes = realNodes().map(function (nd) { var p = nd.position(); return { id: nd.id(), x1: p.x - nd.width() / 2, x2: p.x + nd.width() / 2, y1: p.y - nd.height() / 2, y2: p.y + nd.height() / 2 }; });
    // 모든 선 세그먼트(논리선 태그 포함) — 라벨은 '자기 선 제외' 다른 선만 피한다
    var allSegs = [];
    cy.edges().forEach(function (e) { var P = polyPts(e), ls = e.data("lsrc") || "", lt = e.data("ltgt") || "";
      for (var i = 0; i < P.length - 1; i++) { var a = P[i], b = P[i + 1];
        if (!a || !b || a.x == null || b.x == null) continue;
        if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1) continue;
        allSegs.push({ x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y), ls: ls, lt: lt }); } });
    var placed = [], SEGPAD = 5;
    function ov(a, c, pad) { return a.x1 < c.x2 + pad && a.x2 > c.x1 - pad && a.y1 < c.y2 + pad && a.y2 > c.y1 - pad; }
    var labeled = cy.edges().filter(function (e) { return !!e.data("label"); }).toArray()
      .sort(function (a, b) { return b.data("label").length - a.data("label").length; });   // 긴 라벨부터
    labeled.forEach(function (ed) {
      var B = labelBox(ed), segs = straightSegs(polyPts(ed)), host = null;
      segs.forEach(function (s) { if (s.vert || s.horiz) host = s; });   // 자기 세그먼트(직교 1개)
      if (!host) { placed.push(B); return; }
      var L = { ls: ed.data("lsrc") || "", lt: ed.data("ltgt") || "" };
      var W = B.w, H = B.h, vy = host.vert, lineC = vy ? host.a.x : host.a.y;   // 라벨은 자기 선 '위'에 둠(perp=중앙선)
      var aMin = vy ? Math.min(host.a.y, host.b.y) : Math.min(host.a.x, host.b.x);
      var aMax = vy ? Math.max(host.a.y, host.b.y) : Math.max(host.a.x, host.b.x);
      var half = (vy ? H : W) / 2, lo = aMin + half + K.minLabelClear, hi = aMax - half - K.minLabelClear, cur = vy ? B.cy : B.cx;
      function mk(a) { a = (hi > lo) ? Math.min(hi, Math.max(lo, a)) : a;   // 항상 자기 선 위(perp=0)
        return vy ? { x1: lineC - W / 2, x2: lineC + W / 2, y1: a - H / 2, y2: a + H / 2, cx: lineC, cy: a }
                  : { x1: a - W / 2, x2: a + W / 2, y1: lineC - H / 2, y2: lineC + H / 2, cx: a, cy: lineC }; }
      function hitNodeOrLabel(bx) {                                    // 노드·다른 라벨은 반드시 피한다(하드)
        if (nodes.some(function (nd) { return nd.id !== ed.source().id() && nd.id !== ed.target().id() && ov(bx, nd, K.clearance); })) return true;
        if (placed.some(function (pb) { return ov(bx, pb, K.labelGap); })) return true;
        return false;
      }
      function lineHits(bx) { var n = 0; allSegs.forEach(function (s) { if (!sameLine(s, L) && ov(bx, s, 2)) n++; }); return n; }
      // 라벨은 '자기 선 위'에서만 슬라이드(옆으로 빼지 않음). 노드·라벨은 하드 회피, 다른 선 겹침은 최소화.
      var alongs = [cur]; for (var v = lo; v <= hi; v += 6) alongs.push(v);
      var best = null, bs = 1e9;
      alongs.forEach(function (a) { if (hi > lo && (a < lo - 0.5 || a > hi + 0.5)) return; var bx = mk(a);
        if (hitNodeOrLabel(bx)) return;
        var score = lineHits(bx) * 1000 + Math.abs(a - cur);          // 다른 선 겹침 최소 → 그다음 기본 위치 근접
        if (score < bs) { bs = score; best = bx; } });
      if (!best) { placed.push(B); return; }                           // 노드·라벨도 못 피하면 그대로
      var st = ed.style(), mx = parseFloat(st["text-margin-x"]) || 0, my = parseFloat(st["text-margin-y"]) || 0;
      ed.style({ "text-margin-x": mx + (best.cx - B.cx), "text-margin-y": my + (best.cy - B.cy) });
      placed.push(best);
    });
  }

  /* ============================ verifyDiagram — 규칙을 '코드로 검사' ============================ */
  window.verifyDiagram = function () {
    var nodes = realNodes().map(function (nd) { var p = nd.position(); return { id: nd.id(), x1: p.x - nd.width() / 2, x2: p.x + nd.width() / 2, y1: p.y - nd.height() / 2, y2: p.y + nd.height() / 2, cx: p.x, cy: p.y }; });
    function nodeOf(id) { for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i]; return null; }
    var V = [];
    // 라벨 박스 수집
    var labels = [];
    cy.edges().forEach(function (ed) { if (!ed.data("label")) return; labels.push({ id: ed.id(), s: ed.source().id(), t: ed.target().id(), ls: ed.data("lsrc") || "", lt: ed.data("ltgt") || "", B: labelBox(ed) }); });
    cy.edges().forEach(function (ed) {
      var s = ed.source().id(), t = ed.target().id(), pts = polyPts(ed), segs = straightSegs(pts);
      // 규칙 4 — 대각선 없음
      segs.forEach(function (g) { if (!g.vert && !g.horiz) V.push({ rule: 4, edge: s + "→" + t, msg: "대각선 세그먼트" }); });
      // 규칙 5 — 무관 노드 뒤 통과
      var dense = []; for (var i = 0; i < pts.length - 1; i++) { var a = pts[i], b = pts[i + 1]; for (var u = 0; u <= 14; u++) dense.push({ x: a.x + (b.x - a.x) * u / 14, y: a.y + (b.y - a.y) * u / 14 }); }
      nodes.forEach(function (nd) { if (nd.id === s || nd.id === t) return;
        var x1 = nd.x1 + 5, x2 = nd.x2 - 5, y1 = nd.y1 + 5, y2 = nd.y2 - 5;
        for (var p = 0; p < dense.length; p++) if (dense[p].x > x1 && dense[p].x < x2 && dense[p].y > y1 && dense[p].y < y2) { V.push({ rule: 5, edge: s + "→" + t, msg: "노드 뒤 통과: " + nd.id }); break; }
      });
    });
    // 규칙 13 — 라벨 호스트 세그먼트 축여백
    labels.forEach(function (L) {
      var ed = cy.getElementById(L.id), segs = straightSegs(polyPts(ed)), B = L.B, host = null, bd = 1e9;
      segs.forEach(function (g) { var d = g.vert ? Math.abs(B.cx - g.a.x) : (g.horiz ? Math.abs(B.cy - g.a.y) : 1e9); if (d < bd) { bd = d; host = g; } });
      if (!host) { V.push({ rule: 13, edge: L.s + "→" + L.t, msg: "라벨 호스트 세그먼트 없음(대각선?)" }); return; }
      if (host.vert) { var top = Math.min(host.a.y, host.b.y), bot = Math.max(host.a.y, host.b.y);
        if (B.y1 - top < K.minLabelClear || bot - B.y2 < K.minLabelClear) V.push({ rule: 13, edge: L.s + "→" + L.t, label: ed.data("label"), msg: "세로 라벨 상하 여백 부족" }); }
      else { var lf = Math.min(host.a.x, host.b.x), rg = Math.max(host.a.x, host.b.x);
        if (B.x1 - lf < K.minLabelClear || rg - B.x2 < K.minLabelClear) V.push({ rule: 13, edge: L.s + "→" + L.t, label: ed.data("label"), msg: "가로 라벨 좌우 여백 부족" }); }
    });
    // 규칙 8 — 라벨이 무관 노드/다른 라벨 침범 (own-edge 선 예외는 라벨에 적용 안 함: 모든 노드 회피)
    labels.forEach(function (L) {
      nodes.forEach(function (nd) { if (nd.id === L.s || nd.id === L.t) return;
        if (L.B.x1 < nd.x2 + K.clearance && L.B.x2 > nd.x1 - K.clearance && L.B.y1 < nd.y2 + K.clearance && L.B.y2 > nd.y1 - K.clearance)
          V.push({ rule: 8, edge: L.s + "→" + L.t, label: cy.getElementById(L.id).data("label"), msg: "라벨이 노드 침범: " + nd.id }); });
    });
    for (var i = 0; i < labels.length; i++) for (var j = i + 1; j < labels.length; j++) {
      var A = labels[i].B, Bb = labels[j].B;
      if (A.x1 < Bb.x2 + K.labelGap && A.x2 > Bb.x1 - K.labelGap && A.y1 < Bb.y2 + K.labelGap && A.y2 > Bb.y1 - K.labelGap)
        V.push({ rule: 8, msg: "라벨끼리 겹침", a: cy.getElementById(labels[i].id).data("label"), b: cy.getElementById(labels[j].id).data("label") });
    }
    // (라벨은 항상 '자기 선 위'에 둔다 — 혼잡 구역에선 다른 선과의 교차가 불가피하므로 선-교차는 위반으로
    //  보지 않는다. placeLabels 가 교차를 최소화하되 라벨을 옆으로 빼지는 않는다.)
    // 규칙 14 — 결과 노드 진입 화살표 정확히 1개
    Object.keys(RESULT).forEach(function (rid) { var n = 0;
      cy.edges().forEach(function (ed) { if (ed.target().id() === rid && ed.style("target-arrow-shape") !== "none") n++; });
      if (n !== 1) V.push({ rule: 14, node: rid, msg: "결과 진입 화살표 " + n + "개(1개여야 함)" });
    });
    // 규칙 2·7 — 결정 분기 좌우 균형(쏠림 금지). 비-결과 분기 대상의 dx 부호로 판정.
    //   배치(노드 위치) 속성이라 라우팅/라벨 검사로는 못 잡힌다 → 좌표로 직접 검사.
    M.nodes.forEach(function (dn) {
      if (dn.type !== "decision") return;
      var N = nodeOf(dn.id); if (!N) return;
      var dxs = [];
      M.edges.forEach(function (e) { if (e.source !== dn.id || e.feedback || e.dashed || RESULT[e.target]) return;
        var t = nodeOf(e.target); if (t) dxs.push(t.cx - N.cx); });
      if (dxs.length < 2) return;
      var hasL = dxs.some(function (d) { return d < -24; }), hasR = dxs.some(function (d) { return d > 24; }),
          hasC = dxs.some(function (d) { return Math.abs(d) <= 24; });
      if (!hasC && !(hasL && hasR))   // 중앙 통과도 없고 좌우 양쪽도 아님 = 한 쪽 쏠림
        V.push({ rule: 7, node: dn.id, msg: "분기 쏠림: 모든 분기가 한 쪽으로 나감(규칙 2 대칭 위반)" });
    });
    // 규칙 7(척추) — 주 흐름 노드가 단일 중앙 x(척추)에 정렬되어 가운데를 곧게 통과하는가
    (function () {
      var xs = SPINE.filter(function (id) { return !RESULT[id]; }).map(function (id) { var n = nodeOf(id); return n ? n.cx : null; })
        .filter(function (v) { return v != null; });
      if (xs.length >= 2) { var mn = Math.min.apply(null, xs), mx = Math.max.apply(null, xs);
        if (mx - mn > K.xTol) V.push({ rule: 7, msg: "주 흐름 척추 x 분산 " + Math.round(mx - mn) + "px(중앙 정렬 아님)" }); }
    })();
    // 규칙 9 — 결과 노드는 비-결과 노드 기준 하단/좌·우 외곽에 모인다(중앙 흐름에 묻히지 않음)
    (function () {
      var nonO = nodes.filter(function (nd) { return !RESULT[nd.id] && outdeg[nd.id]; }); if (!nonO.length) return;  // sink(기록) 제외
      var maxBot = Math.max.apply(null, nonO.map(function (nd) { return nd.y2; }));
      var minLft = Math.min.apply(null, nonO.map(function (nd) { return nd.x1; }));
      var maxRgt = Math.max.apply(null, nonO.map(function (nd) { return nd.x2; }));
      Object.keys(RESULT).forEach(function (rid) { var o = nodeOf(rid); if (!o) return;
        var ok = (o.y1 >= maxBot + 40) || (o.x2 <= minLft - 40) || (o.x1 >= maxRgt + 40);
        if (!ok) V.push({ rule: 9, node: rid, msg: "결과 노드가 중앙 흐름에 묻힘(하단/외곽 아님)" });
      });
    })();
    if (V.length && window.console) console.warn("[verifyDiagram] 규칙 위반 " + V.length + "건:", V);
    return { count: V.length, violations: V };
  };

  /* ============================ 화면 맞춤 ============================ */
  function fitView() {
    var bb = cy.elements().boundingBox(); if (!bb || !bb.w) return;
    var pad = 36, contW = mount.clientWidth || 900, z = Math.max(0.45, Math.min((contW - pad * 2) / bb.w, 1.0) * 0.97);
    mount.style.height = Math.max(420, Math.ceil(bb.h * z + pad * 2)) + "px";
    cy.resize(); cy.zoom(z); cy.center();
  }
  function zoomBy(f) { var z = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * f)); cy.zoom({ level: z, renderedPosition: { x: mount.clientWidth / 2, y: mount.clientHeight / 2 } }); }

  /* ============================ 클릭 하이라이트 — 선 추적 ============================
     노드 클릭 → 그 노드에 연결된 모든 논리선 강조 / 라벨·선 클릭 → 그 선 한 줄기 강조 /
     배경 클릭 → 해제. (route seg 는 lsrc/ltgt 로 어느 논리선·노드 소속인지 태깅돼 있다.)
     '*' = 공유 스텁·버스(어느 쪽 클릭에도 함께 강조).                                      */
  function clearHL() { cy.elements().removeClass("hl dimmed"); }
  function applyHL(coll) {
    if (!coll || !coll.length) { clearHL(); return; }
    cy.edges().addClass("dimmed"); realNodes().addClass("dimmed");
    coll.removeClass("dimmed").addClass("hl");
    var ids = {};
    coll.forEach(function (e) { var a = e.data("lsrc"), b = e.data("ltgt"); if (a && a !== "*") ids[a] = 1; if (b && b !== "*") ids[b] = 1; });
    Object.keys(ids).forEach(function (id) { var n = cy.getElementById(id); if (!n.empty()) n.removeClass("dimmed").addClass("hl"); });
  }
  function segsOfLine(ls, lt) {
    return cy.edges().filter(function (e) { var a = e.data("lsrc") || "", b = e.data("ltgt") || "";
      return (a === ls || a === "*" || ls === "*") && (b === lt || b === "*" || lt === "*"); });
  }
  function segsOfNode(id) { return cy.edges().filter(function (e) { return e.data("lsrc") === id || e.data("ltgt") === id; }); }
  function wireHighlight() {
    cy.on("tap", "edge", function (evt) { var e = evt.target; applyHL(segsOfLine(e.data("lsrc") || "", e.data("ltgt") || "")); });
    cy.on("tap", "node", function (evt) { var n = evt.target; if (n.hasClass("wp")) { clearHL(); return; } applyHL(segsOfNode(n.id())); });
    cy.on("tap", function (evt) { if (evt.target === cy) clearHL(); });
  }
  function buildControls() {
    var wrap = document.querySelector(".diagram-wrap"); if (!wrap) return;
    var ctrl = document.createElement("div"); ctrl.className = "diagram-controls"; ctrl.setAttribute("role", "group"); ctrl.setAttribute("aria-label", "다이어그램 확대·축소");
    [{ t: "+", l: "확대", fn: function () { zoomBy(1.25); } }, { t: "−", l: "축소", fn: function () { zoomBy(0.8); } }, { t: "⤢", l: "전체 맞춤", fn: fitView }].forEach(function (b) {
      var el = document.createElement("button"); el.type = "button"; el.className = "diagram-ctrl-btn"; el.textContent = b.t; el.setAttribute("aria-label", b.l); el.title = b.l;
      el.addEventListener("click", b.fn); ctrl.appendChild(el);
    });
    wrap.appendChild(ctrl);
  }
  // 접근성 텍스트 대체 토글 (index.html 동등)
  (function () {
    var link = document.querySelector("[data-toggle-textalt]"), ta = document.getElementById("flow-textalt");
    if (link && ta) link.addEventListener("click", function (e) { e.preventDefault(); ta.open = true; ta.scrollIntoView({ block: "start" }); var sm = ta.querySelector("summary"); if (sm) sm.focus(); });
  })();

  cy.ready(function () {
    window.cy = cy;
    relayout();        // ① 결과 노드 하단(규칙 9)
    route();           // ② 규칙 6·10·11·14·12 라우팅
    placeLabels();     // ③ 규칙 8·13 라벨 자동 여백
    buildControls();   // ④ 기본 기능 버튼(줌·맞춤)
    wireHighlight();   // ⑤ 클릭 하이라이트(선 추적)
    fitView();         // ⑥ 화면 맞춤
    requestAnimationFrame(function () { window.verifyDiagram(); });   // ⑦ 코드 검사 (위반시 console.warn)
  });
  var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(fitView, 180); });
})();
