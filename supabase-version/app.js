import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = window.KINTAI_SUPABASE_CONFIG || {};
const supabase = createClient(CONFIG.url || '', CONFIG.publishableKey || '', {
  auth: {
    lock: (_name, _acquireTimeout, fn) => fn(),
  },
});

const LEAVE_KINDS = ['出勤', '有休', '午前半休', '午後半休', '時間休', '欠勤', '特別休暇', '休日', '代休', '振替休日'];
const DAY_TYPES = ['出勤日', '休日', '祝日', '土曜出勤日', '会社休日'];

const state = {
  session: null,
  profile: null,
  users: [],
  settings: {},
  monthly: null,
  edit: null,
};

const $ = (id) => document.getElementById(id);

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function currentTime() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]);
}

function showMessage(text, isError = false) {
  $('message').innerHTML = text ? `<div class="notice ${isError ? 'error' : ''}">${escapeHtml(text)}</div>` : '';
}

function normalizeError(error) {
  const message = String(error && error.message ? error.message : error).replace(/^Error:\s*/, '');
  if (/Invalid login credentials/i.test(message)) {
    return 'メールアドレスまたはパスワードが正しくありません。';
  }
  if (/Email not confirmed/i.test(message)) {
    return 'メールアドレスが確認されていません。招待メールのリンクをクリックしてから再度ログインしてください。';
  }
  if (/email rate limit exceeded/i.test(message)) {
    return 'Supabaseのメール送信上限に達しました。しばらく待ってから再試行してください。';
  }
  if (/For security purposes, you can only request this after/i.test(message)) {
    return 'リセットメールは短時間に連続送信できません。少し待ってから再送してください。';
  }
  return message;
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
}

function startAction(buttonId, text) {
  const button = $(buttonId);
  if (!button) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.textContent = text;
  button.classList.add('busy');
}

function finishAction(buttonId) {
  const button = $(buttonId);
  if (!button) return;
  if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  button.classList.remove('busy');
}

async function performAction(buttonId, busyText, successText, action) {
  showMessage(busyText);
  setBusy(true);
  startAction(buttonId, busyText);
  try {
    const result = await action();
    showMessage(successText);
    return result;
  } catch (error) {
    showMessage(normalizeError(error), true);
    return null;
  } finally {
    finishAction(buttonId);
    setBusy(false);
  }
}

function assertConfigured() {
  if (!CONFIG.url || !CONFIG.publishableKey || CONFIG.url.includes('YOUR-PROJECT-REF')) {
    throw new Error('config.js に Supabase Project URL と publishable key を設定してください。');
  }
}

function throwIf(error) {
  if (error) throw error;
}

function minutesToHours(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '';
  return `${Math.round((Number(minutes) / 60) * 100) / 100}h`;
}

function timeOnly(value) {
  if (!value) return '';
  return String(value).slice(0, 5);
}

function weekdayLabel(dateString) {
  return ['日', '月', '火', '水', '木', '金', '土'][new Date(`${dateString}T00:00:00+09:00`).getDay()];
}

function getPeriodForDate(dateString) {
  const closingDay = Number(state.settings.closingDay || 15);
  const [yearText, monthText, dayText] = dateString.split('-');
  let year = Number(yearText);
  let month = Number(monthText);
  const day = Number(dayText);

  if (day > closingDay) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return getPeriodRange(`${year}-${pad2(month)}`);
}

function getPeriodRange(periodKey) {
  const closingDay = Number(state.settings.closingDay || 15);
  const [endYearText, endMonthText] = periodKey.split('-');
  const endYear = Number(endYearText);
  const endMonth = Number(endMonthText);
  let startYear = endYear;
  let startMonth = endMonth - 1;
  if (startMonth <= 0) {
    startMonth = 12;
    startYear -= 1;
  }
  return {
    periodKey,
    label: `${endYear}年${endMonth}月度`,
    startDate: `${startYear}-${pad2(startMonth)}-${pad2(closingDay + 1)}`,
    endDate: `${endYear}-${pad2(endMonth)}-${pad2(closingDay)}`,
  };
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00+09:00`);
  const end = new Date(`${endDate}T00:00:00+09:00`);
  while (current <= end) {
    dates.push(current.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function classifyDate(dateString, calendarMap) {
  const override = calendarMap.get(dateString);
  if (override) {
    return {
      type: override.day_type,
      name: override.name || '',
      isWorkday: override.day_type === '出勤日' || override.day_type === '土曜出勤日',
    };
  }

  const day = new Date(`${dateString}T00:00:00+09:00`).getDay();
  const holiday = day === 0 || day === 6;
  return {
    type: holiday ? '休日' : '出勤日',
    name: '',
    isWorkday: !holiday,
  };
}

function leaveHoursForKind(kind) {
  const hoursPerDay = Number(state.settings.hourlyLeaveHoursPerDay || 8);
  if (['有休', '欠勤', '特別休暇', '代休', '振替休日'].includes(kind)) return hoursPerDay;
  if (kind === '午前半休' || kind === '午後半休') return hoursPerDay / 2;
  return null;
}

function rowClass(row) {
  const classes = [];
  if (row.weekday === '土') classes.push('saturday');
  if (row.dayType === '休日') classes.push('holiday');
  if (row.dayType === '祝日') classes.push('national-holiday');
  if (row.dayType === '会社休日') classes.push('company-holiday');
  if (row.missingClockOut) classes.push('missing');
  return classes.join(' ');
}

function fillSelect(select, items, selected) {
  select.innerHTML = items.map((item) => {
    const value = typeof item === 'string' ? item : item.value;
    const label = typeof item === 'string' ? item : item.label;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join('');
  if (selected) select.value = selected;
}

async function loadSettings() {
  const { data, error } = await supabase.from('app_settings').select('key,value');
  throwIf(error);
  state.settings = {};
  (data || []).forEach((row) => {
    state.settings[row.key] = row.value;
  });
  $('appName').textContent = state.settings.companyName || '管理職勤怠管理';
}

async function loadProfile() {
  const email = state.session?.user?.email?.toLowerCase();
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('active', true)
    .eq('email', email)
    .limit(1)
    .maybeSingle();
  throwIf(error);
  state.profile = data;
  return data;
}

async function loadUsers() {
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('active', true)
    .order('role', { ascending: true })
    .order('name', { ascending: true });
  throwIf(error);
  state.users = data || [];
  return state.users;
}

async function init() {
  try {
    assertConfigured();
    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    await safeRenderAuthState();
  } catch (error) {
    showMessage(normalizeError(error), true);
  }
}

async function renderAuthState() {
  const session = state.session;
  $('account').textContent = session?.user?.email || '';
  $('loginPanel').classList.toggle('hidden', Boolean(session));
  $('appPanel').classList.add('hidden');
  $('unauthorizedPanel').classList.add('hidden');

  if (!session) return;

  await loadSettings();
  const profile = await loadProfile();
  if (!profile) {
    $('unauthorizedText').textContent = `${session.user.email} は利用者に登録されていません。ADMINに追加を依頼してください。`;
    $('unauthorizedPanel').classList.remove('hidden');
    return;
  }

  if (profile.role === 'admin') {
    await loadUsers();
  } else {
    state.users = [profile];
  }

  renderMain();
  await loadMonthly();
}

let _renderingAuthState = false;
let _pendingRenderAuthState = false;

async function safeRenderAuthState() {
  if (_renderingAuthState) {
    _pendingRenderAuthState = true;
    return;
  }
  _renderingAuthState = true;
  _pendingRenderAuthState = false;
  try {
    await renderAuthState();
  } catch (error) {
    console.error('renderAuthState failed:', error);
    $('appPanel').classList.add('hidden');
    $('unauthorizedPanel').classList.add('hidden');
    if (!state.session) {
      $('loginPanel').classList.remove('hidden');
    }
    const prefix = state.session ? 'ログインは完了しましたが、初期データの読み込みに失敗しました' : '初期データの読み込みに失敗しました';
    showMessage(`${prefix}: ${normalizeError(error)}`, true);
  } finally {
    _renderingAuthState = false;
    if (_pendingRenderAuthState) {
      _pendingRenderAuthState = false;
      await safeRenderAuthState();
    }
  }
}

function renderMain() {
  const today = todayIso();
  const period = getPeriodForDate(today);
  const isAdmin = state.profile.role === 'admin';
  $('appPanel').classList.remove('hidden');
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

  fillSelect($('leaveKind'), LEAVE_KINDS.filter((kind) => kind !== '出勤'), '時間休');
  fillSelect($('adminKind'), LEAVE_KINDS, '出勤');
  fillSelect($('calendarType'), DAY_TYPES, '土曜出勤日');
  fillSelect($('adminUserId'), state.users.map((user) => ({ value: user.id, label: `${user.name} <${user.email}>` })), state.profile.id);
  $('usersText').value = state.users.map((user) => `${user.email}, ${user.name}, ${user.role}, ${user.active ? 'TRUE' : 'FALSE'}`).join('\n');
  renderAdminEdit(null);
}

async function loadMonthly() {
  const period = getPeriodRange($('periodInput').value);
  const isAdmin = state.profile.role === 'admin';
  const scope = isAdmin ? $('scopeInput').value : 'self';
  const users = isAdmin && scope === 'all' ? state.users : [state.profile];
  const userIds = users.map((user) => user.id);

  const [{ data: records, error: recordError }, { data: calendar, error: calendarError }, { data: closing, error: closingError }] = await Promise.all([
    supabase
      .from('attendance_records')
      .select('*, app_users(id,email,name)')
      .gte('work_date', period.startDate)
      .lte('work_date', period.endDate)
      .in('user_id', userIds),
    supabase
      .from('calendar_days')
      .select('*')
      .gte('work_date', period.startDate)
      .lte('work_date', period.endDate),
    supabase
      .from('monthly_closings')
      .select('*')
      .eq('period_key', period.periodKey)
      .maybeSingle(),
  ]);
  throwIf(recordError);
  throwIf(calendarError);
  throwIf(closingError);

  const recordMap = new Map((records || []).map((record) => [`${record.user_id}|${record.work_date}`, record]));
  const calendarMap = new Map((calendar || []).map((day) => [day.work_date, day]));
  const rows = [];

  users.forEach((user) => {
    enumerateDates(period.startDate, period.endDate).forEach((date) => {
      const day = classifyDate(date, calendarMap);
      const record = recordMap.get(`${user.id}|${date}`) || {};
      rows.push({
        id: record.id || '',
        date,
        weekday: weekdayLabel(date),
        dayType: day.type,
        dayName: day.name,
        userId: user.id,
        email: user.email,
        name: user.name || user.email,
        kind: record.kind || (day.isWorkday ? '' : '休日'),
        clockIn: timeOnly(record.clock_in),
        clockOut: timeOnly(record.clock_out),
        breakMinutes: record.break_minutes ?? '',
        workMinutes: record.work_minutes ?? '',
        nightMinutes: record.night_minutes ?? '',
        leaveHours: record.leave_hours ?? '',
        note: record.note || '',
        missingClockOut: Boolean(record.clock_in && !record.clock_out),
      });
    });
  });

  state.monthly = {
    period,
    closed: closing?.status === 'CLOSED',
    closing,
    rows,
    summaries: summarizeRows(rows),
    isAdmin,
  };
  renderMonthly();
}

function summarizeRows(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.userId)) {
      map.set(row.userId, {
        userId: row.userId,
        name: row.name,
        workDays: 0,
        workMinutes: 0,
        nightMinutes: 0,
        paidLeaveDays: 0,
        leaveHours: 0,
        missingClockOut: 0,
        holidayWorkDays: 0,
      });
    }
    const summary = map.get(row.userId);
    if (row.clockIn) summary.workDays += 1;
    summary.workMinutes += Number(row.workMinutes || 0);
    summary.nightMinutes += Number(row.nightMinutes || 0);
    summary.leaveHours += Number(row.leaveHours || 0);
    if (row.kind === '有休') summary.paidLeaveDays += 1;
    if (row.kind === '午前半休' || row.kind === '午後半休') summary.paidLeaveDays += 0.5;
    if (row.missingClockOut) summary.missingClockOut += 1;
    if (row.clockIn && row.dayType !== '出勤日' && row.dayType !== '土曜出勤日') summary.holidayWorkDays += 1;
  });
  return Array.from(map.values()).map((summary) => ({
    ...summary,
    workHours: Math.round((summary.workMinutes / 60) * 100) / 100,
    nightHours: Math.round((summary.nightMinutes / 60) * 100) / 100,
  }));
}

function renderMonthly() {
  const monthly = state.monthly;
  $('periodLabel').textContent = `${monthly.period.label} ${monthly.period.startDate} - ${monthly.period.endDate}`;
  $('closingBadge').textContent = monthly.closed ? '締め済み' : '未締め';
  $('closingBadge').className = `badge ${monthly.closed ? 'closed' : 'open'}`;

  const today = monthly.rows.find((row) => row.userId === state.profile.id && row.date === todayIso()) || {};
  $('todayClockIn').textContent = today.clockIn || '-';
  $('todayClockOut').textContent = today.clockOut || '-';
  $('todayKind').textContent = today.kind || '-';

  $('summary').innerHTML = monthly.summaries.map((summary) => `
    <div class="metric"><span>${escapeHtml(summary.name)}</span><strong>${summary.workDays}日 / ${summary.workHours}h</strong></div>
    <div class="metric"><span>有休</span><strong>${summary.paidLeaveDays}日</strong></div>
    <div class="metric"><span>休暇時間</span><strong>${summary.leaveHours || 0}h</strong></div>
    <div class="metric"><span>深夜</span><strong>${summary.nightHours || 0}h</strong></div>
    <div class="metric"><span>退勤漏れ</span><strong>${summary.missingClockOut}</strong></div>
  `).join('');

  $('monthlyBody').innerHTML = monthly.rows.map((row) => `
    <tr class="${rowClass(row)} ${monthly.isAdmin ? 'editable-row' : ''}" data-user-id="${escapeHtml(row.userId)}" data-date="${escapeHtml(row.date)}">
      <td>${escapeHtml(row.date)}</td>
      <td>${escapeHtml(row.weekday)}</td>
      <td>${escapeHtml(row.dayType)} ${row.dayName ? `<span class="badge">${escapeHtml(row.dayName)}</span>` : ''}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.kind)}</td>
      <td>${escapeHtml(row.clockIn)}</td>
      <td>${escapeHtml(row.clockOut)}</td>
      <td>${escapeHtml(row.breakMinutes)}</td>
      <td>${escapeHtml(minutesToHours(row.workMinutes))}</td>
      <td>${escapeHtml(minutesToHours(row.nightMinutes))}</td>
      <td>${escapeHtml(row.leaveHours)}</td>
      <td>${escapeHtml(row.note)}</td>
    </tr>
  `).join('');
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  ['leave', 'admin', 'calendar', 'users'].forEach((tab) => {
    $(`${tab}Tab`).classList.toggle('hidden', tab !== name);
  });
}

function renderAdminEdit(edit) {
  const status = $('adminEditStatus');
  if (!status) return;
  if (!edit) {
    status.innerHTML = '<div class="metric"><span>修正対象</span><strong>未読込</strong></div>';
    return;
  }
  status.innerHTML = `
    <div class="metric"><span>対象</span><strong>${escapeHtml(edit.name)}</strong></div>
    <div class="metric"><span>日付</span><strong>${escapeHtml(edit.work_date)}</strong></div>
    <div class="metric"><span>状態</span><strong>${edit.id ? '記録あり' : '新規修正'}</strong></div>
    <div class="metric"><span>締め</span><strong>${state.monthly?.closed ? '締め済み' : '未締め'}</strong></div>
  `;
}

async function loadAdminEdit() {
  const userId = $('adminUserId').value;
  const date = $('adminDate').value;
  const user = state.users.find((item) => item.id === userId);
  const { data, error } = await supabase
    .from('attendance_records')
    .select('*')
    .eq('user_id', userId)
    .eq('work_date', date)
    .maybeSingle();
  throwIf(error);
  const record = data || {
    id: '',
    work_date: date,
    user_id: userId,
    kind: '出勤',
    clock_in: '',
    clock_out: '',
    leave_hours: '',
    note: '',
  };
  state.edit = { ...record, name: user?.name || user?.email || '' };
  $('adminKind').value = record.kind || '出勤';
  $('adminClockIn').value = timeOnly(record.clock_in);
  $('adminClockOut').value = timeOnly(record.clock_out);
  $('adminLeaveHours').value = record.leave_hours ?? '';
  $('adminNote').value = record.note || '';
  renderAdminEdit(state.edit);
}

async function upsertAttendance(payload) {
  const { error } = await supabase
    .from('attendance_records')
    .upsert(payload, { onConflict: 'work_date,user_id' });
  throwIf(error);
}

async function signIn() {
  assertConfigured();
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) throw new Error('メールアドレスとパスワードを入力してください。');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  throwIf(error);
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  throwIf(error);
  state.session = null;
  state.profile = null;
  state.users = [];
  state.monthly = null;
  await renderAuthState();
}

async function setNewPassword() {
  const password = $('newPassword').value;
  const confirm = $('confirmPassword').value;
  if (!password || password.length < 6) throw new Error('パスワードは6文字以上で入力してください。');
  if (password !== confirm) throw new Error('パスワードが一致しません。');
  const { error } = await supabase.auth.updateUser({ password });
  throwIf(error);
  $('passwordResetPanel').classList.add('hidden');
  showMessage('パスワードを変更しました。ログインしてください。');
  await supabase.auth.signOut();
  state.session = null;
  await renderAuthState();
}

async function sendPasswordReset(email) {
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  throwIf(error);
}

async function clockIn() {
  await upsertAttendance({
    work_date: todayIso(),
    user_id: state.profile.id,
    kind: '出勤',
    clock_in: currentTime(),
    edit_reason: '出勤打刻',
  });
}

async function clockOut() {
  const date = todayIso();
  const { data, error } = await supabase
    .from('attendance_records')
    .select('*')
    .eq('user_id', state.profile.id)
    .eq('work_date', date)
    .maybeSingle();
  throwIf(error);
  if (!data?.clock_in) throw new Error('出勤打刻がありません。先に出勤を記録してください。');
  await upsertAttendance({
    ...data,
    clock_out: currentTime(),
    edit_reason: '退勤打刻',
  });
}

async function saveLeave() {
  const kind = $('leaveKind').value;
  const leaveHours = kind === '時間休' ? Number($('leaveHours').value) : leaveHoursForKind(kind);
  if (kind === '時間休' && (!leaveHours || leaveHours <= 0)) {
    throw new Error('時間休は取得時間を入力してください。');
  }
  await upsertAttendance({
    work_date: $('leaveDate').value,
    user_id: state.profile.id,
    kind,
    leave_hours: leaveHours,
    note: $('leaveNote').value.trim(),
    edit_reason: '休暇登録',
  });
}

async function saveAdminAttendance() {
  const userId = $('adminUserId').value;
  const date = $('adminDate').value;
  const reason = $('adminReason').value.trim() || 'ADMIN勤怠修正';
  await upsertAttendance({
    work_date: date,
    user_id: userId,
    kind: $('adminKind').value,
    leave_hours: $('adminLeaveHours').value ? Number($('adminLeaveHours').value) : null,
    clock_in: $('adminClockIn').value || null,
    clock_out: $('adminClockOut').value || null,
    note: $('adminNote').value.trim(),
    edit_reason: reason,
  });
}

async function saveCalendarDay() {
  const { error } = await supabase
    .from('calendar_days')
    .upsert({
      work_date: $('calendarDate').value,
      day_type: $('calendarType').value,
      name: $('calendarName').value.trim(),
      note: $('calendarNote').value.trim(),
    }, { onConflict: 'work_date' });
  throwIf(error);
}

function parseUsersText() {
  return $('usersText').value.split(/\r?\n/).map((line) => {
    const [email, name, role, active] = line.split(',').map((part) => (part || '').trim());
    return {
      email: email.toLowerCase(),
      name: name || email,
      role: role === 'admin' ? 'admin' : 'user',
      active: ['true', 'TRUE', '1', '有効'].includes(active),
    };
  }).filter((user) => user.email);
}

async function saveUsers() {
  const users = parseUsersText();
  const { error } = await supabase
    .from('app_users')
    .upsert(users, { onConflict: 'email' });
  throwIf(error);
  await loadUsers();
  renderMain();
}

async function closeMonth(status) {
  const period = getPeriodRange($('periodInput').value);
  const { error } = await supabase
    .from('monthly_closings')
    .upsert({
      period_key: period.periodKey,
      start_date: period.startDate,
      end_date: period.endDate,
      status,
      closed_at: new Date().toISOString(),
      closed_by: state.session.user.id,
    });
  throwIf(error);
}

function exportCsv() {
  const monthly = state.monthly;
  const header = ['月度', '締日', '集計開始日', '集計終了日', '日付', '曜日', '日区分', '日名', '氏名', 'メール', '勤務区分', '出勤', '退勤', '休憩分', '勤務分', '深夜分', '休暇時間', '備考'];
  const lines = [header].concat(monthly.rows.map((row) => [
    monthly.period.label,
    `${state.settings.closingDay || 15}日`,
    monthly.period.startDate,
    monthly.period.endDate,
    row.date,
    row.weekday,
    row.dayType,
    row.dayName,
    row.name,
    row.email,
    row.kind,
    row.clockIn,
    row.clockOut,
    row.breakMinutes,
    row.workMinutes,
    row.nightMinutes,
    row.leaveHours,
    row.note,
  ]));
  const csv = lines.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `attendance-${monthly.period.periodKey}_${monthly.period.startDate}_${monthly.period.endDate}_15day.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// --- Event Listeners ---

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  if (tab) selectTab(tab.dataset.tab);
});

$('loginButton').addEventListener('click', async () => {
  await performAction('loginButton', 'ログイン中...', 'ログインしました。', signIn);
});

$('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginButton').click();
});

$('forgotPasswordButton').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  if (!email) {
    showMessage('メールアドレスを入力してからパスワードリセットをクリックしてください。', true);
    return;
  }
  await performAction('forgotPasswordButton', '送信中...', 'パスワードリセットメールを送信しました。受信トレイをご確認ください。', () => sendPasswordReset(email));
});

$('setPasswordButton').addEventListener('click', () => performAction('setPasswordButton', '変更中...', 'パスワードを変更しました。', setNewPassword));

$('logoutButton').addEventListener('click', () => performAction('logoutButton', 'ログアウト中...', 'ログアウトしました。', signOut));
$('logoutUnauthorizedButton').addEventListener('click', () => performAction('logoutUnauthorizedButton', 'ログアウト中...', 'ログアウトしました。', signOut));

$('clockInButton').addEventListener('click', async () => {
  await performAction('clockInButton', '出勤を記録中...', '出勤を記録しました。', async () => {
    await clockIn();
    await loadMonthly();
  });
});

$('clockOutButton').addEventListener('click', async () => {
  await performAction('clockOutButton', '退勤を記録中...', '退勤を記録しました。', async () => {
    await clockOut();
    await loadMonthly();
  });
});

$('saveLeaveButton').addEventListener('click', async () => {
  await performAction('saveLeaveButton', '休暇を登録中...', '休暇を登録しました。', async () => {
    await saveLeave();
    await loadMonthly();
  });
});

$('reloadMonthlyButton').addEventListener('click', () => performAction('reloadMonthlyButton', '読み込み中...', '読み込みました。', loadMonthly));
$('scopeInput').addEventListener('change', loadMonthly);

$('monthlyBody').addEventListener('click', async (event) => {
  if (!state.monthly?.isAdmin) return;
  const row = event.target.closest('tr[data-user-id][data-date]');
  if (!row) return;
  $('adminUserId').value = row.dataset.userId;
  $('adminDate').value = row.dataset.date;
  selectTab('admin');
  await performAction('adminLoadButton', '修正対象を読み込み中...', '修正対象を読み込みました。', loadAdminEdit);
});

$('adminLoadButton').addEventListener('click', () => performAction('adminLoadButton', '修正対象を読み込み中...', '修正対象を読み込みました。', loadAdminEdit));
$('adminSaveButton').addEventListener('click', async () => {
  await performAction('adminSaveButton', '保存中...', '保存しました。', async () => {
    await saveAdminAttendance();
    await loadMonthly();
    await loadAdminEdit();
  });
});

$('closeMonthButton').addEventListener('click', async () => {
  await performAction('closeMonthButton', '月締め中...', '月締めしました。', async () => {
    await closeMonth('CLOSED');
    await loadMonthly();
  });
});

$('reopenMonthButton').addEventListener('click', async () => {
  await performAction('reopenMonthButton', '締め解除中...', '締め解除しました。', async () => {
    await closeMonth('OPEN');
    await loadMonthly();
  });
});

$('saveCalendarButton').addEventListener('click', async () => {
  await performAction('saveCalendarButton', '保存中...', '保存しました。', async () => {
    await saveCalendarDay();
    await loadMonthly();
  });
});

$('saveUsersButton').addEventListener('click', () => performAction('saveUsersButton', '保存中...', '保存しました。', saveUsers));
$('exportCsvButton').addEventListener('click', () => performAction('exportCsvButton', 'CSVを作成中...', 'CSVを作成しました。', exportCsv));

$('sendResetButton').addEventListener('click', () => {
  const email = $('resetEmail').value.trim();
  if (!email) {
    showMessage('メールアドレスを入力してください。', true);
    return;
  }
  performAction('sendResetButton', '送信中...', `${email} にパスワードリセットメールを送信しました。`, () => sendPasswordReset(email));
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  showMessage(`処理中にエラーが発生しました: ${normalizeError(event.reason)}`, true);
});

window.addEventListener('error', (event) => {
  console.error('Unhandled error:', event.error || event.message);
  showMessage(`処理中にエラーが発生しました: ${normalizeError(event.error || event.message)}`, true);
});

supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    state.session = session;
    $('loginPanel').classList.add('hidden');
    $('appPanel').classList.add('hidden');
    $('unauthorizedPanel').classList.add('hidden');
    $('passwordResetPanel').classList.remove('hidden');
    showMessage('新しいパスワードを入力してください。');
    return;
  }
  state.session = session;
  await safeRenderAuthState();
});

init();
