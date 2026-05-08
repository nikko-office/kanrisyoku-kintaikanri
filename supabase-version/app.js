import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = window.KINTAI_SUPABASE_CONFIG || {};

// ロックバイパスなし、シンプルなクライアント
const supabase = createClient(CONFIG.url || '', CONFIG.publishableKey || '');

const LEAVE_KINDS = ['出勤', '有休', '午前半休', '午後半休', '時間休', '欠勤', '特別休暇', '休日', '代休', '振替休日'];
const DAY_TYPES = ['出勤日', '休日', '祝日', '土曜出勤日', '会社休日'];

const state = {
  session: null,
  profile: null,
  users: [],
  settings: {},
  monthly: null,
};

const $ = (id) => document.getElementById(id);

// ─── ユーティリティ ───────────────────────────────────────

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function currentTime() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function pad2(v) { return String(v).padStart(2, '0'); }

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
}

function showMessage(text, isError = false) {
  $('message').innerHTML = text
    ? `<div class="notice ${isError ? 'error' : ''}">${escapeHtml(text)}</div>`
    : '';
}

function clearMessage() { $('message').innerHTML = ''; }

function normalizeError(err) {
  const msg = String(err?.message || err || '不明なエラー').replace(/^Error:\s*/, '');
  if (/Invalid login credentials/i.test(msg)) return 'メールアドレスまたはパスワードが正しくありません。';
  if (/Email not confirmed/i.test(msg)) return 'メールアドレスが未確認です。招待メールのリンクをクリックしてください。';
  if (/email rate limit/i.test(msg)) return 'メール送信上限に達しました。しばらく待ってから再試行してください。';
  if (/only request this after/i.test(msg)) return 'リセットメールは連続送信できません。少し待ってから再送してください。';
  return msg;
}

function throwIf(error) { if (error) throw error; }

function minutesToHours(min) {
  if (min === null || min === undefined || min === '') return '';
  return `${Math.round((Number(min) / 60) * 100) / 100}h`;
}

function timeOnly(v) { return v ? String(v).slice(0, 5) : ''; }

function weekdayLabel(dateStr) {
  return ['日','月','火','水','木','金','土'][new Date(`${dateStr}T00:00:00+09:00`).getDay()];
}

function getPeriodForDate(dateStr) {
  const cd = Number(state.settings.closingDay || 15);
  let [y, m, d] = dateStr.split('-').map(Number);
  if (d > cd) { m++; if (m > 12) { m = 1; y++; } }
  return getPeriodRange(`${y}-${pad2(m)}`);
}

function getPeriodRange(periodKey) {
  const cd = Number(state.settings.closingDay || 15);
  const [ey, em] = periodKey.split('-').map(Number);
  let sy = ey, sm = em - 1;
  if (sm <= 0) { sm = 12; sy--; }
  return {
    periodKey,
    label: `${ey}年${em}月度`,
    startDate: `${sy}-${pad2(sm)}-${pad2(cd + 1)}`,
    endDate: `${ey}-${pad2(em)}-${pad2(cd)}`,
  };
}

function enumerateDates(start, end) {
  const dates = [];
  const cur = new Date(`${start}T00:00:00+09:00`);
  const fin = new Date(`${end}T00:00:00+09:00`);
  while (cur <= fin) {
    dates.push(cur.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function classifyDate(dateStr, calMap) {
  const ov = calMap.get(dateStr);
  if (ov) return { type: ov.day_type, name: ov.name || '', isWorkday: ov.day_type === '出勤日' || ov.day_type === '土曜出勤日' };
  const d = new Date(`${dateStr}T00:00:00+09:00`).getDay();
  const holiday = d === 0 || d === 6;
  return { type: holiday ? '休日' : '出勤日', name: '', isWorkday: !holiday };
}

function leaveHoursForKind(kind) {
  const h = Number(state.settings.hourlyLeaveHoursPerDay || 8);
  if (['有休','欠勤','特別休暇','代休','振替休日'].includes(kind)) return h;
  if (kind === '午前半休' || kind === '午後半休') return h / 2;
  return null;
}

function fillSelect(sel, items, selected) {
  sel.innerHTML = items.map((item) => {
    const v = typeof item === 'string' ? item : item.value;
    const l = typeof item === 'string' ? item : item.label;
    return `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`;
  }).join('');
  if (selected) sel.value = selected;
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
}

async function withBusy(buttonId, busyText, successText, fn) {
  const btn = $(buttonId);
  const origText = btn?.textContent;
  if (btn) { btn.textContent = busyText; btn.classList.add('busy'); }
  setBusy(true);
  showMessage(busyText);
  try {
    await fn();
    showMessage(successText);
  } catch (err) {
    showMessage(normalizeError(err), true);
  } finally {
    if (btn) { btn.textContent = origText; btn.classList.remove('busy'); }
    setBusy(false);
  }
}

// ─── 画面切替 ────────────────────────────────────────────

function showPanel(panelId) {
  ['loginPanel','appPanel','unauthorizedPanel','passwordResetPanel'].forEach((id) => {
    $(id).classList.toggle('hidden', id !== panelId);
  });
}

// ─── データロード ─────────────────────────────────────────

async function loadSettings() {
  const { data, error } = await supabase.from('app_settings').select('key,value');
  throwIf(error);
  state.settings = {};
  (data || []).forEach((r) => { state.settings[r.key] = r.value; });
  $('appName').textContent = state.settings.companyName || '管理職勤怠管理';
}

async function loadProfile() {
  const email = state.session?.user?.email?.toLowerCase();
  const { data, error } = await supabase
    .from('app_users').select('*')
    .eq('active', true).eq('email', email).limit(1).maybeSingle();
  throwIf(error);
  state.profile = data;
  return data;
}

async function loadUsers() {
  const { data, error } = await supabase
    .from('app_users').select('*').eq('active', true)
    .order('role', { ascending: true }).order('name', { ascending: true });
  throwIf(error);
  state.users = data || [];
}

// ─── アプリ表示 ───────────────────────────────────────────

async function renderApp() {
  try {
    showMessage('読み込み中...');
    await loadSettings();
    const profile = await loadProfile();

    if (!profile) {
      showPanel('unauthorizedPanel');
      $('unauthorizedText').textContent =
        `${state.session.user.email} は利用者に登録されていません。管理者に追加を依頼してください。`;
      clearMessage();
      return;
    }

    if (profile.role === 'admin') {
      await loadUsers();
    } else {
      state.users = [profile];
    }

    showPanel('appPanel');
    $('account').textContent = state.session.user.email;
    renderMain();
    await loadMonthly();
    clearMessage();
  } catch (err) {
    showMessage(`データ読み込みエラー: ${normalizeError(err)}`, true);
  }
}

function renderMain() {
  const today = todayIso();
  const period = getPeriodForDate(today);
  const isAdmin = state.profile.role === 'admin';

  $('todayDate').textContent = today;
  $('leaveDate').value = today;
  $('adminDate').value = today;
  $('calendarDate').value = today;
  $('periodInput').value = period.periodKey;
  $('periodLabel').textContent = `${period.label} ${period.startDate} - ${period.endDate}`;

  $('scopeInput').classList.toggle('hidden', !isAdmin);
  $('exportCsvButton').classList.toggle('hidden', !isAdmin);
  $('adminTabButton').classList.toggle('hidden', !isAdmin);
  $('calendarTabButton').classList.toggle('hidden', !isAdmin);
  $('usersTabButton').classList.toggle('hidden', !isAdmin);
  $('scopeInput').value = 'self';

  fillSelect($('leaveKind'), LEAVE_KINDS.filter((k) => k !== '出勤'), '時間休');
  fillSelect($('adminKind'), LEAVE_KINDS, '出勤');
  fillSelect($('calendarType'), DAY_TYPES, '土曜出勤日');
  fillSelect($('adminUserId'),
    state.users.map((u) => ({ value: u.id, label: `${u.name} <${u.email}>` })),
    state.profile.id);
  $('usersText').value = state.users
    .map((u) => `${u.email}, ${u.name}, ${u.role}, ${u.active ? 'TRUE' : 'FALSE'}`).join('\n');
  renderAdminEdit(null);
}

async function loadMonthly() {
  const period = getPeriodRange($('periodInput').value);
  const isAdmin = state.profile.role === 'admin';
  const scope = isAdmin ? $('scopeInput').value : 'self';
  const users = isAdmin && scope === 'all' ? state.users : [state.profile];
  const userIds = users.map((u) => u.id);

  const [{ data: records, error: e1 }, { data: calendar, error: e2 }, { data: closing, error: e3 }] =
    await Promise.all([
      supabase.from('attendance_records').select('*, app_users(id,email,name)')
        .gte('work_date', period.startDate).lte('work_date', period.endDate).in('user_id', userIds),
      supabase.from('calendar_days').select('*')
        .gte('work_date', period.startDate).lte('work_date', period.endDate),
      supabase.from('monthly_closings').select('*')
        .eq('period_key', period.periodKey).maybeSingle(),
    ]);
  throwIf(e1); throwIf(e2); throwIf(e3);

  const recMap = new Map((records || []).map((r) => [`${r.user_id}|${r.work_date}`, r]));
  const calMap = new Map((calendar || []).map((d) => [d.work_date, d]));
  const rows = [];

  users.forEach((user) => {
    enumerateDates(period.startDate, period.endDate).forEach((date) => {
      const day = classifyDate(date, calMap);
      const rec = recMap.get(`${user.id}|${date}`) || {};
      rows.push({
        date, weekday: weekdayLabel(date), dayType: day.type, dayName: day.name,
        userId: user.id, email: user.email, name: user.name || user.email,
        kind: rec.kind || (day.isWorkday ? '' : '休日'),
        clockIn: timeOnly(rec.clock_in), clockOut: timeOnly(rec.clock_out),
        breakMinutes: rec.break_minutes ?? '', workMinutes: rec.work_minutes ?? '',
        nightMinutes: rec.night_minutes ?? '', leaveHours: rec.leave_hours ?? '',
        note: rec.note || '', missingClockOut: Boolean(rec.clock_in && !rec.clock_out),
      });
    });
  });

  state.monthly = {
    period, rows, isAdmin,
    closed: closing?.status === 'CLOSED',
    summaries: summarizeRows(rows),
  };
  renderMonthly();
}

function summarizeRows(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.userId)) {
      map.set(row.userId, { userId: row.userId, name: row.name,
        workDays: 0, workMinutes: 0, nightMinutes: 0,
        paidLeaveDays: 0, leaveHours: 0, missingClockOut: 0 });
    }
    const s = map.get(row.userId);
    if (row.clockIn) s.workDays++;
    s.workMinutes += Number(row.workMinutes || 0);
    s.nightMinutes += Number(row.nightMinutes || 0);
    s.leaveHours += Number(row.leaveHours || 0);
    if (row.kind === '有休') s.paidLeaveDays++;
    if (row.kind === '午前半休' || row.kind === '午後半休') s.paidLeaveDays += 0.5;
    if (row.missingClockOut) s.missingClockOut++;
  });
  return Array.from(map.values()).map((s) => ({
    ...s,
    workHours: Math.round((s.workMinutes / 60) * 100) / 100,
    nightHours: Math.round((s.nightMinutes / 60) * 100) / 100,
  }));
}

function renderMonthly() {
  const m = state.monthly;
  $('periodLabel').textContent = `${m.period.label} ${m.period.startDate} - ${m.period.endDate}`;
  $('closingBadge').textContent = m.closed ? '締め済み' : '未締め';
  $('closingBadge').className = `badge ${m.closed ? 'closed' : 'open'}`;

  const today = m.rows.find((r) => r.userId === state.profile.id && r.date === todayIso()) || {};
  $('todayClockIn').textContent = today.clockIn || '-';
  $('todayClockOut').textContent = today.clockOut || '-';
  $('todayKind').textContent = today.kind || '-';

  $('summary').innerHTML = m.summaries.map((s) => `
    <div class="metric"><span>${escapeHtml(s.name)}</span><strong>${s.workDays}日 / ${s.workHours}h</strong></div>
    <div class="metric"><span>有休</span><strong>${s.paidLeaveDays}日</strong></div>
    <div class="metric"><span>休暇時間</span><strong>${s.leaveHours}h</strong></div>
    <div class="metric"><span>深夜</span><strong>${s.nightHours}h</strong></div>
    <div class="metric"><span>退勤漏れ</span><strong>${s.missingClockOut}</strong></div>
  `).join('');

  $('monthlyBody').innerHTML = m.rows.map((row) => {
    const cls = [
      row.weekday === '土' ? 'saturday' : '',
      row.dayType === '休日' ? 'holiday' : '',
      row.dayType === '祝日' ? 'national-holiday' : '',
      row.dayType === '会社休日' ? 'company-holiday' : '',
      row.missingClockOut ? 'missing' : '',
      m.isAdmin ? 'editable-row' : '',
    ].filter(Boolean).join(' ');
    return `<tr class="${cls}" data-user-id="${escapeHtml(row.userId)}" data-date="${escapeHtml(row.date)}">
      <td>${escapeHtml(row.date)}</td>
      <td>${escapeHtml(row.weekday)}</td>
      <td>${escapeHtml(row.dayType)}${row.dayName ? ` <span class="badge">${escapeHtml(row.dayName)}</span>` : ''}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.kind)}</td>
      <td>${escapeHtml(row.clockIn)}</td>
      <td>${escapeHtml(row.clockOut)}</td>
      <td>${escapeHtml(row.breakMinutes)}</td>
      <td>${escapeHtml(minutesToHours(row.workMinutes))}</td>
      <td>${escapeHtml(minutesToHours(row.nightMinutes))}</td>
      <td>${escapeHtml(row.leaveHours)}</td>
      <td>${escapeHtml(row.note)}</td>
    </tr>`;
  }).join('');
}

function renderAdminEdit(edit) {
  const el = $('adminEditStatus');
  if (!el) return;
  el.innerHTML = edit ? `
    <div class="metric"><span>対象</span><strong>${escapeHtml(edit.name)}</strong></div>
    <div class="metric"><span>日付</span><strong>${escapeHtml(edit.work_date)}</strong></div>
    <div class="metric"><span>状態</span><strong>${edit.id ? '記録あり' : '新規修正'}</strong></div>
    <div class="metric"><span>締め</span><strong>${state.monthly?.closed ? '締め済み' : '未締め'}</strong></div>
  ` : '<div class="metric"><span>修正対象</span><strong>未読込</strong></div>';
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['leave','admin','calendar','users'].forEach((t) => $(`${t}Tab`).classList.toggle('hidden', t !== name));
}

// ─── アクション ───────────────────────────────────────────

async function upsertAttendance(payload) {
  const { error } = await supabase.from('attendance_records')
    .upsert(payload, { onConflict: 'work_date,user_id' });
  throwIf(error);
}

async function loadAdminEdit() {
  const userId = $('adminUserId').value;
  const date = $('adminDate').value;
  const user = state.users.find((u) => u.id === userId);
  const { data, error } = await supabase.from('attendance_records').select('*')
    .eq('user_id', userId).eq('work_date', date).maybeSingle();
  throwIf(error);
  const rec = data || { id: '', work_date: date, user_id: userId, kind: '出勤' };
  const edit = { ...rec, name: user?.name || user?.email || '' };
  state.edit = edit;
  $('adminKind').value = rec.kind || '出勤';
  $('adminClockIn').value = timeOnly(rec.clock_in);
  $('adminClockOut').value = timeOnly(rec.clock_out);
  $('adminLeaveHours').value = rec.leave_hours ?? '';
  $('adminNote').value = rec.note || '';
  renderAdminEdit(edit);
}

async function closeMonth(status) {
  const period = getPeriodRange($('periodInput').value);
  const { error } = await supabase.from('monthly_closings').upsert({
    period_key: period.periodKey, start_date: period.startDate,
    end_date: period.endDate, status,
    closed_at: new Date().toISOString(), closed_by: state.session.user.id,
  });
  throwIf(error);
}

function exportCsv() {
  const m = state.monthly;
  const header = ['月度','締日','集計開始日','集計終了日','日付','曜日','日区分','日名','氏名','メール','勤務区分','出勤','退勤','休憩分','勤務分','深夜分','休暇時間','備考'];
  const lines = [header].concat(m.rows.map((r) => [
    m.period.label, `${state.settings.closingDay || 15}日`,
    m.period.startDate, m.period.endDate,
    r.date, r.weekday, r.dayType, r.dayName, r.name, r.email,
    r.kind, r.clockIn, r.clockOut, r.breakMinutes, r.workMinutes,
    r.nightMinutes, r.leaveHours, r.note,
  ]));
  const csv = lines.map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance-${m.period.periodKey}.csv`;
  a.click();
}

// ─── 認証 ─────────────────────────────────────────────────

async function init() {
  if (!CONFIG.url || !CONFIG.publishableKey || CONFIG.url.includes('YOUR-PROJECT-REF')) {
    showMessage('config.js を確認してください。Supabase URL と publishable key を設定してください。', true);
    showPanel('loginPanel');
    return;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;

    if (data.session) {
      state.session = data.session;
      await renderApp();
    } else {
      showPanel('loginPanel');
    }
  } catch (err) {
    showPanel('loginPanel');
    showMessage(normalizeError(err), true);
  }
}

// PASSWORD_RECOVERY のみ onAuthStateChange で処理
supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    state.session = session;
    showPanel('passwordResetPanel');
    showMessage('新しいパスワードを入力してください。');
  }
});

// ─── イベントリスナー ─────────────────────────────────────

$('loginButton').addEventListener('click', () => withBusy('loginButton', 'ログイン中...', '', async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) throw new Error('メールアドレスとパスワードを入力してください。');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  throwIf(error);
  state.session = data.session;
  clearMessage();
  await renderApp();
}));

$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginButton').click(); });

$('forgotPasswordButton').addEventListener('click', () => withBusy('forgotPasswordButton', '送信中...', 'パスワードリセットメールを送信しました。', async () => {
  const email = $('loginEmail').value.trim();
  if (!email) throw new Error('メールアドレスを入力してください。');
  const redirectTo = location.origin + location.pathname;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  throwIf(error);
}));

$('setPasswordButton').addEventListener('click', () => withBusy('setPasswordButton', '変更中...', 'パスワードを変更しました。再度ログインしてください。', async () => {
  const password = $('newPassword').value;
  const confirm = $('confirmPassword').value;
  if (!password || password.length < 6) throw new Error('パスワードは6文字以上で入力してください。');
  if (password !== confirm) throw new Error('パスワードが一致しません。');
  const { error } = await supabase.auth.updateUser({ password });
  throwIf(error);
  state.session = null;
  await supabase.auth.signOut();
  showPanel('loginPanel');
}));

async function logout() {
  await supabase.auth.signOut();
  state.session = null;
  state.profile = null;
  state.users = [];
  state.monthly = null;
  $('account').textContent = '';
  showPanel('loginPanel');
  clearMessage();
}

$('logoutButton').addEventListener('click', () => withBusy('logoutButton', 'ログアウト中...', '', logout));
$('logoutUnauthorizedButton').addEventListener('click', () => withBusy('logoutUnauthorizedButton', 'ログアウト中...', '', logout));

$('clockInButton').addEventListener('click', () => withBusy('clockInButton', '出勤を記録中...', '出勤を記録しました。', async () => {
  await upsertAttendance({ work_date: todayIso(), user_id: state.profile.id, kind: '出勤', clock_in: currentTime(), edit_reason: '出勤打刻' });
  await loadMonthly();
}));

$('clockOutButton').addEventListener('click', () => withBusy('clockOutButton', '退勤を記録中...', '退勤を記録しました。', async () => {
  const { data, error } = await supabase.from('attendance_records').select('*')
    .eq('user_id', state.profile.id).eq('work_date', todayIso()).maybeSingle();
  throwIf(error);
  if (!data?.clock_in) throw new Error('出勤打刻がありません。先に出勤を記録してください。');
  await upsertAttendance({ ...data, clock_out: currentTime(), edit_reason: '退勤打刻' });
  await loadMonthly();
}));

$('saveLeaveButton').addEventListener('click', () => withBusy('saveLeaveButton', '休暇を登録中...', '休暇を登録しました。', async () => {
  const kind = $('leaveKind').value;
  const leaveHours = kind === '時間休' ? Number($('leaveHours').value) : leaveHoursForKind(kind);
  if (kind === '時間休' && (!leaveHours || leaveHours <= 0)) throw new Error('時間休は取得時間を入力してください。');
  await upsertAttendance({ work_date: $('leaveDate').value, user_id: state.profile.id, kind, leave_hours: leaveHours, note: $('leaveNote').value.trim(), edit_reason: '休暇登録' });
  await loadMonthly();
}));

$('reloadMonthlyButton').addEventListener('click', () => withBusy('reloadMonthlyButton', '読み込み中...', '読み込みました。', loadMonthly));
$('scopeInput').addEventListener('change', loadMonthly);

$('monthlyBody').addEventListener('click', async (e) => {
  if (!state.monthly?.isAdmin) return;
  const row = e.target.closest('tr[data-user-id][data-date]');
  if (!row) return;
  $('adminUserId').value = row.dataset.userId;
  $('adminDate').value = row.dataset.date;
  selectTab('admin');
  await withBusy('adminLoadButton', '読み込み中...', '読み込みました。', loadAdminEdit);
});

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) selectTab(tab.dataset.tab);
});

$('adminLoadButton').addEventListener('click', () => withBusy('adminLoadButton', '読み込み中...', '読み込みました。', loadAdminEdit));

$('adminSaveButton').addEventListener('click', () => withBusy('adminSaveButton', '保存中...', '保存しました。', async () => {
  const reason = $('adminReason').value.trim() || 'ADMIN勤怠修正';
  await upsertAttendance({
    work_date: $('adminDate').value, user_id: $('adminUserId').value,
    kind: $('adminKind').value,
    leave_hours: $('adminLeaveHours').value ? Number($('adminLeaveHours').value) : null,
    clock_in: $('adminClockIn').value || null, clock_out: $('adminClockOut').value || null,
    note: $('adminNote').value.trim(), edit_reason: reason,
  });
  await loadMonthly();
  await loadAdminEdit();
}));

$('closeMonthButton').addEventListener('click', () => withBusy('closeMonthButton', '月締め中...', '月締めしました。', async () => {
  await closeMonth('CLOSED'); await loadMonthly();
}));

$('reopenMonthButton').addEventListener('click', () => withBusy('reopenMonthButton', '締め解除中...', '締め解除しました。', async () => {
  await closeMonth('OPEN'); await loadMonthly();
}));

$('saveCalendarButton').addEventListener('click', () => withBusy('saveCalendarButton', '保存中...', '保存しました。', async () => {
  const { error } = await supabase.from('calendar_days').upsert({
    work_date: $('calendarDate').value, day_type: $('calendarType').value,
    name: $('calendarName').value.trim(), note: $('calendarNote').value.trim(),
  }, { onConflict: 'work_date' });
  throwIf(error);
  await loadMonthly();
}));

$('saveUsersButton').addEventListener('click', () => withBusy('saveUsersButton', '保存中...', '保存しました。', async () => {
  const users = $('usersText').value.split(/\r?\n/).map((line) => {
    const [email, name, role, active] = line.split(',').map((p) => (p || '').trim());
    return { email: email.toLowerCase(), name: name || email, role: role === 'admin' ? 'admin' : 'user', active: ['true','TRUE','1','有効'].includes(active) };
  }).filter((u) => u.email);
  const { error } = await supabase.from('app_users').upsert(users, { onConflict: 'email' });
  throwIf(error);
  await loadUsers();
  renderMain();
}));

$('exportCsvButton').addEventListener('click', () => withBusy('exportCsvButton', 'CSV作成中...', 'CSVを作成しました。', exportCsv));

$('sendResetButton').addEventListener('click', () => withBusy('sendResetButton', '送信中...', 'パスワードリセットメールを送信しました。', async () => {
  const email = $('resetEmail').value.trim();
  if (!email) throw new Error('メールアドレスを入力してください。');
  const redirectTo = location.origin + location.pathname;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  throwIf(error);
}));

// ─── 起動 ──────────────────────────────────────────────────
init();
