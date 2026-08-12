// 서울 아파트 매매 대시보드 — ES module, 번들러/프레임워크 없음.
'use strict';

/* ===================== 상수 / 포맷터 ===================== */
const LS_BUDGET = 'dashboard.budget';
const LS_BUCKET = 'dashboard.areaBucket';
const nfInt = new Intl.NumberFormat('ko-KR');

function fmtCount(n) { return `${nfInt.format(n || 0)}건`; }
function fmtEok(manwon) {
  if (manwon == null) return '—';
  if (Math.abs(manwon) < 10000) return `${nfInt.format(Math.round(manwon))}만원`;
  return `${(manwon / 10000).toFixed(2)}억`;
}
function fmtBudgetEok(manwon) {
  const eok = manwon / 10000;
  const r = Math.round(eok * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}억`;
}
function fmtPyeong(manwon) { return manwon == null ? '—' : `${nfInt.format(Math.round(manwon))}만원/평`; }
function fmtPct(x) { return `${((x || 0) * 100).toFixed(1)}%`; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clampBudget(m) { return Math.min(300000, Math.max(30000, m)); }

const GRADE = {
  ok: { label: '가능', color: 'var(--status-positive)', copy: '절반 이상의 거래가 예산 안쪽' },
  border: { label: '경계', color: 'var(--primary-normal)', copy: '하위 25~50% 구간에서만 가능' },
  no: { label: '불가', color: 'var(--label-assist)', copy: '하위 25%도 예산을 넘음' },
  insufficient: { label: '표본부족', color: 'var(--fill-strong)', copy: n => `거래 ${fmtCount(n)}뿐이라 판정하지 않음` }
};
function gradeRank(g) { return { ok: 0, border: 1, no: 2 }[g]; }

function verdictFor(stats, budget, minSample) {
  if (!stats || stats.n < minSample) return 'insufficient';
  if (stats.p50 <= budget) return 'ok';
  if (stats.p25 <= budget) return 'border';
  return 'no';
}
function formulaText(grade, stats, budget) {
  const B = fmtEok(budget), p25 = fmtEok(stats.p25), p50 = fmtEok(stats.p50);
  if (grade === 'ok') return `중위 ${p50} ≤ 예산 ${B} → 가능`;
  if (grade === 'border') return `하위25% ${p25} ≤ 예산 ${B} < 중위 ${p50} → 경계`;
  if (grade === 'no') return `예산 ${B} < 하위25% ${p25} → 불가`;
  return `거래 ${fmtCount(stats.n)}뿐이라 판정하지 않음`;
}

/* 1억 단위 히스토그램에서 예산 이하 비율 추정(선형 보간) */
function estimateAffordCountHist(hist, budget) {
  const bin = 10000, cap = 30;
  let idx = Math.floor(budget / bin);
  let count = 0;
  for (let i = 0; i < Math.min(idx, cap); i++) count += hist[i] || 0;
  if (idx < cap) {
    const frac = Math.max(0, Math.min(1, (budget - idx * bin) / bin));
    count += frac * (hist[idx] || 0);
  } else {
    count += hist[cap] || 0;
  }
  return count;
}
function estimateAffordShareHist(hist, n, budget) {
  if (!n) return 0;
  return Math.min(1, estimateAffordCountHist(hist, budget) / n);
}
/* 히스토그램이 없는(동 단위) 경우 사분위수 선형 보간으로 추정 */
function estimateAffordShareQuantile(stats, budget) {
  if (!stats || !stats.n) return 0;
  const pts = [[stats.min, 0], [stats.p25, 25], [stats.p50, 50], [stats.p75, 75], [stats.max, 100]];
  if (budget <= pts[0][0]) return 0;
  if (budget >= pts[4][0]) return 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (budget >= x0 && budget <= x1) {
      if (x1 === x0) return y1 / 100;
      const frac = (budget - x0) / (x1 - x0);
      return (y0 + frac * (y1 - y0)) / 100;
    }
  }
  return 1;
}

/* ===================== 상태 ===================== */
const state = {
  summary: null,
  guCache: new Map(),
  budget: 80000,
  areaBucket: 'a60_85',
  prevBudgetForDelta: null,
  route: { name: 'home' },
  compareSort: { key: 'p50', dir: 'asc' },
  dongSort: 'p50asc',
  complexSearch: '',
  complexVisibleCount: 30,
  expandedComplexes: new Set(),
  samplesRenderedFor: null
};

function loadLS(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; } }
function saveLS(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }

function bucketLabelOf(key) {
  const b = state.summary.meta.areaBuckets.find(x => x.key === key);
  return b ? b.label : key;
}
function periodLabel(period) { return `${period.from.replace('-', '.')}–${period.to.replace('-', '.')}`; }

/* ===================== 구별 판정/비교 계산 ===================== */
function computeCompareRows(bucket, budget, minSample) {
  return state.summary.gu.map(g => {
    const stats = g.stats[bucket];
    const grade = verdictFor(stats, budget, minSample);
    const share = stats ? estimateAffordShareHist(g.hist[bucket] || [], stats.n, budget) : 0;
    return { slug: g.slug, name: g.name, stats, grade, share };
  });
}
function computeVerdictGroups(bucket, budget, minSample) {
  const rows = computeCompareRows(bucket, budget, minSample);
  const groups = { ok: [], border: [], no: [], insufficient: [] };
  rows.forEach(r => groups[r.grade].push(r));
  groups.ok.sort((a, b) => a.stats.p50 - b.stats.p50);
  groups.border.sort((a, b) => a.stats.p50 - b.stats.p50);
  groups.no.sort((a, b) => a.stats.p50 - b.stats.p50);
  groups.insufficient.sort((a, b) => (b.stats ? b.stats.n : 0) - (a.stats ? a.stats.n : 0));
  return groups;
}
function budgetFactText(bucket, budget) {
  const minSample = state.summary.meta.minSampleForVerdict;
  const rows = computeCompareRows(bucket, budget, minSample);
  const counts = { ok: 0, border: 0, no: 0, insufficient: 0 };
  rows.forEach(r => counts[r.grade]++);
  return { text: `${bucketLabelOf(bucket)} 기준 가능 ${counts.ok}곳 · 경계 ${counts.border}곳 · 불가 ${counts.no}곳 (예산 ${fmtBudgetEok(budget)})`, counts };
}
function heroFactText(bucket, budget, counts) {
  const d = state.summary.meta.defaults;
  if (bucket === d.areaBucket && budget === d.budget) return state.summary.copy.heroFact;
  return `${fmtBudgetEok(budget)}이면 25개 구 중 ${counts.ok}곳이 중위값 안쪽입니다`;
}
function spreadFactText(bucket) {
  const d = state.summary.meta.defaults;
  if (bucket === d.areaBucket) return state.summary.copy.spreadFact;
  const list = state.summary.gu.map(g => ({ name: g.name, p50: g.stats[bucket].p50 })).filter(x => x.p50 != null);
  if (!list.length) return `${bucketLabelOf(bucket)} 기준 거래가 없습니다`;
  list.sort((a, b) => a.p50 - b.p50);
  const min = list[0], max = list[list.length - 1];
  const ratio = Math.round((max.p50 / min.p50) * 10) / 10;
  return `${bucketLabelOf(bucket)} 기준 구별 중위가는 ${min.name} ${fmtEok(min.p50)}부터 ${max.name} ${fmtEok(max.p50)}까지 ${ratio}배 차이가 납니다`;
}
function trendFactText(bucket) {
  const d = state.summary.meta.defaults;
  if (bucket === d.areaBucket) return state.summary.copy.trendFact;
  const monthly = state.summary.seoul.monthly[bucket];
  const first = monthly[0], last = monthly[monthly.length - 1];
  return `${bucketLabelOf(bucket)} 기준 서울 매매는 ${first.m} ${fmtCount(first.n)}(중위 ${fmtEok(first.p50)})에서 ${last.m} ${fmtCount(last.n)}(중위 ${fmtEok(last.p50)})으로 움직였습니다`;
}
function computeDeltaText(oldB, newB, bucket) {
  if (oldB == null || oldB === newB) return '';
  const minSample = state.summary.meta.minSampleForVerdict;
  const oldRows = computeCompareRows(bucket, oldB, minSample);
  const newRows = computeCompareRows(bucket, newB, minSample);
  const changed = [];
  for (let i = 0; i < oldRows.length; i++) {
    const o = oldRows[i], n = newRows[i];
    if (o.grade !== n.grade && o.grade !== 'insufficient' && n.grade !== 'insufficient') {
      changed.push({ name: o.name, from: o.grade, to: n.grade });
    }
  }
  if (!changed.length) return '';
  const groups = {};
  changed.forEach(c => { const k = c.from + '>' + c.to; (groups[k] = groups[k] || []).push(c.name); });
  let bestKey = null, bestArr = null;
  Object.entries(groups).forEach(([k, arr]) => { if (!bestArr || arr.length > bestArr.length) { bestKey = k; bestArr = arr; } });
  const [from, to] = bestKey.split('>');
  const verb = gradeRank(to) < gradeRank(from) ? '넘어옵니다' : '넘어갑니다';
  const direction = newB > oldB ? '올리면' : '내리면';
  return `${fmtBudgetEok(newB)}으로 ${direction} ${bestArr.length}개 구(${bestArr.join('·')})가 ${GRADE[from].label}에서 ${GRADE[to].label}으로 ${verb}`;
}

/* ===================== 공통 마크업 조각 ===================== */
function budgetBarHTML() {
  const eok = state.budget / 10000;
  const presets = [6, 8, 10, 12].map(v =>
    `<button type="button" class="preset-chip" data-preset="${v}" aria-pressed="${state.budget === v * 10000 ? 'true' : 'false'}">${v}억</button>`
  ).join('');
  return `<div class="budget-bar" role="group" aria-label="예산 설정">
    <span class="bb-label">예산</span>
    <div class="bb-number-wrap">
      <input type="number" id="budget-number" min="3" max="30" step="0.5" value="${eok}" aria-label="예산 억원 입력">
      <span class="bb-unit">억</span>
    </div>
    <input type="range" id="budget-range" min="3" max="30" step="0.5" value="${eok}" aria-label="예산 슬라이더">
    <div class="presets" role="group" aria-label="예산 프리셋">${presets}</div>
    <span class="bb-guard-short">예산은 매매가 상한만을 뜻합니다. 대출·금리·세금은 계산하지 않습니다.</span>
  </div>`;
}
function limitsSectionHTML() {
  const m = state.summary.meta;
  return `<section class="section limits">
    <h2>이 대시보드가 답하지 않는 것</h2>
    <ul>
      <li>원본 ${fmtCount(m.totalRows)} 중 매매 ${fmtCount(m.saleRows)}만 사용합니다(${m.period.from}~${m.period.to}). 전세·월세는 포함하지 않습니다.</li>
      <li>예산은 매매가 상한만을 뜻합니다. 대출 한도·금리·취득세·중개보수는 계산하지 않습니다.</li>
      <li>표본 ${m.minSampleForVerdict}건 미만인 구는 가능·경계·불가를 판정하지 않습니다(표본부족).</li>
      <li>평당가는 전용면적 기준입니다. 분양 광고에서 흔히 쓰는 공급면적 평당가와는 다릅니다.</li>
      <li>단지 랭킹은 거래 ${m.minComplexTxns}건 이상인 단지만 포함합니다.</li>
      <li>건축년도·세대수·학군·교통 정보는 원본 데이터에 없어 표시하지 않습니다.</li>
      <li>가격을 예측하지 않고 투자를 추천하지 않습니다. 판정은 산식 그대로입니다.</li>
    </ul>
  </section>`;
}
function footerHTML() {
  const m = state.summary.meta;
  return `<footer class="foot">
    <span>데이터 출처: 서울열린데이터광장 「서울시 부동산 실거래가 정보」(OA-21275) · 매매 ${fmtCount(m.saleRows)} · 빌드 ${m.builtAt}</span>
    <a href="../index.html">About</a>
  </footer>`;
}

/* ===================== F3 판정 그룹 ===================== */
function verdictChipHTML(r, key) {
  const g = GRADE[key];
  if (key === 'insufficient') {
    return `<button type="button" class="verdict-chip" data-slug="${r.slug}" style="--chip-color:${g.color}">
      <span class="vc-top"><span>${escapeHtml(r.name)}</span><span>${g.label}</span></span>
      <span class="vc-sub"><span>${g.copy(r.stats ? r.stats.n : 0)}</span></span>
    </button>`;
  }
  return `<button type="button" class="verdict-chip" data-slug="${r.slug}" style="--chip-color:${g.color}">
    <span class="vc-top"><span>${escapeHtml(r.name)}</span><span>${g.label} · ${fmtEok(r.stats.p50)}</span></span>
    <span class="vc-sub"><span>${fmtCount(r.stats.n)}</span><span>${fmtPct(r.share)} 이하</span></span>
    <div class="vc-bar-track"><div class="vc-bar-fill" style="width:${Math.round(r.share * 100)}%"></div></div>
  </button>`;
}
function verdictGroupsHTML(groups) {
  const order = [['ok', 'group-ok'], ['border', 'group-border'], ['no', 'group-no'], ['insufficient', 'group-insufficient']];
  return order.map(([key, cls]) => {
    const arr = groups[key];
    if (!arr.length) return '';
    const g = GRADE[key];
    const copy = typeof g.copy === 'function' ? '' : g.copy;
    return `<div class="verdict-group ${cls}" style="--chip-color:${g.color}">
      <h3>${g.label} <span class="group-count">${arr.length}</span></h3>
      <p class="group-copy">${copy}</p>
      <div class="chip-list">${arr.map(r => verdictChipHTML(r, key)).join('')}</div>
    </div>`;
  }).join('');
}

/* ===================== Hero ===================== */
function heroDynamicHTML(bucket, budget) {
  const minSample = state.summary.meta.minSampleForVerdict;
  const rows = computeCompareRows(bucket, budget, minSample);
  const counts = { ok: 0, border: 0, no: 0, insufficient: 0 };
  rows.forEach(r => counts[r.grade]++);
  const fact = heroFactText(bucket, budget, counts);
  const lead = `최근 12개월 서울 아파트 매매 ${fmtCount(state.summary.meta.saleRows)} 실거래를 기준으로, 예산을 넣으면 25개 구가 가능·경계·불가로 갈립니다. ${escapeHtml(fact)}.`;
  const deltaText = computeDeltaText(state.prevBudgetForDelta, budget, bucket);
  const delta = deltaText ? `<p class="delta-sentence">${escapeHtml(deltaText)}.</p>` : '';
  return `<h1>${fmtBudgetEok(budget)}으로 서울 어디까지 갈 수 있을까</h1>
    <p class="lead">${lead}</p>
    ${delta}`;
}

/* ===================== F6 구 비교 표 ===================== */
function sortRows(rows, sort) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const arr = rows.slice();
  arr.sort((a, b) => {
    if (sort.key === 'name') return dir * a.name.localeCompare(b.name, 'ko');
    const av = a.stats ? a.stats[sort.key] : Infinity;
    const bv = b.stats ? b.stats[sort.key] : Infinity;
    return dir * (av - bv);
  });
  return arr;
}
function compareTableHTML(bucket, budget) {
  const minSample = state.summary.meta.minSampleForVerdict;
  const rows = sortRows(computeCompareRows(bucket, budget, minSample), state.compareSort);
  const sortAria = key => state.compareSort.key === key ? (state.compareSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = key => state.compareSort.key === key ? (state.compareSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const thBtn = (key, label) => `<th aria-sort="${sortAria(key)}"><button type="button" data-sort-key="${key}">${label}${arrow(key)}</button></th>`;
  const thead = `<tr>${thBtn('name', '구')}${thBtn('n', '거래건수')}${thBtn('p25', '하위25%')}${thBtn('p50', '중위')}${thBtn('p75', '상위25%')}${thBtn('ppyeong', '평당가')}<th scope="col">예산이하%</th><th scope="col">판정</th></tr>`;
  const tbody = rows.map(r => {
    const g = GRADE[r.grade];
    const cells = r.stats
      ? `<td>${fmtCount(r.stats.n)}</td><td>${fmtEok(r.stats.p25)}</td><td>${fmtEok(r.stats.p50)}</td><td>${fmtEok(r.stats.p75)}</td><td>${fmtPyeong(r.stats.ppyeong)}</td><td>${fmtPct(r.share)}</td>`
      : `<td colspan="6">데이터 없음</td>`;
    return `<tr data-slug="${r.slug}" tabindex="0" role="button" aria-label="${escapeHtml(r.name)} 상세로 이동">
      <th scope="row">${escapeHtml(r.name)}</th>${cells}
      <td><span class="grade-badge" style="--chip-color:${g.color}">${g.label}</span></td>
    </tr>`;
  }).join('');
  const cards = rows.map(r => {
    const g = GRADE[r.grade];
    const body = r.stats ? `<dl>
        <div>거래건수</div><dd>${fmtCount(r.stats.n)}</dd>
        <div>중위가</div><dd>${fmtEok(r.stats.p50)}</dd>
        <div>하위25~상위25%</div><dd>${fmtEok(r.stats.p25)} ~ ${fmtEok(r.stats.p75)}</dd>
        <div>평당가</div><dd>${fmtPyeong(r.stats.ppyeong)}</dd>
        <div>예산이하%</div><dd>${fmtPct(r.share)}</dd>
      </dl>` : `<p>데이터 없음</p>`;
    return `<div class="compare-card" data-slug="${r.slug}" tabindex="0" role="button" aria-label="${escapeHtml(r.name)} 상세로 이동">
      <div class="cc-top"><span>${escapeHtml(r.name)}</span><span class="grade-badge" style="--chip-color:${g.color}">${g.label}</span></div>
      ${body}
    </div>`;
  }).join('');
  const bm = state.summary.meta.areaBuckets.find(b => b.key === bucket);
  const caption = `<p class="caption">n=${fmtCount(bm.n)} · ${state.summary.meta.period.from}~${state.summary.meta.period.to} · 예산이하%는 1억 단위 구간 분포에서 추정한 값입니다. 헤더를 클릭하면 정렬, 행을 클릭하면 구 상세로 이동합니다.</p>`;
  return `<div class="compare-table-wrap"><table class="compare-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>
    <div class="compare-cards">${cards}</div>
    ${caption}`;
}

/* ===================== F7 12개월 흐름 ===================== */
function buildFlowChartHTML(bucket) {
  const monthly = state.summary.seoul.monthly[bucket];
  const width = 760, height = 260, padL = 46, padR = 12, padT = 14, padB = 28;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const maxN = Math.max(...monthly.map(m => m.n), 1);
  const minP = Math.min(...monthly.map(m => m.p50)), maxP = Math.max(...monthly.map(m => m.p50));
  const slot = innerW / monthly.length;
  const barW = slot * 0.5;
  const xFor = i => padL + slot * (i + 0.5);
  const yForN = v => padT + innerH - (v / maxN) * innerH;
  const pRange = (maxP - minP) || 1;
  const yForP = v => padT + innerH * 0.1 + (1 - (v - minP) / pRange) * innerH * 0.8;
  const bars = monthly.map((m, i) => {
    const y = yForN(m.n);
    return `<rect x="${(xFor(i) - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + innerH - y).toFixed(1)}" fill="var(--fill-strong)" rx="2"><title>${m.m} 거래량 ${fmtCount(m.n)}</title></rect>`;
  }).join('');
  const points = monthly.map((m, i) => `${xFor(i).toFixed(1)},${yForP(m.p50).toFixed(1)}`).join(' ');
  const dots = monthly.map((m, i) => `<circle cx="${xFor(i).toFixed(1)}" cy="${yForP(m.p50).toFixed(1)}" r="3.2" fill="var(--primary-heavy)"><title>${m.m} 중위 ${fmtEok(m.p50)}</title></circle>`).join('');
  const labels = monthly.map((m, i) => `<text x="${xFor(i).toFixed(1)}" y="${height - 8}" font-size="10" text-anchor="middle" fill="var(--label-assist)">${m.m.slice(5)}</text>`).join('');
  const axis = `<text x="4" y="${(yForP(maxP) + 4).toFixed(1)}" font-size="10" fill="var(--label-assist)">${fmtEok(maxP)}</text><text x="4" y="${(yForP(minP) + 4).toFixed(1)}" font-size="10" fill="var(--label-assist)">${fmtEok(minP)}</text>`;
  const first = monthly[0], last = monthly[monthly.length - 1];
  const desc = `${first.m} ${fmtCount(first.n)} 중위 ${fmtEok(first.p50)}에서 ${last.m} ${fmtCount(last.n)} 중위 ${fmtEok(last.p50)}으로 변화했습니다. 막대는 거래량, 선은 중위가입니다.`;
  const table = `<table><thead><tr><th>월</th><th>거래건수</th><th>중위가</th></tr></thead><tbody>${
    monthly.map(m => `<tr><td>${m.m}</td><td>${fmtCount(m.n)}</td><td>${fmtEok(m.p50)}</td></tr>`).join('')
  }</tbody></table>`;
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="flow-title flow-desc">
    <title id="flow-title">서울 전체 12개월 매매 흐름</title>
    <desc id="flow-desc">${desc}</desc>
    ${bars}${axis}
    <polyline points="${points}" fill="none" stroke="var(--primary-normal)" stroke-width="2.5" />
    ${dots}${labels}
  </svg></div>
  <p class="caption">n=${fmtCount(state.summary.meta.areaBuckets.find(b => b.key === bucket).n)} · ${state.summary.meta.period.from}~${state.summary.meta.period.to} · 서울 전체 기준입니다.</p>
  <details class="chart-alt"><summary>표로 보기</summary>${table}</details>`;
}

/* ===================== 렌더 파이프라인 ===================== */
let appEl;

function syncControlInputs() {
  const numEl = document.getElementById('budget-number');
  const rangeEl = document.getElementById('budget-range');
  const eok = state.budget / 10000;
  if (numEl && document.activeElement !== numEl) numEl.value = eok;
  if (rangeEl) rangeEl.value = eok;
  document.querySelectorAll('.preset-chip').forEach(btn => {
    const v = parseFloat(btn.dataset.preset) * 10000;
    btn.setAttribute('aria-pressed', v === state.budget ? 'true' : 'false');
  });
}

function mountShell() {
  appEl.innerHTML = state.route.name === 'home' ? homeShellHTML() : guShellHTML(state.route.slug);
  syncControlInputs();
}

function updateHomeDynamic() {
  const bucket = state.areaBucket, budget = state.budget;
  const heroEl = document.getElementById('hero-dynamic');
  if (heroEl) heroEl.innerHTML = heroDynamicHTML(bucket, budget);
  const { text } = budgetFactText(bucket, budget);
  const summaryEl = document.getElementById('verdict-summary');
  if (summaryEl) summaryEl.textContent = text;
  const groupsEl = document.getElementById('verdict-groups');
  if (groupsEl) groupsEl.innerHTML = verdictGroupsHTML(computeVerdictGroups(bucket, budget, state.summary.meta.minSampleForVerdict));
  const compareHeadingEl = document.getElementById('compare-heading');
  if (compareHeadingEl) compareHeadingEl.textContent = spreadFactText(bucket);
  const compareEl = document.getElementById('compare-table-container');
  if (compareEl) compareEl.innerHTML = compareTableHTML(bucket, budget);
  const flowHeadingEl = document.getElementById('flow-heading');
  if (flowHeadingEl) flowHeadingEl.textContent = trendFactText(bucket);
  const flowEl = document.getElementById('flow-chart');
  if (flowEl) flowEl.innerHTML = buildFlowChartHTML(bucket);
}

function updateGuDynamic() {
  const slug = state.route.slug;
  const entry = state.summary.gu.find(g => g.slug === slug);
  if (!entry) return;
  const bucket = state.areaBucket, budget = state.budget;
  const dd = document.getElementById('detail-dynamic');
  if (dd) dd.innerHTML = detailDynamicHTML(entry, bucket, budget);
  const guData = state.guCache.get(slug);
  if (!guData) return;
  const dongHeadingEl = document.getElementById('dong-heading');
  if (dongHeadingEl) dongHeadingEl.textContent = dongHeadingText(guData, bucket);
  const dongListEl = document.getElementById('dong-list');
  if (dongListEl) dongListEl.innerHTML = buildDongListHTML(guData, bucket, budget, state.dongSort);
  updateComplexSection(guData, bucket, budget);
  if (state.samplesRenderedFor !== slug) {
    const samplesEl = document.getElementById('samples-container');
    if (samplesEl) { samplesEl.innerHTML = buildSamplesHTML(guData); state.samplesRenderedFor = slug; }
  }
  const histHeadingEl = document.getElementById('hist-heading');
  if (histHeadingEl) histHeadingEl.textContent = histHeadingText(guData, bucket, budget);
  const histEl = document.getElementById('hist-chart');
  if (histEl) histEl.innerHTML = buildHistogramHTML(guData, bucket, budget);
}

function updateDynamic() {
  syncControlInputs();
  if (state.route.name === 'home') updateHomeDynamic();
  else if (state.route.name === 'gu') updateGuDynamic();
}

function setBudget(manwonRaw) {
  const manwon = clampBudget(Math.round(manwonRaw));
  if (manwon === state.budget) { syncControlInputs(); return; }
  state.prevBudgetForDelta = state.budget;
  state.budget = manwon;
  saveLS(LS_BUDGET, String(manwon));
  updateDynamic();
}

/* ===================== 구 상세 데이터 로드 ===================== */
function showGuSkeleton() {
  const status = document.getElementById('gu-data-status');
  const heavy = document.getElementById('gu-heavy-sections');
  if (!status || !heavy) return;
  heavy.style.display = 'none';
  status.innerHTML = `<div class="section"><span class="skel skel-line" style="width:200px"></span><span class="skel skel-block"></span><span class="skel skel-block"></span></div>`;
}
function showGuLoaded() {
  const status = document.getElementById('gu-data-status');
  const heavy = document.getElementById('gu-heavy-sections');
  if (!status || !heavy) return;
  status.innerHTML = '';
  heavy.style.display = '';
}
function showGuError(slug) {
  const status = document.getElementById('gu-data-status');
  const heavy = document.getElementById('gu-heavy-sections');
  if (!status || !heavy) return;
  heavy.style.display = 'none';
  status.innerHTML = `<div class="error-card">구 데이터를 불러오지 못했습니다.<br><button type="button" data-retry-gu="${escapeHtml(slug)}">다시 시도</button></div>`;
}
function fetchGuData(slug) {
  const entry = state.summary.gu.find(g => g.slug === slug);
  if (!entry) { showGuError(slug); return; }
  fetch(`../data/json/${entry.file}`, { cache: 'no-cache' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(data => {
      state.guCache.set(slug, data);
      if (state.route.name === 'gu' && state.route.slug === slug) { showGuLoaded(); updateDynamic(); }
    })
    .catch(err => {
      console.error(err);
      if (state.route.name === 'gu' && state.route.slug === slug) showGuError(slug);
    });
}

/* ===================== 라우팅 ===================== */
function parseHash() {
  const h = (location.hash || '').replace(/^#/, '');
  const m = h.match(/^\/gu\/([^/?#]+)/);
  if (m) return { name: 'gu', slug: decodeURIComponent(m[1]) };
  return { name: 'home' };
}
function resetGuInteractionState() {
  state.dongSort = 'p50asc';
  state.complexSearch = '';
  state.complexVisibleCount = 30;
  state.expandedComplexes = new Set();
  state.samplesRenderedFor = null;
}
function setRoute(newRoute) {
  if (newRoute.name === 'gu' && (!state.summary || !state.summary.gu.some(g => g.slug === newRoute.slug))) {
    if (location.hash) { location.hash = ''; return; }
    newRoute = { name: 'home' };
  }
  const prev = state.route;
  const shellChanged = !prev || prev.name !== newRoute.name || prev.slug !== newRoute.slug;
  state.route = newRoute;
  if (shellChanged) {
    resetGuInteractionState();
    mountShell();
    window.scrollTo({ top: 0 });
  }
  if (newRoute.name === 'gu') {
    if (state.guCache.has(newRoute.slug)) showGuLoaded();
    else { showGuSkeleton(); fetchGuData(newRoute.slug); }
  }
  updateDynamic();
}

/* ===================== 이벤트 위임 ===================== */
let searchTimer = null;
function onInput(e) {
  const t = e.target;
  if (t.id === 'budget-number') {
    const v = parseFloat(t.value);
    if (Number.isFinite(v) && v > 0) setBudget(v * 10000);
    return;
  }
  if (t.id === 'budget-range') {
    const v = parseFloat(t.value);
    if (Number.isFinite(v)) setBudget(v * 10000);
    return;
  }
  if (t.id === 'complex-search') {
    clearTimeout(searchTimer);
    const val = t.value;
    searchTimer = setTimeout(() => {
      state.complexSearch = val;
      state.complexVisibleCount = 30;
      const guData = state.guCache.get(state.route.slug);
      if (guData) updateComplexSection(guData, state.areaBucket, state.budget);
    }, 200);
  }
}
function onChange(e) {
  const t = e.target;
  if (t.id === 'budget-number') {
    let v = parseFloat(t.value);
    if (!Number.isFinite(v)) v = state.budget / 10000;
    v = Math.min(30, Math.max(3, Math.round(v * 2) / 2));
    t.value = v;
    setBudget(v * 10000);
    return;
  }
  if (t.name === 'area-bucket') {
    state.areaBucket = t.value;
    saveLS(LS_BUCKET, t.value);
    state.prevBudgetForDelta = null;
    state.complexVisibleCount = 30;
    updateDynamic();
  }
}
function onClick(e) {
  const presetBtn = e.target.closest('[data-preset]');
  if (presetBtn) { setBudget(parseFloat(presetBtn.dataset.preset) * 10000); return; }

  const backBtn = e.target.closest('#back-btn');
  if (backBtn) { location.hash = ''; return; }

  const retrySummary = e.target.closest('[data-retry-summary]');
  if (retrySummary) { boot(); return; }

  const retryGu = e.target.closest('[data-retry-gu]');
  if (retryGu) { const slug = retryGu.dataset.retryGu; showGuSkeleton(); fetchGuData(slug); return; }

  const sortBtn = e.target.closest('button[data-sort-key]');
  if (sortBtn) {
    const key = sortBtn.dataset.sortKey;
    if (state.compareSort.key === key) state.compareSort.dir = state.compareSort.dir === 'asc' ? 'desc' : 'asc';
    else state.compareSort = { key, dir: 'asc' };
    const compareEl = document.getElementById('compare-table-container');
    if (compareEl) compareEl.innerHTML = compareTableHTML(state.areaBucket, state.budget);
    return;
  }

  const dongSortBtn = e.target.closest('button[data-dong-sort]');
  if (dongSortBtn) {
    state.dongSort = dongSortBtn.dataset.dongSort;
    document.querySelectorAll('button[data-dong-sort]').forEach(b => b.setAttribute('aria-pressed', b === dongSortBtn ? 'true' : 'false'));
    const guData = state.guCache.get(state.route.slug);
    if (guData) {
      const dongListEl = document.getElementById('dong-list');
      if (dongListEl) dongListEl.innerHTML = buildDongListHTML(guData, state.areaBucket, state.budget, state.dongSort);
    }
    return;
  }

  const toggleBtn = e.target.closest('[data-toggle-complex]');
  if (toggleBtn) {
    const key = toggleBtn.dataset.toggleComplex;
    if (state.expandedComplexes.has(key)) state.expandedComplexes.delete(key); else state.expandedComplexes.add(key);
    const guData = state.guCache.get(state.route.slug);
    if (guData) updateComplexSection(guData, state.areaBucket, state.budget);
    return;
  }

  if (e.target.id === 'complex-more') {
    state.complexVisibleCount += 30;
    const guData = state.guCache.get(state.route.slug);
    if (guData) updateComplexSection(guData, state.areaBucket, state.budget);
    return;
  }

  const rowNav = e.target.closest('tr[data-slug], .compare-card[data-slug], .verdict-chip[data-slug]');
  if (rowNav) { location.hash = `#/gu/${rowNav.dataset.slug}`; }
}
function onKeydown(e) {
  if (e.key === 'Escape' && state.route.name === 'gu') { e.preventDefault(); location.hash = ''; return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-slug], .compare-card[data-slug]')) {
    e.preventDefault();
    location.hash = `#/gu/${e.target.dataset.slug}`;
  }
}

let listenersAttached = false;
function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  appEl.addEventListener('input', onInput);
  appEl.addEventListener('change', onChange);
  appEl.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
}

/* ===================== 부팅 ===================== */
function renderAppSkeleton() {
  appEl.innerHTML = `<div class="wrap">
    <div class="skel skel-line" style="width:220px;margin-top:24px;"></div>
    <div class="skel skel-block"></div>
    <div class="skel skel-block"></div>
    <div class="skel skel-block"></div>
  </div>`;
}
function renderBootError() {
  appEl.innerHTML = `<div class="wrap"><div class="error-card">데이터를 불러오지 못했습니다.<br><button type="button" data-retry-summary>다시 시도</button></div></div>`;
}

async function boot() {
  appEl = document.getElementById('app');
  attachListeners();
  renderAppSkeleton();
  try {
    const res = await fetch('../data/json/summary.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const summary = await res.json();
    state.summary = summary;

    const savedBudgetRaw = loadLS(LS_BUDGET, null);
    const savedBudget = savedBudgetRaw != null ? parseInt(savedBudgetRaw, 10) : NaN;
    state.budget = Number.isFinite(savedBudget) ? clampBudget(savedBudget) : summary.meta.defaults.budget;

    const savedBucket = loadLS(LS_BUCKET, null);
    const validKeys = summary.meta.areaBuckets.map(b => b.key);
    state.areaBucket = validKeys.includes(savedBucket) ? savedBucket : summary.meta.defaults.areaBucket;

    document.body.classList.add('has-fixed-budget-bar');

    const initialRoute = parseHash();
    state.route = null;
    setRoute(initialRoute);

    window.addEventListener('hashchange', () => { if (state.summary) setRoute(parseHash()); });
  } catch (err) {
    console.error(err);
    renderBootError();
  }
}

boot();

/* ===================== 홈 셸 ===================== */
function homeShellHTML() {
  const m = state.summary.meta;
  const areaOptions = m.areaBuckets.map(b =>
    `<label><input type="radio" name="area-bucket" value="${b.key}" ${state.areaBucket === b.key ? 'checked' : ''}><span>${b.label} <span class="seg-n">${fmtCount(b.n)}</span></span></label>`
  ).join('');
  return `<div class="wrap">
    <header class="hero">
      <span class="eyebrow"><span class="dot"></span> 실거래 ${fmtCount(m.saleRows)} · ${periodLabel(m.period)}</span>
      <div id="hero-dynamic"></div>
      ${budgetBarHTML()}
      <p class="guard">예산은 매매가 상한만을 뜻합니다. 대출 한도·금리·취득세·중개보수는 계산하지 않습니다.</p>
    </header>
    <section class="section" id="verdict-section">
      <h2 id="verdict-summary" aria-live="polite"></h2>
      <div id="verdict-groups"></div>
    </section>
    <section class="section" id="area-section">
      <h2>면적대</h2>
      <p class="lead">기본값은 국민평형 60~85㎡입니다. 바꾸면 아래 모든 계산이 다시 됩니다(추가로 불러오지 않습니다).</p>
      <fieldset class="area-segments" style="border:none;padding:0;margin:0;">${areaOptions}</fieldset>
    </section>
    <section class="section" id="compare-section">
      <h2 id="compare-heading"></h2>
      <p class="lead">행을 클릭하면 구 상세로 이동합니다.</p>
      <div id="compare-table-container"></div>
    </section>
    <section class="section" id="flow-section">
      <h2 id="flow-heading"></h2>
      <div id="flow-chart"></div>
    </section>
    ${limitsSectionHTML()}
    ${footerHTML()}
  </div>`;
}

/* ===================== 구 상세 셸 ===================== */
function guShellHTML(slug) {
  const entry = state.summary.gu.find(g => g.slug === slug);
  const name = entry ? entry.name : slug;
  const m = state.summary.meta;
  return `<div class="wrap">
    ${budgetBarHTML()}
    <div class="detail-header">
      <button type="button" class="back-btn" id="back-btn">← 대시보드로</button>
      <h1>${escapeHtml(name)}</h1>
      <div id="detail-dynamic"></div>
    </div>
    <div id="gu-data-status"></div>
    <div id="gu-heavy-sections" style="display:none">
      <section class="section">
        <h2 id="dong-heading"></h2>
        <p class="lead">각 동의 하위25~상위25% 구간과 예산선을 함께 봅니다.</p>
        <div class="sort-toggle">
          <button type="button" data-dong-sort="p50asc" aria-pressed="true">중위가 낮은순</button>
          <button type="button" data-dong-sort="nDesc" aria-pressed="false">건수 많은순</button>
          <button type="button" data-dong-sort="shareDesc" aria-pressed="false">예산이하%높은순</button>
        </div>
        <div id="dong-list"></div>
        <p class="caption">표본 10건 미만 동은 배지로 표시하고, 이 면적대 거래가 없는 동은 회색으로 표시합니다.</p>
      </section>
      <section class="section">
        <h2 id="complex-count-header"></h2>
        <p class="lead">거래 ${m.minComplexTxns}건 이상 단지만 표시합니다. 예산 이하 단지는 강조 표시됩니다.</p>
        <input type="search" id="complex-search" class="complex-search" placeholder="단지명 검색" aria-label="단지명 검색">
        <div id="complex-list"></div>
        <div id="complex-more-wrap"></div>
        <p class="caption" id="complex-excluded"></p>
      </section>
      <section class="section">
        <h2>실거래 20건</h2>
        <p class="lead">집계가 아닌 개별 계약 건입니다.</p>
        <div id="samples-container"></div>
      </section>
      <section class="section">
        <h2 id="hist-heading"></h2>
        <p class="lead">1억 단위 구간입니다. 마지막 구간은 30억 이상을 모두 더했습니다. 예산선 왼쪽은 진하게, 오른쪽은 옅게 표시했습니다.</p>
        <div id="hist-chart" class="chart-wrap"></div>
      </section>
    </div>
    ${limitsSectionHTML()}
    ${footerHTML()}
  </div>`;
}

/* ===================== 구 상세 — 헤더(요약 데이터만으로 즉시 렌더) ===================== */
function detailDynamicHTML(entry, bucket, budget) {
  const minSample = state.summary.meta.minSampleForVerdict;
  const stats = entry.stats[bucket];
  const grade = verdictFor(stats, budget, minSample);
  const g = GRADE[grade];
  const share = stats ? estimateAffordShareHist(entry.hist[bucket] || [], stats.n, budget) : 0;
  return `<span class="grade-badge" style="--chip-color:${g.color}">${g.label}</span>
    <p class="verdict-formula">${formulaText(grade, stats, budget)}</p>
    <div class="detail-stats">
      <div class="stat"><p class="k">거래건수(${bucketLabelOf(bucket)})</p><p class="v">${fmtCount(stats.n)}</p></div>
      <div class="stat"><p class="k">중위가</p><p class="v">${fmtEok(stats.p50)}</p></div>
      <div class="stat"><p class="k">평당가</p><p class="v">${fmtPyeong(stats.ppyeong)}</p></div>
      <div class="stat"><p class="k">예산이하</p><p class="v">${fmtPct(share)}</p></div>
    </div>`;
}

/* ===================== F1 동 랭킹 ===================== */
function dongHeadingText(guData, bucket) {
  const list = guData.dongs.map(d => ({ name: d.name, stats: d.byBucket && d.byBucket[bucket] })).filter(d => d.stats && d.stats.n > 0);
  if (!list.length) return `${guData.name}에는 이 면적대 거래가 없습니다`;
  list.sort((a, b) => a.stats.p50 - b.stats.p50);
  const top = list[0];
  return `${bucketLabelOf(bucket)} 기준 ${list.length}개 동 중 ${top.name} 중위가가 ${fmtEok(top.stats.p50)}으로 가장 낮습니다`;
}
function buildDongListHTML(guData, bucket, budget, sortMode) {
  const rows = guData.dongs.map(d => ({ name: d.name, stats: d.byBucket && d.byBucket[bucket] }));
  const withData = rows.filter(r => r.stats && r.stats.n > 0);
  const maxP75 = withData.length ? Math.max(...withData.map(r => r.stats.p75)) : 1;
  const sorters = {
    p50asc: (a, b) => (a.stats ? a.stats.p50 : Infinity) - (b.stats ? b.stats.p50 : Infinity),
    nDesc: (a, b) => (b.stats ? b.stats.n : 0) - (a.stats ? a.stats.n : 0),
    shareDesc: (a, b) => estimateAffordShareQuantile(b.stats, budget) - estimateAffordShareQuantile(a.stats, budget)
  };
  const sorted = rows.slice().sort(sorters[sortMode] || sorters.p50asc);
  return sorted.map(r => {
    if (!r.stats || !r.stats.n) {
      return `<div class="dong-row dong-empty"><span class="dong-name">${escapeHtml(r.name)}</span><span class="dong-n">0건</span><span></span></div>`;
    }
    const s = r.stats;
    const leftPct = (s.p25 / maxP75) * 100;
    const widthPct = Math.max(0.5, ((s.p75 - s.p25) / maxP75) * 100);
    const medianPct = (s.p50 / maxP75) * 100;
    const budgetPct = Math.min(100, (budget / maxP75) * 100);
    const share = estimateAffordShareQuantile(s, budget);
    const badge = s.n < 10 ? `<span class="dong-badge">표본 ${s.n}건</span>` : '';
    return `<div class="dong-row">
      <div><span class="dong-name">${escapeHtml(r.name)}</span>${badge}<span class="dong-n">${fmtCount(s.n)}</span></div>
      <div class="dong-bar-wrap" aria-hidden="true">
        <div class="dong-bar-track"></div>
        <div class="dong-bar-range" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></div>
        <div class="dong-bar-median" style="left:calc(${medianPct.toFixed(1)}% - 1.5px)"></div>
        <div class="dong-bar-budget" style="left:calc(${budgetPct.toFixed(1)}% - 1px)"></div>
      </div>
      <div class="dong-share">${fmtEok(s.p50)}<br><span style="font-size:11px;color:var(--label-alt)">${fmtPct(share)} 이하</span></div>
    </div>`;
  }).join('');
}

/* ===================== F2 단지 랭킹 ===================== */
function complexRowHTML(c, bucket, budget) {
  const key = `${c.dong}__${c.name}`;
  const expanded = state.expandedComplexes.has(key);
  const affordable = c.p50 <= budget;
  const count = bucket === 'all' ? c.n : (c.bn && c.bn[bucket]) || 0;
  const detail = expanded
    ? `<div class="complex-detail">대표 거래 · ${c.rep.area}㎡ ${c.rep.floor}층 ${c.rep.ym} ${fmtEok(c.rep.price)}</div>`
    : '';
  return `<div class="complex-row ${affordable ? 'affordable' : ''}">
    <button type="button" class="complex-row-btn" data-toggle-complex="${escapeHtml(key)}" aria-expanded="${expanded}">
      <span><span class="cx-name">${escapeHtml(c.name)}</span> <span class="cx-dong">${escapeHtml(c.dong)} · ${fmtCount(count)}</span></span>
      <span class="cx-price">${fmtEok(c.p50)}</span>
    </button>
    ${detail}
  </div>`;
}
function filteredComplexList(guData, bucket) {
  let list = guData.complexes;
  if (bucket !== 'all') list = list.filter(c => c.bn && c.bn[bucket]);
  const q = state.complexSearch.trim();
  if (q) list = list.filter(c => c.name.includes(q));
  return list.slice().sort((a, b) => a.p50 - b.p50);
}
function updateComplexSection(guData, bucket, budget) {
  const list = filteredComplexList(guData, bucket);
  const total = list.length;
  const affordable = list.filter(c => c.p50 <= budget).length;
  const headerEl = document.getElementById('complex-count-header');
  if (headerEl) headerEl.textContent = `예산 ${fmtBudgetEok(budget)} 이하 단지 ${nfInt.format(affordable)}/${nfInt.format(total)}개`;
  const visible = list.slice(0, state.complexVisibleCount);
  const listEl = document.getElementById('complex-list');
  if (listEl) listEl.innerHTML = visible.map(c => complexRowHTML(c, bucket, budget)).join('') || `<p class="caption">검색 결과가 없습니다.</p>`;
  const moreWrap = document.getElementById('complex-more-wrap');
  if (moreWrap) {
    moreWrap.innerHTML = state.complexVisibleCount < total
      ? `<button type="button" class="load-more-btn" id="complex-more">더 보기 (${nfInt.format(Math.min(30, total - state.complexVisibleCount))}개)</button>`
      : '';
  }
  const excludedEl = document.getElementById('complex-excluded');
  if (excludedEl) excludedEl.textContent = `${guData.excluded.complexes}개 단지(거래 ${fmtCount(guData.excluded.txns)})는 ${state.summary.meta.minComplexTxns}건 미만이라 집계에서 제외했습니다.`;
}

/* ===================== 실거래 샘플 ===================== */
function buildSamplesHTML(guData) {
  const rows = guData.samples || [];
  return `<table class="samples-table"><thead><tr><th>동</th><th>단지</th><th>면적</th><th>층</th><th>계약일</th><th>가격</th><th>평당가</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${escapeHtml(r.dong)}</td><td>${escapeHtml(r.complex)}</td><td>${r.area}㎡</td><td>${r.floor}층</td><td>${r.date}</td><td>${fmtEok(r.price)}</td><td>${nfInt.format(r.ppyeong)}만원</td></tr>`).join('')}
  </tbody></table>`;
}

/* ===================== F8 히스토그램 ===================== */
function histHeadingText(guData, bucket, budget) {
  const s = guData.stats[bucket];
  if (!s || !s.n) return `${guData.name}에는 이 면적대 거래가 없습니다`;
  const share = estimateAffordShareHist(guData.hist[bucket] || [], s.n, budget);
  return `${fmtCount(s.n)} 중 ${fmtPct(share)}가 예산 ${fmtBudgetEok(budget)} 이하입니다`;
}
function buildHistogramHTML(guData, bucket, budget) {
  const hist = (guData.hist && guData.hist[bucket]) || [];
  if (!hist.length || !hist.some(v => v > 0)) return `<p class="caption">이 면적대 거래가 없습니다.</p>`;
  const width = 760, height = 200, padL = 8, padR = 8, padT = 8, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const max = Math.max(...hist, 1);
  const bw = innerW / hist.length;
  const bars = hist.map((v, i) => {
    const h = (v / max) * innerH;
    const x = padL + i * bw, y = padT + innerH - h;
    const binStart = i * 10000;
    const color = binStart < budget ? 'var(--primary-normal)' : 'var(--fill-strong)';
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>${i === 30 ? '30억+' : `${i}억~${i + 1}억`}: ${fmtCount(v)}</title></rect>`;
  }).join('');
  const budgetX = padL + Math.min(budget / 10000, hist.length) * bw;
  const labels = [0, 5, 10, 15, 20, 25, 30].map(i => {
    const x = padL + i * bw;
    const label = i === 30 ? '30억+' : `${i}억`;
    return `<text x="${x.toFixed(1)}" y="${height - 8}" font-size="10" text-anchor="middle" fill="var(--label-assist)">${label}</text>`;
  }).join('');
  const table = `<table><thead><tr><th>구간</th><th>건수</th></tr></thead><tbody>${
    hist.map((v, i) => `<tr><td>${i === 30 ? '30억 이상' : `${i}억~${i + 1}억`}</td><td>${fmtCount(v)}</td></tr>`).join('')
  }</tbody></table>`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="hist-title hist-desc">
    <title id="hist-title">${escapeHtml(guData.name)} 가격 분포</title>
    <desc id="hist-desc">1억 단위 구간별 거래 건수이며, 예산선을 기준으로 좌우 색을 다르게 표시했습니다.</desc>
    ${bars}
    <line x1="${budgetX.toFixed(1)}" y1="${padT}" x2="${budgetX.toFixed(1)}" y2="${padT + innerH}" stroke="var(--label-strong)" stroke-width="1.5" stroke-dasharray="4 3" />
    ${labels}
  </svg>
  <details class="chart-alt"><summary>표로 보기</summary>${table}</details>`;
}
