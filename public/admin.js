/**
 * admin.js — halaman admin: laporan pengguna + daftar blokir.
 *
 * Halaman ini sengaja **tidak** membuka socket. Server cuma mengizinkan satu
 * sesi hidup per akun (lihat server.js), jadi kalau halaman ini menyambung,
 * tab chat yang sedang dipakai admin justru yang tertendang. Sebagai gantinya
 * data diambil lewat REST: saat dibuka, saat tombol "Muat ulang" ditekan, dan
 * otomatis tiap 15 detik.
 *
 * Yang perlu diingat: halaman ini cuma tampilan. Kalau akun ini bukan admin,
 * semua endpoint /api/admin/* menjawab 403 dan layar ini bilang terus terang
 * bahwa aksesnya nggak ada.
 */

import { createAuthClient } from './auth-client.js';

const $ = (selector) => document.querySelector(selector);

const el = {
  boot: $('#boot'),
  login: $('#login'),
  loginFirebase: $('#login-firebase'),
  loginDev: $('#login-dev'),
  loginDevNote: $('#login-dev-note'),
  loginUsername: $('#login-username'),
  loginSubmit: $('#login-submit'),
  loginError: $('#login-error'),
  btnGoogle: $('#btn-google'),

  denied: $('#denied'),
  deniedDetail: $('#denied-detail'),
  deniedChat: $('#denied-chat'),
  deniedLogout: $('#denied-logout'),

  admin: $('#admin'),
  me: $('#admin-me'),
  stats: $('#admin-stats'),
  tabs: $('#admin-tabs'),
  tabReports: $('#tab-reports'),
  error: $('#admin-error'),
  panel: $('#admin-panel'),
  btnRefresh: $('#btn-refresh'),
  btnChat: $('#btn-chat'),
  btnLogout: $('#btn-logout'),

  modal: $('#modal'),
  modalCard: $('#modal-card'),
  toast: $('#toast'),
};

const state = {
  config: null,
  auth: null,
  profile: null,
  overview: null,
  tab: 'reports',
  query: '',
  loading: false,
};

const REPORT_STATUS_LABEL = { open: 'Belum ditangani', resolved: 'Selesai', dismissed: 'Diabaikan' };

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function showToast(message, ms = 4500) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (el.toast.hidden = true), ms);
}

function openModal(html) {
  el.modalCard.innerHTML = html;
  el.modal.hidden = false;
}

function closeModal() {
  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
}

/**
 * Satu pintu ke semua endpoint admin. Token selalu diambil segar dari auth
 * client supaya sesi yang panjang nggak mati karena token kedaluwarsa.
 */
async function api(path, options = {}) {
  const token = await state.auth.getIdToken();
  const headers = { ...(options.headers || {}), authorization: `Bearer ${token || ''}` };
  if (options.body) headers['content-type'] = 'application/json';

  const response = await fetch(path, { ...options, headers });
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* jawaban tanpa isi */
  }
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Gagal (${response.status}).`), {
      status: response.status,
      data,
    });
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Layar
 * ------------------------------------------------------------------ */

function showLogin() {
  state.profile = null;
  state.overview = null;
  el.admin.hidden = true;
  el.denied.hidden = true;
  el.login.hidden = false;
  el.boot.hidden = true;
}

function showDenied(detail) {
  el.deniedDetail.textContent = detail || 'Akun ini bukan admin.';
  el.denied.hidden = false;
  el.admin.hidden = true;
  el.login.hidden = true;
  el.boot.hidden = true;
}

async function loadOverview({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    const overview = await api('/api/admin/overview');
    const previousOpen = state.overview?.stats?.open;
    state.overview = overview;

    el.login.hidden = true;
    el.denied.hidden = true;
    el.boot.hidden = true;
    el.admin.hidden = false;
    el.error.hidden = true;
    render();

    if (previousOpen !== undefined && overview.stats.open > previousOpen) {
      showToast(`Ada ${overview.stats.open - previousOpen} laporan baru.`, 6000);
    }
  } catch (err) {
    if (err.status === 403) return showDenied(err.message);
    if (err.status === 401) return showLogin();
    el.error.textContent = err.message;
    el.error.hidden = false;
    if (!quiet) showToast(`Gagal memuat: ${err.message}`);
  } finally {
    state.loading = false;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  const overview = state.overview;
  if (!overview) return;

  const who = overview.me.username ? `@${overview.me.username}` : overview.me.uid.slice(0, 12);
  el.me.textContent = `Masuk sebagai ${who}${overview.me.email ? ` · ${overview.me.email}` : ''}`;

  el.stats.innerHTML = [
    { value: overview.stats.open, label: 'laporan belum ditangani', hot: overview.stats.open > 0 },
    { value: overview.stats.reports, label: 'total laporan' },
    { value: overview.stats.bans, label: 'akun diblokir' },
    { value: overview.stats.users, label: `pengguna terdaftar · ${overview.stats.online} online` },
  ]
    .map(
      (stat) =>
        `<div class="admin-stat${stat.hot ? ' hot' : ''}"><strong>${stat.value}</strong><span>${esc(stat.label)}</span></div>`
    )
    .join('');

  el.tabReports.textContent = 'Laporan';
  if (overview.stats.open > 0) {
    el.tabReports.insertAdjacentHTML('beforeend', ` <span class="badge">${overview.stats.open}</span>`);
  }

  for (const tab of el.tabs.querySelectorAll('.admin-tab')) {
    tab.classList.toggle('active', tab.dataset.tab === state.tab);
  }

  if (state.tab === 'reports') renderReports();
  else if (state.tab === 'users') renderUsers();
  else renderBans();
}

function when(ts) {
  return new Date(ts).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderReports() {
  const reports = state.overview.reports || [];
  if (!reports.length) {
    el.panel.innerHTML = '<p class="admin-empty">Belum ada laporan. Bagus.</p>';
    return;
  }

  el.panel.innerHTML = reports.map(reportCard).join('');
}

function reportCard(report) {
  const from = report.fromName || report.from;
  const about = report.aboutName || report.about;
  const open = report.status === 'open';

  return `
    <article class="admin-card" data-report="${esc(report.id)}">
      <div class="admin-card-head">
        <span class="tag ${esc(report.status)}">${esc(REPORT_STATUS_LABEL[report.status] || report.status)}</span>
        <strong>${esc(from)} melaporkan ${esc(about)}</strong>
        <span class="admin-when">${esc(when(report.at))}</span>
      </div>
      <p>
        <strong>${esc(report.reasonLabel || report.reason)}</strong>
        ${report.detail ? ` — ${esc(report.detail)}` : ' <span class="muted">(tanpa catatan)</span>'}
      </p>
      ${
        report.handledNote
          ? `<div class="admin-note">Catatan admin: ${esc(report.handledNote)}${
              report.handledAt ? ` · ${esc(when(report.handledAt))}` : ''
            }</div>`
          : ''
      }
      <div class="admin-card-actions">
        ${
          open
            ? '<button class="ghost" data-act="resolved">Tandai selesai</button>'
            : `<button class="ghost" data-act="open">Buka lagi</button>`
        }
        <button class="ghost" data-act="dismissed">Abaikan</button>
        <button class="ghost" data-act="ban" data-uid="${esc(report.about)}" data-name="${esc(about)}">Blokir ${esc(about)}</button>
        <button class="ghost" data-act="find" data-name="${esc(about)}">Cari di daftar pengguna</button>
      </div>
    </article>
  `;
}

function renderUsers() {
  const query = state.query.trim().toLowerCase();
  const users = (state.overview.users || []).filter((user) => {
    if (!query) return true;
    return [user.username, user.email, user.phone, user.uid]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(query));
  });

  const search = `
    <div class="admin-toolbar">
      <input id="admin-search" class="search" placeholder="Cari username, email, nomor, atau uid…" value="${esc(state.query)}" />
      <span class="muted small">${users.length} dari ${(state.overview.users || []).length} pengguna</span>
    </div>
  `;

  if (!users.length) {
    el.panel.innerHTML = `${search}<p class="admin-empty">Nggak ada pengguna yang cocok.</p>`;
    wireSearch();
    return;
  }

  el.panel.innerHTML =
    search +
    users
      .map((user) => {
        const name = user.username || user.uid.slice(0, 10);
        return `
          <article class="admin-card" data-user="${esc(user.uid)}">
            <div class="admin-card-head">
              <strong>${esc(name)}</strong>
              ${user.banned ? '<span class="tag banned">Diblokir</span>' : ''}
              ${user.online ? '<span class="tag online">Online</span>' : ''}
              <span class="admin-when">${esc(when(Date.now()))}</span>
            </div>
            <p class="admin-card-sub">
              ${user.email ? `${esc(user.email)}<br />` : ''}
              ${user.phone ? `${esc(user.phone)}<br />` : ''}
              <code>${esc(user.uid)}</code>
            </p>
            ${user.banned && user.banReason ? `<div class="admin-note">Alasan blokir: ${esc(user.banReason)}</div>` : ''}
            <div class="admin-card-actions">
              ${
                user.banned
                  ? `<button class="ghost" data-act="unban" data-uid="${esc(user.uid)}">Buka blokir</button>`
                  : `<button class="ghost" data-act="ban" data-uid="${esc(user.uid)}" data-name="${esc(name)}">Blokir</button>`
              }
              <button class="ghost" data-act="report-about" data-name="${esc(name)}" data-uid="${esc(user.uid)}">Lihat laporannya</button>
            </div>
          </article>
        `;
      })
      .join('');

  wireSearch();
}

function renderBans() {
  const bans = state.overview.bans || [];
  if (!bans.length) {
    el.panel.innerHTML = '<p class="admin-empty">Nggak ada akun yang diblokir.</p>';
    return;
  }

  el.panel.innerHTML = bans
    .map((ban) => {
      const name = ban.username || ban.uid.slice(0, 10);
      return `
        <article class="admin-card" data-user="${esc(ban.uid)}">
          <div class="admin-card-head">
            <span class="tag banned">Diblokir</span>
            <strong>${esc(name)}</strong>
            <span class="admin-when">${esc(when(ban.at))}</span>
          </div>
          <p class="admin-card-sub">
            ${ban.reason ? `Alasan: ${esc(ban.reason)}<br />` : 'Tanpa alasan tertulis.<br />'}
            Diblokir oleh <code>${esc(ban.by || '—')}</code> · <code>${esc(ban.uid)}</code>
          </p>
          <div class="admin-card-actions">
            <button class="ghost" data-act="unban" data-uid="${esc(ban.uid)}">Buka blokir</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function wireSearch() {
  const search = $('#admin-search');
  if (!search) return;
  search.addEventListener('input', () => {
    state.query = search.value;
    renderUsers();
    const next = $('#admin-search');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Aksi
 * ------------------------------------------------------------------ */

async function askReason({ title, hint, confirmLabel, placeholder }) {
  return new Promise((resolve) => {
    openModal(`
      <h3>${esc(title)}</h3>
      <p class="sub">${esc(hint)}</p>
      <label for="ban-reason">Alasan (opsional)</label>
      <textarea id="ban-reason" maxlength="200" placeholder="${esc(placeholder)}"></textarea>
      <div class="modal-actions">
        <button data-cancel>Batal</button>
        <button class="primary" data-ok>${esc(confirmLabel)}</button>
      </div>
    `);

    el.modalCard.querySelector('[data-cancel]').addEventListener('click', () => {
      closeModal();
      resolve(null);
    });
    el.modalCard.querySelector('[data-ok]').addEventListener('click', () => {
      const value = el.modalCard.querySelector('#ban-reason').value.trim();
      closeModal();
      resolve(value);
    });
  });
}

async function banUser(uid, name) {
  if (!uid) return;
  const reason = await askReason({
    title: `Blokir ${name || uid.slice(0, 10)}?`,
    hint: 'Akun ini langsung ditendang dari sesi yang sedang jalan dan nggak bisa masuk lagi sampai blokirnya dibuka.',
    confirmLabel: 'Blokir akun',
    placeholder: 'misal: kirim link penipuan berulang',
  });
  if (reason === null) return; // dibatalkan

  try {
    await api('/api/admin/ban', { method: 'POST', body: JSON.stringify({ uid, reason }) });
    showToast('Akun diblokir.');
    await loadOverview({ quiet: true });
  } catch (err) {
    showToast(`Gagal memblokir: ${err.message}`);
  }
}

async function unbanUser(uid) {
  try {
    const result = await api('/api/admin/unban', { method: 'POST', body: JSON.stringify({ uid }) });
    showToast(result.removed ? 'Blokir dibuka.' : 'Akun itu memang nggak sedang diblokir.');
    await loadOverview({ quiet: true });
  } catch (err) {
    showToast(`Gagal membuka blokir: ${err.message}`);
  }
}

async function setReportStatus(id, status) {
  try {
    await api('/api/admin/report', {
      method: 'POST',
      body: JSON.stringify({ id, status }),
    });
    showToast(status === 'resolved' ? 'Laporan ditandai selesai.' : 'Laporan diperbarui.');
    await loadOverview({ quiet: true });
  } catch (err) {
    showToast(`Gagal memperbarui laporan: ${err.message}`);
  }
}

/* Satu pendengar untuk semua tombol di dalam panel. */
el.panel.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;

  const action = button.dataset.act;
  const card = button.closest('[data-report], [data-user]');

  if (action === 'ban') return banUser(button.dataset.uid, button.dataset.name);
  if (action === 'unban') return unbanUser(button.dataset.uid);

  if (action === 'find' || action === 'report-about') {
    state.tab = 'users';
    state.query = button.dataset.name || '';
    render();
    return;
  }

  const reportId = card?.dataset.report;
  if (reportId && ['resolved', 'dismissed', 'open'].includes(action)) {
    setReportStatus(reportId, action);
  }
});

el.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.admin-tab');
  if (!tab) return;
  state.tab = tab.dataset.tab;
  state.query = '';
  render();
});

el.btnRefresh.addEventListener('click', () => loadOverview());
el.btnChat.addEventListener('click', () => window.open('/', '_blank', 'noopener'));
el.btnLogout.addEventListener('click', async () => {
  if (!confirm('Keluar dari halaman admin?')) return;
  await state.auth.signOut();
  location.reload();
});

el.deniedChat.addEventListener('click', () => window.open('/', '_blank', 'noopener'));
el.deniedLogout.addEventListener('click', async () => {
  await state.auth.signOut();
  location.reload();
});

el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeModal();
});

/* ------------------------------------------------------------------ *
 * Masuk
 * ------------------------------------------------------------------ */

async function boot() {
  try {
    state.config = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    el.boot.hidden = true;
    el.login.hidden = false;
    el.loginError.textContent = 'Gagal ambil konfigurasi server.';
    el.loginError.hidden = false;
    return;
  }

  el.boot.hidden = true;
  el.login.hidden = false;

  const firebaseMode = state.config.auth.mode === 'firebase';
  el.loginFirebase.hidden = !firebaseMode;
  el.loginDev.hidden = firebaseMode;
  el.loginDevNote.hidden = firebaseMode;

  state.auth = await createAuthClient(state.config);
  state.auth.onUserChange(async (profile) => {
    state.profile = profile;
    if (profile) await loadOverview();
    else showLogin();
  });

  // Driver dev nggak punya sesi jarak jauh buat dipulihkan, jadi disenggol manual.
  state.auth.resume?.();
}

el.btnGoogle.addEventListener('click', async () => {
  el.loginError.hidden = true;
  el.btnGoogle.disabled = true;
  try {
    await state.auth.signInWithGoogle();
  } catch (err) {
    el.loginError.textContent = err.message || 'Login Google gagal.';
    el.loginError.hidden = false;
  } finally {
    el.btnGoogle.disabled = false;
  }
});

el.loginDev.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginError.hidden = true;
  el.loginSubmit.disabled = true;
  try {
    await state.auth.signInAs(el.loginUsername.value);
  } catch (err) {
    el.loginError.textContent = err.message;
    el.loginError.hidden = false;
  } finally {
    el.loginSubmit.disabled = false;
  }
});

// Penyegaran otomatis: laporan baru muncul tanpa admin harus menekan apa pun.
setInterval(() => {
  if (el.admin.hidden || document.visibilityState !== 'visible') return;
  loadOverview({ quiet: true });
}, 15000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !el.admin.hidden) loadOverview({ quiet: true });
});

boot();
