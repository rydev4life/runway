// ===== STORAGE =====
const STORE_KEY = 'runway_data_v1';

function loadData(){
  const raw = localStorage.getItem(STORE_KEY);
  if(raw){
    try{ return JSON.parse(raw); }catch(e){ /* fall through to default */ }
  }
  return {
    balance: 0,
    nextPayDate: null,
    nextPayAmount: 0,
    hourlyRate: 0,
    taxLocation: 'none',
    extraDeductions: [],  // {id, label, type: 'percent'|'flat', amount}
    bills: [],      // {id, name, amount, date}
    debts: [],       // {id, person, amount, note, date}
    tips: [],        // {id, amount, date}
    spends: [],      // {id, amount, note, date}
    shifts: [],      // {id, date, hours}
    paystubs: []     // {id, periodStart, periodEnd, actualPay, date}
  };
}

function saveData(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }catch(err){
    alert('Could not save your data. If you\'re in Private Browsing mode, switch to a regular tab — private mode blocks saved data.');
    throw err;
  }
}

let data = loadData();

// ===== UTIL =====
function fmt(n){
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
function todayISO(){
  return new Date().toISOString().slice(0,10);
}
function daysBetween(a, b){
  const MS = 1000*60*60*24;
  const d1 = new Date(a+'T00:00:00');
  const d2 = new Date(b+'T00:00:00');
  return Math.round((d2 - d1) / MS);
}
function uid(){
  return Math.random().toString(36).slice(2,10);
}

// ===== CORE CALCULATIONS =====

// Trailing tips average + consistency (last up to 8 entries)
function tipStats(){
  const recent = data.tips.slice(-8);
  if(recent.length === 0) return {avg: 0, count: 0, consistency: 0};
  const amounts = recent.map(t => t.amount);
  const avg = amounts.reduce((a,b)=>a+b,0) / amounts.length;
  // consistency: 1 = very steady, 0 = wildly variable
  if(amounts.length < 2) return {avg, count: amounts.length, consistency: 0};
  const mean = avg;
  const variance = amounts.reduce((sum,v)=> sum + Math.pow(v-mean,2), 0) / amounts.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 1; // coefficient of variation
  const consistency = Math.max(0, Math.min(1, 1 - cv)); // clamp 0-1
  return {avg, count: amounts.length, consistency};
}

// Bills due before next payday
function billsBeforePayday(){
  if(!data.nextPayDate) return data.bills.reduce((s,b)=>s+Number(b.amount||0),0);
  return data.bills
    .filter(b => b.date && b.date <= data.nextPayDate)
    .reduce((s,b)=> s + Number(b.amount||0), 0);
}

// AI-determined buffer: based on a baseline (avg weekly fixed-cost-ish cushion)
// reduced by how much trailing tips reliably contribute, and inflated by inconsistency.
function calcBuffer(){
  const stats = tipStats();
  const billsTotal = data.bills.reduce((s,b)=> s + Number(b.amount||0), 0);
  // Baseline: roughly one week of obligations, or a modest floor if no bills logged
  const weeklyBillsEstimate = billsTotal > 0 ? billsTotal / 4 : 75;
  let baseline = weeklyBillsEstimate;

  if(stats.count === 0){
    // No tip history yet — be conservative, full baseline as buffer
    return {amount: Math.round(baseline), note: "No tip history yet — using a standard cushion until a few shifts are logged."};
  }

  // The more consistent tips have been, the more we let them offset the buffer.
  // The less consistent, the more buffer we keep as cushion.
  const offset = stats.avg * stats.consistency * 1.5; // consistent tips can meaningfully reduce buffer
  let buffer = baseline - offset;

  // Inconsistent tips add a bit of safety margin back in
  const volatilityPad = stats.avg * (1 - stats.consistency) * 0.5;
  buffer += volatilityPad;

  buffer = Math.max(40, buffer); // never let it go below a small floor
  buffer = Math.round(buffer);

  let note;
  if(stats.consistency > 0.7){
    note = `Tips have been steady (avg $${fmt(stats.avg)}/shift) — buffer eased down accordingly.`;
  } else if(stats.consistency > 0.35){
    note = `Tips are somewhat variable (avg $${fmt(stats.avg)}/shift) — buffer kept moderate.`;
  } else {
    note = `Tips have swung a lot night to night — buffer nudged up as a cushion.`;
  }
  return {amount: buffer, note};
}

function calcDaysToPayday(){
  if(!data.nextPayDate) return null;
  const d = daysBetween(todayISO(), data.nextPayDate);
  return Math.max(d, 0);
}

// Total money owed to other people (no due-date weighting — treated as
// already-spoken-for money, same as a bill, since it's not really yours to spend)
function totalDebtsOwed(){
  return (data.debts || []).reduce((s,d)=> s + Number(d.amount||0), 0);
}

// ===== TAX ESTIMATION =====
// Simplified, approximate deduction model. This is intentionally rough —
// meant to sanity-check a real paystub, not replace it. Real payroll uses
// per-period tables, credits, and exemptions this does not model.

const TAX_PROFILES = {
  'none':  { label: 'No deductions', incomeTaxRate: 0, statutoryRate: 0, statutoryLabel: '' },

  // Canada — rough blended federal+provincial income tax rate at typical
  // part-time/service-job income levels. CPP + EI shown separately below.
  'CA-ON': { label: 'Ontario',                   incomeTaxRate: 0.16, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-QC': { label: 'Quebec',                    incomeTaxRate: 0.20, statutoryRate: 0.0935, statutoryLabel: 'QPP + EI + QPIP' },
  'CA-BC': { label: 'British Columbia',          incomeTaxRate: 0.14, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-AB': { label: 'Alberta',                   incomeTaxRate: 0.14, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-MB': { label: 'Manitoba',                  incomeTaxRate: 0.17, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-SK': { label: 'Saskatchewan',              incomeTaxRate: 0.16, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-NS': { label: 'Nova Scotia',               incomeTaxRate: 0.18, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-NB': { label: 'New Brunswick',             incomeTaxRate: 0.17, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-NL': { label: 'Newfoundland and Labrador', incomeTaxRate: 0.17, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },
  'CA-PE': { label: 'Prince Edward Island',      incomeTaxRate: 0.17, statutoryRate: 0.0759, statutoryLabel: 'CPP + EI' },

  // US — rough blended federal + state income tax rate. FICA shown separately.
  'US-CA': { label: 'California',  incomeTaxRate: 0.145, statutoryRate: 0.0765, statutoryLabel: 'FICA (Social Security + Medicare)' },
  'US-NY': { label: 'New York',    incomeTaxRate: 0.155, statutoryRate: 0.0765, statutoryLabel: 'FICA (Social Security + Medicare)' },
  'US-TX': { label: 'Texas',       incomeTaxRate: 0.085, statutoryRate: 0.0765, statutoryLabel: 'FICA (Social Security + Medicare)' },
  'US-FL': { label: 'Florida',     incomeTaxRate: 0.085, statutoryRate: 0.0765, statutoryLabel: 'FICA (Social Security + Medicare)' },
  'US-WA': { label: 'Washington',  incomeTaxRate: 0.085, statutoryRate: 0.0765, statutoryLabel: 'FICA (Social Security + Medicare)' }
};

function getTaxProfile(){
  const key = data.taxLocation || 'none';
  return TAX_PROFILES[key] || TAX_PROFILES['none'];
}

// Extra deductions beyond tax/CPP/EI — e.g. workplace pension contribution
// (percentage of gross) and staff meal deduction (flat amount per shift).
// Stored on data.extraDeductions = [{id, label, type: 'percent'|'flat', amount}]
function calcExtraDeductions(gross, shiftCount){
  const list = data.extraDeductions || [];
  return list.map(d => {
    const value = d.type === 'percent'
      ? gross * (Number(d.amount) / 100)
      : Number(d.amount) * Math.max(1, shiftCount || 1);
    return { label: d.label, value };
  });
}

function applyDeductions(gross, shiftCount){
  const profile = getTaxProfile();
  const incomeTax = gross * profile.incomeTaxRate;
  const statutory = gross * profile.statutoryRate;
  const extras = calcExtraDeductions(gross, shiftCount);
  const extrasTotal = extras.reduce((s,e)=> s + e.value, 0);
  const totalDeductions = incomeTax + statutory + extrasTotal;
  return {
    gross: gross,
    incomeTax: incomeTax,
    statutory: statutory,
    statutoryLabel: profile.statutoryLabel,
    extras: extras,
    extrasTotal: extrasTotal,
    deductions: totalDeductions,
    net: gross - totalDeductions,
    label: profile.label
  };
}

// Expected gross pay for shifts falling within [start, end] inclusive,
// based on logged hours x your set hourly rate. Also returns expected net
// pay after applying your selected tax location's estimated deductions
// (income tax, CPP/EI or FICA, and any extra deductions like pension or meals).
function expectedPayForPeriod(start, end){
  const rate = Number(data.hourlyRate || 0);
  const shifts = (data.shifts || []).filter(s => s.date >= start && s.date <= end);
  const totalHours = shifts.reduce((sum, s) => sum + Number(s.hours || 0), 0);
  const gross = totalHours * rate;
  const deductionInfo = applyDeductions(gross, shifts.length);
  return {
    expectedGross: gross,
    expectedNet: deductionInfo.net,
    incomeTax: deductionInfo.incomeTax,
    statutory: deductionInfo.statutory,
    statutoryLabel: deductionInfo.statutoryLabel,
    extras: deductionInfo.extras,
    extrasTotal: deductionInfo.extrasTotal,
    deductions: deductionInfo.deductions,
    taxLabel: deductionInfo.label,
    totalHours,
    shiftCount: shifts.length
  };
}

// Compares a logged paystub's actual amount against what your logged shifts
// say you should have earned (net of estimated deductions) for that period.
function comparePaystub(paystub){
  const calc = expectedPayForPeriod(paystub.periodStart, paystub.periodEnd);
  const diff = Number(paystub.actualPay) - calc.expectedNet;
  return {
    expectedGross: calc.expectedGross,
    expectedNet: calc.expectedNet,
    incomeTax: calc.incomeTax,
    statutory: calc.statutory,
    statutoryLabel: calc.statutoryLabel,
    extras: calc.extras,
    extrasTotal: calc.extrasTotal,
    deductions: calc.deductions,
    taxLabel: calc.taxLabel,
    actual: Number(paystub.actualPay),
    diff: diff,
    totalHours: calc.totalHours,
    shiftCount: calc.shiftCount
  };
}



function calcSafeToSpend(){
  const billsOwed = billsBeforePayday();
  const debtsOwed = totalDebtsOwed();
  const bufferInfo = calcBuffer();
  const days = calcDaysToPayday();
  const usableDays = (days === null || days <= 0) ? 1 : days;

  const available = data.balance - billsOwed - debtsOwed - bufferInfo.amount;
  const perDay = available / usableDays;

  return {
    perDay: perDay,
    available: available,
    billsOwed: billsOwed,
    debtsOwed: debtsOwed,
    buffer: bufferInfo.amount,
    bufferNote: bufferInfo.note,
    days: days
  };
}

// ===== RENDER =====
let lastRenderedPerDay = null;

function render(){
  const calc = calcSafeToSpend();
  const perDayDisplay = Math.max(0, Math.round(calc.perDay));

  // Hero number + tag
  const heroEl = document.getElementById('hero-number');
  const tagEl = document.getElementById('hero-tag');

  if(lastRenderedPerDay !== perDayDisplay){
    heroEl.textContent = perDayDisplay.toLocaleString('en-US');
    heroEl.classList.remove('digit-roll');
    void heroEl.offsetWidth; // restart animation
    heroEl.classList.add('digit-roll');
    lastRenderedPerDay = perDayDisplay;
  }

  let tagText = 'steady';
  tagEl.className = 'hero-tag';
  if(calc.perDay < 0){
    tagText = 'tight';
    tagEl.classList.add('tight');
  } else if(calc.perDay > 60){
    tagText = 'ahead';
    tagEl.classList.add('ahead');
  }
  tagEl.textContent = tagText;

  // Runway bar
  const days = calc.days;
  const barFill = document.getElementById('runway-bar-fill');
  const daysLabel = document.getElementById('runway-days-label');
  const dateLabel = document.getElementById('runway-date-label');

  if(days === null){
    daysLabel.textContent = 'Set your next pay date in Bills';
    barFill.style.width = '0%';
    dateLabel.textContent = '';
  } else {
    daysLabel.textContent = days === 0 ? 'Payday is today' : `${days} day${days===1?'':'s'} to next pay`;
    const totalSpan = 14; // assume ~2 week cycle for visual scale, clamp
    const pct = Math.max(4, 100 - Math.min(100, (days/totalSpan)*100));
    barFill.style.width = pct + '%';
    dateLabel.textContent = data.nextPayDate ? new Date(data.nextPayDate+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
  }

  // Till summary
  document.getElementById('till-balance').textContent = '$' + fmt(data.balance);
  document.getElementById('till-bills').textContent = '$' + fmt(calc.billsOwed);
  document.getElementById('till-debts').textContent = '$' + fmt(calc.debtsOwed);
  document.getElementById('till-buffer').textContent = '$' + fmt(calc.buffer);
  document.getElementById('buffer-explainer').textContent = calc.bufferNote;

  renderHistory();
  renderBillsList();
  renderDebtsList();
  renderTipsHistory();
  renderSpendingChart();
}

// ===== SPENDING BREAKDOWN CHART =====
const CATEGORY_COLORS = {
  food:          { color: '#FF8A3D', label: 'Food' },
  gaming:        { color: '#2FE0E8', label: 'Gaming' },
  gambling:      { color: '#FF3D81', label: 'Gambling' },
  subscriptions: { color: '#7B6CF6', label: 'Subscriptions' },
  gas:           { color: '#F6C445', label: 'Gas' },
  misc:          { color: '#A89AA0', label: 'Misc' },
  uncategorized: { color: '#D8CFC8', label: 'Uncategorized' }
};

let currentChartRange = '7';

function getChartRangeSpends(){
  let cutoff = null;
  if(currentChartRange === '7'){
    const d = new Date(); d.setDate(d.getDate() - 7);
    cutoff = d.toISOString().slice(0,10);
  } else if(currentChartRange === '30'){
    const d = new Date(); d.setDate(d.getDate() - 30);
    cutoff = d.toISOString().slice(0,10);
  } else if(currentChartRange === 'period'){
    // Pay period = since the last logged paystub's period end, or last 14 days if none
    const stubs = (data.paystubs || []).slice().sort((a,b)=> (b.periodEnd||'').localeCompare(a.periodEnd||''));
    if(stubs.length > 0){
      cutoff = stubs[0].periodEnd;
    } else {
      const d = new Date(); d.setDate(d.getDate() - 14);
      cutoff = d.toISOString().slice(0,10);
    }
  }
  return (data.spends || []).filter(s => !cutoff || s.date >= cutoff);
}

function groupSpendsByCategory(spends){
  const totals = {};
  spends.forEach(s => {
    const key = s.category && CATEGORY_COLORS[s.category] ? s.category : 'uncategorized';
    totals[key] = (totals[key] || 0) + Number(s.amount || 0);
  });
  return Object.entries(totals)
    .map(([key, total]) => ({ key, total, ...CATEGORY_COLORS[key] }))
    .sort((a,b) => b.total - a.total);
}

function buildDonutSVG(groups, total){
  const cx = 80, cy = 80, r = 60, strokeWidth = 22;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  let paths = '';
  groups.forEach(g => {
    const fraction = g.total / total;
    const dash = fraction * circumference;
    paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${g.color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`;
    offset += dash;
  });
  return paths;
}

function renderSpendingChart(){
  const wrapEl = document.getElementById('chart-wrap');
  if(!wrapEl) return;
  const emptyEl = document.getElementById('chart-empty');
  const svgEl = document.getElementById('chart-donut');
  const legendEl = document.getElementById('chart-legend');

  const spends = getChartRangeSpends();
  const groups = groupSpendsByCategory(spends);
  const total = groups.reduce((s,g)=> s + g.total, 0);

  if(groups.length === 0 || total <= 0){
    emptyEl.style.display = 'block';
    svgEl.style.display = 'none';
    legendEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  svgEl.style.display = 'block';
  svgEl.innerHTML = buildDonutSVG(groups, total);

  legendEl.innerHTML = '';
  groups.forEach(g => {
    const pct = Math.round((g.total / total) * 100);
    const li = document.createElement('li');
    li.className = 'chart-legend-item';
    li.innerHTML = `
      <span class="chart-legend-left">
        <span class="chart-legend-dot" style="background:${g.color}"></span>
        ${g.label} · ${pct}%
      </span>
      <span class="chart-legend-value">$${fmt(g.total)}</span>
    `;
    legendEl.appendChild(li);
  });
}

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('range-active'));
    btn.classList.add('range-active');
    currentChartRange = btn.dataset.range;
    renderSpendingChart();
  });
});

function combinedActivity(){
  const spends = data.spends.map(s => ({...s, type:'spend'}));
  const tips = data.tips.map(t => ({...t, type:'tip'}));
  return [...spends, ...tips].sort((a,b)=> b.date.localeCompare(a.date));
}

function renderHistory(){
  const list = combinedActivity();
  const el = document.getElementById('history-list');
  const elFull = document.getElementById('history-list-full');

  const renderInto = (target, items) => {
    target.innerHTML = '';
    if(items.length === 0){
      target.innerHTML = '<li class="history-empty">Nothing logged yet. Add a spend or tip below to get started.</li>';
      return;
    }
    items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'history-item';
      const isSpend = item.type === 'spend';
      const emojiPrefix = (isSpend && item.emoji) ? item.emoji + ' ' : '';
      const label = isSpend ? (item.note || (item.category ? item.category[0].toUpperCase() + item.category.slice(1) : 'Spend')) : 'Tips logged';
      li.innerHTML = `
        <div class="history-left">
          <span class="history-note">${emojiPrefix}${label}</span>
          <span class="history-date">${new Date(item.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
        </div>
        <span class="history-amount mono ${isSpend?'neg':'pos'}">${isSpend?'−':'+'}$${fmt(item.amount)}</span>
      `;
      target.appendChild(li);
    });
  };

  renderInto(el, list.slice(0,6));
  renderInto(elFull, list);
}

function renderBillsList(){
  const el = document.getElementById('bills-list');
  el.innerHTML = '';
  if(data.bills.length === 0){
    el.innerHTML = '<li class="bills-empty">No bills added yet.</li>';
    return;
  }
  const sorted = [...data.bills].sort((a,b)=> (a.date||'').localeCompare(b.date||''));
  sorted.forEach(bill => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${bill.name}</span>
        <span class="history-date">${bill.date ? new Date(bill.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'No date'}</span>
      </div>
      <span class="history-amount mono neg">$${fmt(bill.amount)}</span>
      <button class="icon-btn" data-remove-bill="${bill.id}" style="font-size:16px;margin-left:6px;">✕</button>
    `;
    el.appendChild(li);
  });
  el.querySelectorAll('[data-remove-bill]').forEach(btn => {
    btn.addEventListener('click', () => {
      data.bills = data.bills.filter(b => b.id !== btn.dataset.removeBill);
      saveData();
      renderBillsList();
      render();
    });
  });
}

function renderDebtsList(){
  const el = document.getElementById('debts-list');
  if(!el) return;
  el.innerHTML = '';
  const debts = data.debts || [];
  if(debts.length === 0){
    el.innerHTML = '<li class="bills-empty">No debts added yet.</li>';
    return;
  }
  const sorted = [...debts].sort((a,b)=> (a.date||'').localeCompare(b.date||''));
  sorted.forEach(debt => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${debt.person}${debt.note ? ' — ' + debt.note : ''}</span>
        <span class="history-date">${debt.date ? new Date(debt.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'No date'}</span>
      </div>
      <span class="history-amount mono neg">$${fmt(debt.amount)}</span>
      <button class="icon-btn" data-remove-debt="${debt.id}" style="font-size:16px;margin-left:6px;">✕</button>
    `;
    el.appendChild(li);
  });
  el.querySelectorAll('[data-remove-debt]').forEach(btn => {
    btn.addEventListener('click', () => {
      data.debts = (data.debts||[]).filter(d => d.id !== btn.dataset.removeDebt);
      saveData();
      renderDebtsList();
      render();
    });
  });
}

function renderShiftsList(){
  const el = document.getElementById('shifts-list');
  if(!el) return;
  el.innerHTML = '';
  const shifts = data.shifts || [];
  if(shifts.length === 0){
    el.innerHTML = '<li class="bills-empty">No shifts logged yet.</li>';
    return;
  }
  const sorted = [...shifts].sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  const rate = Number(data.hourlyRate || 0);
  sorted.slice(0,15).forEach(shift => {
    const li = document.createElement('li');
    li.className = 'history-item';
    const gross = Number(shift.hours||0) * rate;
    const deductionInfo = applyDeductions(gross, 1);
    let payLabel = '';
    if(rate > 0){
      payLabel = deductionInfo.deductions > 0
        ? ` · $${fmt(gross)} gross / $${fmt(deductionInfo.net)} net`
        : ` · $${fmt(gross)}`;
    }
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${shift.hours}h${payLabel}</span>
        <span class="history-date">${shift.date ? new Date(shift.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'No date'}</span>
      </div>
      <button class="icon-btn" data-remove-shift="${shift.id}" style="font-size:16px;margin-left:6px;">✕</button>
    `;
    el.appendChild(li);
  });
  el.querySelectorAll('[data-remove-shift]').forEach(btn => {
    btn.addEventListener('click', () => {
      data.shifts = (data.shifts||[]).filter(s => s.id !== btn.dataset.removeShift);
      saveData();
      renderShiftsList();
    });
  });
}

function renderPaystubsList(){
  const el = document.getElementById('paystubs-list');
  if(!el) return;
  el.innerHTML = '';
  const stubs = data.paystubs || [];
  if(stubs.length === 0){
    el.innerHTML = '<li class="bills-empty">No paystubs checked yet.</li>';
    return;
  }
  const sorted = [...stubs].sort((a,b)=> (b.periodEnd||'').localeCompare(a.periodEnd||''));
  sorted.forEach(stub => {
    const result = comparePaystub(stub);
    const li = document.createElement('li');
    li.className = 'history-item';
    const diffAbs = Math.abs(result.diff);
    let diffLabel, diffClass;
    if(diffAbs < 1){
      diffLabel = 'Matches';
      diffClass = 'pos';
    } else if(result.diff < 0){
      diffLabel = `Short $${fmt(diffAbs)}`;
      diffClass = 'neg';
    } else {
      diffLabel = `Over $${fmt(diffAbs)}`;
      diffClass = 'pos';
    }
    const periodLabel = `${new Date(stub.periodStart+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}–${new Date(stub.periodEnd+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;
    let breakdownParts = [];
    if(result.incomeTax > 0) breakdownParts.push(`${result.taxLabel} tax $${fmt(result.incomeTax)}`);
    if(result.statutory > 0) breakdownParts.push(`${result.statutoryLabel} $${fmt(result.statutory)}`);
    (result.extras||[]).forEach(e => { if(e.value > 0) breakdownParts.push(`${e.label} $${fmt(e.value)}`); });
    const expectedLine = breakdownParts.length > 0
      ? `${result.totalHours}h logged · expected net $${fmt(result.expectedNet)} (gross $${fmt(result.expectedGross)} − ${breakdownParts.join(', ')})`
      : `${result.totalHours}h logged, expected $${fmt(result.expectedNet)}`;
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${periodLabel} · ${expectedLine}</span>
        <span class="history-date">Paid $${fmt(result.actual)}</span>
      </div>
      <span class="history-amount mono ${diffClass}">${diffLabel}</span>
      <button class="icon-btn" data-remove-stub="${stub.id}" style="font-size:16px;margin-left:6px;">✕</button>
    `;
    el.appendChild(li);
  });
  el.querySelectorAll('[data-remove-stub]').forEach(btn => {
    btn.addEventListener('click', () => {
      data.paystubs = (data.paystubs||[]).filter(s => s.id !== btn.dataset.removeStub);
      saveData();
      renderPaystubsList();
    });
  });
}

function renderDeductionsList(){
  const el = document.getElementById('deductions-list');
  if(!el) return;
  el.innerHTML = '';
  const list = data.extraDeductions || [];
  if(list.length === 0){
    el.innerHTML = '<li class="bills-empty">No other deductions added yet.</li>';
    return;
  }
  list.forEach(d => {
    const li = document.createElement('li');
    li.className = 'history-item';
    const amountLabel = d.type === 'percent' ? `${d.amount}% of gross` : `$${fmt(d.amount)} per shift`;
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${d.label}</span>
        <span class="history-date">${amountLabel}</span>
      </div>
      <button class="icon-btn" data-remove-deduction="${d.id}" style="font-size:16px;margin-left:6px;">✕</button>
    `;
    el.appendChild(li);
  });
  el.querySelectorAll('[data-remove-deduction]').forEach(btn => {
    btn.addEventListener('click', () => {
      data.extraDeductions = (data.extraDeductions||[]).filter(d => d.id !== btn.dataset.removeDeduction);
      saveData();
      renderDeductionsList();
      renderShiftsList();
      renderPaystubsList();
    });
  });
}

function renderTipsHistory(){
  const el = document.getElementById('tips-history-list');
  el.innerHTML = '';
  const recent = [...data.tips].slice(-10).reverse();
  if(recent.length === 0){
    el.innerHTML = '<li class="bills-empty">No tips logged yet.</li>';
    return;
  }
  recent.forEach(t => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">Tips</span>
        <span class="history-date">${new Date(t.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
      </div>
      <span class="history-amount mono pos">+$${fmt(t.amount)}</span>
    `;
    el.appendChild(li);
  });
}

// ===== NAVIGATION =====
function showScreen(id){
  window.scrollTo(0,0);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('nav-active', b.dataset.screen === id);
  });
  // Second scroll reset on next frame as a safety net for iOS Safari,
  // which can otherwise ignore scrollTo when it fires alongside a display swap.
  requestAnimationFrame(() => window.scrollTo(0,0));
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.screen));
});
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
});
document.getElementById('btn-settings').addEventListener('click', () => showScreen('screen-settings'));
document.getElementById('btn-view-all').addEventListener('click', () => showScreen('screen-history-full'));

// ===== MODALS =====
const overlay = document.getElementById('modal-overlay');
function openModal(id){
  overlay.classList.add('active');
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function closeModal(){
  overlay.classList.remove('active');
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}
overlay.addEventListener('click', (e) => { if(e.target === overlay) closeModal(); });
document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', closeModal));

document.getElementById('btn-log-spend').addEventListener('click', () => {
  document.getElementById('spend-amount').value = '';
  document.getElementById('spend-note').value = '';
  document.getElementById('spend-category').value = '';
  document.querySelectorAll('#spend-category-row .category-chip').forEach(c => c.classList.remove('selected'));
  openModal('modal-log-spend');
});
document.getElementById('btn-log-tips').addEventListener('click', () => {
  document.getElementById('tips-amount').value = '';
  openModal('modal-log-tips');
});
document.getElementById('btn-add-bill').addEventListener('click', () => {
  document.getElementById('bill-name').value = '';
  document.getElementById('bill-amount').value = '';
  document.getElementById('bill-date').value = '';
  openModal('modal-add-bill');
});
document.getElementById('btn-add-debt').addEventListener('click', () => {
  document.getElementById('debt-person').value = '';
  document.getElementById('debt-amount').value = '';
  document.getElementById('debt-note').value = '';
  document.getElementById('debt-date').value = '';
  openModal('modal-add-debt');
});
document.getElementById('btn-add-shift').addEventListener('click', () => {
  document.getElementById('shift-date').value = todayISO();
  document.getElementById('shift-hours').value = '';
  openModal('modal-add-shift');
});
document.getElementById('btn-add-paystub').addEventListener('click', () => {
  document.getElementById('paystub-start').value = '';
  document.getElementById('paystub-end').value = '';
  document.getElementById('paystub-amount').value = '';
  openModal('modal-add-paystub');
});
document.getElementById('btn-add-deduction').addEventListener('click', () => {
  document.getElementById('deduction-label').value = '';
  document.getElementById('deduction-type').value = 'percent';
  document.getElementById('deduction-amount').value = '';
  openModal('modal-add-deduction');
});

document.querySelectorAll('#spend-category-row .category-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const alreadySelected = chip.classList.contains('selected');
    document.querySelectorAll('#spend-category-row .category-chip').forEach(c => c.classList.remove('selected'));
    if(!alreadySelected){
      chip.classList.add('selected');
      document.getElementById('spend-category').value = chip.dataset.category;
    } else {
      document.getElementById('spend-category').value = '';
    }
  });
});

document.getElementById('confirm-spend').addEventListener('click', () => {
  const amount = parseFloat(document.getElementById('spend-amount').value);
  if(!amount || amount <= 0) return;
  const note = document.getElementById('spend-note').value.trim();
  const category = document.getElementById('spend-category').value;
  const selectedChip = document.querySelector('#spend-category-row .category-chip.selected');
  const emoji = selectedChip ? selectedChip.dataset.emoji : '';
  data.spends.push({id: uid(), amount, note, category, emoji, date: todayISO()});
  data.balance -= amount;
  saveData();
  render();
  closeModal();
});

document.getElementById('confirm-tips').addEventListener('click', () => {
  const amount = parseFloat(document.getElementById('tips-amount').value);
  if(!amount || amount <= 0) return;
  data.tips.push({id: uid(), amount, date: todayISO()});
  data.balance += amount;
  saveData();
  render();
  closeModal();
});

document.getElementById('confirm-bill').addEventListener('click', () => {
  const name = document.getElementById('bill-name').value.trim() || 'Bill';
  const amount = parseFloat(document.getElementById('bill-amount').value);
  const date = document.getElementById('bill-date').value;
  if(!amount || amount <= 0) return;
  data.bills.push({id: uid(), name, amount, date});
  saveData();
  renderBillsList();
  render();
  closeModal();
});

document.getElementById('confirm-debt').addEventListener('click', () => {
  const person = document.getElementById('debt-person').value.trim() || 'Someone';
  const amount = parseFloat(document.getElementById('debt-amount').value);
  const note = document.getElementById('debt-note').value.trim();
  const date = document.getElementById('debt-date').value || todayISO();
  if(!amount || amount <= 0) return;
  data.debts = data.debts || [];
  data.debts.push({id: uid(), person, amount, note, date});
  saveData();
  renderDebtsList();
  render();
  closeModal();
});

document.getElementById('confirm-shift').addEventListener('click', () => {
  const date = document.getElementById('shift-date').value || todayISO();
  const hours = parseFloat(document.getElementById('shift-hours').value);
  if(!hours || hours <= 0) return;
  data.shifts = data.shifts || [];
  data.shifts.push({id: uid(), date, hours});
  saveData();
  renderShiftsList();
  closeModal();
});

document.getElementById('confirm-paystub').addEventListener('click', () => {
  const periodStart = document.getElementById('paystub-start').value;
  const periodEnd = document.getElementById('paystub-end').value;
  const actualPay = parseFloat(document.getElementById('paystub-amount').value);
  if(!periodStart || !periodEnd || actualPay === undefined || isNaN(actualPay)) return;
  data.paystubs = data.paystubs || [];
  data.paystubs.push({id: uid(), periodStart, periodEnd, actualPay, date: todayISO()});
  saveData();
  renderPaystubsList();
  closeModal();
});

document.getElementById('confirm-deduction').addEventListener('click', () => {
  const label = document.getElementById('deduction-label').value.trim();
  const type = document.getElementById('deduction-type').value;
  const amount = parseFloat(document.getElementById('deduction-amount').value);
  if(!label || !amount || amount <= 0) return;
  data.extraDeductions = data.extraDeductions || [];
  data.extraDeductions.push({id: uid(), label, type, amount});
  saveData();
  renderDeductionsList();
  renderShiftsList();
  renderPaystubsList();
  closeModal();
});

// ===== SETUP / BILLS SCREEN =====
function fillSetupForm(){
  document.getElementById('input-balance').value = data.balance || '';
  document.getElementById('input-next-pay-date').value = data.nextPayDate || '';
  document.getElementById('input-next-pay-amount').value = data.nextPayAmount || '';
}
document.querySelector('[data-screen="screen-bills"]').addEventListener('click', fillSetupForm);

document.getElementById('btn-save-setup').addEventListener('click', () => {
  data.balance = parseFloat(document.getElementById('input-balance').value) || 0;
  data.nextPayDate = document.getElementById('input-next-pay-date').value || null;
  data.nextPayAmount = parseFloat(document.getElementById('input-next-pay-amount').value) || 0;
  saveData();
  render();
  showScreen('screen-home');
});

// ===== PAY SCREEN =====
function fillPayScreen(){
  document.getElementById('input-hourly-rate').value = data.hourlyRate || '';
  document.getElementById('input-tax-location').value = data.taxLocation || 'none';
  renderShiftsList();
  renderPaystubsList();
  renderDeductionsList();
}
document.querySelector('[data-screen="screen-pay"]').addEventListener('click', fillPayScreen);

document.getElementById('btn-save-rate').addEventListener('click', () => {
  try{
    data.hourlyRate = parseFloat(document.getElementById('input-hourly-rate').value) || 0;
    data.taxLocation = document.getElementById('input-tax-location').value || 'none';
    saveData();
    renderShiftsList();
    renderPaystubsList();
    const btn = document.getElementById('btn-save-rate');
    const original = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = original; }, 1200);
  }catch(err){
    alert('Could not save: ' + err.message);
  }
});

// ===== ASK SCREEN =====
function generateAnswer(question){
  const calc = calcSafeToSpend();
  const perDay = Math.max(0, Math.round(calc.perDay));
  const q = question.toLowerCase();

  // Try to detect a dollar amount in the question
  const amountMatch = q.match(/\$?\s*(\d+(\.\d{1,2})?)/);
  const askedAmount = amountMatch ? parseFloat(amountMatch[1]) : null;

  let headline, body, tone;

  if(askedAmount !== null){
    const remainder = perDay - askedAmount;
    if(remainder >= 0){
      tone = 'go';
      headline = `Yes — you'd have $${fmt(remainder)} left for today.`;
      body = `Your safe-to-spend today is $${fmt(perDay)}. After $${fmt(askedAmount)}, you're still in the clear, ${calc.days !== null ? `with ${calc.days} day(s) until your next pay.` : ''}`;
    } else {
      tone = 'caution';
      headline = `Tight — that's $${fmt(Math.abs(remainder))} over today's number.`;
      body = `Your safe-to-spend today is $${fmt(perDay)}. Spending $${fmt(askedAmount)} would eat into next pay period's runway or your buffer. Doable, but it borrows from tomorrow.`;
    }
  } else if(q.includes('week') || q.includes('tracking')){
    tone = perDay >= 0 ? 'go' : 'caution';
    headline = perDay >= 0 ? `On track — about $${fmt(perDay)}/day to work with.` : `Running tight — about $${fmt(Math.abs(perDay))}/day over.`;
    body = `Balance: $${fmt(data.balance)}. Bills before payday: $${fmt(calc.billsOwed)}. Buffer: $${fmt(calc.buffer)} (${calc.bufferNote}) ${calc.days !== null ? `Next pay in ${calc.days} day(s).` : 'Set a next pay date in Bills for a sharper number.'}`;
  } else if(q.includes('relax')){
    tone = 'go';
    if(perDay > 60){
      headline = `You've got room now — $${fmt(perDay)}/day clear.`;
      body = `Tips have been factored into your buffer, and you're sitting comfortably above your obligations. Good night to treat yourself, within reason.`;
    } else {
      headline = `Hold steady a bit longer.`;
      body = `You're at $${fmt(perDay)}/day after bills and buffer — workable, but not loose. Once a few more steady tip nights land, the buffer eases and this number grows.`;
    }
  } else {
    tone = perDay >= 0 ? 'go' : 'caution';
    headline = perDay >= 0 ? `$${fmt(perDay)}/day is your number right now.` : `You're about $${fmt(Math.abs(perDay))}/day past safe right now.`;
    body = `That's balance minus bills due before payday minus your buffer, split across the days left. ${calc.bufferNote}`;
  }

  return {headline, body, tone};
}

function renderAnswer(question){
  const result = generateAnswer(question);
  const box = document.getElementById('ask-answer');
  box.innerHTML = `
    <div class="ask-answer-headline ${result.tone}">${result.headline}</div>
    <div>${result.body}</div>
  `;
}

document.querySelectorAll('.ask-chip').forEach(chip => {
  chip.addEventListener('click', () => renderAnswer(chip.dataset.q));
});
document.getElementById('btn-ask-send').addEventListener('click', () => {
  const val = document.getElementById('ask-input').value.trim();
  if(!val) return;
  renderAnswer(val);
  document.getElementById('ask-input').value = '';
});
document.getElementById('ask-input').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') document.getElementById('btn-ask-send').click();
});

// ===== SETTINGS: EXPORT / IMPORT / RESET =====
document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `runway-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try{
      const imported = JSON.parse(evt.target.result);
      data = Object.assign(loadData(), imported);
      saveData();
      render();
      showScreen('screen-home');
    }catch(err){
      alert('Could not read that backup file.');
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if(confirm('This will erase all data on this phone. Are you sure?')){
    localStorage.removeItem(STORE_KEY);
    data = loadData();
    render();
    showScreen('screen-home');
  }
});

// ===== INIT =====
render();

// Register service worker for offline support
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
