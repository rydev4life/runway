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
    bills: [],      // {id, name, amount, date}
    debts: [],       // {id, person, amount, note, date}
    tips: [],        // {id, amount, date}
    spends: [],      // {id, amount, note, date}
    shifts: [],      // {id, date, hours}
    paystubs: []     // {id, periodStart, periodEnd, actualPay, date}
  };
}

function saveData(){
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
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

// Expected gross pay for shifts falling within [start, end] inclusive,
// based on logged hours x your set hourly rate.
function expectedPayForPeriod(start, end){
  const rate = Number(data.hourlyRate || 0);
  const shifts = (data.shifts || []).filter(s => s.date >= start && s.date <= end);
  const totalHours = shifts.reduce((sum, s) => sum + Number(s.hours || 0), 0);
  return {expected: totalHours * rate, totalHours, shiftCount: shifts.length};
}

// Compares a logged paystub's actual amount against what your logged shifts
// say you should have earned for that same period.
function comparePaystub(paystub){
  const calc = expectedPayForPeriod(paystub.periodStart, paystub.periodEnd);
  const diff = Number(paystub.actualPay) - calc.expected;
  return {
    expected: calc.expected,
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
}

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
      li.innerHTML = `
        <div class="history-left">
          <span class="history-note">${isSpend ? (item.note || 'Spend') : 'Tips logged'}</span>
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
    const pay = Number(shift.hours||0) * rate;
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${shift.hours}h${rate > 0 ? ' · $' + fmt(pay) : ''}</span>
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
    li.innerHTML = `
      <div class="history-left">
        <span class="history-note">${periodLabel} · ${result.totalHours}h logged, expected $${fmt(result.expected)}</span>
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

document.getElementById('confirm-spend').addEventListener('click', () => {
  const amount = parseFloat(document.getElementById('spend-amount').value);
  if(!amount || amount <= 0) return;
  const note = document.getElementById('spend-note').value.trim();
  data.spends.push({id: uid(), amount, note, date: todayISO()});
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
  renderShiftsList();
  renderPaystubsList();
}
document.querySelector('[data-screen="screen-pay"]').addEventListener('click', fillPayScreen);

document.getElementById('btn-save-rate').addEventListener('click', () => {
  data.hourlyRate = parseFloat(document.getElementById('input-hourly-rate').value) || 0;
  saveData();
  renderShiftsList();
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
