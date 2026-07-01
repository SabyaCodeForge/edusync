/* ==========================================================================
   Tuition Manager — Application Logic
   Storage: Local Storage only. No backend, no external APIs.
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* CONSTANTS & STATE                                                       */
/* ---------------------------------------------------------------------- */
const LS_KEYS = {
  STUDENTS: 'tm_students',
  SETTINGS: 'tm_settings',
  SEEDED: 'tm_seeded', // marks that first-run initialization has already happened
  BATCHES: 'tm_batches',
  SNAPSHOTS: 'tm_snapshots',     // rotating array of auto-backup snapshots
  LAST_SNAPSHOT_AT: 'tm_last_snapshot_at',
};

const APP_VERSION = '2.0.0';
const SNAPSHOT_INTERVAL_DAYS = 7;
const SNAPSHOT_MAX_KEEP = 6; // keep the last 6 weekly snapshots (~6 weeks of history)

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

let state = {
  students: [],
  batches: [],
  settings: { teacherName: 'Suman Mondal', tuitionName: 'TutorDesk', darkMode: false },
  feesMonthCursor: new Date(), // month being viewed on Fees page
  studentsFilter: 'all',
  feesFilter: 'all',
  feesBatchFilter: 'all',
  scheduleDayFilter: 'all',
  studentsSearch: '',
  editingStudentId: null,
  editingBatchId: null,
  confirmCallback: null,
};

/* ---------------------------------------------------------------------- */
/* UTILITIES                                                               */
/* ---------------------------------------------------------------------- */
function uid(){ return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function monthKey(date){ return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; }

function formatMoney(n){
  n = Number(n) || 0;
  return '₹' + n.toLocaleString('en-IN');
}

function formatDate(d){
  if(!d) return '—';
  const dt = new Date(d);
  if(isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}

function initials(name){
  if(!name) return '?';
  return name.trim().split(/\s+/).slice(0,2).map(w=>w[0].toUpperCase()).join('');
}

/* Performance: debounce wrapper so expensive table re-renders (e.g. on every
   keystroke while searching) don't fire faster than the browser can paint. */
function debounce(fn, wait){
  let timer = null;
  return function(...args){
    clearTimeout(timer);
    timer = setTimeout(()=> fn.apply(this, args), wait);
  };
}

/* Feature: Color-coded avatar initials — deterministic color per student name */
const AVATAR_PALETTE = [
  ['#4D6BF5', '#6B4FF5'], // royal -> indigo
  ['#15B07A', '#0E8C5F'], // green
  ['#F0A030', '#D9821B'], // amber
  ['#E8503F', '#C73A2C'], // red
  ['#00B8D9', '#0095AE'], // cyan
  ['#D946EF', '#A435C2'], // magenta
  ['#FF7A45', '#E0562A'], // orange
  ['#2DD4BF', '#159E8E'], // teal
  ['#8B5CF6', '#6D3FD6'], // violet
  ['#F43F5E', '#D02747'], // rose
];
function avatarGradient(name){
  const str = (name || '?').trim();
  let hash = 0;
  for(let i=0; i<str.length; i++){
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  const [c1, c2] = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}

/* Feature: Batches — solid accent colors used for batch chips/cards/badges */
const BATCH_COLORS = ['#4D6BF5','#15B07A','#F0A030','#E8503F','#00B8D9','#D946EF','#FF7A45','#8B5CF6'];
function batchColor(batch){
  if(batch && batch.color) return batch.color;
  const str = (batch && batch.name) || '?';
  let hash = 0;
  for(let i=0; i<str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return BATCH_COLORS[hash % BATCH_COLORS.length];
}

function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function showToast(message, type='info'){
  const icons = { success:'check_circle', error:'error', info:'info' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="material-icons-round">${icons[type]||'info'}</span><span>${escapeHtml(message)}</span>`;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(()=> toast.remove(), 2900);
}

/* Ripple effect for all .ripple buttons — optimized to avoid layout thrash on tap */
document.addEventListener('click', function(e){
  const btn = e.target.closest('.ripple');
  if(!btn) return;

  // Avoid stacking up ripples if the user taps rapidly — keep at most one in flight per button.
  const existing = btn.querySelector('.ripple-circle');
  if(existing) existing.remove();

  const rect = btn.getBoundingClientRect(); // one unavoidable read
  const size = Math.max(rect.width, rect.height);
  const x = (e.clientX - rect.left - size/2) + 'px';
  const y = (e.clientY - rect.top - size/2) + 'px';

  requestAnimationFrame(()=>{
    const circle = document.createElement('span');
    circle.className = 'ripple-circle';
    circle.style.width = circle.style.height = size + 'px';
    circle.style.left = x;
    circle.style.top = y;
    btn.appendChild(circle);
    circle.addEventListener('animationend', ()=> circle.remove(), { once: true });
    setTimeout(()=>{ if(circle.isConnected) circle.remove(); }, 650); // fallback safety
  });
}, { passive: true });

/* ---------------------------------------------------------------------- */
/* PERSISTENCE                                                             */
/* ---------------------------------------------------------------------- */
function loadData(){
  try{
    const s = localStorage.getItem(LS_KEYS.STUDENTS);
    state.students = s ? JSON.parse(s) : [];
  }catch(e){ state.students = []; }

  try{
    const b = localStorage.getItem(LS_KEYS.BATCHES);
    state.batches = b ? JSON.parse(b) : [];
  }catch(e){ state.batches = []; }

  try{
    const set = localStorage.getItem(LS_KEYS.SETTINGS);
    if(set) state.settings = Object.assign(state.settings, JSON.parse(set));
  }catch(e){ /* keep defaults */ }

  // Seed demo data only on the very first run ever (tracked by a dedicated flag,
  // so resetting or deleting all students later never brings the demo data back).
  if(!localStorage.getItem(LS_KEYS.SEEDED)){
    if(state.students.length === 0){
      seedDemoData();
    }
    localStorage.setItem(LS_KEYS.SEEDED, '1');
  }

  // Feature: weekly auto-backup snapshot — runs silently on every app load,
  // but only actually writes a new snapshot if 7+ days have passed.
  maybeCreateAutoSnapshot();
}

function saveStudents(){
  localStorage.setItem(LS_KEYS.STUDENTS, JSON.stringify(state.students));
}
function saveBatches(){
  localStorage.setItem(LS_KEYS.BATCHES, JSON.stringify(state.batches));
}
function saveSettings(){
  localStorage.setItem(LS_KEYS.SETTINGS, JSON.stringify(state.settings));
}

/* ---------------------------------------------------------------------- */
/* AUTO LOCAL BACKUP SNAPSHOTS (every 7 days, fully local, no server)      */
/* ---------------------------------------------------------------------- */
function loadSnapshots(){
  try{
    const raw = localStorage.getItem(LS_KEYS.SNAPSHOTS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}
function saveSnapshots(list){
  try{
    localStorage.setItem(LS_KEYS.SNAPSHOTS, JSON.stringify(list));
  }catch(e){
    // Storage quota exceeded — drop the oldest snapshot and retry once.
    if(list.length > 1){
      list.shift();
      try{ localStorage.setItem(LS_KEYS.SNAPSHOTS, JSON.stringify(list)); }catch(e2){ /* give up silently */ }
    }
  }
}

function createSnapshot(reason){
  // Don't bother snapshotting an empty app (nothing to protect yet).
  if(state.students.length === 0 && state.batches.length === 0) return null;

  const snapshot = {
    id: uid(),
    createdAt: new Date().toISOString(),
    reason: reason || 'auto', // 'auto' (weekly) or 'manual'
    students: state.students,
    batches: state.batches,
    settings: state.settings,
  };

  let list = loadSnapshots();
  list.push(snapshot);
  // Keep only the most recent N snapshots so storage never grows unbounded.
  if(list.length > SNAPSHOT_MAX_KEEP){
    list = list.slice(list.length - SNAPSHOT_MAX_KEEP);
  }
  saveSnapshots(list);
  localStorage.setItem(LS_KEYS.LAST_SNAPSHOT_AT, snapshot.createdAt);
  return snapshot;
}

function maybeCreateAutoSnapshot(){
  const lastAt = localStorage.getItem(LS_KEYS.LAST_SNAPSHOT_AT);
  const now = Date.now();
  if(!lastAt){
    // No snapshot ever taken — start the clock now rather than snapshotting
    // an essentially-empty first run immediately.
    localStorage.setItem(LS_KEYS.LAST_SNAPSHOT_AT, new Date().toISOString());
    return;
  }
  const elapsedDays = (now - new Date(lastAt).getTime()) / (1000*60*60*24);
  if(elapsedDays >= SNAPSHOT_INTERVAL_DAYS){
    createSnapshot('auto');
  }
}

function restoreSnapshot(snapshotId){
  const list = loadSnapshots();
  const snap = list.find(s => s.id === snapshotId);
  if(!snap) return;
  openConfirm({
    title: 'Restore this snapshot?',
    message: `This will replace all current students, batches and settings with the backup from ${formatDateTime(snap.createdAt)}. Your current data will be saved as a new snapshot first, just in case.`,
    onConfirm: ()=>{
      // Safety net: snapshot the current state before overwriting it.
      createSnapshot('manual');
      state.students = snap.students || [];
      state.batches = snap.batches || [];
      if(snap.settings) state.settings = Object.assign(state.settings, snap.settings);
      saveStudents(); saveBatches(); saveSettings(); applyTheme();
      refreshSettingsForm();
      renderDashboard(); renderStudentsTable(); renderFeesTable(); renderScheduleList(); renderBatchesPage();
      renderSnapshotsList();
      showToast('Snapshot restored successfully', 'success');
    }
  });
}

function deleteSnapshot(snapshotId){
  openConfirm({
    title: 'Delete this snapshot?',
    message: 'This backup snapshot will be permanently removed from this device.',
    onConfirm: ()=>{
      const list = loadSnapshots().filter(s => s.id !== snapshotId);
      saveSnapshots(list);
      renderSnapshotsList();
      showToast('Snapshot deleted', 'success');
    }
  });
}

function formatDateTime(iso){
  if(!iso) return '—';
  const dt = new Date(iso);
  if(isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) +
    ' · ' + dt.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
}

function renderSnapshotsList(){
  const container = document.getElementById('snapshots-list-container');
  if(!container) return;
  const list = [...loadSnapshots()].sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));

  if(list.length === 0){
    container.innerHTML = `<p class="empty-hint">No automatic snapshots yet. The app saves one every ${SNAPSHOT_INTERVAL_DAYS} days on its own — check back soon.</p>`;
    return;
  }

  container.innerHTML = list.map(snap => `
    <div class="snapshot-row">
      <div class="snapshot-row-icon"><span class="material-icons-round">${snap.reason==='manual' ? 'bookmark' : 'history'}</span></div>
      <div class="snapshot-row-main">
        <div class="snapshot-row-title">${formatDateTime(snap.createdAt)}</div>
        <div class="snapshot-row-sub">${snap.reason === 'manual' ? 'Pre-restore safety backup' : 'Automatic weekly backup'} · ${(snap.students||[]).length} students, ${(snap.batches||[]).length} batches</div>
      </div>
      <div class="row-actions">
        <button title="Restore" onclick="restoreSnapshot('${snap.id}')"><span class="material-icons-round">restore</span></button>
        <button title="Delete" class="danger" onclick="deleteSnapshot('${snap.id}')"><span class="material-icons-round">delete</span></button>
      </div>
    </div>
  `).join('');
}

function seedDemoData(){
  const demo = [
    {
      name: 'Sabyasachi', class: 'Class 10', school: 'Greenfield High School',
      dob: '2010-04-12', studentPhone: '', guardianName: 'Mr. Mondal', guardianPhone: '9800000001',
      address: 'Kolkata, West Bengal', monthlyFee: 1500, admissionDate: '2024-01-10', status: 'active',
      notes: '', schedule: [
        { day: 'Monday', time: '17:00', subject: 'Mathematics', location: 'Home Tuition', remarks: '' },
        { day: 'Wednesday', time: '17:00', subject: 'Science', location: 'Home Tuition', remarks: '' },
        { day: 'Friday', time: '17:00', subject: 'Mathematics', location: 'Home Tuition', remarks: '' },
      ],
      payments: {}
    },
    {
      name: 'Anagh', class: 'Class 8', school: 'Sunrise Public School',
      dob: '2012-08-20', studentPhone: '', guardianName: 'Mrs. Sarkar', guardianPhone: '9800000002',
      address: 'Howrah, West Bengal', monthlyFee: 1200, admissionDate: '2024-03-05', status: 'active',
      notes: '', schedule: [
        { day: 'Tuesday', time: '18:00', subject: 'English', location: 'Home Tuition', remarks: '' },
        { day: 'Thursday', time: '18:00', subject: 'Science', location: 'Home Tuition', remarks: '' },
      ],
      payments: {}
    },
    {
      name: 'Soumya', class: 'Class 9', school: 'Lakeview School',
      dob: '2011-11-02', studentPhone: '9876500003', guardianName: 'Mr. Das', guardianPhone: '9800000003',
      address: 'Salt Lake, Kolkata', monthlyFee: 1300, admissionDate: '2023-12-01', status: 'active',
      notes: 'Needs extra focus on Algebra.', schedule: [
        { day: 'Monday', time: '19:00', subject: 'Mathematics', location: 'Home Tuition', remarks: '' },
        { day: 'Saturday', time: '11:00', subject: 'Physics', location: 'Home Tuition', remarks: '' },
      ],
      payments: {}
    },
  ];
  demo.forEach(d => {
    d.id = uid();
    d.createdAt = new Date().toISOString();
    d.batchIds = [];
    state.students.push(d);
  });
  saveStudents();

  // Feature: Batches — seed one example batch so first-time users see how it works.
  const classNineBatch = {
    id: uid(),
    name: 'Class 9 — Evening Batch',
    subject: 'Mathematics & Science',
    day: 'Saturday',
    time: '16:00',
    location: 'Home Tuition',
    fee: 1300,
    color: batchColor({ name: 'Class 9 — Evening Batch' }),
    notes: 'Group batch for Class 9 students, weekend session.',
    createdAt: new Date().toISOString(),
  };
  state.batches.push(classNineBatch);
  const soumya = state.students.find(s => s.name === 'Soumya');
  if(soumya) soumya.batchIds = [classNineBatch.id];
  saveBatches();
  saveStudents();
}

/* ---------------------------------------------------------------------- */
/* THEME                                                                   */
/* ---------------------------------------------------------------------- */
function applyTheme(){
  document.documentElement.setAttribute('data-theme', state.settings.darkMode ? 'dark' : 'light');
  document.getElementById('dark-mode-toggle').checked = state.settings.darkMode;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if(metaTheme) metaTheme.setAttribute('content', state.settings.darkMode ? '#1B1E2B' : '#3F51E8');

  // Fix: keep the mobile top-bar theme icon in sync with current mode
  const mobileIcon = document.querySelector('#theme-toggle-mobile .material-icons-round');
  if(mobileIcon) mobileIcon.textContent = state.settings.darkMode ? 'light_mode' : 'dark_mode';
}

/* ---------------------------------------------------------------------- */
/* NAVIGATION                                                              */
/* ---------------------------------------------------------------------- */
const PAGE_TITLES = {
  dashboard: 'Dashboard', students: 'Students', batches: 'Batches', fees: 'Fees',
  schedule: 'Schedule', backup: 'Backup', settings: 'Settings'
};

function navigateTo(page){
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  document.querySelectorAll('.nav-item, .bnav-item').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  document.getElementById('mobile-page-title').textContent = PAGE_TITLES[page] || '';
  closeDrawer();

  // Fix: clear the dashboard quick-search box once we leave Students/Dashboard flow,
  // so stale search text doesn't linger when the user comes back to Dashboard later.
  if(page !== 'students' && page !== 'dashboard'){
    state.studentsSearch = '';
    document.getElementById('quick-search-input').value = '';
    document.getElementById('students-search-input').value = '';
  }

  // Re-render the relevant page content
  if(page === 'dashboard') renderDashboard();
  if(page === 'students') renderStudentsTable();
  if(page === 'batches') renderBatchesPage();
  if(page === 'fees') renderFeesTable();
  if(page === 'schedule') renderScheduleList();
  if(page === 'backup') renderSnapshotsList();
  if(page === 'settings' && !updateBtn.classList.contains('is-available')) checkForAppUpdate(false);

  window.scrollTo({ top:0, behavior:'smooth' });
}

document.querySelectorAll('.nav-item, .bnav-item').forEach(btn=>{
  btn.addEventListener('click', ()=> navigateTo(btn.dataset.page));
});

/* Mobile drawer open/close + bottom nav hide/show */
function openDrawer(){
  document.getElementById('mobile-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('show');
  document.getElementById('bottom-nav').classList.add('hide-nav');
}
function closeDrawer(){
  document.getElementById('mobile-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('show');
  document.getElementById('bottom-nav').classList.remove('hide-nav');
}
document.getElementById('mobile-menu-btn').addEventListener('click', openDrawer);
document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);

document.getElementById('theme-toggle-mobile').addEventListener('click', ()=>{
  state.settings.darkMode = !state.settings.darkMode;
  saveSettings(); applyTheme();
});

/* ---------------------------------------------------------------------- */
/* DASHBOARD RENDERING                                                     */
/* ---------------------------------------------------------------------- */
function getThisMonthKey(){ return monthKey(new Date()); }

function renderDashboard(){
  const mk = getThisMonthKey();
  const total = state.students.length;
  const active = state.students.filter(s=>s.status==='active').length;

  let paidAmount = 0, pendingAmount = 0;
  state.students.forEach(s=>{
    if(s.status !== 'active') return;
    const rec = s.payments && s.payments[mk];
    if(rec && rec.status === 'paid'){ paidAmount += Number(s.monthlyFee)||0; }
    else { pendingAmount += Number(s.monthlyFee)||0; }
  });

  document.getElementById('stat-total-students').textContent = total;
  document.getElementById('stat-active-students').textContent = active;
  document.getElementById('stat-fees-paid').textContent = formatMoney(paidAmount);
  document.getElementById('stat-fees-pending').textContent = formatMoney(pendingAmount);

  const totalExpected = paidAmount + pendingAmount;
  const pct = totalExpected > 0 ? Math.round((paidAmount/totalExpected)*100) : 0;
  const circumference = 2 * Math.PI * 61; // r=61
  const offset = circumference - (circumference * pct/100);
  document.getElementById('progress-ring-fill').style.strokeDashoffset = offset;
  document.getElementById('progress-ring-percent').textContent = pct + '%';
  document.getElementById('progress-caption').textContent = `${formatMoney(paidAmount)} of ${formatMoney(totalExpected)} collected this month`;

  const now = new Date();
  document.getElementById('dashboard-date-line').textContent =
    `Today is ${now.toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}`;

  renderTodaySchedule();
  renderRecentStudents();
}

function renderTodaySchedule(){
  const container = document.getElementById('today-schedule-list');
  const todayName = DAYS[new Date().getDay()];
  let items = [];
  state.students.forEach(s=>{
    if(s.status !== 'active' || !Array.isArray(s.schedule)) return;
    s.schedule.forEach(sch=>{
      if(sch.day === todayName){
        items.push({ student: s, ...sch });
      }
    });
  });
  items.sort((a,b)=> (a.time||'').localeCompare(b.time||''));

  if(items.length === 0){
    container.innerHTML = `<p class="empty-hint">No classes scheduled for today. Enjoy your day! 🎉</p>`;
    return;
  }
  container.innerHTML = items.map(it => `
    <div class="schedule-item">
      <div class="schedule-item-time">${escapeHtml(it.time || '--:--')}</div>
      <div class="schedule-item-main">
        <div class="schedule-item-name">${escapeHtml(it.student.name)} · ${escapeHtml(it.student.class||'')}</div>
        <div class="schedule-item-sub">${escapeHtml(it.subject||'Subject')} ${it.location ? '· '+escapeHtml(it.location) : ''}</div>
      </div>
    </div>
  `).join('');
}

function renderRecentStudents(){
  const container = document.getElementById('recent-students-list');
  const sorted = [...state.students].sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt)).slice(0,5);
  if(sorted.length === 0){
    container.innerHTML = `<p class="empty-hint">No students added yet.</p>`;
    return;
  }
  container.innerHTML = sorted.map(s => `
    <div class="recent-student-item">
      <div class="avatar-circle" style="--avatar-color:${avatarGradient(s.name)};">${escapeHtml(initials(s.name))}</div>
      <div class="schedule-item-main">
        <div class="schedule-item-name">${escapeHtml(s.name)}</div>
        <div class="schedule-item-sub">${escapeHtml(s.class||'')} · ${formatMoney(s.monthlyFee)}/mo</div>
      </div>
      <span class="status-badge ${s.status}">${s.status === 'active' ? 'Active' : 'Inactive'}</span>
    </div>
  `).join('');
}

/* ---------------------------------------------------------------------- */
/* STUDENTS PAGE                                                           */
/* ---------------------------------------------------------------------- */
function getFilteredStudents(){
  const mk = getThisMonthKey();
  let list = [...state.students];
  const q = state.studentsSearch.trim().toLowerCase();
  if(q){
    list = list.filter(s =>
      (s.name||'').toLowerCase().includes(q) ||
      (s.class||'').toLowerCase().includes(q) ||
      (s.studentPhone||'').toLowerCase().includes(q) ||
      (s.guardianPhone||'').toLowerCase().includes(q)
    );
  }
  switch(state.studentsFilter){
    case 'active': list = list.filter(s=>s.status==='active'); break;
    case 'inactive': list = list.filter(s=>s.status==='inactive'); break;
    case 'paid': list = list.filter(s=> s.status==='active' && s.payments && s.payments[mk] && s.payments[mk].status==='paid'); break;
    case 'pending': list = list.filter(s=> s.status==='active' && !(s.payments && s.payments[mk] && s.payments[mk].status==='paid')); break;
  }
  return list.sort((a,b)=> a.name.localeCompare(b.name));
}

function renderStudentsTable(){
  const tbody = document.getElementById('students-table-body');
  const list = getFilteredStudents();
  const mk = getThisMonthKey();
  document.getElementById('students-empty-hint').style.display = list.length ? 'none' : 'block';

  tbody.innerHTML = list.map(s=>{
    const paid = s.payments && s.payments[mk] && s.payments[mk].status === 'paid';
    const sStudentBatches = state.batches.filter(b => Array.isArray(s.batchIds) && s.batchIds.includes(b.id));
    const batchCellHtml = sStudentBatches.length
      ? sStudentBatches.map(b=>`<span class="batch-badge compact" style="--batch-color:${batchColor(b)};">${escapeHtml(b.name)}</span>`).join('')
      : '—';
    return `
    <tr>
      <td><strong>${escapeHtml(s.name)}</strong></td>
      <td>${escapeHtml(s.class||'—')}</td>
      <td>${escapeHtml(s.school||'—')}</td>
      <td>${batchCellHtml}</td>
      <td>${escapeHtml(s.guardianPhone||'—')}</td>
      <td>${formatMoney(s.monthlyFee)}</td>
      <td><span class="status-badge ${s.status}">${s.status==='active'?'Active':'Inactive'}</span></td>
      <td><span class="status-badge ${paid?'paid':'pending'}">${paid?'Paid':'Pending'}</span></td>
      <td>
        <div class="row-actions">
          <button title="View" onclick="openViewModal('${s.id}')"><span class="material-icons-round">visibility</span></button>
          <button title="Edit" onclick="openEditStudentModal('${s.id}')"><span class="material-icons-round">edit</span></button>
          <button title="Delete" class="danger" onclick="deleteStudent('${s.id}')"><span class="material-icons-round">delete</span></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

const debouncedRenderStudentsTable = debounce(renderStudentsTable, 120);

document.getElementById('students-search-input').addEventListener('input', (e)=>{
  state.studentsSearch = e.target.value;
  document.getElementById('quick-search-input').value = e.target.value;
  debouncedRenderStudentsTable();
});
document.getElementById('quick-search-input').addEventListener('input', (e)=>{
  state.studentsSearch = e.target.value;
  const studentsPage = document.getElementById('page-students');
  const alreadyOnStudents = studentsPage.classList.contains('active');
  document.getElementById('students-search-input').value = e.target.value;
  if(e.target.value.trim() && !alreadyOnStudents){
    navigateTo('students');
    // Restore focus to the dashboard-style flow: keep the typed text visible on Students page search box.
    document.getElementById('students-search-input').focus();
  } else {
    debouncedRenderStudentsTable();
  }
});
document.getElementById('students-filter-row').addEventListener('click', (e)=>{
  const chip = e.target.closest('.chip');
  if(!chip) return;
  document.querySelectorAll('#students-filter-row .chip').forEach(c=>c.classList.remove('active'));
  chip.classList.add('active');
  state.studentsFilter = chip.dataset.filter;
  renderStudentsTable();
});

function deleteStudent(id){
  const student = state.students.find(s=>s.id===id);
  if(!student) return;
  openConfirm({
    title: 'Delete this student?',
    message: `${student.name}'s record, fee history and schedule will be permanently removed.`,
    onConfirm: ()=>{
      state.students = state.students.filter(s=>s.id!==id);
      // Keep batch rosters consistent: remove this student's id from any batch.studentIds.
      state.batches.forEach(b => { if(Array.isArray(b.studentIds)) b.studentIds = b.studentIds.filter(sid => sid !== id); });
      saveStudents(); saveBatches();
      renderStudentsTable(); renderDashboard(); renderFeesTable(); renderScheduleList(); renderBatchesPage();
      showToast('Student deleted', 'success');
    }
  });
}

/* ---------------------------------------------------------------------- */
/* BATCHES PAGE                                                           */
/* ---------------------------------------------------------------------- */
function studentsInBatch(batchId){
  return state.students.filter(s => Array.isArray(s.batchIds) && s.batchIds.includes(batchId));
}

function renderBatchesPage(){
  const container = document.getElementById('batches-grid-container');
  const emptyHint = document.getElementById('batches-empty-hint');
  if(!container) return;

  const list = [...state.batches].sort((a,b)=> (a.name||'').localeCompare(b.name||''));
  emptyHint.style.display = list.length ? 'none' : 'block';

  container.innerHTML = list.map(b => {
    const roster = studentsInBatch(b.id);
    const color = batchColor(b);
    return `
    <div class="neo-card batch-card" style="--batch-color:${color};">
      <div class="batch-card-top">
        <div class="batch-color-dot" style="background:${color};"></div>
        <div class="batch-card-title-wrap">
          <div class="batch-card-title">${escapeHtml(b.name)}</div>
          <div class="batch-card-sub">${escapeHtml(b.subject||'General')}</div>
        </div>
        <div class="row-actions">
          <button title="Edit" onclick="openEditBatchModal('${b.id}')"><span class="material-icons-round">edit</span></button>
          <button title="Delete" class="danger" onclick="deleteBatch('${b.id}')"><span class="material-icons-round">delete</span></button>
        </div>
      </div>
      <div class="batch-card-meta">
        <span><span class="material-icons-round">event</span> ${escapeHtml(b.day||'—')} ${b.time ? '· '+escapeHtml(b.time) : ''}</span>
        ${b.location ? `<span><span class="material-icons-round">place</span> ${escapeHtml(b.location)}</span>` : ''}
        ${b.fee ? `<span><span class="material-icons-round">payments</span> ${formatMoney(b.fee)}/mo</span>` : ''}
      </div>
      <div class="batch-card-roster">
        <div class="batch-roster-label">${roster.length} student${roster.length===1?'':'s'} enrolled</div>
        <div class="batch-roster-avatars">
          ${roster.slice(0,6).map(s=>`<div class="avatar-circle mini" style="--avatar-color:${avatarGradient(s.name)};" title="${escapeHtml(s.name)}">${escapeHtml(initials(s.name))}</div>`).join('')}
          ${roster.length > 6 ? `<div class="avatar-circle mini avatar-more">+${roster.length-6}</div>` : ''}
        </div>
      </div>
      <button class="btn-secondary ripple small-btn" style="margin-top:12px;width:100%;" onclick="openBatchRosterModal('${b.id}')">
        <span class="material-icons-round">groups</span> Manage Roster
      </button>
    </div>`;
  }).join('');
}

const batchModalOverlay = document.getElementById('batch-modal-overlay');

function openAddBatchModal(){
  state.editingBatchId = null;
  document.getElementById('batch-modal-title').textContent = 'Add Batch';
  document.getElementById('batch-form').reset();
  document.getElementById('batch-id').value = '';
  batchModalOverlay.classList.add('show');
}

function openEditBatchModal(id){
  const b = state.batches.find(x=>x.id===id);
  if(!b) return;
  state.editingBatchId = id;
  document.getElementById('batch-modal-title').textContent = 'Edit Batch';
  document.getElementById('batch-id').value = b.id;
  document.getElementById('bf-name').value = b.name||'';
  document.getElementById('bf-subject').value = b.subject||'';
  document.getElementById('bf-day').value = b.day||'Monday';
  document.getElementById('bf-time').value = b.time||'';
  document.getElementById('bf-location').value = b.location||'';
  document.getElementById('bf-fee').value = b.fee||'';
  document.getElementById('bf-notes').value = b.notes||'';
  batchModalOverlay.classList.add('show');
}

function closeBatchModal(){ batchModalOverlay.classList.remove('show'); }
document.getElementById('batch-modal-close').addEventListener('click', closeBatchModal);
document.getElementById('batch-form-cancel').addEventListener('click', closeBatchModal);
document.getElementById('add-batch-btn').addEventListener('click', openAddBatchModal);

document.getElementById('batch-form').addEventListener('submit', function(e){
  e.preventDefault();
  const id = document.getElementById('batch-id').value || uid();
  const existing = state.batches.find(b=>b.id===id);
  const name = document.getElementById('bf-name').value.trim();

  const batchData = {
    id,
    name,
    subject: document.getElementById('bf-subject').value.trim(),
    day: document.getElementById('bf-day').value,
    time: document.getElementById('bf-time').value,
    location: document.getElementById('bf-location').value.trim(),
    fee: Number(document.getElementById('bf-fee').value) || 0,
    notes: document.getElementById('bf-notes').value.trim(),
    color: existing ? existing.color : batchColor({ name }),
    studentIds: existing ? existing.studentIds || [] : [],
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };

  if(existing){
    Object.assign(existing, batchData);
    showToast('Batch updated successfully', 'success');
  } else {
    state.batches.push(batchData);
    showToast('Batch created successfully', 'success');
  }
  saveBatches();
  closeBatchModal();
  renderBatchesPage(); renderDashboard(); renderScheduleList(); renderFeesPage_refreshBatchFilter();
});

function deleteBatch(id){
  const b = state.batches.find(x=>x.id===id);
  if(!b) return;
  const roster = studentsInBatch(id);
  openConfirm({
    title: 'Delete this batch?',
    message: roster.length
      ? `"${b.name}" will be removed. ${roster.length} enrolled student${roster.length===1?'':'s'} will be unassigned from it (their individual records are not affected).`
      : `"${b.name}" will be permanently removed.`,
    onConfirm: ()=>{
      state.batches = state.batches.filter(x=>x.id!==id);
      state.students.forEach(s => { if(Array.isArray(s.batchIds)) s.batchIds = s.batchIds.filter(bid => bid !== id); });
      saveBatches(); saveStudents();
      renderBatchesPage(); renderDashboard(); renderStudentsTable(); renderScheduleList(); renderFeesPage_refreshBatchFilter();
      showToast('Batch deleted', 'success');
    }
  });
}

/* ---------------------------------------------------------------------- */
/* BATCH ROSTER MODAL — add/remove students from a batch                  */
/* ---------------------------------------------------------------------- */
const batchRosterOverlay = document.getElementById('batch-roster-modal-overlay');
let rosterModalBatchId = null;

function openBatchRosterModal(batchId){
  const b = state.batches.find(x=>x.id===batchId);
  if(!b) return;
  rosterModalBatchId = batchId;
  document.getElementById('batch-roster-modal-title').textContent = `Manage Roster — ${b.name}`;
  renderBatchRosterList();
  batchRosterOverlay.classList.add('show');
}
function closeBatchRosterModal(){ batchRosterOverlay.classList.remove('show'); rosterModalBatchId = null; }
document.getElementById('batch-roster-modal-close').addEventListener('click', closeBatchRosterModal);

function renderBatchRosterList(){
  const b = state.batches.find(x=>x.id===rosterModalBatchId);
  if(!b) return;
  const container = document.getElementById('batch-roster-list');
  const allStudents = [...state.students].sort((a,b2)=>a.name.localeCompare(b2.name));

  if(allStudents.length === 0){
    container.innerHTML = `<p class="empty-hint">No students yet. Add students first from the Students page.</p>`;
    return;
  }

  container.innerHTML = allStudents.map(s=>{
    const checked = Array.isArray(s.batchIds) && s.batchIds.includes(b.id);
    return `
    <label class="roster-checkbox-row">
      <input type="checkbox" data-student-id="${s.id}" ${checked?'checked':''}>
      <div class="avatar-circle mini" style="--avatar-color:${avatarGradient(s.name)};">${escapeHtml(initials(s.name))}</div>
      <div class="roster-row-main">
        <div class="roster-row-name">${escapeHtml(s.name)}</div>
        <div class="roster-row-sub">${escapeHtml(s.class||'')}</div>
      </div>
    </label>`;
  }).join('');

  container.querySelectorAll('input[type="checkbox"]').forEach(cb=>{
    cb.addEventListener('change', (e)=>{
      const sid = e.target.dataset.studentId;
      const student = state.students.find(s=>s.id===sid);
      if(!student) return;
      if(!Array.isArray(student.batchIds)) student.batchIds = [];
      if(e.target.checked){
        if(!student.batchIds.includes(b.id)) student.batchIds.push(b.id);
      } else {
        student.batchIds = student.batchIds.filter(bid => bid !== b.id);
      }
      saveStudents();
      renderBatchesPage(); renderStudentsTable(); renderDashboard(); renderScheduleList();
    });
  });
}

/* ---------------------------------------------------------------------- */
/* STUDENT FORM (Add / Edit)                                               */
/* ---------------------------------------------------------------------- */
const studentModalOverlay = document.getElementById('student-modal-overlay');

function openAddStudentModal(){
  state.editingStudentId = null;
  document.getElementById('student-modal-title').textContent = 'Add Student';
  document.getElementById('student-form').reset();
  document.getElementById('student-id').value = '';
  document.getElementById('schedule-rows-container').innerHTML = '';
  addScheduleRow();
  studentModalOverlay.classList.add('show');
}

function openEditStudentModal(id){
  const s = state.students.find(x=>x.id===id);
  if(!s) return;
  state.editingStudentId = id;
  document.getElementById('student-modal-title').textContent = 'Edit Student';
  document.getElementById('student-id').value = s.id;
  document.getElementById('f-name').value = s.name||'';
  document.getElementById('f-class').value = s.class||'';
  document.getElementById('f-school').value = s.school||'';
  document.getElementById('f-dob').value = s.dob||'';
  document.getElementById('f-student-phone').value = s.studentPhone||'';
  document.getElementById('f-admission-date').value = s.admissionDate||'';
  document.getElementById('f-guardian-name').value = s.guardianName||'';
  document.getElementById('f-guardian-phone').value = s.guardianPhone||'';
  document.getElementById('f-address').value = s.address||'';
  document.getElementById('f-monthly-fee').value = s.monthlyFee||'';
  document.getElementById('f-status').value = s.status||'active';
  document.getElementById('f-notes').value = s.notes||'';

  const container = document.getElementById('schedule-rows-container');
  container.innerHTML = '';
  if(Array.isArray(s.schedule) && s.schedule.length){
    s.schedule.forEach(sch => addScheduleRow(sch));
  } else {
    addScheduleRow();
  }
  studentModalOverlay.classList.add('show');
}

function closeStudentModal(){ studentModalOverlay.classList.remove('show'); }
document.getElementById('student-modal-close').addEventListener('click', closeStudentModal);
document.getElementById('student-form-cancel').addEventListener('click', closeStudentModal);
document.getElementById('fab-add-student').addEventListener('click', openAddStudentModal);

function addScheduleRow(data){
  data = data || {};
  const container = document.getElementById('schedule-rows-container');
  const rowId = uid();
  const row = document.createElement('div');
  row.className = 'schedule-row';
  row.dataset.rowId = rowId;
  row.innerHTML = `
    <div class="form-group">
      <label>Day</label>
      <select class="sch-day">
        ${DAYS.map(d=>`<option value="${d}" ${data.day===d?'selected':''}>${d}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>Time</label>
      <input type="time" class="sch-time" value="${escapeHtml(data.time||'')}">
    </div>
    <div class="form-group">
      <label>Subject</label>
      <input type="text" class="sch-subject" value="${escapeHtml(data.subject||'')}" placeholder="e.g. Maths">
    </div>
    <div class="form-group">
      <label>Location</label>
      <input type="text" class="sch-location" value="${escapeHtml(data.location||'')}" placeholder="e.g. Home">
    </div>
    <button type="button" class="remove-row-btn" title="Remove"><span class="material-icons-round">close</span></button>
  `;
  row.querySelector('.remove-row-btn').addEventListener('click', ()=> row.remove());
  container.appendChild(row);
}
document.getElementById('add-schedule-row-btn').addEventListener('click', ()=> addScheduleRow());

document.getElementById('student-form').addEventListener('submit', function(e){
  e.preventDefault();

  // Fix: validate phone numbers (10-digit Indian mobile pattern, allows leading +91/0)
  const phonePattern = /^(\+91[\-\s]?|0)?[6-9]\d{9}$/;
  const guardianPhoneVal = document.getElementById('f-guardian-phone').value.trim();
  const studentPhoneVal = document.getElementById('f-student-phone').value.trim();

  if(!phonePattern.test(guardianPhoneVal)){
    showToast('Enter a valid 10-digit guardian phone number', 'error');
    document.getElementById('f-guardian-phone').focus();
    return;
  }
  if(studentPhoneVal && !phonePattern.test(studentPhoneVal)){
    showToast('Enter a valid 10-digit student phone number', 'error');
    document.getElementById('f-student-phone').focus();
    return;
  }

  const id = document.getElementById('student-id').value || uid();
  const scheduleRows = [...document.querySelectorAll('#schedule-rows-container .schedule-row')].map(row=>({
    day: row.querySelector('.sch-day').value,
    time: row.querySelector('.sch-time').value,
    subject: row.querySelector('.sch-subject').value.trim(),
    location: row.querySelector('.sch-location').value.trim(),
    remarks: ''
  })).filter(r => r.subject || r.time); // keep only meaningfully filled rows

  const existing = state.students.find(s=>s.id===id);
  const studentData = {
    id,
    name: document.getElementById('f-name').value.trim(),
    class: document.getElementById('f-class').value.trim(),
    school: document.getElementById('f-school').value.trim(),
    dob: document.getElementById('f-dob').value,
    studentPhone: document.getElementById('f-student-phone').value.trim(),
    admissionDate: document.getElementById('f-admission-date').value,
    guardianName: document.getElementById('f-guardian-name').value.trim(),
    guardianPhone: document.getElementById('f-guardian-phone').value.trim(),
    address: document.getElementById('f-address').value.trim(),
    monthlyFee: Number(document.getElementById('f-monthly-fee').value) || 0,
    status: document.getElementById('f-status').value,
    notes: document.getElementById('f-notes').value.trim(),
    schedule: scheduleRows,
    payments: existing ? existing.payments || {} : {},
    batchIds: existing ? existing.batchIds || [] : [],
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };

  if(existing){
    Object.assign(existing, studentData);
    showToast('Student updated successfully', 'success');
  } else {
    state.students.push(studentData);
    showToast('Student added successfully', 'success');
  }
  saveStudents();
  closeStudentModal();
  renderStudentsTable(); renderDashboard(); renderFeesTable(); renderScheduleList(); renderBatchesPage();
});

/* ---------------------------------------------------------------------- */
/* VIEW STUDENT MODAL                                                      */
/* ---------------------------------------------------------------------- */
const viewModalOverlay = document.getElementById('view-modal-overlay');

function openViewModal(id){
  const s = state.students.find(x=>x.id===id);
  if(!s) return;
  const body = document.getElementById('view-modal-body');

  const paymentEntries = Object.entries(s.payments||{}).sort((a,b)=> b[0].localeCompare(a[0]));
  const paymentsHtml = paymentEntries.length ? paymentEntries.map(([mk, rec])=>{
    const [y,m] = mk.split('-');
    const label = new Date(Number(y), Number(m)-1).toLocaleDateString('en-IN',{month:'long', year:'numeric'});
    return `<div class="payment-history-item">
      <span>${label}</span>
      <span class="status-badge ${rec.status}">${rec.status==='paid' ? 'Paid on '+formatDate(rec.paidDate) : 'Pending'}</span>
    </div>`;
  }).join('') : `<p class="empty-hint">No payment history yet.</p>`;

  const scheduleHtml = (s.schedule && s.schedule.length) ? s.schedule.map(sch=>`
    <div class="schedule-card-row" style="margin-bottom:10px;">
      <div class="time-pill">${escapeHtml(sch.day)} · ${escapeHtml(sch.time||'--:--')}</div>
      <div class="sched-main">
        <div class="sched-name">${escapeHtml(sch.subject||'Subject')}</div>
        <div class="sched-sub">${escapeHtml(sch.location||'')}</div>
      </div>
    </div>
  `).join('') : `<p class="empty-hint">No schedule added.</p>`;

  const studentBatches = state.batches.filter(b => Array.isArray(s.batchIds) && s.batchIds.includes(b.id));
  const batchBadgesHtml = studentBatches.length
    ? `<div class="profile-section-title">Batches</div>
       <div class="batch-badges-wrap">${studentBatches.map(b=>`<span class="batch-badge" style="--batch-color:${batchColor(b)};">${escapeHtml(b.name)}</span>`).join('')}</div>`
    : '';

  body.innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar" style="--avatar-color:${avatarGradient(s.name)};">${escapeHtml(initials(s.name))}</div>
      <div>
        <div class="profile-name">${escapeHtml(s.name)}</div>
        <div class="profile-meta">${escapeHtml(s.class||'')} ${s.school ? '· '+escapeHtml(s.school) : ''}</div>
      </div>
      <span class="status-badge ${s.status}" style="margin-left:auto;">${s.status==='active'?'Active':'Inactive'}</span>
    </div>

    ${batchBadgesHtml}

    <div class="detail-grid">
      <div class="detail-item"><label>Date of Birth</label>${formatDate(s.dob)}</div>
      <div class="detail-item"><label>Admission Date</label>${formatDate(s.admissionDate)}</div>
      <div class="detail-item"><label>Student Phone</label>${escapeHtml(s.studentPhone||'—')}</div>
      <div class="detail-item"><label>Monthly Fee</label>${formatMoney(s.monthlyFee)}</div>
      <div class="detail-item"><label>Guardian Name</label>${escapeHtml(s.guardianName||'—')}</div>
      <div class="detail-item"><label>Guardian Phone</label>${escapeHtml(s.guardianPhone||'—')}</div>
      <div class="detail-item" style="grid-column:1/-1;"><label>Address</label>${escapeHtml(s.address||'—')}</div>
      ${s.notes ? `<div class="detail-item" style="grid-column:1/-1;"><label>Notes</label>${escapeHtml(s.notes)}</div>` : ''}
    </div>

    <div class="profile-section-title">Tuition Schedule</div>
    ${scheduleHtml}

    <div class="profile-section-title">Payment History</div>
    <div class="payment-history-list">${paymentsHtml}</div>

    <div class="modal-actions">
      <button class="btn-secondary ripple" onclick="closeViewModal(); openEditStudentModal('${s.id}')">
        <span class="material-icons-round" style="font-size:18px;">edit</span> Edit
      </button>
    </div>
  `;
  viewModalOverlay.classList.add('show');
}
function closeViewModal(){ viewModalOverlay.classList.remove('show'); }
document.getElementById('view-modal-close').addEventListener('click', closeViewModal);

/* ---------------------------------------------------------------------- */
/* FEES PAGE                                                               */
/* ---------------------------------------------------------------------- */
function renderFeesPage_refreshBatchFilter(){
  const sel = document.getElementById('fees-batch-filter');
  if(!sel) return;
  const current = sel.value;
  const sorted = [...state.batches].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  sel.innerHTML = `<option value="all">All Batches</option>` +
    sorted.map(b=>`<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  // Preserve the previous selection if that batch still exists, else fall back to "all".
  if([...sel.options].some(o=>o.value===current)) sel.value = current;
  else { sel.value = 'all'; state.feesBatchFilter = 'all'; }
}

function renderFeesTable(){
  const mk = monthKey(state.feesMonthCursor);
  document.getElementById('fees-current-month').textContent =
    state.feesMonthCursor.toLocaleDateString('en-IN', { month:'long', year:'numeric' });

  let list = state.students.filter(s=>s.status==='active').sort((a,b)=>a.name.localeCompare(b.name));
  if(state.feesFilter === 'paid'){
    list = list.filter(s => s.payments && s.payments[mk] && s.payments[mk].status==='paid');
  } else if(state.feesFilter === 'pending'){
    list = list.filter(s => !(s.payments && s.payments[mk] && s.payments[mk].status==='paid'));
  }
  if(state.feesBatchFilter && state.feesBatchFilter !== 'all'){
    list = list.filter(s => Array.isArray(s.batchIds) && s.batchIds.includes(state.feesBatchFilter));
  }

  const tbody = document.getElementById('fees-table-body');
  document.getElementById('fees-empty-hint').style.display = list.length ? 'none' : 'block';

  // Feature: Bulk "Mark all paid" button only makes sense when a specific batch is selected.
  const bulkBtn = document.getElementById('fees-bulk-mark-paid-btn');
  if(bulkBtn) bulkBtn.style.display = (state.feesBatchFilter && state.feesBatchFilter !== 'all' && list.length) ? 'inline-flex' : 'none';

  tbody.innerHTML = list.map(s=>{
    const rec = (s.payments && s.payments[mk]) || { status: 'pending' };
    const paid = rec.status === 'paid';
    return `
    <tr>
      <td><strong>${escapeHtml(s.name)}</strong></td>
      <td>${escapeHtml(s.class||'—')}</td>
      <td>${formatMoney(s.monthlyFee)}</td>
      <td><span class="status-badge ${paid?'paid':'pending'}">${paid?'Paid':'Pending'}</span></td>
      <td>${paid ? formatDate(rec.paidDate) : '—'}</td>
      <td>
        ${paid
          ? `<button class="mini-btn mark-pending" onclick="setPaymentStatus('${s.id}','${mk}','pending')">Mark Pending</button>`
          : `<button class="mini-btn mark-paid" onclick="setPaymentStatus('${s.id}','${mk}','paid')">Mark Paid</button>`
        }
      </td>
    </tr>`;
  }).join('');
}

function bulkMarkBatchPaid(){
  if(!state.feesBatchFilter || state.feesBatchFilter === 'all') return;
  const batch = state.batches.find(b=>b.id===state.feesBatchFilter);
  if(!batch) return;
  const mk = monthKey(state.feesMonthCursor);
  const roster = studentsInBatch(batch.id).filter(s=>s.status==='active');
  if(roster.length === 0) return;

  openConfirm({
    title: `Mark all of "${batch.name}" as paid?`,
    message: `This will mark ${roster.length} student${roster.length===1?'':'s'} as paid for ${state.feesMonthCursor.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}.`,
    onConfirm: ()=>{
      roster.forEach(s=>{
        if(!s.payments) s.payments = {};
        s.payments[mk] = { status:'paid', paidDate: new Date().toISOString() };
      });
      saveStudents();
      renderFeesTable(); renderDashboard(); renderStudentsTable();
      showToast(`Marked ${roster.length} student${roster.length===1?'':'s'} as paid`, 'success');
    }
  });
}

function setPaymentStatus(studentId, mk, status){
  const s = state.students.find(x=>x.id===studentId);
  if(!s) return;
  if(!s.payments) s.payments = {};
  const existingRec = s.payments[mk];
  s.payments[mk] = status === 'paid'
    ? { status:'paid', paidDate: new Date().toISOString() }
    : { status:'pending', previousPaidDate: existingRec && existingRec.paidDate ? existingRec.paidDate : (existingRec && existingRec.previousPaidDate) || null };
  saveStudents();
  renderFeesTable(); renderDashboard(); renderStudentsTable();
  showToast(status==='paid' ? 'Marked as paid' : 'Marked as pending', 'success');
}

document.getElementById('fees-prev-month').addEventListener('click', ()=>{
  state.feesMonthCursor = new Date(state.feesMonthCursor.getFullYear(), state.feesMonthCursor.getMonth()-1, 1);
  renderFeesTable();
});
document.getElementById('fees-next-month').addEventListener('click', ()=>{
  state.feesMonthCursor = new Date(state.feesMonthCursor.getFullYear(), state.feesMonthCursor.getMonth()+1, 1);
  renderFeesTable();
});
document.getElementById('fees-batch-filter').addEventListener('change', (e)=>{
  state.feesBatchFilter = e.target.value;
  renderFeesTable();
});
document.getElementById('fees-bulk-mark-paid-btn').addEventListener('click', bulkMarkBatchPaid);
document.getElementById('fees-filter-row').addEventListener('click', (e)=>{
  const chip = e.target.closest('.chip');
  if(!chip) return;
  document.querySelectorAll('#fees-filter-row .chip').forEach(c=>c.classList.remove('active'));
  chip.classList.add('active');
  state.feesFilter = chip.dataset.filter;
  renderFeesTable();
});

/* ---------------------------------------------------------------------- */
/* SCHEDULE PAGE                                                          */
/* ---------------------------------------------------------------------- */
function renderScheduleList(){
  const container = document.getElementById('schedule-list-container');
  let entries = [];
  state.students.forEach(s=>{
    if(s.status !== 'active' || !Array.isArray(s.schedule)) return;
    s.schedule.forEach(sch => entries.push({ student: s, ...sch }));
  });

  if(state.scheduleDayFilter !== 'all'){
    entries = entries.filter(e => e.day === state.scheduleDayFilter);
  }

  if(entries.length === 0){
    container.innerHTML = `<p class="empty-hint">No schedules found. Add schedule details from a student's profile.</p>`;
    return;
  }

  const dayOrder = state.scheduleDayFilter === 'all' ? DAYS : [state.scheduleDayFilter];
  let html = '';
  dayOrder.forEach(day=>{
    const dayEntries = entries.filter(e=>e.day===day).sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    if(dayEntries.length === 0) return;
    html += `<div class="day-group-title">${day}</div>`;
    dayEntries.forEach(e=>{
      html += `
      <div class="schedule-card-row">
        <div class="time-pill">${escapeHtml(e.time||'--:--')}</div>
        <div class="sched-main">
          <div class="sched-name">${escapeHtml(e.student.name)} · ${escapeHtml(e.student.class||'')}</div>
          <div class="sched-sub">${escapeHtml(e.subject||'Subject')} ${e.location ? '· '+escapeHtml(e.location) : ''}</div>
        </div>
      </div>`;
    });
  });
  container.innerHTML = html || `<p class="empty-hint">No schedules found for this day.</p>`;
}

document.getElementById('schedule-day-row').addEventListener('click', (e)=>{
  const chip = e.target.closest('.chip');
  if(!chip) return;
  document.querySelectorAll('#schedule-day-row .chip').forEach(c=>c.classList.remove('active'));
  chip.classList.add('active');
  state.scheduleDayFilter = chip.dataset.day;
  renderScheduleList();
});

/* ---------------------------------------------------------------------- */
/* BACKUP / RESTORE / RESET                                                */
/* ---------------------------------------------------------------------- */
document.getElementById('export-json-btn').addEventListener('click', ()=>{
  const payload = {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    settings: state.settings,
    students: state.students,
    batches: state.batches,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tuition-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('Backup exported successfully', 'success');
});

document.getElementById('import-json-btn').addEventListener('click', ()=>{
  document.getElementById('import-json-input').click();
});
document.getElementById('import-json-input').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(ev){
    try{
      const data = JSON.parse(ev.target.result);
      if(!Array.isArray(data.students)) throw new Error('Invalid file format');
      openConfirm({
        title: 'Import this backup?',
        message: `This will replace all current students, batches and settings with the data from the selected file (${(data.students||[]).length} students, ${(data.batches||[]).length} batches).`,
        onConfirm: ()=>{
          state.students = data.students;
          state.batches = data.batches || [];
          if(data.settings) state.settings = Object.assign(state.settings, data.settings);
          saveStudents(); saveBatches(); saveSettings(); applyTheme();
          refreshSettingsForm();
          renderDashboard(); renderStudentsTable(); renderBatchesPage(); renderFeesTable(); renderFeesPage_refreshBatchFilter(); renderScheduleList(); renderSnapshotsList();
          showToast('Data imported successfully', 'success');
        }
      });
    }catch(err){
      showToast('Invalid backup file', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('manual-snapshot-btn').addEventListener('click', ()=>{
  const snap = createSnapshot('manual');
  if(!snap){ showToast('Nothing to snapshot yet — add some students first', 'info'); return; }
  renderSnapshotsList();
  showToast('Snapshot saved successfully', 'success');
});

document.getElementById('reset-data-btn').addEventListener('click', ()=>{
  openConfirm({
    title: 'Reset all data?',
    message: 'This will permanently delete every student, batch, fee record and schedule from this device. Automatic snapshots in the Local Snapshots section will be kept so you can restore if needed.',
    onConfirm: ()=>{
      state.students = [];
      state.batches = [];
      saveStudents(); saveBatches();
      renderDashboard(); renderStudentsTable(); renderBatchesPage(); renderFeesTable(); renderFeesPage_refreshBatchFilter(); renderScheduleList();
      showToast('All data has been reset', 'success');
    }
  });
});

/* ---------------------------------------------------------------------- */
/* SETTINGS PAGE                                                          */
/* ---------------------------------------------------------------------- */
function refreshSettingsForm(){
  document.getElementById('setting-teacher-name').value = state.settings.teacherName || '';
  document.getElementById('setting-tuition-name').value = state.settings.tuitionName || '';
  updateBrandLabels();
}

function updateBrandLabels(){
  const tName = state.settings.tuitionName || 'TutorDesk';
  const teach = state.settings.teacherName || 'Suman Mondal';
  document.getElementById('brand-tuition-name').textContent = tName;
  document.getElementById('brand-teacher-name').textContent = teach;
  document.getElementById('drawer-tuition-name').textContent = tName;
  document.getElementById('drawer-teacher-name').textContent = teach;
  const splashTitle = document.getElementById('splash-tuition-name');
  if(splashTitle) splashTitle.textContent = tName;
  // Feature: 'Built for' is no longer hardcoded — reflects whichever tutor has set up this device.
  const aboutTeacher = document.getElementById('about-teacher-name');
  if(aboutTeacher) aboutTeacher.textContent = teach;
}

document.getElementById('save-settings-btn').addEventListener('click', ()=>{
  state.settings.teacherName = document.getElementById('setting-teacher-name').value.trim() || 'Suman Mondal';
  state.settings.tuitionName = document.getElementById('setting-tuition-name').value.trim() || 'TutorDesk';
  saveSettings();
  updateBrandLabels();
  showToast('Profile saved', 'success');
});

document.getElementById('dark-mode-toggle').addEventListener('change', (e)=>{
  state.settings.darkMode = e.target.checked;
  saveSettings();
  applyTheme();
});

/* ---------------------------------------------------------------------- */
/* APP UPDATE (replaces manual install)                                   */
/* ---------------------------------------------------------------------- */
const updateBtn = document.getElementById('update-app-btn');
const updateIcon = document.getElementById('update-app-icon');
const updateLabel = document.getElementById('update-app-label');
const updateHint = document.getElementById('update-status-hint');

let waitingWorker = null; // a new SW version that's installed and ready to activate

function setUpdateBtnState(mode, message){
  updateBtn.classList.remove('is-checking','is-updating','is-uptodate','is-available');
  updateHint.classList.remove('status-good','status-available','status-error');

  if(mode === 'checking'){
    updateBtn.classList.add('is-checking');
    updateIcon.textContent = 'sync';
    updateLabel.textContent = 'Checking for Update...';
    updateBtn.disabled = true;
  } else if(mode === 'available'){
    updateBtn.classList.add('is-available');
    updateIcon.textContent = 'system_update';
    updateLabel.textContent = 'Update Available — Tap to Update';
    updateBtn.disabled = false;
    updateHint.style.display = 'block';
    updateHint.classList.add('status-available');
    updateHint.textContent = message || 'A new version of TutorDesk is ready to install.';
  } else if(mode === 'updating'){
    updateBtn.classList.add('is-updating');
    updateIcon.textContent = 'sync';
    updateLabel.textContent = 'Updating...';
    updateBtn.disabled = true;
  } else if(mode === 'uptodate'){
    updateBtn.classList.add('is-uptodate');
    updateIcon.textContent = 'check_circle';
    updateLabel.textContent = 'App is Up to Date';
    updateBtn.disabled = false;
    updateHint.style.display = 'block';
    updateHint.classList.add('status-good');
    updateHint.textContent = `You're running the latest version (v${APP_VERSION}).`;
  } else if(mode === 'error'){
    updateIcon.textContent = 'system_update';
    updateLabel.textContent = 'Check for Update';
    updateBtn.disabled = false;
    updateHint.style.display = 'block';
    updateHint.classList.add('status-error');
    updateHint.textContent = message || 'Could not check for updates. Check your connection.';
  } else { // idle/default
    updateIcon.textContent = 'system_update';
    updateLabel.textContent = 'Check for Update';
    updateBtn.disabled = false;
  }
}

async function checkForAppUpdate(showResultEvenIfNone){
  if(!('serviceWorker' in navigator)){
    setUpdateBtnState('error', 'Updates require a browser that supports Service Workers.');
    return;
  }
  setUpdateBtnState('checking');
  try{
    const reg = await navigator.serviceWorker.getRegistration();
    if(!reg){
      setUpdateBtnState('error', 'App is not running in installable mode yet.');
      return;
    }
    // Ask the browser to re-fetch service-worker.js from the server (bypassing HTTP cache)
    // and compare byte-for-byte with the currently installed one. If different => new files.
    await reg.update();

    // Give the browser a brief moment to finish evaluating + installing the new worker.
    setTimeout(()=>{
      if(reg.waiting){
        waitingWorker = reg.waiting;
        setUpdateBtnState('available');
      } else if(reg.installing){
        // Still installing — wait for it to finish, then re-check.
        reg.installing.addEventListener('statechange', function handler(){
          if(this.state === 'installed' && navigator.serviceWorker.controller){
            waitingWorker = reg.waiting || this;
            setUpdateBtnState('available');
            this.removeEventListener('statechange', handler);
          }
        });
        setTimeout(()=>{
          if(reg.waiting){ waitingWorker = reg.waiting; setUpdateBtnState('available'); }
          else if(showResultEvenIfNone){ setUpdateBtnState('uptodate'); }
          else { setUpdateBtnState('idle'); }
        }, 2500);
      } else {
        // No new worker found = repository files are unchanged = already latest.
        if(showResultEvenIfNone){
          setUpdateBtnState('uptodate');
        } else {
          setUpdateBtnState('idle');
        }
      }
    }, 800);
  }catch(err){
    setUpdateBtnState('error', 'Update check failed. Please try again.');
  }
}

function applyAppUpdate(){
  if(!waitingWorker){
    // Nothing pending — just run a fresh check instead.
    checkForAppUpdate(true);
    return;
  }
  setUpdateBtnState('updating');
  // Tell the waiting service worker to take over immediately.
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

// When the new service worker takes control, reload once to load the new files.
let refreshingPage = false;
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(refreshingPage) return;
    refreshingPage = true;
    showToast('Update installed — reloading app', 'success');
    setTimeout(()=> window.location.reload(), 600);
  });
}

updateBtn.addEventListener('click', ()=>{
  if(updateBtn.classList.contains('is-available')){
    applyAppUpdate();
  } else {
    checkForAppUpdate(true);
  }
});

/* ---------------------------------------------------------------------- */
/* CONFIRM DIALOG                                                         */
/* ---------------------------------------------------------------------- */
const confirmOverlay = document.getElementById('confirm-modal-overlay');
function openConfirm({ title, message, onConfirm }){
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  state.confirmCallback = onConfirm;
  confirmOverlay.classList.add('show');
}
document.getElementById('confirm-ok-btn').addEventListener('click', ()=>{
  confirmOverlay.classList.remove('show');
  if(typeof state.confirmCallback === 'function') state.confirmCallback();
  state.confirmCallback = null;
});
document.getElementById('confirm-cancel-btn').addEventListener('click', ()=>{
  confirmOverlay.classList.remove('show');
  state.confirmCallback = null;
});

/* Close modals by clicking on the overlay (outside the card) */
[studentModalOverlay, viewModalOverlay, confirmOverlay].forEach(overlay=>{
  overlay.addEventListener('click', (e)=>{
    if(e.target === overlay) overlay.classList.remove('show');
  });
});

/* ---------------------------------------------------------------------- */
/* SERVICE WORKER REGISTRATION                                            */
/* ---------------------------------------------------------------------- */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').then((reg)=>{
      // If a new worker is already waiting (e.g. updated repo files were deployed
      // while the user was away), flag it as available right away.
      if(reg.waiting){
        waitingWorker = reg.waiting;
        setUpdateBtnState('available');
      }
      // Watch for a brand-new worker being found while the app is open.
      reg.addEventListener('updatefound', ()=>{
        const newWorker = reg.installing;
        if(!newWorker) return;
        newWorker.addEventListener('statechange', ()=>{
          if(newWorker.state === 'installed' && navigator.serviceWorker.controller){
            waitingWorker = newWorker;
            setUpdateBtnState('available');
          }
        });
      });
    }).catch(()=>{
      /* Offline-first app still works without SW registration succeeding */
    });
  });
}

/* ---------------------------------------------------------------------- */
/* INIT                                                                    */
/* ---------------------------------------------------------------------- */
function init(){
  loadData();
  applyTheme();
  refreshSettingsForm();
  renderDashboard();
  renderStudentsTable();
  renderBatchesPage();
  renderFeesPage_refreshBatchFilter();
  renderFeesTable();
  renderScheduleList();
  renderSnapshotsList();

  const versionEl = document.getElementById('about-app-version');
  if(versionEl) versionEl.textContent = APP_VERSION;

  // Hide splash + reveal app
  setTimeout(()=>{
    document.getElementById('splash-screen').classList.add('splash-hide');
    document.getElementById('app').classList.remove('app-hidden');
  }, 900);
}

document.addEventListener('DOMContentLoaded', init);
