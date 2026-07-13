// ── Accent color constants (declared first to avoid TDZ errors) ──
const _ACCENT_DEFAULT = '#d97757';
const _ACCENT_PRESETS = [
  '#d97757', // terracotta (default)
  '#e05c5c', // red
  '#e07b2f', // amber
  '#c0a030', // gold
  '#3ea06c', // green
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#0ea5e9', // sky
];

// ── Plan / source quality tiers (single source of truth) ──────
// Used by: header quality widget, onboarding quality meter, confirm-overwrite dialog.
// Tier 1 = solo materia  →  Tier 4 = programma + dispense + manuali
// Tier 2 = programma
// Tier 3 = (programma + dispense) OR (programma + manuali)
// Tier 4 = programma + dispense + manuali
const _PLAN_QUALITY = [
  { label: 'Base',    shortDesc: 'solo materia',          color: '#6b7280', hint: 'Piano basato sulla conoscenza di Claude — aggiungi il programma e le dispense per domande personalizzate.' },
  { label: 'Buona',   shortDesc: '+ programma',           color: '#d97757', hint: 'Piano con il programma del corso — carica le dispense PDF per domande mirate.' },
  { label: 'Ottima',  shortDesc: '+ dispense o manuali',  color: '#3b82f6', hint: 'Piano costruito sulle tue fonti — aggiungi dispense E manuali per raggiungere la qualità Massima.' },
  { label: 'Massima', shortDesc: '+ dispense + manuali',  color: '#f59e0b', hint: 'Qualità massima — domande basate su dispense e manuali del tuo corso specifico.' },
];

// ── Supabase Auth + Cloud Sync ───────────────────────────────
(function() {

  /* ── Config ── */
  const SB_URL  = 'https://olagntawajefdjrkkvcc.supabase.co';
  const SB_KEY  = 'sb_publishable_azsXEe4uMlPAbKNZ1seQuA_6uVieV_c';

  // Expose for _callClaude() helper (defined outside this IIFE)
  window._SB_URL = SB_URL;
  window._getSBToken = async () => {
    if (!_sb) return null;
    let { data: { session } } = await _sb.auth.getSession();
    if (!session?.access_token) {
      // On iOS the token can temporarily disappear after camera/backgrounding.
      // Attempt a silent refresh before giving up.
      try {
        const { data: refreshData } = await _sb.auth.refreshSession();
        session = refreshData?.session ?? null;
      } catch(e) {
        console.warn('[getSBToken] refresh failed:', e);
      }
    }
    return session?.access_token || null;
  };

  // Keys synced to cloud (anthropic_api_key removed — managed server-side)
  const SYNC_KEYS = [
    'psico_state', 'psico_sources', 'psico_exam_info',
    'psico_ai_plan', 'psico_objective', 'psico_theme'
  ];

  /* ── Init client ── */
  const _sb = window.supabase
    ? window.supabase.createClient(SB_URL, SB_KEY, {
        auth: {
          detectSessionInUrl: true,   // picks up #access_token from confirmation emails
          persistSession: true,
          autoRefreshToken: true
        }
      })
    : null;

  if (!_sb) {
    console.error('[Supabase] SDK not loaded — cloud sync disabled');
  }

  window._sb = _sb;

  /* ── Login mode toggle (login / register) ── */
  let _loginMode = 'login'; // 'login' | 'register'
  window.toggleLoginMode = function() {
    _loginMode = _loginMode === 'login' ? 'register' : 'login';
    const btn      = document.getElementById('loginBtn');
    const toggle   = document.getElementById('loginModeToggle');
    const sub      = document.getElementById('loginSub');
    const passEl   = document.getElementById('loginPassword');
    if (_loginMode === 'register') {
      btn.textContent    = 'Crea account →';
      toggle.innerHTML   = 'Hai già un account? <a href="#" onclick="toggleLoginMode();return false;">Accedi</a>';
      sub.innerHTML      = 'Crea il tuo account Mnesti<br>sincronizzato su tutti i dispositivi';
      if (passEl) passEl.setAttribute('autocomplete', 'new-password');
    } else {
      btn.textContent    = 'Accedi →';
      toggle.innerHTML   = 'Nuovo utente? <a href="#" onclick="toggleLoginMode();return false;">Crea account</a>';
      sub.innerHTML      = 'Piano di studio personalizzato<br>Accedi o crea il tuo account';
      if (passEl) passEl.setAttribute('autocomplete', 'current-password');
    }
  };

  /* ── Sync chip helper ── */
  function _syncDot(st) { // 'synced' | 'syncing' | 'error' | ''
    const dot   = document.getElementById('syncStatusDot');
    const label = document.getElementById('syncChipLabel');
    const chip  = document.getElementById('syncChip');
    if (!dot) return;
    dot.className = 'sync-status-dot' + (st ? ' ' + st : '');
    const titles = { synced:'Dati sincronizzati ✓', syncing:'Sincronizzazione…', error:'Errore sync' };
    const labels = { synced:'Sync ✓', syncing:'Sync…', error:'Sync ✗' };
    if (chip)  chip.title  = titles[st] || 'Cloud sync';
    if (label) label.textContent = labels[st] || 'Sync';
  }

  /* ── Reveal body (removes anti-FOUC visibility:hidden) ── */
  function _showBody() {
    document.body.style.visibility = 'visible';
    document.body.classList.add('app-ready');
    // Allow splash to finish its minimum duration before dismissing
    if (window._splashDismissEarly) window._splashDismissEarly();
  }

  /* ── Hide login screen ── */
  function _hideLogin() {
    _showBody(); // ensure body is visible before fade starts
    const screen = document.getElementById('loginScreen');
    if (!screen || screen.style.display === 'none') return;
    screen.classList.add('fade-out');
    setTimeout(() => { screen.style.display = 'none'; }, 420);
  }

  /* ── Load data from Supabase into localStorage ── */
  async function _loadFromSupabase(userId) {
    if (!_sb) return false;
    try {
      // Only select columns guaranteed to exist in the schema
      const { data, error } = await _sb
        .from('user_data')
        .select('psico_state,psico_sources,psico_exam_info,psico_ai_plan,psico_objective,psico_exams_archive')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.warn('[Supabase] Load error:', error.message);
        return false;
      }
      if (!data) return false; // new user — nothing to restore

      let loaded = false;

      if (data.psico_state) {
        const remote = data.psico_state;
        // __apiKey was previously piggybacked here — strip it if present in old records
        if (remote.__apiKey) delete remote.__apiKey;
        if (remote.__lastDay) {
          localStorage.setItem('psico_last_day', remote.__lastDay);
          delete remote.__lastDay;
        }

        // ── Merge: never discard local progress with stale cloud data ──
        // For each day take the max of: totalSeconds, feedbacks, answers.
        // This protects against page refresh overwriting a live session.
        let local = {};
        try { local = JSON.parse(localStorage.getItem('psico_state') || '{}'); } catch(e) {}
        const STATUS_RANK = { done: 3, partial: 2, skip: 1, '': 0 };
        Object.keys(local).forEach(dayId => {
          if (!remote[dayId]) { remote[dayId] = local[dayId]; return; }
          const L = local[dayId], R = remote[dayId];
          // Hours: always keep the higher value
          R.totalSeconds = Math.max(L.totalSeconds || 0, R.totalSeconds || 0);
          // Status: keep the most advanced
          const lRank = STATUS_RANK[L.status || ''] || 0;
          const rRank = STATUS_RANK[R.status  || ''] || 0;
          if (lRank > rRank) R.status = L.status;
          // Feedbacks / answers: keep whichever set is larger
          const lFB = Object.keys(L.feedbacks || {}).length;
          const rFB = Object.keys(R.feedbacks || {}).length;
          if (lFB > rFB) R.feedbacks = L.feedbacks;
          const lAns = Object.keys(L.answers || {}).length;
          const rAns = Object.keys(R.answers || {}).length;
          if (lAns > rAns) R.answers = L.answers;
          // Quiz best score: keep higher
          const lQS = L.quizBestScore?.score || 0;
          const rQS = R.quizBestScore?.score || 0;
          if (lQS > rQS) R.quizBestScore = L.quizBestScore;
          // Brain dump best: keep higher
          const lBD = L.brainDumpBest || 0;
          const rBD = R.brainDumpBest || 0;
          if (lBD > rBD) R.brainDumpBest = lBD;
        });

        localStorage.setItem('psico_state', JSON.stringify(remote));
        loaded = true;
      }
      if (data.psico_sources && Array.isArray(data.psico_sources) && data.psico_sources.length) {
        localStorage.setItem('psico_sources',   JSON.stringify(data.psico_sources));
        loaded = true;
      }
      if (data.psico_exam_info && Object.keys(data.psico_exam_info).length) {
        localStorage.setItem('psico_exam_info', JSON.stringify(data.psico_exam_info));
        loaded = true;
      }
      if (data.psico_ai_plan) {
        localStorage.setItem('psico_ai_plan',   JSON.stringify(data.psico_ai_plan));
        loaded = true;
      }
      if (data.psico_objective) {
        localStorage.setItem('psico_objective', data.psico_objective);
        loaded = true;
      }
      // Restore exam archive (list of completed/past exams)
      if (data.psico_exams_archive && Array.isArray(data.psico_exams_archive) && data.psico_exams_archive.length) {
        // Merge with any local archive (keep entries from both, prefer remote if same id)
        let localArchive = [];
        try { localArchive = JSON.parse(localStorage.getItem('psico_exams_archive') || '[]'); } catch {}
        const merged = [...data.psico_exams_archive];
        localArchive.forEach(localEntry => {
          if (!merged.find(r => r.id === localEntry.id)) merged.push(localEntry);
        });
        localStorage.setItem('psico_exams_archive', JSON.stringify(merged));
        loaded = true;

        // Fetch per-exam plans from user_exam_plans for any exam not already in localStorage
        const missingIds = data.psico_exams_archive
          .map(e => e.id)
          .filter(id => id && !localStorage.getItem('psico_ai_plan_' + id));
        if (missingIds.length) {
          const { data: examRows } = await _sb
            .from('user_exam_plans')
            .select('exam_id,plan_data,state_data,exam_info')
            .eq('user_id', userId)
            .in('exam_id', missingIds);
          if (examRows && examRows.length) {
            examRows.forEach(row => {
              if (row.plan_data)  localStorage.setItem('psico_ai_plan_' + row.exam_id,  JSON.stringify(row.plan_data));
              if (row.state_data) localStorage.setItem('psico_state_'   + row.exam_id,  JSON.stringify(row.state_data));
              if (row.exam_info)  localStorage.setItem('psico_exam_info_' + row.exam_id, JSON.stringify(row.exam_info));
            });
          }
        }
      }
      return loaded;
    } catch(e) {
      console.warn('[Supabase] Load exception:', e);
      return false;
    }
  }

  /* ── Push local data to Supabase ── */
  window._syncToSupabase = async function() {
    if (!_sb) return;
    const session = (await _sb.auth.getSession()).data.session;
    if (!session) return;

    _syncDot('syncing');

    function _parseLS(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    }

    // Never sync the Anthropic API key to Supabase — it must stay client-side only.
    // The claude-proxy manages the key server-side; storing it in the DB is a security risk.
    const statePayload = _parseLS('psico_state') || {};

    // Piggyback last visited day inside psico_state (no extra DB column needed)
    const lastDay = localStorage.getItem('psico_last_day');
    if (lastDay) statePayload.__lastDay = lastDay;

    const payload = {
      user_id:              session.user.id,
      psico_state:          statePayload,
      psico_sources:        _parseLS('psico_sources')        || [],
      psico_exam_info:      _parseLS('psico_exam_info')      || {},
      psico_ai_plan:        _parseLS('psico_ai_plan'),
      psico_objective:      localStorage.getItem('psico_objective') || 'pass',
      psico_exams_archive:  _parseLS('psico_exams_archive')  || [],
      updated_at:           new Date().toISOString()
    };

    try {
      const { error } = await _sb
        .from('user_data')
        .upsert(payload, { onConflict: 'user_id' });

      if (error) {
        console.warn('[Supabase] Sync error:', error.message);
        _syncDot('error');
        setTimeout(() => _syncDot(''), 4000);
      } else {
        _syncDot('synced');
      }
    } catch(e) {
      console.warn('[Supabase] Sync exception:', e);
      _syncDot('error');
      setTimeout(() => _syncDot(''), 4000);
    }
  };

  /* ── Post-auth bootstrap ── */
  let _bootstrapped = false;
  // Upsert the current exam info into user_exams so the admin dashboard
  // always sees correct counts, even for exams created before the table existed.
  function _syncExamInfoToSupabase(userId) {
    if (!_sb || !userId) return;
    try {
      const info = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
      const subject = (info.subject || '').trim();
      if (!subject) return;
      _sb.from('user_exams')
        .upsert(
          { user_id: userId, exam_name: subject, exam_date: info.date || null, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,exam_name' }
        )
        .then(({ error }) => { if (error) console.warn('[user_exams] sync failed:', error.message, error.details); })
        .catch(e => console.warn('[user_exams] sync error:', e));
    } catch(e) {
      console.warn('[user_exams] sync exception:', e);
    }
  }
  // Expose so generateStudyPlan (outside this IIFE) can call it after plan creation
  window._syncExamInfoToSupabase = _syncExamInfoToSupabase;

  let _logoutInProgress = false;
  async function _bootstrap(session, isNewLogin) {
    if (_bootstrapped) return;
    _bootstrapped = true;

    // Make user id globally available so getActiveDays() knows if we're authenticated
    window._currentUserId = session.user.id;

    if (isNewLogin) {
      // New login (email/password or email confirmation): load remote data first
      await _loadFromSupabase(session.user.id);
    }
    // Note: when isNewLogin=false (existing session on page load), _loadFromSupabase
    // was already called in the DOMContentLoaded handler BEFORE _bootstrap, so we
    // skip it here to avoid a redundant pull.

    _hideLogin();

    // Always land on the calendar overview after login — regardless of any
    // previous showDay() calls (e.g. from plan generation or last session).
    // buildPlanOverview handles the empty-plan state gracefully, so this is safe
    // to call unconditionally. The onboarding overlay (if needed) renders on top.
    if (typeof showPlanOverview === 'function') showPlanOverview();

    // Only push to Supabase if this is a new login (isNewLogin=true).
    // For existing sessions the load already happened and we don't want to
    // risk overwriting remote data with a stale local snapshot.
    if (isNewLogin) {
      await window._syncToSupabase();
    }

    // Backfill user_exams row so admin dashboard always counts correctly
    _syncExamInfoToSupabase(session.user.id);

    // Carica piano utente in background per il paywall check
    _loadUserPlan();

    // Good luck email on exam day at 08:00 (if conditions met)
    TimerRegistry.set('examGoodLuck', _checkExamDayGoodLuck, 5_000);

    // Check if new user needs onboarding (no exam date or no AI plan)
    const info      = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
    const plan      = localStorage.getItem('psico_ai_plan');
    const obSkipped = localStorage.getItem('psico_ob_skipped') === '1';
    const needsOb   = !obSkipped && (!info.date || !plan);

    if (needsOb) {
      // Give DOM a moment to settle before showing onboarding
      setTimeout(() => {
        if (typeof _showOnboarding === 'function') _showOnboarding();
      }, 400);
    } else if (!sessionStorage.getItem('ss_welcome_shown')) {
      setTimeout(() => {
        if (typeof showWelcomeModal === 'function') showWelcomeModal();
      }, 600);
    } else {
      setTimeout(() => {
        if (typeof window._maybeShowExamOutcomeModal === 'function') window._maybeShowExamOutcomeModal();
      }, 800);
      // No welcome modal this session: try PWA banner after a delay
      setTimeout(() => { if (typeof _tryShowPwaBanner === 'function') _tryShowPwaBanner(); }, 4000);
    }
  }

  /* ── doLogin (called by button) ── */
  window.doLogin = async function() {
    if (!_sb) {
      document.getElementById('loginError').textContent = 'Errore: SDK Supabase non caricato.';
      return;
    }
    const email    = (document.getElementById('loginEmail').value    || '').trim();
    const password = (document.getElementById('loginPassword').value || '').trim();
    const errEl    = document.getElementById('loginError');
    const btn      = document.getElementById('loginBtn');

    if (!email || !password) {
      errEl.textContent = 'Inserisci email e password.';
      return;
    }

    btn.disabled = true;
    btn.textContent = _loginMode === 'register' ? 'Creazione account…' : 'Accesso in corso…';
    errEl.textContent = '';

    try {
      let result;
      if (_loginMode === 'register') {
        const _redirectTo = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
          ? `${location.origin}/app.html`
          : 'https://mnesti.it/app.html';
        result = await _sb.auth.signUp({ email, password, options: { emailRedirectTo: _redirectTo } });
        if (!result.error && result.data?.user && !result.data.session) {
          // Email confirmation required
          errEl.style.color = '#27ae60';
          errEl.textContent = '✓ Controlla la tua email e clicca il link di conferma — verrai loggato automaticamente.';
          btn.disabled = false;
          btn.textContent = 'Crea account →';
          return;
        }
      } else {
        result = await _sb.auth.signInWithPassword({ email, password });
      }

      if (result.error) {
        const msg = result.error.message;
        errEl.style.color = '#e74c3c';
        errEl.textContent = msg.includes('Invalid login') ? 'Email o password non corretti.'
                          : msg.includes('Email not confirmed') ? 'Conferma la tua email prima di accedere.'
                          : msg;
        const inputEl = document.getElementById('loginPassword');
        inputEl.classList.add('shake');
        setTimeout(() => inputEl.classList.remove('shake'), 400);
        btn.disabled = false;
        btn.textContent = _loginMode === 'register' ? 'Crea account →' : 'Accedi →';
      } else {
        const loaded = await _loadFromSupabase(result.data.user.id);
        if (loaded && typeof window._reinitApp === 'function') window._reinitApp();
        _bootstrap(result.data.session, true);
      }
    } catch(e) {
      console.error('[Login] catch error:', e);
      const detail = e?.message || String(e);
      errEl.style.color = '#e74c3c';
      errEl.textContent = detail.toLowerCase().includes('fetch') || detail.toLowerCase().includes('network')
        ? 'Connessione a Supabase fallita. Controlla la rete o riprova.'
        : 'Errore: ' + detail.slice(0, 120);
      btn.disabled = false;
      btn.textContent = _loginMode === 'register' ? 'Crea account →' : 'Accedi →';
    }
  };

  /* ── Logout ── */
  window.doLogout = async function() {
    _logoutInProgress = true;
    TimerRegistry.clearAll(); // stop every timer before tearing down session
    window._currentUserId = null;
    try {
      if (_sb) await _sb.auth.signOut();
    } catch (e) {
      console.warn('[Logout] signOut:', e);
    }
    try {
      localStorage.removeItem('psico_state');
      localStorage.removeItem('anthropic_api_key');
    } catch (_) {}
    location.reload();
  };

  /* ── Detect email confirmation URL (PKCE ?code= or legacy #access_token) ── */
  function _isConfirmationUrl() {
    const params = new URLSearchParams(location.search);
    const hash   = new URLSearchParams(location.hash.slice(1));
    return params.has('code') ||
           (hash.get('type') === 'signup' && hash.has('access_token')) ||
           (hash.get('type') === 'recovery') ||
           params.get('type') === 'signup';
  }

  /* ── Check existing session on load ── */
  window.addEventListener('DOMContentLoaded', async () => {
    // Hide mic buttons when not in a secure context (HTTP)
    if (!window.isSecureContext) document.body.classList.add('no-secure-context');

    if (!_sb) { _showBody(); return; }

    // If URL contains a confirmation/recovery code, show spinner and wait for
    // onAuthStateChange to fire SIGNED_IN — do NOT show the login form.
    const isConfirming = _isConfirmationUrl();
    if (isConfirming) {
      const ls = document.getElementById('loginScreen');
      if (ls) ls.classList.add('email-confirming');
      _showBody();
    }

    try {
      const { data: { session } } = await _sb.auth.getSession();
      if (session) {
        window._currentUserId = session.user.id;
        const loaded = await _loadFromSupabase(session.user.id);
        if (loaded) {
          // Remote data populated localStorage — reinit the whole UI
          window._reinitApp();
        }
        _bootstrap(session, false);
      } else if (!isConfirming) {
        // No session and no confirmation in progress — show login screen
        _showBody();
        const loginEmail = document.getElementById('loginEmail');
        if (loginEmail) loginEmail.focus();
      }
      // If isConfirming + no session yet: wait for onAuthStateChange below
    } catch(e) {
      console.warn('[Supabase] Session check failed:', e);
      _showBody();
    }

    // Listen for auth state changes (token refresh, logout, email confirmation)
    _sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        if (!_logoutInProgress) location.reload();
      } else if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && session && !_bootstrapped) {
        // Remove confirming state if present
        const ls = document.getElementById('loginScreen');
        if (ls) ls.classList.remove('email-confirming');
        _loadFromSupabase(session.user.id).then(loaded => {
          if (loaded && typeof window._reinitApp === 'function') window._reinitApp();
          _bootstrap(session, true);
        });
      } else if (event === 'TOKEN_REFRESHED' && session) {
        window._syncToSupabase();
      }
    });
  });

  // Expose pull function so the cross-tab sync layer can call it
  window._loadFromSupabase = _loadFromSupabase;

})();
// ── App reinit after cloud data load ─────────────────────────
// Self-healing: fix plan exam date if it doesn't match psico_exam_info
function _healPlanExamDate() {
  try {
    const info = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
    if (!info.date) return;
    const planRaw = localStorage.getItem('psico_ai_plan');
    if (!planRaw) return;
    const plan = JSON.parse(planRaw);
    if (!plan || !Array.isArray(plan.days)) return;

    const examIso = info.date;
    const examInPlan = plan.days.find(d => d.date === examIso);
    const wrongExam  = plan.days.find(d => d.type === 'exam' && d.date !== examIso);

    // Nothing to fix
    if (examInPlan && examInPlan.type === 'exam' && !wrongExam) return;

    let changed = false;

    // Fix the wrongly-placed exam day
    if (wrongExam) {
      wrongExam.type = 'rest';
      wrongExam.questions = [];
      changed = true;
    }

    // Set the correct exam day
    if (examInPlan && examInPlan.type !== 'exam') {
      examInPlan.type = 'exam';
      examInPlan.questions = [];
      changed = true;
    }

    // Remove days that fall after the exam date
    const before = plan.days.length;
    plan.days = plan.days.filter(d => !d.date || d.date <= examIso);
    if (plan.days.length !== before) changed = true;

    if (changed) {
      console.info('[heal] Fixed exam date in plan:', examIso);
      _safeLSSet('psico_ai_plan', JSON.stringify(plan));
    }
  } catch(e) { console.warn('[heal] Failed to heal plan exam date', e); }
}

// Self-healing: ricostruisce psico_exam_info dal piano quando è vuoto/parziale.
// Il piano salva sempre subject/professor/examDate, quindi se il form "Dati esame"
// risulta vuoto ma un piano esiste, possiamo ripristinare i dati senza perdita.
// Difensivo: copre qualsiasi causa (sync race, switch esame, storage parziale).
function _healExamInfoFromPlan() {
  try {
    const planRaw = localStorage.getItem('psico_ai_plan');
    if (!planRaw) return;
    const plan = JSON.parse(planRaw);
    if (!plan || !plan.subject) return;

    let info = {};
    try { info = JSON.parse(localStorage.getItem('psico_exam_info') || '{}'); } catch { info = {}; }

    const planDate = plan.examDate
      || (Array.isArray(plan.days) ? (plan.days.find(d => d.type === 'exam') || {}).date : '')
      || '';

    if (info.subject && info.date) return; // niente da riparare

    const healed = {
      ...info,
      subject:   info.subject   || plan.subject   || '',
      professor: info.professor || plan.professor || '',
      date:      info.date      || planDate       || ''
    };

    if (healed.subject &&
        (healed.subject !== info.subject || healed.date !== info.date || healed.professor !== info.professor)) {
      console.info('[heal] Ricostruito psico_exam_info dal piano');
      _safeLSSet('psico_exam_info', JSON.stringify(healed));
    }
  } catch(e) { console.warn('[heal] _healExamInfoFromPlan failed', e); }
}

window._reinitApp = function() {
  // If user has an answer edit in progress, skip full DOM rebuild to avoid data loss.
  // Only do the lightweight state + progress updates; schedule a deferred full reinit.
  if (document.querySelector('.q-done-edit-area.open')) {
    try {
      const remote = JSON.parse(localStorage.getItem('psico_state') || '{}');
      _suppressAutoSave = true;
      Object.keys(state).forEach(k => delete state[k]);
      Object.assign(state, remote);
      _suppressAutoSave = false;
    } catch(e) { _suppressAutoSave = false; }
    if (typeof updateProgress     === 'function') updateProgress();
    if (typeof updateTotalHours   === 'function') updateTotalHours();
    if (typeof renderReadinessPanel === 'function') renderReadinessPanel();
    window._deferredReinit = true;
    return;
  }

  // Fix plan exam date if mismatched (self-heal)
  _healPlanExamDate();
  // Ripristina i dati esame dal piano se il form risulta vuoto (self-heal)
  _healExamInfoFromPlan();
  // Apply saved accent color
  if (typeof _loadAccentColor === 'function') _loadAccentColor();

  // Repopulate in-memory state from localStorage (written by _loadFromSupabase)
  try {
    const remote = JSON.parse(localStorage.getItem('psico_state') || '{}');
    _suppressAutoSave = true;
    Object.keys(state).forEach(k => delete state[k]);
    Object.assign(state, remote);
    _suppressAutoSave = false;
  } catch(e) { _suppressAutoSave = false; console.warn('[reinit] state parse failed', e); }

  // Recover any elapsed time from a session that ended without timerStop
  if (typeof _restoreTimerCheckpoint === 'function') _restoreTimerCheckpoint();

  // Rebuild all UI components from fresh localStorage
  applyTheme(localStorage.getItem('psico_theme') || 'dark');
  if (typeof buildNav  === 'function') buildNav();
  if (typeof buildDays === 'function') buildDays({ force: true });
  if (typeof updateProgress     === 'function') updateProgress();
  if (typeof updateTotalHours   === 'function') updateTotalHours();
  if (typeof updateApiIndicator === 'function') updateApiIndicator();
  if (typeof updateHeaderTitle  === 'function') updateHeaderTitle();
  if (typeof renderReadinessPanel === 'function') renderReadinessPanel();
  if (typeof updateSourcesBtn   === 'function') updateSourcesBtn();

  // Recompute statuses + locks
  if (typeof getActiveDays === 'function' && typeof _autoSetStatus === 'function') {
    getActiveDays().forEach(d => {
      if (d.type !== 'rest' && d.type !== 'exam') _autoSetStatus(d.id);
    });
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  if (typeof _refreshNavLocks === 'function') _refreshNavLocks();

  // Show plan calendar overview (rebuilt with fresh synced data)
  if (typeof buildPlanOverview === 'function' && typeof showPlanOverview === 'function') {
    buildPlanOverview();
    showPlanOverview();
  }
};
// ── End Supabase Auth ─────────────────────────────────────────

// ── Onboarding (new users) ────────────────────────────────────
function _needsOnboarding() {
  const info = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
  const plan = localStorage.getItem('psico_ai_plan');
  return !info.date || !plan;
}

function _showOnboarding(startStep) {
  const el = document.getElementById('obOverlay');
  if (!el) return;
  // Decide which step to open: if exam info already exists open step 2 directly
  const info = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
  const hasInfo = !!(info.subject && info.date);
  if (startStep === 2 || hasInfo) {
    _obGoStep2(true);
  } else {
    _obGoStep1(true);
  }
  el.classList.add('active');
  // Pre-fill form fields if data exists
  if (info.subject)   { const f = document.getElementById('obSubject');   if (f) f.value = info.subject; }
  if (info.professor) { const f = document.getElementById('obProfessor'); if (f) f.value = info.professor; }
  if (info.date)      { const f = document.getElementById('obDate');      if (f) f.value = info.date; }
  _obValidate();
  // Mostra "Salta per ora" se l'utente ha un piano attivo o esami in archivio
  const skipLink = document.getElementById('obSkipLink');
  if (skipLink) {
    const hasPlan    = !!localStorage.getItem('psico_ai_plan');
    const hasArchive = (() => {
      try { return JSON.parse(localStorage.getItem('psico_exams_archive') || '[]').length > 0; }
      catch { return false; }
    })();
    skipLink.style.display = (hasPlan || hasArchive) ? 'block' : 'none';
  }
  if (window.lucide) lucide.createIcons();
}

function _closeOnboarding() {
  const el = document.getElementById('obOverlay');
  if (!el) return;
  el.classList.remove('active');
}

function _obGoStep1(noAnim) {
  const s1 = document.getElementById('obS1');
  const s2 = document.getElementById('obS2');
  const d1 = document.getElementById('obDot1');
  const d2 = document.getElementById('obDot2');
  if (s1) { s1.style.display = ''; if (!noAnim) s1.style.animation = 'none', requestAnimationFrame(() => { s1.style.animation = ''; }); }
  if (s2) s2.style.display = 'none';
  if (d1) { d1.className = 'ob-dot active'; }
  if (d2) { d2.className = 'ob-dot'; }
}

function _obGoStep2(noAnim) {
  const s1 = document.getElementById('obS1');
  const s2 = document.getElementById('obS2');
  const d1 = document.getElementById('obDot1');
  const d2 = document.getElementById('obDot2');
  if (s1) s1.style.display = 'none';
  if (s2) { s2.style.display = ''; if (!noAnim) s2.style.animation = 'none', requestAnimationFrame(() => { s2.style.animation = ''; }); }
  if (d1) { d1.className = 'ob-dot done'; }
  if (d2) { d2.className = 'ob-dot active'; }
  // Re-render Lucide icons that may have just appeared
  if (window.lucide) lucide.createIcons();
  _obValidate();
}

// Tracks successfully processed files during onboarding
let _obPendingSources = [];

function _obValidate() {
  const subject     = (document.getElementById('obSubject')?.value  || '').trim();
  const date        = (document.getElementById('obDate')?.value     || '').trim();
  const hasSyllabus = (document.getElementById('obSyllabus')?.value || '').trim().length > 20;
  const hasFiles    = _obPendingSources.some(s => s.status === 'done');
  const hasBooks    = (document.getElementById('obBooks')?.value    || '').trim().length > 10;
  const cta         = document.getElementById('obCta');
  if (!cta) return;

  const hasExam = !!(subject && date);
  cta.disabled  = !hasExam;

  // Legacy hidden step bar (kept for JS compat)
  const s2 = document.getElementById('obStep2');
  const s3 = document.getElementById('obStep3');
  const s4 = document.getElementById('obStep4');
  if (s2) s2.className = 'ob-step' + (hasExam     ? ' done' : '');
  if (s3) s3.className = 'ob-step' + (hasSyllabus ? ' done' : '');
  if (s4) s4.className = 'ob-step' + (hasFiles    ? ' done' : '');

  // Source check-circle indicators
  _obUpdateSourceCheck('obSylCheck',   hasSyllabus);
  _obUpdateSourceCheck('obFilesCheck', hasFiles);
  _obUpdateSourceCheck('obBooksCheck', hasBooks);

  // Show/hide "+" hints
  const sylHint   = document.getElementById('obSylHint');
  const filesHint = document.getElementById('obFilesHint');
  const booksHint = document.getElementById('obBooksHint');
  if (sylHint)   sylHint.style.display   = hasSyllabus ? 'none' : '';
  if (filesHint) filesHint.style.display = hasFiles    ? 'none' : '';
  if (booksHint) booksHint.style.display = hasBooks    ? 'none' : '';

  // Accent border on checked source items
  const sylItem   = document.getElementById('obSylItem');
  const filesItem = document.getElementById('obFilesItem');
  const booksItem = document.getElementById('obBooksItem');
  if (sylItem)   sylItem.classList.toggle('checked-state',   hasSyllabus);
  if (filesItem) filesItem.classList.toggle('checked-state', hasFiles);
  if (booksItem) booksItem.classList.toggle('checked-state', hasBooks);

  // Quality meter
  _obUpdateQuality(hasExam, hasSyllabus, hasFiles, hasBooks);
}

function _obUpdateSourceCheck(id, filled) {
  const el = document.getElementById(id);
  if (!el) return;
  if (filled) {
    el.classList.add('checked');
    el.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  } else {
    el.classList.remove('checked');
    el.innerHTML = '';
  }
}

function _obUpdateQuality(hasExam, hasSyllabus, hasFiles, hasBooks) {
  const meter = document.getElementById('obQualityMeter');
  if (!meter) return;
  meter.style.display = hasExam ? '' : 'none';

  // Tier logic allineata a _calcSourceQualityTier:
  // Massima (4): programma + dispense + manuale
  // Ottima  (3): (programma + dispense) OR (programma + manuale)
  // Buona   (2): programma OR solo manuale
  // Base    (1): solo materia
  let tier = 1;
  if (hasSyllabus && hasFiles && hasBooks) tier = 4;
  else if (hasSyllabus && (hasFiles || hasBooks)) tier = 3;
  else if (hasSyllabus || hasBooks) tier = 2;

  const labels = _PLAN_QUALITY.map(q => q.label);

  for (let i = 1; i <= 4; i++) {
    const bar = document.getElementById('obQBar' + i);
    if (bar) {
      bar.classList.remove('active', 'prev');
      if (tier >= i) bar.classList.add(tier === i ? 'active' : 'prev');
    }
    const tierEl = document.getElementById('obQTier' + i);
    if (tierEl) {
      tierEl.classList.toggle('active',  tier >= i);
      tierEl.classList.toggle('current', tier === i);
    }
  }

  const badge = document.getElementById('obQualityBadge');
  if (badge) badge.textContent = labels[tier - 1];

  const hint = document.getElementById('obQualityHint');
  if (hint) {
    if (tier === 1) hint.textContent = 'Inserisci il programma del corso per generare domande mirate sulla tua materia.';
    else if (tier === 2) hint.textContent = 'Carica le dispense PDF oppure indica i manuali di testo per raggiungere la qualità Ottima.';
    else if (tier === 3) hint.textContent = hasSyllabus && hasFiles && !hasBooks
      ? 'Aggiungi i manuali di testo per citazioni precise di autori e capitoli.'
      : 'Carica le dispense PDF per domande ancora più mirate sul tuo materiale.';
    else hint.textContent = 'Qualità massima — il piano cita autori e capitoli specifici del tuo corso.';
  }
}

function _obToggleSyl() {
  const body = document.getElementById('obSylBody');
  const item = document.getElementById('obSylItem');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  item.classList.toggle('open', !isOpen);
  if (!isOpen && window.lucide) lucide.createIcons();
}

function _obToggleFiles() {
  const body = document.getElementById('obFilesBody');
  const item = document.getElementById('obFilesItem');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  item.classList.toggle('open', !isOpen);
  if (!isOpen && window.lucide) lucide.createIcons();
}

function _obToggleBooks() {
  const body = document.getElementById('obBooksBody');
  const item = document.getElementById('obBooksItem');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  item.classList.toggle('open', !isOpen);
  if (!isOpen && window.lucide) lucide.createIcons();
}

function _obHandleFileInput(input) {
  Array.from(input.files).forEach(_obQueueFile);
  input.value = '';
}

function _obHandleDrop(e) {
  e.preventDefault();
  document.getElementById('obUploadArea').classList.remove('drag-over');
  Array.from(e.dataTransfer.files).forEach(f => {
    if (/\.(pdf|txt|md)$/i.test(f.name)) _obQueueFile(f);
  });
}

function _obQueueFile(file) {
  const id = 'ob-' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  _obPendingSources.push({ id, name: file.name, status: 'processing', content: '', sizeBytes: file.size });
  _obRenderFilesList();
  _obProcessFile(id, file);
}

function _obRenderFilesList() {
  const list = document.getElementById('obFilesList');
  if (!list) return;
  list.innerHTML = _obPendingSources.map(s => {
    const icon  = s.status === 'done'       ? '✓'
                : s.status === 'error'      ? '✗'
                : '<div class="quiz-spinner quiz-spinner--inline" style="width:10px;height:10px" aria-hidden="true"></div>';
    const color = s.status === 'done' ? 'color:#27ae60' : s.status === 'error' ? 'color:#e74c3c' : '';
    const kb = Math.round(s.sizeBytes / 1024);
    return `<div class="ob-file-item ${s.status === 'processing' ? 'processing' : ''} ${s.status === 'error' ? 'error' : ''}">
      <span class="ob-file-status" style="${color}">${icon}</span>
      <span class="ob-file-name">${escHtml(s.name)}</span>
      <span class="ob-file-size">${kb > 1024 ? (kb/1024).toFixed(1)+'MB' : kb+'KB'}</span>
      ${s.status !== 'processing' ? `<button class="ob-file-remove" onclick="_obRemoveFile('${s.id}')" title="Rimuovi">×</button>` : ''}
    </div>`;
  }).join('');
}

function _obRemoveFile(id) {
  _obPendingSources = _obPendingSources.filter(s => s.id !== id);
  _obRenderFilesList();
  _obValidate();
}

async function _obProcessFile(id, file) {
  const bar  = document.getElementById('obExtractBar');
  const fill = document.getElementById('obExtractFill');
  const msg  = document.getElementById('obExtractMsg');
  const setProgress = (pct, text) => {
    if (bar)  { bar.style.display = 'block'; fill.style.width = pct + '%'; }
    if (msg)  { msg.style.display = 'block'; msg.textContent = text; }
  };

  try {
    let text = '';
    if (/\.pdf$/i.test(file.name)) {
      setProgress(10, `Lettura PDF: ${file.name}…`);
      const buffer = await file.arrayBuffer();
      setProgress(30, 'Estrazione testo…');
      const { text: direct } = await _extractPdfText(buffer);
      text = direct;
      if (text.length < 100) {
        setProgress(40, 'OCR in corso…');
        const { pdf } = await _extractPdfText(buffer);
        text = await _extractPdfTextOCR(pdf, (_, pct) => setProgress(40 + pct * 0.5, `OCR ${Math.round(pct)}%…`));
      }
      setProgress(95, 'Salvataggio…');
    } else {
      setProgress(30, `Lettura file: ${file.name}…`);
      text = await file.text();
      setProgress(95, 'Salvataggio…');
    }

    if (!text || text.trim().length < 20)
      throw new Error('Nessun testo estraibile. Il file potrebbe essere criptato o vuoto.');

    const src = _obPendingSources.find(s => s.id === id);
    if (src) { src.status = 'done'; src.content = text.slice(0, 14000); }
    setProgress(100, `✓ ${file.name} aggiunto`);
    setTimeout(() => { if (bar) bar.style.display = 'none'; if (msg) msg.style.display = 'none'; }, 1500);

  } catch(e) {
    const src = _obPendingSources.find(s => s.id === id);
    if (src) { src.status = 'error'; src.errorMsg = e.message; }
    if (bar) bar.style.display = 'none';
    if (msg) { msg.style.display = 'block'; msg.textContent = '✗ ' + e.message; msg.style.color = '#e74c3c'; }
  }

  _obRenderFilesList();
  _obValidate();
}

async function _runOnboarding() {
  const subject   = (document.getElementById('obSubject')?.value   || '').trim();
  const professor = (document.getElementById('obProfessor')?.value || '').trim();
  const date      = (document.getElementById('obDate')?.value      || '').trim();
  const syllabus  = (document.getElementById('obSyllabus')?.value  || '').trim();
  const books     = (document.getElementById('obBooks')?.value     || '').trim();
  const errEl     = document.getElementById('obError');

  if (!subject || !date) {
    if (errEl) errEl.textContent = 'Materia e data esame sono obbligatorie.';
    return;
  }

  const examDate = new Date(date);
  const today = new Date(); today.setHours(0,0,0,0);
  if (examDate <= today) {
    if (errEl) errEl.textContent = 'La data dell\'esame deve essere nel futuro.';
    return;
  }
  if (errEl) errEl.textContent = '';

  // 1. Save exam info
  _safeLSSet('psico_exam_info', JSON.stringify({ subject, professor, date }));

  // 2. Build sources array (both optional — included only if provided)
  const sources = [];
  if (syllabus.length > 20) {
    sources.push({
      id: 'ob-syllabus',
      title: 'Programma del corso',
      content: syllabus.slice(0, 14000),
      sizeBytes: syllabus.length,
      type: 'syllabus',
      addedAt: Date.now()
    });
  }
  const readyFiles = _obPendingSources.filter(s => s.status === 'done');
  readyFiles.forEach(f => {
    sources.push({
      id: f.id,
      title: f.name.replace(/\.(pdf|txt|md)$/i, ''),
      content: f.content,
      sizeBytes: f.sizeBytes,
      type: 'text',
      addedAt: Date.now()
    });
  });
  if (books.length > 10) {
    sources.push({
      id:           'ob-books',
      title:        'Manuali di testo',
      textbookTitle:'Manuali di testo',
      content:      books.slice(0, 8000),
      sizeBytes:    books.length,
      type:         'textbook-ref',   // fonte secondaria — conta per tier Massima
      addedAt:      Date.now()
    });
  }
  _safeLSSet('psico_sources', JSON.stringify(sources));

  // 3. Reset pending list, close onboarding, generate plan
  _obPendingSources = [];
  localStorage.removeItem('psico_ob_skipped'); // completed properly — clear skip flag
  _closeOnboarding();
  setTimeout(() => { if (typeof _tryShowPwaBanner === 'function') _tryShowPwaBanner(); }, 3000);
  await generateStudyPlan(true);
}

function _skipOnboarding() {
  _closeOnboarding();
  // Permanent skip flag — prevents onboarding from re-appearing on reload
  localStorage.setItem('psico_ob_skipped', '1');
  setTimeout(() => { if (typeof _tryShowPwaBanner === 'function') _tryShowPwaBanner(); }, 1500);
}

// "Salta per ora" — chiude l'onboarding e riporta all'esame corrente se esiste
function _skipOnboardingToExam() {
  _closeOnboarding();
  const activeDays = typeof getActiveDays === 'function' ? getActiveDays() : [];
  if (activeDays.length) {
    // Ha un piano attivo: torna al giorno di studio corrente
    if (typeof _resolveStartDay === 'function' && typeof showDay === 'function') {
      const target = _resolveStartDay();
      if (target) showDay(target.id);
    }
  } else {
    // Nessun piano attivo: apri l'archivio esami se ci sono esami salvati
    try {
      const archive = JSON.parse(localStorage.getItem('psico_exams_archive') || '[]');
      if (archive.length > 0 && typeof _openExamsArchive === 'function') {
        _openExamsArchive();
        return;
      }
    } catch {}
    // Nessun piano né archivio: imposta skip flag
    localStorage.setItem('psico_ob_skipped', '1');
  }
}
// ── End onboarding ────────────────────────────────────────────

const days = [
  {
    id: 'apr25', label: 'Sab 25 apr', shortLabel: '25/4',
    phaseStart: { num: 'Settimana 1', desc: 'Studio primario' },
    type: 'studio',
    title: 'Lezioni 1–2',
    subtitle: 'La Psicologia come Scienza · Il Metodo Scientifico',
    tip: 'Per ogni lezione: chiudi le slide, scrivi su un foglio tutto quello che ricordi, poi confronta con il materiale. Non rileggere — produci.',
    sections: [
      {
        tag: 'studio', label: 'Studio primario — 1.5h',
        title: 'Lez. 1 — La Psicologia come Scienza',
        ref: 'Slide pp. 1–7 · Feldman cap. 1',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1.5h',
        title: 'Lez. 2 — Il Metodo Scientifico',
        ref: 'Slide pp. 8–14 · Feldman cap. 1',
        content: null
      }
    ],
    questions: [
      { text: 'Cos\'è la psicologia cognitiva e quali processi studia? Descrivi le relazioni tra mente, cervello, corpo e ambiente.', type: 'definizione' },
      { text: 'Descrivi il contributo di Broca e Wernicke alla nascita della psicologia cognitiva. Perché i casi clinici da loro descritti sono importanti?', type: 'meccanismo' },
      { text: 'Quali sono le 5 fasi del metodo scientifico? Descrivile in ordine e spiega perché è importante seguire questo percorso invece di affidarsi al senso comune.', type: 'meccanismo' },
      { text: 'Cosa si intende per variabile indipendente e variabile dipendente in un esperimento? Fai un esempio concreto.', type: 'definizione' },
      { text: 'Qual è la differenza tra uno studio correlazionale e uno sperimentale? Quale dei due permette di stabilire relazioni di causa-effetto e perché?', type: 'connessione' },
      { text: 'Elenca e descrivi brevemente i principi etici fondamentali della ricerca in psicologia.', type: 'definizione' },
      { text: 'Cosa si intende per "doppia dissociazione" e perché è importante nello studio delle funzioni cognitive?', type: 'connessione' }
    ],
    notes: true
  },
  {
    id: 'apr26', label: 'Dom 26 apr', shortLabel: '26/4',
    type: 'studio',
    title: 'Lezioni 3–4 + Retrieval Lez. 1–2',
    subtitle: 'Tecniche di indagine · Misura · Retrieval prime due lezioni',
    tip: 'Il retrieval di ieri va fatto prima di studiare il nuovo materiale. Metti via il documento e rispondi a memoria alle domande di ieri.',
    sections: [
      {
        tag: 'retrieval', label: 'Retrieval — 30 min',
        title: 'Ripasso attivo Lez. 1–2',
        ref: 'Fai le domande del 25 apr prima di aprire le slide di oggi',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 3 — Le Tecniche di Indagine',
        ref: 'Slide pp. 15–23 · Feldman cap. 2',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 4 — La Misura in Psicologia Cognitiva',
        ref: 'Slide pp. 24–32 · Feldman cap. 2',
        content: null
      }
    ],
    questions: [
      { text: 'Cos\'è una neuroscienza? Quando nasce il termine e con quale obiettivo?', type: 'definizione' },
      { text: 'Descrivi le principali tecniche di neuroimaging (RM, PET, SPECT, EEG) e spiega cosa permette di misurare ciascuna.', type: 'meccanismo' },
      { text: 'Cosa si intende per stimolazione transcranica? Descrivi TMS e tDCS, spiegando come funzionano e quali effetti producono.', type: 'meccanismo' },
      { text: 'Cosa si intende per "mental test" o test psicologico? Quali condizioni deve soddisfare affinché sia considerato uno strumento di misura valido?', type: 'definizione' },
      { text: 'Descrivi le varie forme di validità di un test (di contenuto, rispetto a un criterio, di costrutto). Perché la validità di costrutto è considerata la più complessa?', type: 'meccanismo' },
      { text: 'Qual è la differenza tra conoscenza intuitiva e conoscenza mediante i test? Perché i test psicologici sono preferibili al giudizio del senso comune?', type: 'connessione' },
      { text: 'Cosa si intende per attendibilità di un test e come si misura?', type: 'definizione' }
    ],
    notes: true
  },
  {
    id: 'apr27', label: 'Lun 27 apr', shortLabel: '27/4',
    type: 'studio',
    title: 'Lezioni 5–6 + Retrieval Lez. 3–4',
    subtitle: 'Geni e comportamento · Cervello Prima Parte',
    tip: 'Attenzione alla lezione 5: il tema geni/ambiente è trasversale e torna in molte altre lezioni (intelligenza, apprendimento). Connettilo subito.',
    sections: [
      {
        tag: 'retrieval', label: 'Retrieval — 30 min',
        title: 'Ripasso attivo Lez. 3–4',
        ref: 'Domande del 26 apr da fare a memoria',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 5 — Geni, Ambiente e Comportamento',
        ref: 'Slide pp. 33–41 · Feldman cap. 3',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 6 — Cervello e Comportamento (Prima parte)',
        ref: 'Slide pp. 42–49 · Feldman cap. 3',
        content: null
      }
    ],
    questions: [
      { text: 'Qual è la differenza tra genotipo e fenotipo? Perché genotipo e fenotipo non sono mai una copia l\'uno dell\'altro?', type: 'definizione' },
      { text: 'Cosa si intende per ereditabilità? Come si stima l\'influenza genetica e cosa ci dicono gli studi sui gemelli?', type: 'meccanismo' },
      { text: 'Quali sono le determinanti del comportamento? Geni e ambiente possono essere considerati fattori separati?', type: 'connessione' },
      { text: 'Descrivi la struttura di un neurone: soma, dendriti, assone. Qual è la funzione di ciascuna parte?', type: 'definizione' },
      { text: 'Cosa sono le cellule gliali e quale funzione svolgono nel sistema nervoso?', type: 'definizione' },
      { text: 'Descrivi le fasi dell\'attività elettrica di un neurone: potenziale di riposo, potenziale d\'azione, fase di refrattarietà.', type: 'meccanismo' },
      { text: 'Cosa sono i neurotrasmettitori e come agiscono sulla sinapsi? Fai almeno due esempi.', type: 'meccanismo' }
    ],
    notes: true
  },
  {
    id: 'apr28', label: 'Mar 28 apr', shortLabel: '28/4',
    type: 'studio',
    title: 'Lezioni 7–8 + Retrieval Lez. 5–6',
    subtitle: 'Cervello Seconda Parte · Presupposti Teorici',
    tip: 'La lezione 8 è teoricamente densa: Cognitivismo, HIP, TOTE, Modularismo, Connessionismo. Costruisci una mappa schematica mentre studi.',
    sections: [
      {
        tag: 'retrieval', label: 'Retrieval — 30 min',
        title: 'Ripasso attivo Lez. 5–6',
        ref: 'Domande del 27 apr da fare a memoria',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 7 — Cervello e Comportamento (Seconda parte)',
        ref: 'Slide pp. 49–54 · Feldman cap. 3',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 8 — I Principali Presupposti Teorici',
        ref: 'Slide pp. 55–64 · Feldman cap. 1',
        content: null
      }
    ],
    questions: [
      { text: 'Descrivi le tre parti principali del cervello (rombencefalo, mesencefalo, prosencefalo) e le strutture contenute in ciascuna.', type: 'meccanismo' },
      { text: 'Cos\'è il sistema limbico? Quali strutture lo compongono e quali funzioni svolge?', type: 'definizione' },
      { text: 'Qual è il ruolo dell\'ippocampo e dell\'amigdala rispettivamente? Come si differenziano nelle loro funzioni?', type: 'connessione' },
      { text: 'Cos\'è il cognitivismo e quando nasce? Chi è considerato il suo padre fondatore?', type: 'definizione' },
      { text: 'Descrivi il modello Human Information Processing (HIP): come viene elaborata l\'informazione secondo questo modello?', type: 'meccanismo' },
      { text: 'Cos\'è il modularismo secondo Fodor? Distingui tra sistemi di input e sistemi centrali.', type: 'meccanismo' },
      { text: 'Qual è la differenza tra modularismo e connessionismo come approcci teorici alla cognizione?', type: 'connessione' }
    ],
    notes: true
  },
  {
    id: 'apr29', label: 'Mer 29 apr', shortLabel: '29/4',
    type: 'studio',
    title: 'Lezioni 9–10 + Retrieval Lez. 7–8',
    subtitle: 'Sensazione e Percezione Prima e Seconda Parte',
    tip: 'Sensazione e percezione si estendono su tre lezioni — cerca il filo conduttore: come lo stimolo fisico diventa esperienza percettiva.',
    sections: [
      {
        tag: 'retrieval', label: 'Retrieval — 30 min',
        title: 'Ripasso attivo Lez. 7–8',
        ref: 'Domande del 28 apr da fare a memoria',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 9 — Sensazione e Percezione (Prima parte)',
        ref: 'Slide pp. 65–75 · Feldman cap. 4',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 10 — Sensazione e Percezione (Seconda parte)',
        ref: 'Slide pp. 76–87 · Feldman cap. 4',
        content: null
      }
    ],
    questions: [
      { text: 'Descrivi il processo che trasforma una sensazione in percezione: dal recettore sensoriale alla rappresentazione neurale.', type: 'meccanismo' },
      { text: 'Cosa sono i processi bottom-up e top-down nella percezione? Fai un esempio per ciascuno.', type: 'definizione' },
      { text: 'Descrivi i tre esperimenti citati nella lezione 9 sulla percezione e cosa dimostrano ciascuno.', type: 'meccanismo' },
      { text: 'Come funziona la trasduzione visiva? Descrivi il ruolo di bastoncelli, coni e fotopigmenti.', type: 'meccanismo' },
      { text: 'Descrivi la teoria della doppia analisi nella percezione del colore. Come combina la teoria tricromatica con quella dei processi opposti?', type: 'connessione' },
      { text: 'Qual è la funzione del nervo ottico e cosa si intende per punto cieco?', type: 'definizione' },
      { text: 'Cosa sono i fotopigmenti e come agiscono nella conversione della luce in segnale nervoso?', type: 'meccanismo' }
    ],
    notes: true
  },
  {
    id: 'apr30', label: 'Gio 30 apr', shortLabel: '30/4',
    type: 'studio',
    title: 'Lezioni 11–12 + Retrieval Lez. 9–10',
    subtitle: 'Sensazione e Percezione Terza Parte · Attenzione e Coscienza',
    tip: 'La lezione 12 sulla coscienza è concettualmente difficile. Concentrati sui tipi di attenzione e su come si misurano gli stati di coscienza.',
    sections: [
      {
        tag: 'retrieval', label: 'Retrieval — 30 min',
        title: 'Ripasso attivo Lez. 9–10',
        ref: 'Domande del 29 apr da fare a memoria',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 11 — Sensazione e Percezione (Terza parte)',
        ref: 'Slide pp. 88–99 · Feldman cap. 4',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 12 — Attenzione e Coscienza',
        ref: 'Slide pp. 90–99 · Feldman cap. 5',
        content: null
      }
    ],
    questions: [
      { text: 'Cos\'è il New Look on Perception e quando emerge? Qual è l\'apporto del costruttivismo di Bruner a questa corrente?', type: 'definizione' },
      { text: 'In che senso la percezione è "relativa" secondo il New Look? Cosa influenza i nostri schemi cognitivi?', type: 'connessione' },
      { text: 'Come si definisce la coscienza in psicologia cognitiva? Quali sono le sue caratteristiche principali?', type: 'definizione' },
      { text: 'Descrivi le differenze tra attenzione selettiva, attenzione divisa e attenzione sostenuta.', type: 'meccanismo' },
      { text: 'Come si misurano gli stati di coscienza? Quali strumenti e metodi vengono utilizzati?', type: 'meccanismo' },
      { text: 'Perché abbiamo la coscienza? Quali funzioni adattive svolge secondo la prospettiva cognitiva?', type: 'connessione' },
      { text: 'Qual è la differenza tra il processo bottom-up e top-down nella percezione e come si collega alla coscienza?', type: 'connessione' }
    ],
    notes: true
  },
  {
    id: 'mag1', label: 'Ven 1 mag', shortLabel: '1/5',
    type: 'rest',
    title: 'Festa — riposo',
    subtitle: 'Niente studio oggi'
  },
  {
    id: 'mag2', label: 'Sab 2 mag', shortLabel: '2/5',
    phaseStart: { num: 'Settimana 2', desc: 'Studio · Revisione spaziata' },
    type: 'studio',
    title: 'Lezioni 13–14 + Retrieval Lez. 11–12',
    subtitle: 'Apprendimento · Memoria Prima Parte',
    tip: 'L\'apprendimento è il cuore della psicologia cognitiva. Nota come i meccanismi che studi (condizionamento, ecc.) si collegano alla tua esperienza diretta di apprendimento.',
    sections: [
      {
        tag: 'retrieval', label: 'Retrieval — 30 min',
        title: 'Ripasso attivo Lez. 11–12',
        ref: 'Domande del 30 apr da fare a memoria',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 13 — Apprendimento: Il Ruolo dell\'Esperienza',
        ref: 'Slide pp. 100–110 · Feldman cap. 5',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 14 — La Memoria (Prima parte)',
        ref: 'Slide pp. 111–124 · Feldman cap. 6',
        content: null
      }
    ],
    questions: [
      { text: 'Come si definisce l\'apprendimento in psicologia cognitiva? Qual è la differenza tra adattamento all\'ambiente ed evoluzione?', type: 'definizione' },
      { text: 'Descrivi il condizionamento classico di Pavlov: stimolo condizionato, incondizionato, risposta condizionata. Fai un esempio.', type: 'meccanismo' },
      { text: 'Cos\'è il condizionamento operante? Descrivi il ruolo del rinforzo e della punizione secondo Skinner.', type: 'meccanismo' },
      { text: 'Cosa dice la legge dell\'effetto di Thorndike? Come si collega al condizionamento operante?', type: 'connessione' },
      { text: 'Come cambia il concetto di apprendimento nella prospettiva cognitivista rispetto a quella comportamentista?', type: 'connessione' },
      { text: 'Descrivi il modello di Atkinson e Shiffrin della memoria. Quali sono i tre sistemi di memoria?', type: 'meccanismo' },
      { text: 'Cos\'è la memoria di lavoro secondo Baddeley? Quali componenti la costituiscono e quale funzione svolge ciascuna?', type: 'definizione' }
    ],
    notes: true
  },
  {
    id: 'mag3', label: 'Dom 3 mag', shortLabel: '3/5',
    type: 'rest',
    title: 'Domenica — riposo',
    subtitle: 'Giornata libera. Niente studio.'
  },
  {
    id: 'mag4', label: 'Lun 4 mag', shortLabel: '4/5',
    type: 'studio',
    title: 'Lezioni 15–16 + Revisione Lez. 1–4',
    subtitle: 'Memoria Seconda Parte · Linguaggio · Prima revisione spaziata',
    tip: 'La revisione spaziata di oggi sulle lezioni 1–4 è rapida: 30 minuti, solo titoli e parole chiave. L\'obiettivo non è ristudiarle, ma riattivare la traccia mnemonica.',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 30 min',
        title: 'Revisione Lez. 1–4',
        ref: 'Scorri solo i concetti chiave. Per ogni lezione: scrivi 5 parole chiave senza guardare, poi verifica.',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 15 — La Memoria (Seconda parte)',
        ref: 'Slide pp. 125–134 · Feldman cap. 6',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 16 — Il Linguaggio',
        ref: 'Slide pp. 135–144 · Feldman cap. 7',
        content: null
      }
    ],
    questions: [
      { text: 'Descrivi le tre fasi della memoria: codifica, ritenzione/immagazzinamento, recupero. Cosa avviene in ciascuna?', type: 'meccanismo' },
      { text: 'Cos\'è la teoria della profondità della codifica di Craik e Lockhart (1972)? Quali sono i tre livelli di elaborazione?', type: 'definizione' },
      { text: 'Come gli schemi mentali influenzano la codifica e il recupero delle informazioni secondo Bartlett?', type: 'meccanismo' },
      { text: 'Qual è la differenza tra richiamo e riconoscimento nel recupero della memoria? Quale è più efficiente e perché?', type: 'connessione' },
      { text: 'Descrivi la struttura del linguaggio: grammatica, sintassi, semantica. Cosa distingue il linguaggio umano da altri sistemi di comunicazione?', type: 'definizione' },
      { text: 'Cos\'è la struttura superficiale e la struttura profonda del linguaggio? Fai un esempio di frase ambigua.', type: 'meccanismo' },
      { text: 'Come si comprende e si produce il discorso? Descrivi il ruolo dell\'elaborazione bottom-up e top-down nel linguaggio.', type: 'connessione' }
    ],
    notes: true
  },
  {
    id: 'mag5', label: 'Mar 5 mag', shortLabel: '5/5',
    type: 'studio',
    title: 'Lezioni 17–18 + Revisione Lez. 5–8',
    subtitle: 'Il Pensiero · Intelligenza · Revisione spaziata',
    tip: 'Il pensiero e l\'intelligenza sono lezioni ad alto rischio di domanda d\'esame. Studia bene le teorie (triarchica, intelligenze multiple, fluida/cristallizzata).',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 30 min',
        title: 'Revisione Lez. 5–8',
        ref: 'Neuroni, geni, presupposti teorici. 5 parole chiave per lezione senza guardare.',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 17 — Il Pensiero',
        ref: 'Slide pp. 145–158 · Feldman cap. 7',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 18 — Intelligenza',
        ref: 'Slide pp. 159–168 · Feldman cap. 8',
        content: null
      }
    ],
    questions: [
      { text: 'Cos\'è il pensiero in psicologia cognitiva? Quali funzioni adattive svolge?', type: 'definizione' },
      { text: 'Descrivi le fasi della soluzione di problemi. Qual è il ruolo degli schemi nella risoluzione dei problemi?', type: 'meccanismo' },
      { text: 'Qual è la differenza tra ragionamento deduttivo e induttivo? Fai un esempio per ciascuno.', type: 'connessione' },
      { text: 'Descrivi la distinzione tra intelligenza fluida e cristallizzata introdotta da Cattell e Horn.', type: 'definizione' },
      { text: 'Cos\'è la teoria triarchica dell\'intelligenza di Sternberg? Descrivi le tre componenti.', type: 'meccanismo' },
      { text: 'Quali sono i due approcci principali allo studio dell\'intelligenza (psicometrico e dei processi cognitivi)? In cosa differiscono?', type: 'connessione' },
      { text: 'Descrivi il modello gerarchico di Carroll: i tre livelli di capacità cognitive.', type: 'meccanismo' }
    ],
    notes: true
  },
  {
    id: 'mag6', label: 'Mer 6 mag', shortLabel: '6/5',
    type: 'studio',
    title: 'Lezioni 19–20 + Revisione Lez. 9–12',
    subtitle: 'Motivazione · Emozioni · Revisione spaziata',
    tip: 'Motivazione ed emozioni sono spesso collegate nelle domande d\'esame. Pensa a come i sistemi motivazionali si intrecciano con le risposte emotive.',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 30 min',
        title: 'Revisione Lez. 9–12',
        ref: 'Percezione, attenzione, coscienza. 5 parole chiave per lezione senza guardare.',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 19 — La Motivazione',
        ref: 'Slide pp. 169–181 · Feldman cap. 10',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1h',
        title: 'Lez. 20 — Emozioni',
        ref: 'Slide pp. 182–193 · Feldman cap. 10',
        content: null
      }
    ],
    questions: [
      { text: 'Cos\'è la motivazione? Descrivi il meccanismo omeostatico e come si collega alla teoria delle pulsioni di Clark Hull.', type: 'definizione' },
      { text: 'Descrivi la teoria di Hebb sull\'attivazione ottimale. Qual è il livello di stimolazione ideale per il comportamento?', type: 'meccanismo' },
      { text: 'Cosa sono il BAS e il BIS? Come si differenziano nelle loro funzioni motivazionali?', type: 'definizione' },
      { text: 'Descrivi la piramide di Maslow: quali sono i cinque livelli di bisogno e come si organizzano gerarchicamente?', type: 'meccanismo' },
      { text: 'Quali sono i correlati neurali della motivazione? Quale ruolo svolge la dopamina?', type: 'connessione' },
      { text: 'Descrivi le strutture cerebrali coinvolte nelle emozioni: insula, nucleo accumbens, corteccia anteriore del cingolo, corteccia orbitofrontale.', type: 'meccanismo' },
      { text: 'Come la corteccia prefrontale è coinvolta nella regolazione emotiva? Qual è il suo rapporto con il sistema limbico?', type: 'connessione' }
    ],
    notes: true
  },
  {
    id: 'mag7', label: 'Gio 7 mag', shortLabel: '7/5',
    type: 'studio',
    title: 'Lezione 21 + Revisione Lez. 13–16',
    subtitle: 'Mente e Comportamento Sociale · Revisione spaziata',
    tip: 'Hai completato lo studio di tutto il programma. Da domani si entra nella fase di consolidamento intensivo.',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 30 min',
        title: 'Revisione Lez. 13–16',
        ref: 'Apprendimento, memoria, linguaggio. 5 parole chiave per lezione senza guardare.',
        content: null
      },
      {
        tag: 'studio', label: 'Studio primario — 1.5h',
        title: 'Lez. 21 — Mente e Comportamento Sociale',
        ref: 'Slide pp. 194–204 · Feldman cap. 14',
        content: null
      }
    ],
    questions: [
      { text: 'Cos\'è la cognizione sociale? Come si formano le prime impressioni sugli altri?', type: 'definizione' },
      { text: 'Cos\'è l\'Halo Effect (effetto alone)? Descrivi il meccanismo e fai un esempio.', type: 'definizione' },
      { text: 'Cosa dice la teoria dello scambio sociale? Come influenza la formazione e il mantenimento delle relazioni?', type: 'meccanismo' },
      { text: 'Cos\'è l\'attrattività e quale ruolo svolge nell\'effetto di matching nelle relazioni romantiche?', type: 'connessione' },
      { text: 'Cos\'è l\'altruismo in psicologia cognitiva? Come si distingue dal comportamento prosociale generico?', type: 'definizione' },
      { text: 'Cos\'è l\'empatia e quali aree cerebrali sono coinvolte nella cognizione sociale?', type: 'connessione' },
      { text: 'Descrivi la teoria di Sternberg sull\'amore: quali componenti lo costituiscono?', type: 'meccanismo' }
    ],
    notes: true
  },
  {
    id: 'mag8', label: 'Ven 8 mag', shortLabel: '8/5',
    phaseStart: { num: 'Fase finale', desc: 'Consolidamento intensivo' },
    type: 'revisione',
    title: 'Revisione Lez. 1–7 + Retrieval intensivo',
    subtitle: 'Prima metà del programma — consolidamento',
    tip: 'Oggi niente studio nuovo. Solo recupero. Per ogni blocco di domande: scrivi la risposta per intero, come se fossi all\'esame. Non rispondere a parole — scrivi.',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 1.5h',
        title: 'Revisione Lez. 1–7',
        ref: 'Psicologia, metodo, tecniche, misura, geni, cervello I e II',
        content: null
      },
      {
        tag: 'retrieval', label: 'Retrieval scritto — 1.5h',
        title: 'Domande simulate esame su Lez. 1–7',
        ref: 'Rispondi per iscritto come all\'esame. Almeno 3 domande complete.',
        content: null
      }
    ],
    questions: [
      { text: 'SIMULAZIONE ESAME: Descrivi le origini della psicologia cognitiva, dal contributo di Broca e Wernicke al cognitivismo degli anni \'50. Quali sono i principali presupposti teorici?', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Qual è la differenza tra metodo correlazionale e sperimentale? Descrivi come si costruisce un esperimento in psicologia cognitiva.', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Descrivi la struttura e il funzionamento del neurone, includendo l\'attività elettrica e la trasmissione sinaptica.', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Cos\'è un test psicologico e quali condizioni deve soddisfare per essere considerato uno strumento di misura valido?', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Descrivi le strutture cerebrali coinvolte nelle funzioni cognitive (sistema limbico, lobi cerebrali, aree di Broca e Wernicke).', type: 'simulazione' }
    ],
    notes: true
  },
  {
    id: 'mag9', label: 'Sab 9 mag', shortLabel: '9/5',
    type: 'revisione',
    title: 'Revisione Lez. 8–14 + Retrieval intensivo',
    subtitle: 'Seconda parte del programma — consolidamento',
    tip: 'Attenzione alle domande di connessione oggi: come si collegano apprendimento e memoria? Come il modello HIP si collega alla struttura della memoria?',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 1.5h',
        title: 'Revisione Lez. 8–14',
        ref: 'Presupposti teorici, percezione I-II-III, attenzione, apprendimento, memoria I',
        content: null
      },
      {
        tag: 'retrieval', label: 'Retrieval scritto — 1.5h',
        title: 'Domande simulate esame su Lez. 8–14',
        ref: 'Rispondi per iscritto come all\'esame. Almeno 3 domande complete.',
        content: null
      }
    ],
    questions: [
      { text: 'SIMULAZIONE ESAME: Descrivi il modello Human Information Processing e i principali presupposti del cognitivismo. Come si differenzia dal comportamentismo?', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Descrivi il processo percettivo dalla sensazione alla percezione. Qual è la differenza tra processi bottom-up e top-down?', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Cos\'è il condizionamento classico e come si differenzia dal condizionamento operante? Descrivi il contributo di Pavlov e Skinner.', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Descrivi i sistemi di memoria secondo Atkinson e Shiffrin. Qual è il ruolo della memoria di lavoro di Baddeley?', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Cos\'è la coscienza e come si distinguono le diverse forme di attenzione (selettiva, divisa, sostenuta)?', type: 'simulazione' }
    ],
    notes: true
  },
  {
    id: 'mag10', label: 'Dom 10 mag', shortLabel: '10/5',
    type: 'revisione',
    title: 'Revisione Lez. 15–21 + Retrieval finale',
    subtitle: 'Terza parte del programma — consolidamento finale',
    tip: 'Ultima giornata di studio intensivo. Dopo le 18:00 smetti di studiare. Il cervello consolida durante il riposo: non forzare.',
    sections: [
      {
        tag: 'revisione', label: 'Revisione spaziata — 1.5h',
        title: 'Revisione Lez. 15–21',
        ref: 'Memoria II, linguaggio, pensiero, intelligenza, motivazione, emozioni, mente sociale',
        content: null
      },
      {
        tag: 'retrieval', label: 'Retrieval scritto — 1.5h',
        title: 'Domande simulate esame su Lez. 15–21',
        ref: 'Rispondi per iscritto come all\'esame. Smetti alle 18:00.',
        content: null
      }
    ],
    questions: [
      { text: 'SIMULAZIONE ESAME: Descrivi le tre fasi della memoria (codifica, ritenzione, recupero) e la teoria della profondità della codifica di Craik e Lockhart.', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Descrivi la struttura del linguaggio (grammatica, sintassi, semantica) e il processo di comprensione del discorso.', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Cos\'è l\'intelligenza? Confronta l\'approccio psicometrico con quello dei processi cognitivi. Descrivi almeno due teorie (es. Sternberg, Cattell-Horn).', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Descrivi i meccanismi della motivazione: omeostatici, teoria delle pulsioni, teoria dell\'attivazione ottimale, piramide di Maslow.', type: 'simulazione' },
      { text: 'SIMULAZIONE ESAME: Cos\'è la cognizione sociale? Descrivi la formazione delle prime impressioni, l\'effetto alone e la teoria dello scambio sociale.', type: 'simulazione' }
    ],
    notes: true
  },
  {
    id: 'mag11', label: 'Lun 11 mag', shortLabel: '11/5',
    phaseStart: { num: 'Pre-esame', desc: 'Martedì 12 maggio' },
    type: 'rest',
    title: 'Lunedì — Riposo pre-esame',
    subtitle: 'Niente studio. Riposa, mangia bene, dormi presto. Domani è il grande giorno.'
  },
  {
    id: 'mag12', label: 'Mar 12 mag', shortLabel: '12/5',
    type: 'exam',
    title: 'ESAME — Martedì 12 maggio',
    subtitle: 'Psicologia Cognitiva — Prof. Serra'
  }
];

// ── Timer Registry ────────────────────────────────────────────
// Central manager for named timers and intervals.
// Replaces scattered clearTimeout/clearInterval calls with semantic IDs.
// Use clearSession() on session end, clearAll() on logout.
const TimerRegistry = {
  _t: new Map(), // timeouts
  _i: new Map(), // intervals

  /** Register or replace a named timeout. */
  set(id, fn, ms) {
    clearTimeout(this._t.get(id));
    const h = setTimeout(() => { this._t.delete(id); fn(); }, ms);
    this._t.set(id, h);
    return h;
  },

  /** Register or replace a named interval. */
  interval(id, fn, ms) {
    clearInterval(this._i.get(id));
    const h = setInterval(fn, ms);
    this._i.set(id, h);
    return h;
  },

  /** Cancel a named timeout. */
  clear(id) {
    clearTimeout(this._t.get(id));
    this._t.delete(id);
  },

  /** Cancel a named interval. */
  clearInterval(id) {
    clearInterval(this._i.get(id));
    this._i.delete(id);
  },

  /** Cancel session-bound timers (inactivity, modal countdowns, OCR pulse, auto-save). */
  clearSession() {
    ['inactivity', 'stillThere', 'autoSave'].forEach(id => this.clear(id));
    ['stillThereCountdown'].forEach(id => this.clearInterval(id));
  },

  /** Cancel every registered timer (use on logout). */
  clearAll() {
    this._t.forEach(h => clearTimeout(h));  this._t.clear();
    this._i.forEach(h => clearInterval(h)); this._i.clear();
  }
};

// ── Reactive state store ──────────────────────────────────────
// state is a recursive Proxy: any set/delete on state or its nested
// objects automatically triggers a debounced localStorage + Supabase save.
// Explicit saveState() calls still run the full render cycle on top.
// Set _suppressAutoSave = true during bulk loads to avoid spurious saves.
var _suppressAutoSave = false;

function _debouncedAutoSave() {
  if (_suppressAutoSave) return;
  TimerRegistry.set('autoSave', function() {
    try {
      _safeLSSet('psico_state', JSON.stringify(state));
      window._lastLocalWrite = Date.now();
      if (typeof _debouncedSync === 'function') _debouncedSync();
    } catch(e) { console.warn('[AutoSave] failed:', e); }
  }, 800);
}

function _makeReactiveState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  // Wrap existing nested plain objects recursively
  Object.keys(raw).forEach(function(k) {
    if (raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) {
      raw[k] = _makeReactiveState(raw[k]);
    }
  });
  return new Proxy(raw, {
    set: function(target, key, value) {
      // Wrap plain objects so nested mutations are also reactive
      target[key] = (value && typeof value === 'object' && !Array.isArray(value))
        ? _makeReactiveState(value)
        : value;
      _debouncedAutoSave();
      return true;
    },
    deleteProperty: function(target, key) {
      if (key in target) { delete target[key]; _debouncedAutoSave(); }
      return true;
    }
  });
}

const state = (function() {
  try {
    const raw = JSON.parse(localStorage.getItem('psico_state') || '{}');
    return _makeReactiveState(raw);
  } catch(e) {
    console.warn('[Storage] Corrupted psico_state, resetting');
    return _makeReactiveState({});
  }
})();

// ── Robust localStorage wrapper ───────────────────────────────
// Threshold for proactive localStorage warning (once per session)
const LS_WARN_KB  = 4_500; // warn at ~4.5 MB
const LS_CRIT_KB  = 5_500; // compact + warn at ~5.5 MB
let   _lsWarnShown = false;

function _safeLSSet(key, value) {
  // Proactive check: warn before the browser throws QuotaExceededError
  if (!_lsWarnShown) {
    const usedKB = _storageUsageKB();
    if (usedKB > LS_CRIT_KB) {
      _compactState();
      _showStorageWarning('⚠️ Spazio locale quasi esaurito (' + usedKB + ' KB). Rimuovi fonti PDF obsolete per evitare perdite di dati.');
      _lsWarnShown = true;
    } else if (usedKB > LS_WARN_KB) {
      _showStorageWarning('ℹ️ Spazio locale in esaurimento (' + usedKB + ' KB / ~5.000 KB). Valuta di rimuovere fonti PDF non più necessarie.');
      _lsWarnShown = true;
    }
  }
  try {
    localStorage.setItem(key, value);
    return true;
  } catch(e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22) {
      console.warn('[Storage] QuotaExceededError — attempting compact…');
      _lsWarnShown = false; // reset so next save re-evaluates
      _compactState();
      try {
        localStorage.setItem(key, value);
        _showStorageWarning('⚠️ Spazio quasi esaurito. Alcune vecchie risposte AI sono state compattate.');
        return true;
      } catch(e2) {
        _showStorageWarning('❌ Spazio di archiviazione pieno. Alcune fonti o risposte non potranno essere salvate. Rimuovi delle fonti PDF per liberare spazio.');
        return false;
      }
    }
    console.error('[Storage] Unexpected error:', e);
    return false;
  }
}

// Strip HTML from feedbacks to save space (~70% reduction per feedback)
function _compactState() {
  Object.keys(state).forEach(dayId => {
    const ds = state[dayId];
    if (!ds?.feedbacks) return;
    Object.keys(ds.feedbacks).forEach(idx => {
      const fb = ds.feedbacks[idx];
      if (fb?.html && !fb._compacted) {
        // Extract text content from HTML
        const tmp = document.createElement('div');
        tmp.innerHTML = fb.html;
        fb.text = tmp.textContent || '';
        delete fb.html;
        fb._compacted = true;
      }
    });
    // Also remove cached aiQuestions (regenerable from sources)
    if (ds.aiQuestions) delete ds.aiQuestions;
  });
}

function _showStorageWarning(msg) {
  let el = document.getElementById('storageWarning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'storageWarning';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#c0392b;color:#fff;padding:10px 18px;border-radius:8px;font-family:Inter,sans-serif;font-size:13px;max-width:90vw;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.3)';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

function _storageUsageKB() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k);
    if (v) total += (k.length + v.length) * 2; // UTF-16: 2 bytes per char
  }
  return Math.round(total / 1024);
}

// Debounced cloud sync — avoids hammering Supabase on every keystroke
function _debouncedSync() {
  TimerRegistry.set('sync', () => {
    if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  }, 1000); // 1s — reduces data-loss window on quick tab close
}

function saveState() {
  // Cancel any pending auto-save — we're doing a full explicit flush right now
  TimerRegistry.clear('autoSave');
  _safeLSSet('psico_state', JSON.stringify(state));
  updateProgress();
  renderReadinessPanel();
  // Mark timestamp so the sync engine knows local is authoritative for the next 30s
  window._lastLocalWrite = Date.now();
  _debouncedSync();
  _pwaNotifyStateChange();
}

// ══════════════════════════════════════════════════════════
// PWA CROSS-TAB / CROSS-WINDOW REAL-TIME SYNC
// ══════════════════════════════════════════════════════════
(function() {
  // ── BroadcastChannel (same browser, any tab/window same origin) ──
  const _bc = window.BroadcastChannel ? new BroadcastChannel('mnesti_sync') : null;
  let _ignoreNextStorage = false; // avoid echo when WE write localStorage
  let _lastPull = 0;
  const PULL_THROTTLE_MS = 20_000; // max 1 Supabase pull per 20s

  // Rebuild in-memory state + UI from current localStorage (no network)
  function _applyLocalState() {
    try {
      const remote = JSON.parse(localStorage.getItem('psico_state') || '{}');
      _suppressAutoSave = true;
      Object.keys(state).forEach(k => delete state[k]);
      Object.assign(state, remote);
      _suppressAutoSave = false;
    } catch(e) { _suppressAutoSave = false; }
    if (typeof updateProgress       === 'function') updateProgress();
    if (typeof renderReadinessPanel === 'function') renderReadinessPanel();
    if (typeof getActiveDays === 'function' && typeof renderDayReadiness === 'function') {
      getActiveDays().forEach(d => renderDayReadiness(d.id));
    }
    if (typeof _autoSetStatus === 'function') {
      getActiveDays().forEach(d => { if (d.type !== 'rest' && d.type !== 'exam') _autoSetStatus(d.id); });
    }
  }

  // Pull fresh data from Supabase then reinit
  async function _pullAndReinit() {
    if (!window._loadFromSupabase || !window._currentUserId) return;
    // If user has an answer edit in progress, never re-render the DOM.
    // Use the lightweight update and set a flag to do a full reinit once the edit closes.
    if (document.querySelector('.q-done-edit-area.open')) {
      _applyLocalState();
      window._deferredReinit = true;
      return;
    }
    // If local state was written in the last 30s, trust it — the async Supabase push
    // may not have committed yet, so pulling now would overwrite with stale remote data.
    // (e.g. "Genera domande" saves locally → sync in 1s async → user tabs out/back fast)
    const LOCAL_WRITE_GRACE_MS = 30_000;
    if (window._lastLocalWrite && Date.now() - window._lastLocalWrite < LOCAL_WRITE_GRACE_MS) {
      _applyLocalState();
      return;
    }
    if (Date.now() - _lastPull < PULL_THROTTLE_MS) { _applyLocalState(); return; }
    _lastPull = Date.now();
    try {
      const loaded = await window._loadFromSupabase(window._currentUserId);
      if (loaded && typeof window._reinitApp === 'function') window._reinitApp();
      else _applyLocalState();
    } catch(e) {
      console.warn('[PWASync] pull error', e);
      _applyLocalState();
    }
  }

  // Called by saveState() to notify other contexts
  window._pwaNotifyStateChange = function() {
    if (_bc) {
      try { _bc.postMessage({ type: 'state_changed', ts: Date.now() }); } catch(e) {}
    }
  };

  // Receive notifications from other tabs (same browser, same origin)
  if (_bc) {
    _bc.onmessage = function(e) {
      if (e.data?.type === 'state_changed') {
        // Another tab saved — pull from localStorage (already written there by the other tab)
        _applyLocalState();
      }
    };
  }

  // Fallback: localStorage 'storage' event fires in tabs that did NOT write the key
  window.addEventListener('storage', function(e) {
    if (e.key === 'psico_state' || e.key === 'psico_sources') {
      _applyLocalState();
    }
  });

  // On visibility restored: pull from Supabase (handles multi-device scenario)
  // Reset throttle so the first pull after a background period always fetches fresh data
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') return;
    _lastPull = 0; // always pull fresh on becoming visible
    _pullAndReinit();
  });

  // On window focus (PWA brought to foreground on desktop)
  window.addEventListener('focus', function() {
    _pullAndReinit();
  });

  // On coming back online after connectivity loss
  window.addEventListener('online', function() {
    _lastPull = 0; // force fresh pull
    _pullAndReinit();
  });
})();

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function saveAnswer(dayId, qIdx, value) {
  if (!state[dayId]) state[dayId] = {};
  if (!state[dayId].answers) state[dayId].answers = {};
  state[dayId].answers[qIdx] = value;
  saveState();
  renderDayReadiness(dayId);
  _autoSetStatus(dayId);
}

function _syncVerifyBtn(dayId, qIdx, value) {
  const btn = document.getElementById(`verify-${dayId}-${qIdx}`);
  const row = document.getElementById(`verify-row-${dayId}-${qIdx}`);
  const len = (value || '').trim().length;
  if (btn) btn.disabled = len < MIN_ANSWER_CHARS;
  if (row) row.classList.toggle('visible', len >= MIN_SHOW_VERIFY_CHARS);
}

function calcDayReadiness(dayId) {
  const day = getActiveDays().find(d => d.id === dayId);
  if (!day) return null;
  const dayState  = state[dayId] || {};
  // Use AI-generated questions if present, fall back to hardcoded ones
  const qList  = (dayState.aiQuestions && dayState.aiQuestions.length)
    ? dayState.aiQuestions : (day.questions || []);
  if (!qList.length) return null;
  const nTotal    = qList.length;
  const answers   = dayState.answers   || {};
  const feedbacks = dayState.feedbacks || {};

  const answered = Object.values(answers).filter(v => v && v.trim().length >= 10).length;

  // Segnale 1 — feedback risposte aperte (0..4)
  const gradeMap = { good: 4, partial: 2, poor: 1 };
  const totalPts = Object.values(feedbacks)
    .reduce((sum, f) => sum + (gradeMap[f.grade] || 0), 0);
  const feedbackLevel = totalPts / (nTotal * 4) * 4;   // 0..4

  // Segnale 2 — miglior punteggio quiz (0..4)
  const QUIZ_MAX  = 90;
  const quizBest  = dayState.quizBestScore;
  const quizLevel = quizBest ? Math.min(4, (quizBest.score / QUIZ_MAX) * 4) : null;

  // Segnale 3 — risposte scritte ma non ancora verificate (credito parziale basso)
  const unverifiedCount = answered - Object.keys(feedbacks).length;
  const answerCredit = unverifiedCount > 0
    ? Math.min(0.8, (unverifiedCount / nTotal) * 0.8) : 0;

  // Regole di combinazione:
  // • Verifica (feedback) è il segnale primario (peso 80%)
  // • Quiz: bonus secondario (peso 15%), max 1 barra senza feedback
  // • Risposte scritte non verificate: mini credito (max 1 barra) per mostrare engagement
  const hasFB  = Object.values(feedbacks).length > 0;
  const hasQZ  = quizLevel !== null;
  let rawLevel = 0;
  if      (hasFB && hasQZ) rawLevel = feedbackLevel * 0.80 + quizLevel * 0.15 + Math.min(0.2, answerCredit * 0.05);
  else if (hasFB)           rawLevel = feedbackLevel * 0.95 + Math.min(0.2, answerCredit * 0.05);
  else if (hasQZ)           rawLevel = Math.min(1, quizLevel * 0.25) + answerCredit * 0.3;
  else                      rawLevel = answerCredit; // max 0.8 → mai oltre 1a barra senza verifica

  const prepLevel = Math.min(4, Math.floor(rawLevel + 0.05));
  return { answered, total: nTotal, prepLevel };
}

function renderDayReadiness(dayId) {
  const el = document.getElementById('readiness-' + dayId);
  if (!el) return;
  const r = calcDayReadiness(dayId);
  if (!r) return;

  const bars = [1,2,3,4].map(i =>
    `<span class="day-prep-bar${i <= r.prepLevel ? ' lit' : ''}"></span>`
  ).join('');

  el.className = 'day-readiness' + (r.prepLevel > 0 ? ' prep-' + r.prepLevel : '');
  el.innerHTML =
    `<span class="day-prep-bars">${bars}</span>` +
    `<span class="day-completion-text">${r.answered}/${r.total}</span>`;
}

// ── Session Progress Ring ────────────────────────────────────
function _renderSessionRing(dayId, animate) {
  const wrap = document.getElementById('day-ring-' + dayId);
  if (!wrap) return;

  const dayState  = state[dayId] || {};
  const feedbacks = dayState.feedbacks || {};
  const answers   = dayState.answers   || {};
  const day       = getActiveDays().find(d => d.id === dayId);
  if (!day) return;

  const qList = dayState.aiQuestions || day.questions || [];
  const total = qList.length;
  if (!total) { wrap.style.display = 'none'; return; }

  // Weighted coverage: good=1.0, partial=0.6, poor=0.25, answered-unverified=0.08, unanswered=0
  const WEIGHT = { good: 1.0, partial: 0.6, poor: 0.25 };
  let weightedSum = 0;
  const dotStates = qList.map((q, i) => {
    const fb  = feedbacks[i];
    const ans = answers[i];
    if (fb) {
      weightedSum += WEIGHT[fb.grade] || 0;
      return fb.grade; // 'good' | 'partial' | 'poor'
    }
    if (ans && ans.trim().length > 15) {
      weightedSum += 0.08;
      return 'answered';
    }
    return 'empty';
  });

  const coveragePct = Math.round((weightedSum / total) * 100);
  const verified    = Object.keys(feedbacks).length;
  const quizBest    = dayState.quizBestScore;

  // Color gradient: red → orange → yellow → green
  const ringColor =
    coveragePct >= 75 ? '#27ae60' :
    coveragePct >= 50 ? '#2ecc71' :
    coveragePct >= 30 ? '#f39c12' :
    coveragePct >= 10 ? '#d35400' : 'var(--border)';

  // SVG arc
  const R = 52;
  const C = +(2 * Math.PI * R).toFixed(2);
  const offset = +(C * (1 - coveragePct / 100)).toFixed(2);

  // Progress label
  const label =
    coveragePct === 0  ? 'Inizia la sessione per registrare i progressi' :
    coveragePct < 25   ? 'Hai iniziato — continua a rispondere e a verificare' :
    coveragePct < 50   ? `Buon inizio — ${total - verified} domande ancora da verificare` :
    coveragePct < 75   ? 'Stai andando bene — mantieni la qualità delle risposte' :
    coveragePct < 90   ? 'Ottima progressione — quasi alla copertura completa' :
                         'Giornata quasi completata — consolida i punti deboli';

  const quizHtml = quizBest
    ? `<div class="prog-stat"><span class="prog-stat-val" style="font-size:16px;letter-spacing:-0.02em">${quizBest.score}<small style="font-size:11px;font-weight:600"> pt</small></span><span class="prog-stat-lbl">miglior quiz</span></div>`
    : '';

  const dotsHtml = dotStates.map((s, i) =>
    `<span class="prog-q-dot ${s !== 'empty' ? s : ''}" title="${qList[i]?.text?.substring(0,60) || ''}"></span>`
  ).join('');

  wrap.style.display = '';
  wrap.innerHTML = `
    <div class="session-ring-wrap">
      <div class="prog-ring-container">
        <svg class="prog-ring-svg" width="130" height="130" viewBox="0 0 130 130">
          <circle class="prog-ring-bg" cx="65" cy="65" r="${R}"/>
          <circle class="prog-ring-fill${animate ? ' pulse' : ''}" cx="65" cy="65" r="${R}"
            stroke="${ringColor}"
            stroke-dasharray="${C}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="prog-ring-center">
          <span class="prog-ring-pct" style="color:${ringColor}">${coveragePct}%</span>
          <span class="prog-ring-sub">giornata</span>
        </div>
      </div>
      <div class="prog-ring-info">
        <div class="prog-ring-label">${label}</div>
        <div class="prog-ring-stats">
          <div class="prog-stat">
            <span class="prog-stat-val">${verified}</span>
            <span class="prog-stat-lbl">verificate</span>
          </div>
          <div class="prog-stat">
            <span class="prog-stat-val">${total}</span>
            <span class="prog-stat-lbl">domande</span>
          </div>
          ${quizHtml}
        </div>
        <div class="prog-ring-dots">${dotsHtml}</div>
      </div>
    </div>`;
}

function updateHeaderTitle() {
  try {
    const hasPlan = !!localStorage.getItem('psico_ai_plan');
    const info    = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
    const titleEl = document.getElementById('headerTitle');
    const dateEl  = document.getElementById('headerExamDate');
    if (titleEl) {
      if (hasPlan && info.subject) {
        const parts = [info.subject];
        if (info.professor) parts.push('Prof. ' + info.professor);
        titleEl.textContent = parts.join(' — ');
      } else {
        titleEl.textContent = '';
      }
    }
    if (dateEl) {
      if (hasPlan && info.date) {
        const d = new Date(info.date);
        const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
        dateEl.textContent = 'Esame: ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
        dateEl.classList.add('visible');
      } else {
        dateEl.textContent = '';
        dateEl.classList.remove('visible');
      }
    }
  } catch(e) {}
}

function updateProgress() {
  const activeDays = getActiveDays();
  const studyDays = activeDays.filter(d => d.type !== 'rest' && d.type !== 'exam');
  const done  = studyDays.filter(d => state[d.id]?.status === 'done').length;
  const total = studyDays.length || 1;
  const pct   = Math.round((done / total) * 100);
  // These elements are kept hidden in the DOM for compat; null-safe either way
  const fill  = document.getElementById('progressFill');
  const label = document.getElementById('progressLabel');
  if (fill)  fill.style.width       = pct + '%';
  if (label) label.textContent      = done + ' / ' + total + ' giorni';
  updatePlanQualityWidget();
  updateMobileExamBanner();
}

function updateMobileExamBanner() {
  const banner = document.getElementById('mobileExamBanner');
  if (!banner) return;

  // ── Days to exam ──────────────────────────────────────────────
  let daysLeft = null;
  const info = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
  if (info.date) {
    const exam = new Date(info.date);
    const today = new Date(); today.setHours(0,0,0,0);
    daysLeft = Math.ceil((exam - today) / 86400000);
  } else {
    const examDay = getActiveDays().find(d => d.type === 'exam');
    if (examDay?.date) {
      const exam = new Date(examDay.date);
      const today = new Date(); today.setHours(0,0,0,0);
      daysLeft = Math.ceil((exam - today) / 86400000);
    }
  }

  // ── Readiness ─────────────────────────────────────────────────
  const r = calculateGlobalReadiness();
  const readiness = r?.score ?? 0;

  // ── Urgency class ─────────────────────────────────────────────
  const urgency = (daysLeft !== null && daysLeft <= 3) ? 'urgent'
                : (daysLeft !== null && daysLeft <= 7) ? 'soon' : '';
  banner.className = ('mobile-exam-banner ' + urgency).trim();

  // ── Big number ────────────────────────────────────────────────
  const numEl   = document.getElementById('mebNumber');
  const labelEl = document.getElementById('mebNumberLabel');
  if (numEl && labelEl) {
    if (daysLeft === null) {
      numEl.textContent  = '—';
      labelEl.innerHTML  = 'giorni<br>all\'esame';
    } else if (daysLeft <= 0) {
      numEl.textContent  = '!';
      labelEl.innerHTML  = 'oggi è<br>l\'esame';
    } else {
      numEl.textContent  = daysLeft;
      labelEl.innerHTML  = daysLeft === 1 ? 'giorno<br>all\'esame' : 'giorni<br>all\'esame';
    }
  }

  // ── Readiness pct ─────────────────────────────────────────────
  const pctEl = document.getElementById('mebReadinessPct');
  if (pctEl) pctEl.textContent = readiness + '%';

  // ── Progress bar ──────────────────────────────────────────────
  const barFill = document.getElementById('mebBarFill');
  if (barFill) setTimeout(() => { barFill.style.width = readiness + '%'; }, 120);

  // ── Motivational message ──────────────────────────────────────
  const msgEl = document.getElementById('mebMessage');
  if (msgEl) {
    let msg = '';
    if (daysLeft === null) {
      msg = 'Configura la data dell\'esame';
    } else if (daysLeft <= 0) {
      msg = readiness >= 63 ? 'Sei pronto. Vai e conquista!' : 'Dài tutto quello che hai!';
    } else if (daysLeft === 1) {
      msg = readiness >= 63 ? 'Ultima notte — sei in forma.' : 'Ripassa i punti chiave stasera.';
    } else if (daysLeft <= 3) {
      msg = readiness >= 63 ? 'Sei sulla buona strada, tienici.' : 'Spremi ogni sessione — conta!';
    } else if (daysLeft <= 7) {
      msg = readiness >= 42 ? 'La retta finale. Mantieni il ritmo.' : 'Alzati il ritmo, il tempo stringe.';
    } else {
      // Thresholds aligned with _readinessLevel(): 20 / 42 / 63 / 82
      if (readiness < 20)       msg = 'Ogni sessione è un passo avanti.';
      else if (readiness < 42)  msg = 'Ancora molto da fare. Ogni sessione conta.';
      else if (readiness < 63)  msg = 'In cammino. Mantieni il ritmo.';
      else if (readiness < 82)  msg = 'Stai andando forte. Sei in controllo.';
      else                      msg = 'Ben preparato. Mantieni il ritmo.';
    }
    msgEl.textContent = msg;
  }
}

// ── Global Readiness System ──────────────────────────────────

const OBJECTIVE_THRESHOLDS = { pass: 62, good: 76, excel: 88 };
const OBJECTIVE_LABELS      = { pass: 'Sufficiente', good: 'Buono', excel: 'Eccellenza' };
const GRADE_SCORE = { good: 1.0, partial: 0.50, poor: 0.20 };
const QUIZ_MAX = 90;

function getObjective() {
  return localStorage.getItem('psico_objective') || 'pass';
}
function setObjective(obj, e) {
  if (e) e.stopPropagation();
  _safeLSSet('psico_objective', obj);
  ['pass','good','excel'].forEach(k => {
    document.getElementById('obj-' + k)?.classList.toggle('active', k === obj);
  });
  renderReadinessPanel();
}

function calculateGlobalReadiness() {
  const activeDays = getActiveDays();
  const studyDays  = activeDays.filter(d => d.type !== 'rest' && d.type !== 'exam');
  if (!studyDays.length) return null;

  let totalQ = 0, answeredQ = 0, verifiedQ = 0;
  let qualitySum = 0;
  let quizScoreSum = 0, quizCount = 0;
  let bdScoreSum = 0, bdCount = 0;
  const weakTopics = [];

  studyDays.forEach(day => {
    const ds  = state[day.id] || {};
    const aiQs = ds.aiQuestions;
    const qList = aiQs || day.questions || [];
    const ans  = ds.answers   || {};
    const fbs  = ds.feedbacks || {};

    if (!qList.length) return;
    totalQ += qList.length;

    let dayVerified = 0, dayQualitySum = 0, dayAnswered = 0;
    qList.forEach((q, i) => {
      const hasAns = ans[i] && ans[i].trim().length > 15;
      if (hasAns) {
        answeredQ++; dayAnswered++;
        if (fbs[i]) {
          verifiedQ++; dayVerified++;
          const score = GRADE_SCORE[fbs[i].grade] ?? 0.5;
          qualitySum += score;
          dayQualitySum += score;
        } else {
          // answered but unverified: partial credit
          qualitySum += 0.18;
          dayQualitySum += 0.18;
        }
      }
    });

    // Track weak topics
    const dayAvg = dayAnswered > 0 ? dayQualitySum / dayAnswered : 0;
    if (dayAnswered > 0 && dayAvg < 0.55) {
      weakTopics.push({ title: day.title || day.label, avg: dayAvg });
    }

    // Quiz
    const qz = ds.quizBestScore;
    if (qz) {
      quizScoreSum += Math.min(1, qz.score / QUIZ_MAX);
      quizCount++;
    }
    // Brain Dump
    if (ds.brainDumpBest != null) {
      bdScoreSum += ds.brainDumpBest / 100;
      bdCount++;
    }
  });

  // Component scores (0-1)
  const coverageScore     = totalQ > 0 ? answeredQ / totalQ : 0;
  const qualityScore      = totalQ > 0 ? qualitySum / totalQ : 0;
  const engagementScore   = answeredQ > 0 ? verifiedQ / answeredQ : 0;
  const quizScore         = quizCount > 0 ? quizScoreSum / quizCount : null;
  const bdScore           = bdCount   > 0 ? bdScoreSum   / bdCount   : null;

  // Weighted composite — quality anchors the score, brain dump & quiz add breadth
  let raw;
  const hasQuiz = quizScore !== null;
  const hasBd   = bdScore   !== null;
  if (hasQuiz && hasBd) {
    raw = coverageScore * 0.15 + qualityScore * 0.45 + engagementScore * 0.10 + quizScore * 0.15 + bdScore * 0.15;
  } else if (hasQuiz) {
    raw = coverageScore * 0.18 + qualityScore * 0.52 + engagementScore * 0.10 + quizScore * 0.20;
  } else if (hasBd) {
    raw = coverageScore * 0.18 + qualityScore * 0.52 + engagementScore * 0.10 + bdScore   * 0.20;
  } else {
    raw = coverageScore * 0.20 + qualityScore * 0.65 + engagementScore * 0.15;
  }

  // University difficulty curve: harder to score high
  const calibrated = Math.pow(raw, 1.22) * 100;
  const score = Math.min(95, Math.round(calibrated));

  return {
    score,
    coverage:   Math.round(coverageScore * 100),
    quality:    Math.round(qualityScore  * 100),
    engagement: Math.round(engagementScore * 100),
    quiz:       quizScore !== null ? Math.round(quizScore * 100) : null,
    totalQ, answeredQ, verifiedQ, quizCount,
    weakTopics: weakTopics.sort((a,b) => a.avg - b.avg).slice(0, 2)
  };
}

function _readinessLevel(score) {
  if (score < 20) return 0;
  if (score < 42) return 1;
  if (score < 63) return 2;
  if (score < 82) return 3;
  return 4;
}

function _readinessText(score, obj) {
  const threshold = OBJECTIVE_THRESHOLDS[obj];
  const gap = threshold - score;

  if (score < 10)  return 'Inizia a rispondere alle domande e a verificarle per ottenere una valutazione.';
  if (score < 25)  return `Siamo all'inizio. Hai ancora molto lavoro davanti — ma è normale a quest'ora.`;
  if (score < 42)  return `Hai avviato la preparazione, ma la copertura degli argomenti è ancora parziale.`;
  if (score < 55)  return `Stai costruendo la base. Continua a rispondere e a verificare le risposte.`;
  if (score < 63)  return `Preparazione in corso. Approfondisci gli argomenti più deboli e fai quiz.`;
  if (gap > 15)    return `Sulla buona strada, ma l'obiettivo "${OBJECTIVE_LABELS[obj]}" richiede ancora impegno.`;
  if (gap > 5)     return `Quasi alla soglia per "${OBJECTIVE_LABELS[obj]}". Concentrati sulle lacune.`;
  if (gap > 0)     return `Molto vicino all'obiettivo. Pochi argomenti ancora da consolidare.`;
  if (score < 85)  return `Hai superato la soglia per "${OBJECTIVE_LABELS[obj]}". Mantieni il ritmo.`;
  if (score < 92)  return `Ben preparato. Fai simulazioni d'esame per il tocco finale.`;
  return `Preparazione eccellente. Sei pronto per l'esame.`;
}

function toggleReadinessDetail() {
  const det = document.getElementById('readinessDetail');
  const chev = document.getElementById('readinessChevron');
  if (!det) return;
  det.classList.toggle('open');
  if (chev) chev.classList.toggle('open', det.classList.contains('open'));
}

function renderReadinessPanel() {
  const r = calculateGlobalReadiness();
  const obj = getObjective();
  const threshold = OBJECTIVE_THRESHOLDS[obj];

  // Update objective buttons
  ['pass','good','excel'].forEach(k => {
    document.getElementById('obj-' + k)?.classList.toggle('active', k === obj);
  });

  const badge   = document.getElementById('readinessBadge');
  const barFill = document.getElementById('readinessBarFill');
  const label   = document.getElementById('readinessLabel');
  const advice  = document.getElementById('readinessAdvice');

  if (!r || r.totalQ === 0) {
    if (badge)   { badge.textContent = '—'; badge.className = 'readiness-score-badge level-0'; }
    if (barFill) { barFill.style.width = '0%'; barFill.className = 'readiness-bar-fill level-0'; }
    if (label)   label.textContent = 'Inizia a rispondere alle domande…';
    if (advice)  advice.innerHTML = 'Rispondi alle domande e fai verificare le tue risposte per ottenere una valutazione accurata.';
    return;
  }

  const lv = _readinessLevel(r.score);

  if (badge)   { badge.textContent = r.score + '%'; badge.className = `readiness-score-badge level-${lv}`; }
  if (barFill) { barFill.style.width = r.score + '%'; barFill.className = `readiness-bar-fill level-${lv}`; }

  const labelTexts = ['Non iniziato','Molto distante','In cammino','Sulla buona strada','Ben preparato'];
  if (label) label.textContent = labelTexts[lv];

  // Dimension bars
  const setDim = (id, val) => {
    const v = val !== null ? val : null;
    const valEl = document.getElementById('rdim-' + id + '-val');
    const barEl = document.getElementById('rdim-' + id + '-bar');
    if (valEl) valEl.textContent = v !== null ? v + '%' : '—';
    if (barEl) barEl.style.width = (v !== null ? v : 0) + '%';
  };
  setDim('coverage',  r.coverage);
  setDim('quality',   r.quality);
  setDim('quiz',      r.quiz);

  // Target marker
  const marker = document.getElementById('readinessTargetMarker');
  const tPct   = document.getElementById('readinessTargetPct');
  if (marker) marker.style.left = threshold + '%';
  if (tPct)   tPct.textContent  = `${threshold}% (${OBJECTIVE_LABELS[obj]})`;

  // Advice
  if (advice) {
    let html = _readinessText(r.score, obj);
    if (r.weakTopics.length) {
      const wList = r.weakTopics.map(t => `<strong>${t.title}</strong>`).join(', ');
      html += `<br><br>📌 Argomenti più deboli: ${wList}.`;
    }
    if (r.verifiedQ < r.answeredQ) {
      const unver = r.answeredQ - r.verifiedQ;
      html += `<br>⚡ Hai ${unver} risposta${unver > 1 ? 'e' : ''} non ancora verificata${unver > 1 ? '' : ''} — verifica per migliorare il punteggio.`;
    }
    if (r.quizCount === 0 && r.answeredQ > 0) {
      html += `<br>🎮 Non hai ancora fatto quiz — provali per rafforzare il punteggio.`;
    }
    advice.innerHTML = html;
  }
}

// ── Welcome modal ──────────────────────────────────────────────
function _greeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Sei un nottambulo 🌙';
  if (h < 12) return 'Buongiorno ☀️';
  if (h < 17) return 'Buon pomeriggio';
  if (h < 21) return 'Buona sera';
  return 'Buona serata 🌙';
}

function _motivationalMsg(daysLeft, readiness, obj) {
  const threshold = { pass: 62, good: 76, excel: 88 }[obj] || 62;
  const gap = threshold - readiness;

  if (daysLeft === null) {
    return 'Configura la data dell\'esame nel pannello Fonti per ricevere una stima personalizzata.';
  }
  if (daysLeft <= 0) return '🎓 Il giorno dell\'esame è arrivato. In bocca al lupo!';
  if (daysLeft === 1) return '⚡ Domani è l\'esame. Riposa bene stasera — hai fatto il tuo lavoro.';
  if (daysLeft <= 3) {
    return readiness >= threshold
      ? `✅ Sei alla soglia dell'obiettivo. Fai una revisione leggera, poi riposa.`
      : `⚠️ Poco tempo rimasto. Concentrati sugli argomenti più deboli e smetti di studiare entro le 21.`;
  }
  if (readiness < 10) return `Hai ancora ${daysLeft} giorni — un buon margine. Inizia oggi con le prime domande.`;
  if (gap > 25) return `Hai ${daysLeft} giorni davanti. È il momento di accelerare: cerca di coprire tutti gli argomenti.`;
  if (gap > 10) return `Ci stai arrivando. Con costanza nelle prossime sessioni puoi raggiungere l'obiettivo.`;
  if (gap > 0)  return `Sei vicino alla soglia. Ancora un piccolo sforzo e sei pronto.`;
  return `Ottima preparazione! Mantieni il ritmo e sfrutta i ${daysLeft} giorni rimasti per consolidare.`;
}

function showWelcomeModal() {
  const overlay = document.getElementById('welcomeOverlay');
  if (!overlay) return;

  // If the exam date is strictly in the past, hand off to the outcome modal
  // instead of showing "Oggi è il giorno dell'esame" for stale dates.
  const _preInfo = getExamInfo();
  if (_preInfo.date && _examDateHasPassed(_preInfo.date)) {
    window._maybeShowExamOutcomeModal?.();
    return;
  }

  // ── Exam days calculation ────────────────────────────────────
  const info = getExamInfo();
  let daysLeft = null;
  let examDateStr = '';
  if (info.date) {
    const exam = new Date(info.date);
    const today = new Date(); today.setHours(0,0,0,0);
    daysLeft = Math.ceil((exam - today) / 86400000);
    const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
    examDateStr = `${exam.getDate()} ${months[exam.getMonth()]} ${exam.getFullYear()}`;
    if (info.subject) examDateStr = `${info.subject} · ` + examDateStr;
  } else {
    const examDay = getActiveDays().find(d => d.type === 'exam');
    if (examDay?.date) {
      const exam = new Date(examDay.date);
      const today = new Date(); today.setHours(0,0,0,0);
      daysLeft = Math.ceil((exam - today) / 86400000);
    }
  }

  // ── Readiness + progress ──────────────────────────────────────
  const r = calculateGlobalReadiness();
  const readiness = r?.score ?? 0;
  const obj = getObjective();

  const activeDays = getActiveDays();
  const studyDays  = activeDays.filter(d => d.type !== 'rest' && d.type !== 'exam');
  const done  = studyDays.filter(d => state[d.id]?.status === 'done').length;
  const total = studyDays.length || 1;
  const progressPct = Math.round((done / total) * 100);

  // ── ① Greeting ────────────────────────────────────────────────
  document.getElementById('welcomeGreeting').textContent = _greeting();

  // ── ② Hero: days number ───────────────────────────────────────
  const heroNum   = document.getElementById('welcomeHeroNumber');
  const heroLabel = document.getElementById('welcomeHeroLabel');
  if (daysLeft === null) {
    heroNum.textContent = '—';
    heroNum.className   = 'welcome-hero-number good';
    heroLabel.innerHTML = 'giorni al tuo esame';
  } else if (daysLeft <= 0) {
    heroNum.textContent = '🤞';
    heroNum.className   = 'welcome-hero-number urgent emoji';
    heroLabel.innerHTML = '<strong>Oggi è il giorno dell\'esame</strong>';
  } else if (daysLeft === 1) {
    heroNum.textContent = '1';
    heroNum.className   = 'welcome-hero-number urgent';
    heroLabel.innerHTML = '<strong>giorno</strong> al tuo esame';
  } else {
    heroNum.textContent = daysLeft;
    const cls = daysLeft <= 3 ? 'urgent' : daysLeft <= 7 ? 'soon' : 'good';
    heroNum.className   = `welcome-hero-number ${cls}`;
    heroLabel.innerHTML = `giorni al tuo esame`;
  }

  // ── ③ Stats: readiness ────────────────────────────────────────
  const readinessEl  = document.getElementById('welcomeReadiness');
  const readinessBar = document.getElementById('welcomeReadinessBar');
  if (readinessEl) {
    readinessEl.textContent = readiness + '%';
    const lv = readiness < 20 ? 'red' : readiness < 45 ? 'orange' : readiness < 75 ? 'accent' : readiness < 88 ? 'green' : 'blue';
    readinessEl.className = `welcome-stat-value ${lv}`;
    if (readinessBar) {
      readinessBar.className = `welcome-mini-fill ${lv === 'accent' ? '' : lv}`.trim();
      setTimeout(() => { readinessBar.style.width = readiness + '%'; }, 100);
    }
  }

  // ── ③ Stats: plan progress ────────────────────────────────────
  const progEl  = document.getElementById('welcomeProgress');
  const progBar = document.getElementById('welcomeProgressFill');
  if (progEl) {
    progEl.textContent = `${done}/${total}`;
    const lv2 = done === 0 ? 'red' : done === total ? 'green' : 'accent';
    progEl.className = `welcome-stat-value ${lv2}`;
    if (progBar) {
      progBar.className = `welcome-mini-fill ${lv2 === 'accent' ? '' : lv2}`.trim();
      setTimeout(() => { progBar.style.width = progressPct + '%'; }, 150);
    }
  }

  // ── ④ Message ─────────────────────────────────────────────────
  const msgEl = document.getElementById('welcomeMessage');
  if (msgEl) msgEl.textContent = _motivationalMsg(daysLeft, readiness, obj);

  // ── Exam badge ────────────────────────────────────────────────
  const badgeEl   = document.getElementById('welcomeExamBadge');
  const dateLabel = document.getElementById('welcomeExamDate');
  if (badgeEl) {
    if (examDateStr) {
      badgeEl.classList.add('show');
      if (dateLabel) dateLabel.textContent = examDateStr;
    } else {
      badgeEl.classList.remove('show');
    }
  }

  // ── ⑤ CTA + secondary link (exam day vs normal) ──────────────
  const ctaBtn = document.getElementById('welcomeCloseBtn');
  const secLink = document.getElementById('welcomeSecondaryLink');
  if (daysLeft !== null && daysLeft <= 0) {
    if (ctaBtn) {
      ctaBtn.textContent = 'Crea nuovo esame';
      ctaBtn.onclick = () => { closeWelcomeModal(); _showOnboarding(); };
    }
    if (secLink) secLink.classList.add('show');
  } else {
    if (ctaBtn) {
      ctaBtn.textContent = 'Inizia a studiare →';
      ctaBtn.onclick = closeWelcomeModal;
    }
    if (secLink) secLink.classList.remove('show');
  }

  overlay.classList.add('open');
}

function closeWelcomeModal() {
  document.getElementById('welcomeOverlay')?.classList.remove('open');
  sessionStorage.setItem('ss_welcome_shown', '1');
  setTimeout(() => {
    if (typeof window._maybeShowExamOutcomeModal === 'function') window._maybeShowExamOutcomeModal();
  }, 450);
  // Try PWA banner after welcome modal closes
  setTimeout(_tryShowPwaBanner, 1200);
}

// ── PWA Install Banner ────────────────────────────────────────────────────────
(function() {
  const _isMobile    = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const _isIOS       = /iPad|iPhone|iPod/i.test(navigator.userAgent) && !window.MSStream;
  const _isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || !!navigator.standalone;

  let _deferredPrompt = null; // Android beforeinstallprompt event

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredPrompt = e;
  });

  function _anyModalOpen() {
    return !!(
      document.querySelector('.ob-overlay.active') ||
      document.getElementById('welcomeOverlay')?.classList.contains('open') ||
      document.getElementById('ahintModal')?.classList.contains('open') ||
      document.getElementById('ocrModal')?.classList.contains('open')
    );
  }

  window._tryShowPwaBanner = function _tryShowPwaBanner(retries) {
    retries = retries ?? 0;
    if (!_isMobile || _isStandalone) return;
    if (localStorage.getItem('psico_pwa_dismissed')) return;
    if (_anyModalOpen()) {
      if (retries < 8) setTimeout(() => _tryShowPwaBanner(retries + 1), 2000);
      return;
    }
    _showPwaBanner();
  };

  function _showPwaBanner() {
    const banner = document.getElementById('pwaBanner');
    if (!banner || banner.classList.contains('visible')) return;

    if (_isIOS) {
      // iOS Safari: manual instructions
      document.getElementById('pwaBannerDesc').textContent = 'Salvala sulla tua Home per aprirla come un\'app vera.';
      document.getElementById('pwaBannerIosSteps').style.display = 'flex';
    } else if (_deferredPrompt) {
      // Android Chrome: native install button
      document.getElementById('pwaBannerInstallBtn').style.display = 'inline-flex';
    } else {
      // Generic mobile (other browser)
      document.getElementById('pwaBannerDesc').textContent = 'Aggiungi Mnesti alla tua schermata Home dal menu del browser.';
    }

    banner.classList.add('visible');
  }

  window._pwaBannerInstall = async function() {
    if (!_deferredPrompt) return;
    _deferredPrompt.prompt();
    const { outcome } = await _deferredPrompt.userChoice;
    _deferredPrompt = null;
    if (outcome === 'accepted') _pwaBannerDismiss();
  };

  window._pwaBannerDismiss = function() {
    document.getElementById('pwaBanner')?.classList.remove('visible');
    localStorage.setItem('psico_pwa_dismissed', '1');
  };
})();

// ── Claude API proxy helper ───────────────────────────────────
// All AI calls go through this function. The API key lives server-side.
async function _callClaude(payload, signal) {
  const token = window._getSBToken ? await window._getSBToken() : null;
  if (!token) throw new Error('Sessione scaduta — effettua di nuovo il login.');

  let res, data;
  try {
    res = await fetch(`${window._SB_URL}/functions/v1/claude-proxy`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (netErr) {
    if (netErr.name === 'AbortError') throw netErr; // preserve for timeout detection
    throw new Error(`Errore di rete — controlla la connessione. (${netErr.message})`);
  }

  try {
    data = await res.json();
  } catch {
    throw new Error(`Risposta non valida dal server (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || `Errore API (${res.status})`;
    if (data?.code === 'RATE_LIMIT') {
      throw new Error(`⚠️ Limite giornaliero raggiunto. Riprova domani. (${data.calls_today}/${data.limit} chiamate)`);
    }
    if (data?.code === 'UNAUTHORIZED') {
      throw new Error('Sessione scaduta — effettua di nuovo il login.');
    }
    if (data?.code === 'OVERLOADED' || data?.error?.type === 'overloaded_error' || res.status === 529) {
      const e = new Error('Il servizio AI è momentaneamente sovraccarico. Riprova tra qualche secondo.');
      e.name = 'OverloadedError';
      throw e;
    }
    throw new Error(msg);
  }

  return data;
}

// ── Streaming Claude call (for long requests like plan generation) ────────────
// Sends stream:true, reads Anthropic SSE events, returns the same shape as
// _callClaude so callers can be swapped without other changes.
async function _callClaudeStream(payload) {
  const token = window._getSBToken ? await window._getSBToken() : null;
  if (!token) throw new Error('Sessione scaduta — effettua di nuovo il login.');

  let res;
  try {
    res = await fetch(`${window._SB_URL}/functions/v1/claude-proxy`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...payload, stream: true }),
    });
  } catch (netErr) {
    throw new Error(`Errore di rete — controlla la connessione. (${netErr.message})`);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data?.error?.message || data?.error || data?.message || `Errore API (${res.status})`;
    if (data?.code === 'RATE_LIMIT') {
      throw new Error(`⚠️ Limite giornaliero raggiunto. Riprova domani. (${data.calls_today}/${data.limit} chiamate)`);
    }
    if (data?.code === 'UNAUTHORIZED') throw new Error('Sessione scaduta — effettua di nuovo il login.');
    if (data?.code === 'OVERLOADED' || res.status === 529) {
      const e = new Error('Il servizio AI è momentaneamente sovraccarico. Riprova tra qualche secondo.');
      e.name = 'OverloadedError';
      throw e;
    }
    if (data?.code === 'TIMEOUT' || res.status === 504) {
      const e = new Error('La generazione ha impiegato troppo tempo. Prova con un esame più vicino o con meno fonti caricate, poi riprova.');
      e.name = 'TimeoutError';
      throw e;
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let inputTokens = 0, outputTokens = 0;
  let buffer = '';

  try {

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const s = line.slice(6).trim();
      if (s === '[DONE]') continue;
      try {
        const ev = JSON.parse(s);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullText += ev.delta.text;
        }
        if (ev.type === 'message_start') inputTokens  = ev.message?.usage?.input_tokens  ?? 0;
        if (ev.type === 'message_delta') outputTokens = ev.usage?.output_tokens ?? 0;
      } catch { /* ignore malformed SSE lines */ }
    }
  }

  } catch (streamErr) {
    const n = streamErr?.name;
    if (n === 'TimeoutError' || n === 'AbortError') {
      const e = new Error('La generazione ha impiegato troppo tempo. Prova con un esame più vicino o con meno fonti caricate, poi riprova.');
      e.name = 'TimeoutError';
      throw e;
    }
    throw new Error(`Errore durante la ricezione della risposta AI. Riprova. (${streamErr?.message ?? 'sconosciuto'})`);
  }

  if (!fullText) throw new Error('Risposta AI vuota — riprova.');

  return {
    content: [{ text: fullText }],
    usage:   { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ── Session-based question panel ─────────────────────────────

const MIN_ANSWER_CHARS = 40;
const MIN_SHOW_VERIFY_CHARS = 80; // ~5 righe su mobile prima di mostrare il bottone verifica
const _MIC_SVG = `<i data-lucide="mic" style="width:14px;height:14px;stroke-width:2.2;pointer-events:none"></i>`;

function _nextUnverifiedIdx(dayId, qList) {
  const feedbacks = state[dayId]?.feedbacks || {};
  const skipped   = state[dayId]?.skipped   || {};
  return qList.findIndex((q, i) => !feedbacks[i] && !skipped[i]);
}

function skipQuestion(dayId, qIdx) {
  if (!state[dayId]) state[dayId] = {};
  if (!state[dayId].skipped) state[dayId].skipped = {};
  state[dayId].skipped[qIdx] = true;
  saveState();
  _renderQsPanel(dayId);
  renderDayReadiness(dayId);
}

function resumeSkippedQuestion(dayId, qIdx) {
  if (!state[dayId]?.skipped) return;
  delete state[dayId].skipped[qIdx];
  saveState();
  _renderQsPanel(dayId);
  renderDayReadiness(dayId);
}

function startDaySession(dayId) {
  if (!state[dayId]) state[dayId] = {};
  const wasStarted = !!state[dayId].sessionStarted;
  state[dayId].sessionStarted = true;
  saveState();
  // Show full timer block (remove any inline display:none set by timerStop)
  const tb = document.getElementById('timer-' + dayId);
  if (tb) { tb.style.display = ''; tb.classList.remove('timer-idle'); tb.classList.add('timer-active'); }
  timerStart(dayId);
  // Reveal action bar (quiz + gen-q buttons) when session starts
  const sAct = document.getElementById('section-actions-' + dayId);
  if (sAct) sAct.style.display = '';
  if (!wasStarted) _renderQsPanel(dayId);
  _renderSessionRing(dayId, false);
}

function advanceQuestion(dayId, animate) {
  _renderQsPanel(dayId);
  if (animate) {
    requestAnimationFrame(() => {
      const card = document.querySelector('#qs-panel-' + dayId + ' .q-active-card');
      if (card) {
        card.classList.add('q-advance-in');
        card.addEventListener('animationend', () => card.classList.remove('q-advance-in'), { once: true });
        // Scroll the new question into view smoothly
        setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
      }
    });
  }
}

function toggleDoneQ(dayId, idx) {
  document.getElementById(`done-q-${dayId}-${idx}`)?.classList.toggle('expanded');
}

function _renderQsPanel(dayId) {
  const container = document.getElementById('qs-panel-' + dayId);
  if (!container) return;

  const day = getActiveDays().find(d => d.id === dayId);
  if (!day) return;

  const dayState    = state[dayId] || {};
  const sessionStarted = !!dayState.sessionStarted;
  const qList       = dayState.aiQuestions || day.questions || [];
  if (!qList.length) { container.innerHTML = ''; return; }

  const feedbacks = dayState.feedbacks || {};
  const answers   = dayState.answers   || {};
  const skipped   = dayState.skipped   || {};
  const completedCount = qList.filter((q, i) => feedbacks[i]).length;
  const skippedIdxs = qList.map((q, i) => i).filter(i => skipped[i] && !feedbacks[i]);
  const activeIdx  = _nextUnverifiedIdx(dayId, qList);
  // allDone: no more active questions AND no skipped-without-feedback left
  const allDone    = activeIdx === -1 && skippedIdxs.length === 0;

  // ── Completed questions HTML (collapsed cards) ──────────────
  const _completedHtml = () => {
    // Build index list of completed questions sorted newest → oldest
    const completedIdxs = qList
      .map((q, i) => ({ q, i, ts: feedbacks[i]?.ts || 0 }))
      .filter(({ i }) => !!feedbacks[i])
      .sort((a, b) => b.ts - a.ts);
    return completedIdxs.map(({ q, i }) => {
    const fb = feedbacks[i];
      const gradeIcon = { good: '✓', partial: '◑', poor: '✗' }[fb.grade] || '?';
    const ans = answers[i] || '';
    const ansPreview = escHtml(ans);
    // Support both full HTML feedback and compacted text-only feedback
    // Reconstruct feedback HTML from stored components (never rely on saved raw HTML)
    const _fbScore = fb.score || { good: 4, partial: 2, poor: 1 }[fb.grade] || 2;
    const _fbDots = Array.from({length: 5}, (_, di) =>
      `<span class="q-dot${di < _fbScore ? ' filled' : ''}"></span>`).join('');
    const _fbGradeLabel = { good: 'BUONO', partial: 'PARZIALE', poor: 'INSUFFICIENTE' }[fb.grade] || 'PARZIALE';
    const _fbGradeClass = { good: 'feedback-good', partial: 'feedback-partial', poor: 'feedback-poor' }[fb.grade] || 'feedback-partial';
    // Support legacy (text/html) and new (reviewText) formats
    const _fbReviewRaw = fb.reviewText || fb.text || '';
    const _fbSrcRef = fb.srcRef
      ? `<span class="q-src-ref">${escHtml(fb.srcRef).replace(/\n/g,'<br>')}</span>`
      : '';
    const _qt2Esc = (q.text||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const _qt2TypeEsc = (q.type||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const _fbShowAnswerBtn = (fb.grade === 'poor' || fb.grade === 'partial')
      ? `<button class="q-show-answer-btn" id="done-show-ans-${dayId}-${i}"
            onclick="showCorrectAnswer('${dayId}',${i},'${_qt2Esc}','${_qt2TypeEsc}','done')">
          <i data-lucide="lightbulb" style="width:12px;height:12px;stroke-width:2;flex-shrink:0"></i>
          Fornisci la risposta corretta
        </button>
        <div id="done-correct-ans-${dayId}-${i}"></div>`
      : '';
    const fbContent = fb.html && !fb.reviewText
      // Legacy path: saved HTML (old format) — keep but append button if missing
      ? fb.html + (!(fb.html.includes('q-show-answer-btn')) && (fb.grade==='poor'||fb.grade==='partial') ? _fbShowAnswerBtn : '')
      : `<div class="q-rating-row">` +
          `<span class="q-rating-dots">${_fbDots}</span>` +
          `<span class="q-rating-label ${_fbGradeClass}">${_fbGradeLabel}</span>` +
        `</div>` +
        `<div class="q-review-text">${escHtml(_fbReviewRaw).replace(/\n/g,'<br>')}${_fbSrcRef}</div>` +
        _fbShowAnswerBtn;
    const qTypeEscaped = (q.type || '').replace(/'/g, "\\'");
    const qTextEscaped = q.text.replace(/'/g, "\\'");
    const _doneSourceTag = q.sourceRef
      ? `<div class="q-source-tag" onclick="event.stopPropagation();this.classList.toggle('open')" style="margin-top:6px">
          <span class="q-source-tag-btn"><i data-lucide="book-open" style="width:10px;height:10px;stroke-width:2.2;flex-shrink:0"></i> Fonte</span>
          <span class="q-source-expand">${escHtml(q.sourceRef)}</span>
         </div>`
      : '';
    return `
      <div class="q-done-summary" id="done-q-${dayId}-${i}">
        <button class="q-done-toggle" onclick="toggleDoneQ('${dayId}', ${i})">
          <span class="q-done-grade-icon grade-${fb.grade || 'poor'}">${gradeIcon}</span>
          <span class="q-done-text">${escHtml(q.text)}</span>
          <span class="q-done-chevron">›</span>
        </button>
        <div class="q-done-improving-header">
          <div class="q-type-badge">${escHtml(q.type || 'domanda')}</div>
          <div class="q-full-text">${escHtml(q.text)}</div>
        </div>
        <div class="q-done-body">
          ${_doneSourceTag}
          <div class="q-done-answer-label" id="done-ans-label-${dayId}-${i}">La tua risposta</div>
          <div class="q-done-answer-text" id="done-ans-text-${dayId}-${i}">${ansPreview}</div>
          <div class="q-feedback ${fb.grade || ''} visible" style="margin-top:0" id="done-fb-${dayId}-${i}">${fbContent}</div>
          <button class="q-done-improve-btn" onclick="openImproveAnswer('${dayId}', ${i})" id="done-improve-btn-${dayId}-${i}">✏ Migliora risposta</button>
          <div class="q-done-edit-area" id="done-edit-${dayId}-${i}">
            <div class="q-done-edit-label">Modifica e riverifica</div>
            <div class="q-textarea-wrap">
              <textarea class="q-done-edit-textarea" id="done-edit-ta-${dayId}-${i}"
                oninput="_syncReverifyBtn('${dayId}', ${i}, this.value); _syncClearBtn(this)">${escHtml(ans)}</textarea>
              <button class="q-clear-btn${ans ? ' has-text' : ''}" tabindex="-1"
                onclick="_clearAnswerField('done-edit-ta-${dayId}-${i}')"
                title="Cancella risposta">
                <i data-lucide="x" style="width:11px;height:11px;stroke-width:2.5;pointer-events:none"></i>
              </button>
            </div>
            <div class="q-done-edit-bar">
              <div class="q-done-edit-tools-row">
                <div class="q-tool-btns">
                  <button class="q-mic-btn" onclick="startVoiceDictationInto('done-edit-ta-${dayId}-${i}')" title="Trascrivi con voce">${_MIC_SVG}</button>
                  <button class="q-cam-btn" onclick="startPhotoOcr('${dayId}', ${i}, 'done-edit-ta-${dayId}-${i}')" title="Scatta foto del foglio scritto a mano">
                    <i data-lucide="camera" style="width:14px;height:14px;stroke-width:2.2;pointer-events:none"></i>
                  </button>
                </div>
                <button class="q-done-cancel-edit" onclick="closeImproveAnswer('${dayId}', ${i})">Annulla</button>
              </div>
              <button class="q-done-reverify-btn" id="done-reverify-btn-${dayId}-${i}"
                onclick="reverifyAnswer('${dayId}', ${i}, '${qTextEscaped}', '${qTypeEscaped}')">
                <i data-lucide="refresh-cw" style="width:13px;height:13px;stroke-width:2.2;flex-shrink:0;pointer-events:none"></i>
                Riverifica
              </button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  };

  // ── Pre-session state ────────────────────────────────────────
  if (!sessionStarted) {
    const btnLabel = completedCount > 0
      ? '<i data-lucide="play" style="width:13px;height:13px;stroke-width:2.2;fill:currentColor;flex-shrink:0"></i> Riprendi sessione'
      : '<i data-lucide="play" style="width:13px;height:13px;stroke-width:2.2;fill:currentColor;flex-shrink:0"></i> Inizia sessione';
    const dots = qList.map((q, i) =>
      `<span class="session-dot${feedbacks[i] ? ' done ' + feedbacks[i].grade : skipped[i] ? ' skipped' : (answers[i] && answers[i].trim().length > 15 ? ' answered' : '')}"></span>`
    ).join('');
    const pendingCount = qList.length - completedCount;
    const savedSecs = state[dayId]?.totalSeconds || 0;
    const hoursBadge = savedSecs > 0
      ? `<div class="session-hours-badge"><i data-lucide="timer" style="width:11px;height:11px;stroke-width:2;vertical-align:middle"></i> ${formatSeconds(savedSecs)} già studiate</div>`
      : '';

    // ── Topics list ──────────────────────────────────────────
    const _tagIcon = { retrieval: 'refresh-cw', studio: 'book-open',
                       ripasso: 'repeat-2',     revisione: 'repeat-2',
                       simulazione: 'zap',      integrazione: 'layers' };
    let topicsHtml = '';
    if (day.sections && day.sections.length > 0) {
      topicsHtml = day.sections.map(s => {
        const icon = _tagIcon[s.tag] || 'circle';
        const refHtml = s.ref
          ? `<span class="session-topic-ref">${escHtml(s.ref)}</span>`
          : '';
        return `<div class="session-topic-item">
          <i data-lucide="${icon}" style="width:11px;height:11px;stroke-width:2;flex-shrink:0"></i>
          <span class="session-topic-label">${escHtml(s.title || s.label)}</span>
          ${refHtml}
        </div>`;
      }).join('');
    } else if (day.subtitle) {
      topicsHtml = day.subtitle.split('·').map(t => t.trim()).filter(Boolean).map(t =>
        `<div class="session-topic-item">
          <i data-lucide="circle" style="width:6px;height:6px;stroke-width:0;fill:var(--text-3);flex-shrink:0"></i>
          <span class="session-topic-label">${escHtml(t)}</span>
        </div>`
      ).join('');
    }

    container.innerHTML = `
      <div class="session-prompt">
        <div class="session-layout">
          <div class="session-left">
            <div class="session-q-stat">
              <span class="session-q-num">${pendingCount}</span>
              <span class="session-q-sub">${pendingCount === 1 ? 'domanda da rispondere' : 'domande da rispondere'}</span>
            </div>
            ${topicsHtml ? `<div class="session-topics">${topicsHtml}</div>` : ''}
            <div class="session-progress-wrap">
              <div class="session-progress-dots">${dots}</div>
              <div class="session-progress-legend">
                <span class="sp-legend-item"><span class="sp-dot sp-dot-pending"></span>${pendingCount} da completare</span>
                <span class="sp-legend-item"><span class="sp-dot sp-dot-done"></span>${completedCount} completate</span>
              </div>
            </div>
          </div>
          <div class="session-right">
            ${hoursBadge}
            <button class="session-start-btn" onclick="startDaySession('${dayId}')">${btnLabel}</button>
          </div>
        </div>
      </div>
      ${completedCount > 0 ? `<div class="done-questions-area"><div class="done-qs-header">Completate</div>${_completedHtml()}</div>` : ''}`;
    lucide.createIcons();
    return;
  }

  // ── All questions done ───────────────────────────────────────
  if (allDone) {
    container.innerHTML = `
      <div class="session-complete-card">
        <div class="session-complete-icon">✓</div>
        <div class="session-complete-title">Sessione completata!</div>
        <div class="session-complete-sub">Hai verificato tutte e ${qList.length} le domande di oggi.</div>
        <div class="session-complete-actions">
          <button class="sc-action-btn sc-quiz"
            onclick="startQuiz('${dayId}','${(day.title||'').replace(/'/g,"\\'")}')">
            🎯 Quiz
          </button>
          <button class="sc-action-btn sc-bd"
            onclick="startBrainDump('${dayId}','${(day.title||'').replace(/'/g,"\\'")}')">
            🧠 Brain Dump
          </button>
          <button class="sc-action-btn sc-mc"
            onclick="startMemoryCards('${dayId}')">
            🃏 Cards Autori
          </button>
        </div>
      </div>
      <div class="done-questions-area"><div class="done-qs-header">Domande completate</div>${_completedHtml()}</div>`;
    lucide.createIcons();
    // Modale “Giornata completata!”: una sola volta per giornata (persiste tra visite / tab)
    if (!localStorage.getItem('dcm_' + dayId)) {
      setTimeout(() => _showDayCompleteModal(dayId), 350);
    }
    return;
  }

  // ── Active idx exhausted but skipped questions remain ────────
  if (activeIdx === -1 && skippedIdxs.length > 0) {
    const _skippedOnlyHtml = `<div class="skipped-questions-area">
      <div class="skipped-qs-header">
        <i data-lucide="skip-forward" style="width:11px;height:11px;stroke-width:2.2"></i>
        Hai saltato ${skippedIdxs.length} domand${skippedIdxs.length === 1 ? 'a' : 'e'} — riprendile quando sei pronto
      </div>
      ${skippedIdxs.map(i => {
        const sq = qList[i];
        return `<div class="q-skipped-card">
          <span class="q-skipped-text">${escHtml(sq.text)}</span>
          <button class="q-resume-btn" onclick="resumeSkippedQuestion('${dayId}', ${i})">
            <i data-lucide="rotate-ccw" style="width:10px;height:10px;stroke-width:2.2;flex-shrink:0"></i> Riprendi
          </button>
        </div>`;
      }).join('')}
    </div>`;
    container.innerHTML = _skippedOnlyHtml +
      `<div class="done-questions-area"><div class="done-qs-header">Completate</div>${_completedHtml()}</div>`;
    lucide.createIcons();
    return;
  }

  // ── Active question ──────────────────────────────────────────
  const q = qList[activeIdx];
  const existingAns = answers[activeIdx] || '';
  const canVerify = existingAns.trim().length >= MIN_ANSWER_CHARS;

  const _srcTagHtml = (q.sourceRef)
    ? `<div class="q-source-tag" onclick="this.classList.toggle('open')">
        <span class="q-source-tag-btn"><i data-lucide="book-open" style="width:10px;height:10px;stroke-width:2.2;flex-shrink:0"></i> Fonte</span>
        <span class="q-source-expand">${escHtml(q.sourceRef)}</span>
       </div>`
    : '';

  const activeHtml = `
    <div class="q-active-card">
      <div class="q-active-label">In corso — ${activeIdx + 1} di ${qList.length}</div>
      <div class="q-top">
        <div class="q-text">${escHtml(q.text)}</div>
        <div class="q-type">${_qTypeBadge(q.type)}</div>
      </div>
      ${_srcTagHtml}
      <div class="q-answer-area">
        <div class="q-textarea-wrap">
          <textarea class="q-answer-input" id="answer-${dayId}-${activeIdx}"
            placeholder="Scrivi qui la tua risposta…"
            oninput="saveAnswer('${dayId}', ${activeIdx}, this.value); _syncVerifyBtn('${dayId}', ${activeIdx}, this.value); _syncClearBtn(this)">${escHtml(existingAns)}</textarea>
          <button class="q-clear-btn${existingAns ? ' has-text' : ''}" tabindex="-1"
            onclick="_clearAnswerField('answer-${dayId}-${activeIdx}')"
            title="Cancella risposta">
            <i data-lucide="x" style="width:11px;height:11px;stroke-width:2.5;pointer-events:none"></i>
          </button>
        </div>
        <div class="q-answer-tools">
          <div class="q-tool-btns">
            <button class="q-mic-btn" id="mic-${dayId}-${activeIdx}"
              onclick="startVoiceDictation('${dayId}', ${activeIdx})" title="Trascrivi con voce">${_MIC_SVG}</button>
            <button class="q-cam-btn" id="cam-${dayId}-${activeIdx}"
              onclick="startPhotoOcr('${dayId}', ${activeIdx})" title="Scatta foto del foglio scritto a mano">
              <i data-lucide="camera" style="width:14px;height:14px;stroke-width:2.2;pointer-events:none"></i>
            </button>
          </div>
          <button class="q-skip-btn" style="margin-left:auto"
            onclick="skipQuestion('${dayId}', ${activeIdx})" title="Salta questa domanda e riprendi dopo">
            <i data-lucide="skip-forward" style="width:11px;height:11px;stroke-width:2.2;flex-shrink:0"></i> Salta
          </button>
        </div>
        <div class="q-verify-row${canVerify ? ' visible' : ''}" id="verify-row-${dayId}-${activeIdx}">
          <button class="q-verify-btn" id="verify-${dayId}-${activeIdx}"
            ${canVerify ? '' : 'disabled'}
            onclick="verifyAnswer('${dayId}', ${activeIdx}, '${q.text.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}', '${(q.type||'').replace(/'/g,"\\'")}')">
            <i data-lucide="check-circle" style="width:14px;height:14px;stroke-width:2.2;flex-shrink:0"></i>
            Verifica risposta
          </button>
        </div>
        <div class="q-feedback" id="feedback-${dayId}-${activeIdx}"></div>
      </div>
    </div>`;

  const doneHtml = completedCount > 0
    ? `<div class="done-questions-area"><div class="done-qs-header">Completate</div>${_completedHtml()}</div>`
    : '';

  const _skippedHtml = skippedIdxs.length
    ? `<div class="skipped-questions-area">
        <div class="skipped-qs-header">
          <i data-lucide="skip-forward" style="width:11px;height:11px;stroke-width:2.2"></i>
          Saltate — da riprendere (${skippedIdxs.length})
        </div>
        ${skippedIdxs.map(i => {
          const sq = qList[i];
          return `<div class="q-skipped-card">
            <span class="q-skipped-text">${escHtml(sq.text)}</span>
            <button class="q-resume-btn" onclick="resumeSkippedQuestion('${dayId}', ${i})">
              <i data-lucide="rotate-ccw" style="width:10px;height:10px;stroke-width:2.2;flex-shrink:0"></i> Riprendi
            </button>
          </div>`;
        }).join('')}
      </div>`
    : '';

  container.innerHTML = activeHtml + _skippedHtml + doneHtml;
  lucide.createIcons();

  // ── First-time answer-hint modal ─────────────────────────
  if (activeIdx !== -1 && !localStorage.getItem('psico_answer_hint_shown')) {
    setTimeout(() => {
      const modal = document.getElementById('ahintModal');
      if (modal) {
        modal.classList.add('open');
        lucide.createIcons();
        localStorage.setItem('psico_answer_hint_shown', '1');
      }
    }, 600);
  }
}

function closeAnswerHint() {
  document.getElementById('ahintModal')?.classList.remove('open');
}
function _ahintOverlayClick(e) {
  if (e.target === document.getElementById('ahintModal')) closeAnswerHint();
}

// Returns true if day at given id is accessible (all preceding non-rest days have a status)
function isDayUnlocked(dayId) {
  const activeDays = getActiveDays();
  const idx = activeDays.findIndex(d => d.id === dayId);
  if (idx <= 0) return true; // first day always open
  for (let i = 0; i < idx; i++) {
    const d = activeDays[i];
    if (d.type === 'rest') continue; // rest days don't require completion
    if (!state[d.id]?.status) return false; // no status → chain breaks here
  }
  return true;
}

// Stricter than isDayUnlocked: a day is navigable only if it's done/skip/rest
// OR it's the first incomplete (currently active) study day.
function isDayNavigable(dayId) {
  const activeDays = getActiveDays();
  const day = activeDays.find(d => d.id === dayId);
  if (!day) return false;
  if (day.type === 'rest' || day.type === 'exam') return isDayUnlocked(dayId);
  const s = state[dayId]?.status;
  if (s === 'done' || s === 'skip') return true;
  // Allow the first unlocked-but-incomplete day (the one currently being worked on)
  for (const d of activeDays) {
    if (d.type === 'rest' || d.type === 'exam') continue;
    const ds = state[d.id]?.status;
    if (ds === 'done' || ds === 'skip') continue;
    // First study day that is not done/skip → current working day
    return d.id === dayId && isDayUnlocked(dayId);
  }
  return false;
}

function buildNav() {
  const nav = document.getElementById('dayNav');
  nav.innerHTML = ''; // reset

  const typeTag = {
    studio:    { cls: 'nav-tag-studio',    label: 'Studio' },
    rest:      { cls: 'nav-tag-rest',      label: 'Riposo' },
    revisione: { cls: 'nav-tag-revisione', label: 'Revisione' },
    exam:      { cls: 'nav-tag-exam',      label: 'Esame' },
  };

  const activeDays = getActiveDays();
  let currentWeek = null;

  activeDays.forEach(day => {
    // Week divider from hardcoded phaseStart OR AI plan weekStart
    const wStart = day.phaseStart || (day.weekStart ? { num: day.weekStart, desc: '' } : null);
    if (wStart && wStart.num !== currentWeek) {
      currentWeek = wStart.num;
      const div = document.createElement('div');
      div.className = 'week-divider';
      div.innerHTML = `<div class="week-divider-num">${wStart.num}</div>
        ${wStart.desc ? `<div class="week-divider-desc">${wStart.desc}</div>` : ''}`;
      nav.appendChild(div);
    }

    const item = document.createElement('button');
    item.className = 'day-nav-item';
    item.dataset.id = day.id;
    const status = state[day.id]?.status || '';
    if (status) item.classList.add('status-' + status);
    const tag = typeTag[day.type] || { cls: '', label: day.type };
    const hasQ = (day.questions && day.questions.length > 0) || !!state[day.id]?.aiQuestions;
    const locked = !isDayUnlocked(day.id);
    if (locked) item.classList.add('locked');
    const lockSvg = locked
      ? `<i class="nav-lock-icon" data-lucide="lock" style="width:10px;height:10px;stroke-width:2.5;flex-shrink:0"></i>`
      : '';
    item.innerHTML = `
      <div class="day-dot"></div>
      <div class="nav-day-content">
        <span class="nav-day-name">${day.label}</span>
        ${hasQ ? `<div class="day-readiness" id="readiness-${day.id}"></div>` : ''}
      </div>
      <span class="nav-type-tag ${tag.cls}">${tag.label}</span>
      ${lockSvg}`;
    item.onclick = () => showDay(day.id);
    nav.appendChild(item);
    if (hasQ) renderDayReadiness(day.id);
  });
  lucide.createIcons();
}

// ── Plan Calendar Overview ──────────────────────────────────────────────────
function buildPlanOverview() {
  const el = document.getElementById('planOverview');
  if (!el) return;
  const activeDays = getActiveDays();

  if (!activeDays.length) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 24px;text-align:center;gap:16px;min-height:300px;">
        <i data-lucide="calendar-plus" style="width:40px;height:40px;color:var(--text-3);stroke-width:1.5"></i>
        <div style="font-size:15px;font-weight:600;color:var(--text)">Nessun piano di studio</div>
        <div style="font-size:13px;color:var(--text-2);max-width:320px;line-height:1.5">
          Completa la configurazione iniziale per generare il tuo piano di studio personalizzato.
        </div>
        <button onclick="_showOnboarding()" style="margin-top:8px;padding:10px 22px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:500">
          Crea il mio piano →
        </button>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  const examInfo = (() => { try { return JSON.parse(localStorage.getItem('psico_exam_info') || '{}'); } catch(e) { return {}; } })();
  let daysToExam = null;
  if (examInfo.date) {
    const examD = _examInfoParseYMD(examInfo.date);
    if (examD) {
      const nowD = new Date(); nowD.setHours(0, 0, 0, 0);
      daysToExam = Math.ceil((examD - nowD) / 86400000);
    }
  }
  const studyDays  = activeDays.filter(d => d.type !== 'rest' && d.type !== 'exam');
  const doneDays   = studyDays.filter(d => (state[d.id] || {}).status === 'done').length;
  const totalStudy = studyDays.length;
  const totalSecs  = activeDays.reduce((s, d) => s + ((state[d.id] || {}).totalSeconds || 0), 0);
  const totalHours = (totalSecs / 3600).toFixed(1);

  // ── Two separate concepts ─────────────────────────────────────────────────
  // activeDayId : first accessible/working day → full accent treatment + CTA
  // todayDateId : day matching today's calendar date → subtle border only
  const _activeDay   = _resolveStartDay() || activeDays[0];
  const activeDayId  = _activeDay?.id || null;
  const _todayMatch  = activeDays.find(d => d.date === todayStr);
  const todayDateId  = _todayMatch?.id || null;
  // Legacy alias (used below for backwards compat with gap detection)
  const todayDayId   = todayDateId || activeDayId;

  // ── Gap detection: plan generated but never started and already overdue ────
  const planFirstDate = activeDays.find(d => d.date)?.date || null;
  let gapDays = 0;
  let showGapBanner = false;
  if (planFirstDate && doneDays === 0 && daysToExam !== null && daysToExam > 0) {
    const planStart = new Date(planFirstDate); planStart.setHours(0, 0, 0, 0);
    const todayD    = new Date();              todayD.setHours(0, 0, 0, 0);
    gapDays = Math.floor((todayD - planStart) / 86400000);
    if (gapDays > 1) showGapBanner = true;
  }

  // ── Group days into weeks (mirrors buildNav logic) ────────────────────────
  let curWeekKey  = null;
  let curWeekMeta = null;
  let curWeekDays = [];
  const weeks = [];
  activeDays.forEach(day => {
    const wStart = day.phaseStart || (day.weekStart ? { num: day.weekStart, desc: '' } : null);
    if (wStart && wStart.num !== curWeekKey) {
      if (curWeekDays.length) weeks.push({ num: curWeekMeta.num, desc: curWeekMeta.desc || '', days: curWeekDays });
      curWeekKey  = wStart.num;
      curWeekMeta = wStart;
      curWeekDays = [day];
    } else {
      curWeekDays.push(day);
    }
  });
  if (curWeekDays.length) weeks.push({ num: curWeekMeta ? curWeekMeta.num : '', desc: curWeekMeta ? (curWeekMeta.desc || '') : '', days: curWeekDays });

  // ── Build HTML ────────────────────────────────────────────────────────────
  const daysLabel = daysToExam === null ? '—' : daysToExam <= 0 ? '0' : String(daysToExam);
  let html = `<div class="po-inner">
    <div class="po-header">
      <div class="po-header-left">
        <div class="po-title">Piano di studio</div>
        ${examInfo.subject ? `<div class="po-subtitle">${escHtml(examInfo.subject)}${examInfo.professor ? ' — ' + escHtml(examInfo.professor) : ''}</div>` : '<div class="po-subtitle" style="height:1rem"></div>'}
        <div class="po-stats">
          <div class="po-stat-card">
            <div class="po-stat-val">${daysLabel}</div>
            <div class="po-stat-label">Giorni all'esame</div>
          </div>
          <div class="po-stat-card">
            <div class="po-stat-val${doneDays > 0 ? ' done-green' : ''}">${doneDays}/${totalStudy}</div>
            <div class="po-stat-label">Sessioni completate</div>
          </div>
          <div class="po-stat-card">
            <div class="po-stat-val">${totalHours}h</div>
            <div class="po-stat-label">Ore studiate</div>
          </div>
        </div>
      </div>
      <div class="po-header-actions">
        <button class="po-action-btn po-action-ghost" onclick="_openExamsArchive()">
          <i data-lucide="archive" style="width:13px;height:13px;stroke-width:2"></i>
          I miei esami
        </button>
        <button class="po-action-btn po-action-accent" onclick="_createNewExam()">
          <i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5"></i>
          Crea nuovo esame
        </button>
      </div>
    </div>`;

  // ── Gap banner ────────────────────────────────────────────────────────────
  if (showGapBanner) {
    const daysLeft = daysToExam;
    html += `
    <div class="po-gap-banner" id="poGapBanner">
      <div class="po-gap-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div class="po-gap-body">
        <div class="po-gap-title">Piano non ancora iniziato</div>
        <div class="po-gap-desc">
          Il piano era previsto ${gapDays === 1 ? 'ieri' : `${gapDays} giorni fa`}, ma non hai ancora completato sessioni.
          Con la data dell'esame fissa hai <strong>${daysLeft} giorn${daysLeft === 1 ? 'o' : 'i'} rimast${daysLeft === 1 ? 'o' : 'i'}</strong> —
          vuoi rigenerare il piano ottimizzato sul tempo effettivo?
        </div>
      </div>
      <div class="po-gap-actions">
        <button class="po-gap-cta" onclick="generateStudyPlan(false)">Rigenera piano</button>
        <button class="po-gap-dismiss" onclick="document.getElementById('poGapBanner').remove()">Ignora</button>
      </div>
    </div>`;
  }

  // Single flat grid — week labels are full-span rows inside the same grid
  html += `<div class="po-days-grid">`;

  weeks.forEach(week => {
    const wStudy = week.days.filter(d => d.type !== 'rest' && d.type !== 'exam');
    const wDone  = wStudy.filter(d => (state[d.id] || {}).status === 'done').length;
    const wTotal = wStudy.length;
    const allDone = wDone === wTotal && wTotal > 0;

    // Week label row — spans all columns, visually minimal
    html += `<div class="po-week-label-row">
      <span class="po-week-num">${escHtml(week.num)}</span>`;
    if (week.desc) html += `<span class="po-week-vdiv"></span><span class="po-week-desc">${escHtml(week.desc)}</span>`;
    if (wTotal > 0) html += `<span class="po-week-count${allDone ? ' complete' : ''}">${wDone}/${wTotal}</span>`;
    html += `</div>`;

    week.days.forEach(day => {
      const isActiveDay  = day.id === activeDayId;   // first accessible day → CTA + full accent
      const isTodayDate  = day.id === todayDateId;   // calendar date = today → subtle marker only
      const dayState   = state[day.id] || {};
      const isDone     = dayState.status === 'done';
      const isLocked   = !isDayUnlocked(day.id);
      const navigable  = isDayNavigable(day.id);
      const isRest     = day.type === 'rest';
      const isExam     = day.type === 'exam';
      const isRev      = day.type === 'revisione';

      const hasQ = (day.questions && day.questions.length > 0) || !!dayState.aiQuestions;
      const r    = hasQ ? calcDayReadiness(day.id) : null;
      const answered  = r ? r.answered  : 0;
      const total     = r ? r.total     : 0;
      const prepLevel = r ? r.prepLevel : 0;

      let cardClass = 'po-day-card';
      if (isActiveDay)              cardClass += ' po-today';      // full accent on active day
      else if (isTodayDate)         cardClass += ' po-today-marker'; // just a border for today's date
      else if (isDone)              cardClass += ' po-done';
      else if (isExam)              cardClass += ' po-exam';
      else if (isRest)              cardClass += ' po-rest';
      if (isLocked && !isRest)      cardClass += ' po-locked';
      if (navigable)                cardClass += ' navigable';

      const TYPE_LABEL = { studio:'Studio', revisione:'Revisione', rest:'', exam:'Esame' };
      const typeLbl    = TYPE_LABEL[day.type] || '';
      const typeClass  = isRev ? 'po-type-badge rev' : isExam ? 'po-type-badge exam' : 'po-type-badge';
      const bars       = [1,2,3,4].map(i => `<span class="po-prep-bar${i <= prepLevel ? (isDone ? ' lit-g' : ' lit') : ''}"></span>`).join('');
      const clickAttr  = navigable ? `onclick="showDay('${day.id}')"` : '';

      html += `<div class="${cardClass}" ${clickAttr}>`;
      if (isActiveDay)            html += `<div class="po-today-bar"></div>`;
      if (isDone && !isActiveDay) html += `<div class="po-done-stripe"></div>`;
      html += `<div class="po-card-inner">`;

      // Row 1: date + badge
      // "Oggi" pill = only on the actual calendar date (isTodayDate).
      // The active day just shows its type label (Studio/Revisione/…).
      html += `<div class="po-card-top"><span class="po-card-date">${escHtml(day.label)}</span>`;
      if (isTodayDate && isActiveDay)  html += `<span class="po-today-pill">Oggi</span>`;
      else if (isTodayDate)            html += `<span class="po-today-pill po-today-pill--muted">Oggi</span>`;
      else if (typeLbl)                html += `<span class="${typeClass}">${typeLbl}</span>`;
      html += `</div>`;

      // Row 2: title
      html += `<div class="po-card-title">${isRest ? 'Riposo' : escHtml(day.title)}</div>`;

      // Row 3: bottom
      html += `<div class="po-card-bottom">`;
      if (isActiveDay && !isDone) {
        const ctaLbl = Object.keys(dayState.answers || {}).length > 0 ? 'Riprendi sessione' : 'Inizia sessione';
        html += `<button class="po-cta-btn" onclick="event.stopPropagation();showDay('${day.id}')">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          ${ctaLbl}
        </button>`;
      } else if (isDone) {
        html += `<div class="po-done-row">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#3a9d6e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span class="po-done-label">Completata</span>
        </div>`;
      } else if (total > 0) {
        const lockSvg = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
        html += `<div class="po-progress-row">
          <div class="po-prep-bars">${bars}</div>
          ${isLocked ? `<span class="po-lock-icon-inline">${lockSvg}</span>` : `<span class="po-count">${answered}/${total}</span>`}
        </div>`;
      } else if (isLocked && !isRest && !isExam) {
        const lockSvg = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
        html += `<div class="po-progress-row" style="justify-content:flex-end"><span class="po-lock-icon-inline">${lockSvg}</span></div>`;
      }
      html += `</div>`; // po-card-bottom
      html += `</div>`; // po-card-inner
      html += `</div>`; // po-day-card
    });

  });

  html += `</div>`; // po-days-grid (single flat grid)
  html += `</div>`; // po-inner

  el.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function showPlanOverview() {
  const ov = document.getElementById('planOverview');
  const ly = document.querySelector('.layout');
  if (!ov) return;
  buildPlanOverview();
  ov.classList.add('visible');
  if (ly) ly.style.display = 'none';
  document.body.classList.remove('po-session-view');
  document.querySelectorAll('.day-nav-item').forEach(el => el.classList.remove('active'));
}

function hidePlanOverview() {
  const ov = document.getElementById('planOverview');
  const ly = document.querySelector('.layout');
  if (!ov) return;
  ov.classList.remove('visible');
  if (ly) ly.style.display = '';
  document.body.classList.add('po-session-view');
}
// ── End Plan Calendar Overview ──────────────────────────────────────────────

function showDay(id) {
  if (!isDayNavigable(id)) return; // guard: only done/skip/rest + current working day

  // Auto-start session BEFORE making the block visible to avoid a pre-session flash.
  // The calendar already serves as the plan overview — no intermediate gate needed.
  const _day = getActiveDays().find(d => d.id === id);
  if (_day && _day.type !== 'rest' && _day.type !== 'exam') {
    const _s = state[id]?.status;
    if (_s !== 'done' && _s !== 'skip') {
      if (!state[id]) state[id] = {};
      if (!state[id].sessionStarted && typeof startDaySession === 'function') {
        startDaySession(id);
      }
    }
  }

  hidePlanOverview();
  document.querySelectorAll('.day-block').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.day-nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('block-' + id)?.classList.add('visible');
  document.querySelector(`[data-id="${id}"]`)?.classList.add('active');
  if (window.innerWidth <= 768) { updateMobileDayNav(id); closeMobileSidebar(); }
  // Persist last visited day so we can restore it on next open
  try { localStorage.setItem('psico_last_day', id); } catch(e) {}
}

function _resolveStartDay() {
  const active = getActiveDays();
  if (!active.length) return null;

  // 1. Current active study day — first incomplete non-rest day (correct across all devices)
  for (const d of active) {
    if (d.type === 'rest' || d.type === 'exam') continue;
    const s = state[d.id]?.status;
    if (s !== 'done' && s !== 'skip') {
      if (isDayNavigable(d.id)) return d;
      break; // locked — fall through to saved/fallback
    }
  }

  // 2. Last explicitly visited day (synced from cloud via psico_last_day)
  const saved = localStorage.getItem('psico_last_day');
  if (saved) {
    const match = active.find(d => d.id === saved);
    if (match && isDayNavigable(match.id)) return match;
  }

  // 3. Last day with any recorded work
  const worked = active
    .filter(d => d.type !== 'rest' && d.type !== 'exam')
    .filter(d => {
      const ds = state[d.id] || {};
      return ds.sessionStarted || Object.keys(ds.feedbacks || {}).length > 0;
    });
  if (worked.length) {
    const last = worked[worked.length - 1];
    if (isDayNavigable(last.id)) return last;
  }

  return active[0];
}

// Mappa tipo-domanda → Tassonomia di Bloom + difficoltà
const Q_TYPE_META = {
  definizione: { bloom: 'Ricordo',      diff: 'base',       icon: '🔵' },
  meccanismo:  { bloom: 'Comprensione', diff: 'intermedio', icon: '🟡' },
  connessione: { bloom: 'Applicazione', diff: 'avanzato',   icon: '🔴' },
  simulazione: { bloom: 'Simulazione',  diff: 'avanzato',   icon: '🔴' }
};

function _qTypeBadge(type) {
  const m = Q_TYPE_META[type] || { bloom: type, diff: 'base', icon: '⚪' };
  const diffLabel = { base: 'Base', intermedio: 'Intermedio', avanzato: 'Avanzato' }[m.diff] || m.diff;
  return `<span class="quiz-diff-badge diff-${m.diff}">${diffLabel}</span><span class="quiz-bloom-tag">${m.icon} ${m.bloom}</span>`;
}

// ── Dirty-flag card cache ─────────────────────────────────────
// Avoids full DOM rebuild: only cards whose state actually changed get replaced.
// _dayCardCache: dayId → .day-block HTMLElement currently in the DOM
// _dayStateHash: dayId → JSON snapshot used to detect changes
const _dayCardCache = new Map();
const _dayStateHash = new Map();

function _dayHash(day) {
  // Covers both plan-level fields (title, sections…) and runtime state (answers, status…)
  return JSON.stringify({
    p: { title: day.title, subtitle: day.subtitle, type: day.type,
         sections: day.sections, tip: day.tip },
    s: state[day.id] || {}
  });
}

// ── Single-card factory ───────────────────────────────────────
// Builds and returns one .day-block element; does NOT touch the DOM.
// ── _buildDayCard(day) ────────────────────────────────────────
// Rest/exam cards use <template> + cloneNode (textContent = auto-escaped).
// Study cards use template literals with explicit escHtml() on all user values.
function _buildDayCard(day) {
  const block = document.createElement('div');
  block.className = 'day-block';
  block.id = 'block-' + day.id;

  if (day.type === 'rest') {
    // ── <template> clone — zero XSS risk, all values via textContent ──
    const tpl = document.getElementById('day-rest-tpl');
    if (tpl) {
      const frag = tpl.content.cloneNode(true);
      frag.querySelector('.day-title').textContent    = day.label;
      frag.querySelector('.day-subtitle').textContent = day.title;
      frag.querySelector('.rest-day-sub').textContent = day.subtitle;
      block.appendChild(frag);
    } else {
      // Fallback if template is missing (e.g. partial load)
      block.innerHTML = `
        <div class="day-header"><div>
          <button class="po-back-btn" onclick="showPlanOverview()"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Piano</button>
          <div class="day-title">${escHtml(day.label)}</div>
          <div class="day-subtitle">${escHtml(day.title)}</div>
        </div></div>
        <div class="rest-day">
          <div class="big-label">RIPOSO</div>
          <p style="color:var(--text-3);font-size:13px;">${escHtml(day.subtitle)}</p>
        </div>`;
    }

  } else if (day.type === 'exam') {
    // ── <template> clone ──────────────────────────────────────
    const tpl = document.getElementById('day-exam-tpl');
    if (tpl) {
      const frag = tpl.content.cloneNode(true);
      frag.querySelector('.day-title').textContent        = day.label;
      frag.querySelector('.exam-title-span').textContent  = day.title;
      frag.querySelector('.exam-subtitle').textContent    = day.subtitle;
      block.appendChild(frag);
    } else {
      block.innerHTML = `
        <div class="day-header"><div>
          <button class="po-back-btn" onclick="showPlanOverview()"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Piano</button>
          <div class="day-title">${escHtml(day.label)}</div>
          <div class="day-subtitle"><span style="color:var(--accent)">${escHtml(day.title)}</span></div>
        </div></div>
        <div class="exam-day-content">
          <div class="big-label">IN BOCCA AL LUPO</div>
          <p>${escHtml(day.subtitle)}</p>
          <p style="margin-top:1rem;color:var(--text-3);font-size:12px;">Hai studiato bene. Fidati del lavoro fatto.</p>
        </div>`;
    }

  } else {
    // ── Study day — template literal with explicit escHtml() ──
    const dayState = state[day.id] || {};
    const notes    = dayState.notes || '';
    const isAiQ    = !!dayState.aiQuestions;
    const _statusLabel = { done: '✓ Completata', partial: '· In corso', skip: '✕ Saltata' };
    const _curStatus   = dayState.status || 'none';
    const _skipBtnTxt  = dayState.status === 'skip' ? '↩ Annulla skip' : 'Salta giornata';
    // Escape plan-level strings used in HTML context
    const _eLbl  = escHtml(day.label);
    const _eSub  = escHtml(day.subtitle);
    const _eTitle = escHtml(day.title);
    // Escape title for use inside onclick attribute (single-quote context)
    const _titleAttr = day.title.replace(/\\/g,'\\\\').replace(/'/g,"\\'");

    block.innerHTML = `
      <div class="day-header">
        <div>
          <button class="po-back-btn" onclick="showPlanOverview()">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Piano
          </button>
          <div class="day-title">${_eLbl}</div>
          <div class="day-subtitle">${_eSub}</div>
          <div class="day-name"><span>${_eTitle}</span></div>
        </div>
        <div class="day-status-row">
          <span class="day-status-badge ${_curStatus}" id="statusBadge-${day.id}">${_statusLabel[_curStatus] || ''}</span>
          <button class="day-skip-btn" id="skipBtn-${day.id}" onclick="toggleSkip('${day.id}')">${_skipBtnTxt}</button>
        </div>
      </div>
      <div class="timer-block" id="timer-${day.id}">
        <div class="timer-countdown-label">⏱ Tempo rimanente</div>
        <div class="timer-display" id="timerDisplay-${day.id}">${formatSeconds(SESSION_DURATION)}</div>
        <div class="timer-controls">
          <button class="timer-btn timer-resume-btn" id="timerResumeBtn-${day.id}" onclick="timerResume('${day.id}')" style="display:none"><i data-lucide="play" style="width:11px;height:11px;stroke-width:2.2;fill:currentColor"></i> Riprendi</button>
          <button class="timer-btn pause-btn" id="timerPauseBtn-${day.id}" onclick="timerPause('${day.id}')" style="display:none"><i data-lucide="pause" style="width:11px;height:11px;stroke-width:2.2;fill:currentColor"></i> Pausa</button>
          <button class="timer-btn stop-btn" id="timerStopBtn-${day.id}" onclick="timerStop('${day.id}')" style="display:none"><i data-lucide="square" style="width:10px;height:10px;stroke-width:2.2;fill:currentColor"></i> Termina</button>
        </div>
        <div class="timer-meta">
          <div class="timer-saved">Tempo studiato: <span id="timerSaved-${day.id}">${formatSeconds(dayState.totalSeconds || 0)}</span></div>
        </div>
      </div>
      ${day.tip ? `<div class="tip-box"><div class="tip-label"><i data-lucide="lightbulb" style="width:11px;height:11px;stroke-width:2.2;flex-shrink:0"></i>Metodo di studio</div><div class="tip-text">${escHtml(day.tip)}</div></div>` : ''}
      <div class="day-content-row">
        <div class="section-card day-content-main">
          <div class="section-head">
            <div class="section-head-title-row">
              <span class="section-tag tag-retrieval">retrieval practice</span>
              <span class="section-title">Domande per questa giornata</span>
            </div>
            <div class="section-head-actions" id="section-actions-${day.id}" style="${dayState.sessionStarted ? '' : 'display:none'}">
              ${day.questions ? `<button class="genq-launch-btn" id="genq-btn-${day.id}" onclick="generateQuestionsFromSource('${day.id}')">
                <i data-lucide="sparkles" style="width:11px;height:11px;stroke-width:2;flex-shrink:0"></i>
                ${isAiQ ? 'Aggiungi domande' : 'Genera domande'}
              </button>` : ''}
              <button class="genq-launch-btn" id="mc-btn-${day.id}"
                onclick="startMemoryCards('${day.id}')">
                <i data-lucide="layers" style="width:11px;height:11px;stroke-width:2;flex-shrink:0"></i>
                Cards Autori
              </button>
              <button class="genq-launch-btn" id="bd-btn-${day.id}"
                onclick="startBrainDump('${day.id}', '${_titleAttr}')">
                <i data-lucide="brain" style="width:11px;height:11px;stroke-width:2;flex-shrink:0"></i>
                Brain Dump${(dayState.brainDumpBest != null) ? `<span class="bd-best-score">${dayState.brainDumpBest}%</span>` : ''}
              </button>
              <button class="quiz-launch-btn" id="quiz-btn-${day.id}"
                onclick="startQuiz('${day.id}', '${_titleAttr}')">
                <i data-lucide="zap" style="width:12px;height:12px;stroke-width:2.2;fill:currentColor;flex-shrink:0"></i>
                Genera Quiz
              </button>
            </div>
          </div>
          <div class="section-body">
            <div id="qs-panel-${day.id}"></div>
            <div id="genq-wrap-${day.id}" style="display:none"></div>
            <div class="notes-area">
              <label>Note e punti deboli emersi</label>
              <textarea placeholder="Scrivi qui cosa non ricordavi, cosa devi ripassare, concetti da approfondire..." onchange="saveNotes('${day.id}', this.value)">${escHtml(notes)}</textarea>
            </div>
          </div>
        </div>
        <div class="day-ring-aside" id="day-ring-${day.id}" style="display:none"></div>
      </div>`;
  }
  return block;
}

// ── Post-insert wiring for a day card ────────────────────────
function _wireDayCard(day) {
  if (day.type === 'rest' || day.type === 'exam') return;
  _renderQsPanel(day.id);
  const _ds = state[day.id] || {};
  if (_ds.sessionStarted || Object.keys(_ds.feedbacks || {}).length > 0) {
    _renderSessionRing(day.id, false);
  }
  // Restore timer UI if session was active (handles page reload and _patchDay rebuilds)
  if (_ds.sessionStarted) {
    _restoreTimerUI(day.id);
  }
}

// ── Restore timer block visibility after a DOM rebuild ────────
// Called by _wireDayCard whenever sessionStarted = true.
// Handles: page reload, incremental dirty-rebuild, _patchDay after AI question generation.
function _restoreTimerUI(dayId) {
  const tb = document.getElementById('timer-' + dayId);
  if (!tb) return;
  tb.style.display = '';
  tb.classList.remove('timer-idle');
  tb.classList.add('timer-active');

  const ts = timerState[dayId];
  const isRunning = ts && ts.running;
  const isPaused  = ts && !ts.running && (ts.elapsed || 0) > 0;
  const elapsed   = (ts && ts.elapsed) || 0;

  const disp      = document.getElementById('timerDisplay-' + dayId);
  const pauseBtn  = document.getElementById('timerPauseBtn-'  + dayId);
  const stopBtn   = document.getElementById('timerStopBtn-'   + dayId);
  const resumeBtn = document.getElementById('timerResumeBtn-' + dayId);
  const sAct      = document.getElementById('section-actions-' + dayId);

  if (disp) {
    disp.textContent = formatSeconds(Math.max(SESSION_DURATION - elapsed, 0));
    disp.classList.toggle('running', isRunning);
    disp.classList.toggle('paused',  isPaused);
    disp.classList.toggle('timer-warning', isRunning && (SESSION_DURATION - elapsed) <= 30 * 60);
  }
  if (pauseBtn)  pauseBtn.style.display  = isRunning ? '' : 'none';
  if (stopBtn)   stopBtn.style.display   = (isRunning || isPaused) ? '' : 'none';
  if (resumeBtn) resumeBtn.style.display = isPaused ? '' : 'none';
  if (sAct)      sAct.style.display      = '';

  // If no timer is running (page reload), start a fresh countdown
  if (!isRunning && !isPaused) {
    timerStart(dayId);
  }
}

// ── buildDays(opts) ────────────────────────────────────────────
// opts.force = true  → always do a full DOM rebuild (clears cache).
// Default            → dirty-flag: only replace cards whose state changed.
// First render is always a full build (cache is empty).
function buildDays(opts) {
  const force = opts && opts.force;
  const main  = document.getElementById('mainContent');
  const activeDays = getActiveDays();

  // ── Empty-plan state ──────────────────────────────────────
  if (!activeDays.length) {
    main.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 24px;text-align:center;gap:16px;min-height:300px;">
        <i data-lucide="calendar-plus" style="width:40px;height:40px;color:var(--text-3);stroke-width:1.5"></i>
        <div style="font-size:15px;font-weight:600;color:var(--text)">Nessun piano di studio</div>
        <div style="font-size:13px;color:var(--text-2);max-width:320px;line-height:1.5">
          Completa la configurazione iniziale per generare il tuo piano di studio personalizzato.
        </div>
        <button onclick="_showOnboarding()" style="margin-top:8px;padding:10px 22px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:500">
          Crea il mio piano →
        </button>
      </div>`;
    _dayCardCache.clear();
    _dayStateHash.clear();
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // ── Detect plan-structure change (different day set) ──────
  // If the active day IDs no longer match what's cached, force a full rebuild.
  const activeIds = activeDays.map(d => d.id).join(',');
  const cachedIds = [..._dayCardCache.keys()].join(',');
  const structureChanged = activeIds !== cachedIds;

  if (force || structureChanged || _dayCardCache.size === 0) {
    // ── Full rebuild ────────────────────────────────────────
    main.innerHTML = '';
    _dayCardCache.clear();
    _dayStateHash.clear();
    activeDays.forEach(day => {
      const block = _buildDayCard(day);
      main.appendChild(block);
      _dayCardCache.set(day.id, block);
      _dayStateHash.set(day.id, _dayHash(day));
      _wireDayCard(day);
    });
    lucide.createIcons();
    return;
  }

  // ── Incremental update (dirty-flag) ───────────────────────
  let anyChanged = false;
  activeDays.forEach(day => {
    const hash = _dayHash(day);
    if (_dayStateHash.get(day.id) === hash) return; // nothing changed for this card

    anyChanged = true;
    const newCard = _buildDayCard(day);
    const oldCard = _dayCardCache.get(day.id);
    if (oldCard && oldCard.parentNode === main) {
      main.replaceChild(newCard, oldCard);
    } else {
      main.appendChild(newCard);
    }
    _dayCardCache.set(day.id, newCard);
    _dayStateHash.set(day.id, hash);
    _wireDayCard(day);
  });
  if (anyChanged) lucide.createIcons();
}

// ── _patchDay(dayId) ──────────────────────────────────────────
// Targeted single-card refresh — use instead of buildDays() when only
// one day's data changed (e.g. after generateQuestionsFromSource).
function _patchDay(dayId) {
  const activeDays = getActiveDays();
  const day = activeDays.find(d => d.id === dayId);
  if (!day) { buildDays(); return; } // fallback: full rebuild

  const main    = document.getElementById('mainContent');
  const newCard = _buildDayCard(day);
  const oldCard = _dayCardCache.get(dayId) || document.getElementById('block-' + dayId);

  if (oldCard && oldCard.parentNode === main) {
    main.replaceChild(newCard, oldCard);
  } else {
    buildDays(); return; // card not found — fall back to full rebuild
  }

  _dayCardCache.set(dayId, newCard);
  _dayStateHash.set(dayId, _dayHash(day));
  _wireDayCard(day);
  lucide.createIcons();
}

function formatSeconds(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

function formatHoursMinutes(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h + 'h ' + String(m).padStart(2,'0') + 'm';
}

const timerState = {};
const SESSION_DURATION = 3 * 60 * 60; // 3-hour countdown (seconds)

// ── Focus mode helpers ─────────────────────────────────────────
function _focusModeOn() {
  document.body.classList.add('focus-mode');
}
function _focusModeOff() {
  document.body.classList.remove('focus-mode');
}

// ── Anti-ghost-timer: inactivity + page-visibility guard ─────
const INACTIVITY_MS   = 15 * 60 * 1000; // 15 min no interaction → pause
const HIDDEN_GRACE_MS = 30 * 1000;       // <30 s hidden → silent resume
const ST_AUTO_STOP_MS = 2 * 60 * 1000;  // "still there?" auto-stop after 2 min

let _activeTimerDayId = null;  // dayId whose timer is currently running
let _lastActivityAt   = Date.now(); // timestamp of last user interaction
let _hiddenAt         = null;  // Date.now() when tab went hidden
// _inactivityTimer, _stAutoStopTimer, _stCountdownInterval → managed by TimerRegistry
let _stillThereShown     = false; // guard against double-show

function _timerIsRunning() {
  return _activeTimerDayId !== null && !!(timerState[_activeTimerDayId]?.running);
}

function _resetInactivity() {
  if (!_timerIsRunning()) return;
  _lastActivityAt = Date.now();
  // setTimeout is throttled on mobile when page is backgrounded,
  // so we also check elapsed time on visibilitychange (see below).
  TimerRegistry.set('inactivity', _onTimerInactive, INACTIVITY_MS);
}

function _clearInactivity() {
  TimerRegistry.clear('inactivity');
}

function _onTimerInactive() {
  if (!_timerIsRunning()) return;
  if (_stillThereShown) return; // already showing
  // If user has an answer edit in progress, silently extend the timer rather
  // than interrupting them — they may be thinking between sentences.
  if (document.querySelector('.q-done-edit-area.open')) {
    _resetInactivity();
    return;
  }
  timerPause(_activeTimerDayId);
  _showStillThereModal('inactivity', 0);
}

// ── Page Visibility API (desktop + Android) ──────────────────
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    _saveHiddenState();
    // Flush pending sync — essential for PWA: iOS kills the app right after hidden
    TimerRegistry.clear('sync');
    if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  } else {
    _onPageVisible();
    // Re-check exam day email when user returns to the tab (catches the 08:00 transition)
    if (typeof _checkExamDayGoodLuck === 'function') _checkExamDayGoodLuck();
  }
});

// ── pagehide / pageshow — extra coverage for iOS PWA ─────────
window.addEventListener('pagehide', function() {
  _saveHiddenState();
  // Flush any pending sync immediately — debounce won't fire if app is killed
  TimerRegistry.clear('sync');
  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
});
window.addEventListener('pageshow', function(e) { if (e.persisted) _onPageVisible(); });

// ── Save hidden-state checkpoint ─────────────────────────────
function _saveHiddenState() {
  if (!_timerIsRunning()) return;
  _hiddenAt = Date.now();
  try {
    sessionStorage.setItem('_timerHiddenAt',  String(_hiddenAt));
    sessionStorage.setItem('_timerHiddenDay', _activeTimerDayId || '');
    // Also persist last activity timestamp so we can detect inactivity on return
    sessionStorage.setItem('_lastActivityAt', String(_lastActivityAt));
  } catch(e) {}
  timerPause(_activeTimerDayId);
}

// ── Handle page becoming visible ─────────────────────────────
let _onPageVisiblePending = false; // debounce: pagehide+visibilitychange can both fire
function _onPageVisible() {
  if (_onPageVisiblePending) return;
  _onPageVisiblePending = true;
  setTimeout(function() { _onPageVisiblePending = false; }, 500);

  // Prefer in-memory values; fall back to sessionStorage (PWA restarts)
  let hiddenAt     = _hiddenAt;
  let hiddenDay    = _activeTimerDayId;
  let lastActivity = _lastActivityAt;

  if (hiddenAt === null) {
    const sAt  = sessionStorage.getItem('_timerHiddenAt');
    const sDay = sessionStorage.getItem('_timerHiddenDay');
    const sLAA = sessionStorage.getItem('_lastActivityAt');
    if (sAt && sDay) {
      hiddenAt     = parseInt(sAt,  10);
      hiddenDay    = sDay;
      lastActivity = sLAA ? parseInt(sLAA, 10) : hiddenAt;
    }
  }

  // Clean up
  try {
    sessionStorage.removeItem('_timerHiddenAt');
    sessionStorage.removeItem('_timerHiddenDay');
    sessionStorage.removeItem('_lastActivityAt');
  } catch(e) {}
  _hiddenAt = null;

  if (hiddenAt === null || !hiddenDay) return;

  const awayMs       = Date.now() - hiddenAt;
  const inactiveMs   = Date.now() - lastActivity;
  const wasInactive  = inactiveMs >= INACTIVITY_MS;

  if (awayMs < HIDDEN_GRACE_MS && !wasInactive) {
    // Brief switch AND user was recently active → resume silently
    if (_activeTimerDayId === hiddenDay) {
      timerResume(hiddenDay);
    } else {
      // Page was reloaded — timer state lost; just note the day
      _activeTimerDayId = hiddenDay;
    }
  } else {
    // Long absence OR inactivity detected → ask the user
    _activeTimerDayId = _activeTimerDayId || hiddenDay;
    const reason = wasInactive ? 'inactivity' : 'hidden';
    _showStillThereModal(reason, awayMs);
  }
}

// ── Track user interactions ───────────────────────────────────
['mousemove','keydown','click','touchstart','touchend','pointerdown','scroll'].forEach(function(evt) {
  document.addEventListener(evt, _resetInactivity, { passive: true });
});

// ── On app start: check for an uncleared "hidden" marker ─────
// Handles the case where iOS killed the PWA while hidden
(function _checkRestoredSession() {
  const stored = sessionStorage.getItem('_timerHiddenAt');
  const storedDay = sessionStorage.getItem('_timerHiddenDay');
  if (stored && storedDay) {
    const awayMs = Date.now() - parseInt(stored, 10);
    sessionStorage.removeItem('_timerHiddenAt');
    sessionStorage.removeItem('_timerHiddenDay');
    // Only surface the modal if the gap is material (> grace period)
    // and the session state suggests a timer was active
    let savedState = {};
    try { savedState = JSON.parse(localStorage.getItem('psico_state') || '{}'); } catch(e) {}
    const dayState = savedState[storedDay];
    if (awayMs > HIDDEN_GRACE_MS && dayState?.sessionStarted && dayState?.totalSeconds) {
      // Defer until the UI is ready
      _activeTimerDayId = storedDay;
      setTimeout(function() {
        _showStillThereModal('hidden', awayMs);
      }, 1200);
    }
  }
})();

// ── Memory Cards ──────────────────────────────────────────────
const MC_PHOTO_KEY = 'psico_mc_photos'; // cached photo URLs { authorName: url|null }

let _mcCards    = [];      // loaded card array
let _mcIdx      = 0;       // current card index
let _mcMode     = 'study'; // 'study' | 'challenge'
let _mcFlipped  = false;
let _mcKnown    = 0;
let _mcAnswered = 0;
let _mcDayId    = null;    // current day context

function _mcCacheKey(dayId) { return `psico_mc_v3_${dayId}`; }

// ── Public entry-point ─────────────────────────────────────
async function startMemoryCards(dayId) {
  _mcDayId   = dayId;
  _mcIdx     = 0;
  _mcFlipped = false;
  _mcKnown   = 0;
  _mcAnswered = 0;

  const overlay = document.getElementById('mcOverlay');
  overlay.classList.add('open');

  _mcShowView('loading');

  // Show day context in loading screen
  const day = getActiveDays().find(d => d.id === dayId);
  const subEl = document.getElementById('mcLoadingSub');
  if (subEl && day?.title) subEl.textContent = `Argomenti: "${day.title}"`;


  // Check per-day cache first
  const cached = _mcLoadCache(dayId);
  if (cached && cached.length) {
    _mcCards = cached;
    _mcFetchAllPhotos(dayId).then(() => _mcRender());
    _mcRender();
    return;
  }

  // No cache → extract via AI for this specific day
  try {
    _mcCards = await _mcExtractCards(dayId);
    if (!_mcCards.length) { _mcShowView('empty'); return; }
    _mcSaveCache(dayId, _mcCards);
    _mcFetchAllPhotos(dayId).then(() => _mcRender());
    _mcRender();
  } catch (err) {
    console.error('[MemoryCards] extraction error:', err);
    _mcShowView('empty');
    document.querySelector('#mcEmptyView .mc-empty-title').textContent = 'Errore durante l\'estrazione';
    document.querySelector('#mcEmptyView .mc-empty-sub').textContent   = err.message || 'Riprova più tardi.';
  }
}

function _closeMc() {
  document.getElementById('mcOverlay').classList.remove('open');
  const track = document.getElementById('mcCarouselTrack');
  if (track) {
    track.querySelectorAll('.mc-card').forEach(c => c.classList.remove('flipped'));
    track.innerHTML = '';
  }
  const car = document.getElementById('mcCarousel');
  if (car) delete car.dataset.mcCarouselBound;
}

// ── LocalStorage helpers ───────────────────────────────────
function _mcLoadCache(dayId) {
  try { return JSON.parse(localStorage.getItem(_mcCacheKey(dayId)) || 'null'); }
  catch { return null; }
}
function _mcSaveCache(dayId, cards) {
  try { localStorage.setItem(_mcCacheKey(dayId), JSON.stringify(cards)); } catch {}
}
function _mcLoadPhotos() {
  try { return JSON.parse(localStorage.getItem(MC_PHOTO_KEY) || '{}'); }
  catch { return {}; }
}
function _mcSavePhotos(map) {
  try { localStorage.setItem(MC_PHOTO_KEY, JSON.stringify(map)); } catch {}
}

// Clear per-day card caches when sources change (photos cache is shared, keep it)
function invalidateMemoryCards() {
  const days = getActiveDays ? getActiveDays() : [];
  days.forEach(d => localStorage.removeItem(_mcCacheKey(d.id)));
  // Also clear any orphaned keys
  Object.keys(localStorage)
    .filter(k => k.startsWith('psico_mc_'))
    .forEach(k => localStorage.removeItem(k));
}

// ── AI extraction ──────────────────────────────────────────
async function _mcExtractCards(dayId) {
  const { context: sourceCtx, rule: sourceRule, hasPrimary } = _buildWeightedSourceContext({ primaryMax: 6000, secondaryMax: 1500, totalMax: 11000 });
  if (!sourceCtx) return [];

  // Get day context
  const day      = getActiveDays().find(d => d.id === dayId);
  const dayTitle = day?.title    || day?.label || '';
  const daySub   = day?.subtitle || '';

  // Questions from the day (AI-generated or plan-default)
  const dayState = state[dayId] || {};
  const qList    = dayState.aiQuestions || day?.questions || [];
  const qTexts   = qList.slice(0, 12).map(q => `• ${q.text}`).join('\n');

  const dayContext = [
    dayTitle && `Argomento della giornata: "${dayTitle}"`,
    daySub   && `Sottotitolo: "${daySub}"`,
    qTexts   && `Domande di studio per questa giornata:\n${qTexts}`,
  ].filter(Boolean).join('\n');

  const prompt = `Sei un assistente accademico specializzato in psicologia cognitiva.
Il contesto di studio di oggi è il seguente:

${dayContext}

${sourceRule}

Dal materiale di studio fornito, estrai i ricercatori/teorici/psicologi RILEVANTI per gli argomenti della giornata indicata sopra.
Priorità assoluta alle fonti primarie (dispense, slide, PDF). Includi solo autori il cui contributo è pertinente ai topic di oggi (es. se oggi si studia "sensazione e percezione", includi Gibson, Broadbent, Treisman, ecc. — non autori di altri capitoli).

Per ciascun autore fornisci:
- "author": nome completo (es. "Alan Baddeley")
- "theory": nome della teoria, modello o contributo principale pertinente agli argomenti di oggi
- "year": anno di pubblicazione/formulazione (usa la tua conoscenza se non esplicito; formato "AAAA" o "AAAA–AAAA")
- "theoryDetail": da 2 a 4 frasi (minimo ~220 caratteri, massimo ~520 caratteri) in italiano: contesto scientifico, assunti o struttura del modello, cosa spiega o predice, perché è rilevante per l'argomento della giornata. Scrivi in modo chiaro per uno studente universitario, senza elenchi puntati.
- "keyIdea": una sola frase breve (max 100 caratteri) che riassume in sintesi il messaggio da ricordare a memoria

Regole:
- Solo autori rilevanti per gli argomenti della giornata — NON tutti gli autori del corso
- Nessuna duplicazione: un autore = un contributo (il più pertinente agli argomenti di oggi)
- Da 4 a 12 autori totali
- Rispondi ESCLUSIVAMENTE con un array JSON valido, senza testo aggiuntivo

MATERIALE DI STUDIO:
${sourceCtx}`;

  const result = await _callClaude({
    model: 'claude-opus-4-5',
    max_tokens: 4200,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
  });

  const raw = result?.content?.[0]?.text || result?.text || '';
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let cards;
  try { cards = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(cards)) return [];

  return cards
    .filter(c => c.author && c.theory)
    .map((c, i) => ({
      id:      i,
      author:  String(c.author).trim(),
      theory:  String(c.theory).trim(),
      year:    String(c.year   || '—').trim(),
      theoryDetail: String(c.theoryDetail || '').trim(),
      keyIdea: String(c.keyIdea || '').trim(),
      photoUrl: null,
    }));
}

// ── Wikipedia photo fetch ──────────────────────────────────
async function _mcFetchPhoto(authorName) {
  const photoCache = _mcLoadPhotos();
  if (authorName in photoCache) return photoCache[authorName]; // null or url

  const encoded = encodeURIComponent(authorName.trim().replace(/ /g, '_'));
  let url = null;

  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      url = data?.thumbnail?.source || null;
    }
  } catch { /* network error — leave null */ }

  // Persist result (including null so we don't retry)
  photoCache[authorName] = url;
  _mcSavePhotos(photoCache);
  return url;
}

async function _mcFetchAllPhotos(dayId) {
  const pending = _mcCards.filter(c => c.photoUrl === null);
  await Promise.allSettled(pending.map(async c => {
    c.photoUrl = await _mcFetchPhoto(c.author);
  }));
  _mcSaveCache(dayId || _mcDayId, _mcCards);
  // Re-render current card photo if visible
  if (document.getElementById('mcCardsView').style.display !== 'none') {
    _mcUpdateCardDOM();
  }
}

// ── Render ─────────────────────────────────────────────────
function _mcShowView(v) {
  const loading = document.getElementById('mcLoadingView');
  const empty   = document.getElementById('mcEmptyView');
  const cards   = document.getElementById('mcCardsView');
  const box     = document.querySelector('#mcOverlay .mc-box');
  loading.style.display = v === 'loading' ? ''      : 'none';
  empty.style.display   = v === 'empty'   ? ''      : 'none';
  cards.style.display   = v === 'cards'   ? ''      : 'none';
  if (box) box.classList.toggle('mc-box--cards', v === 'cards');
  if (v === 'cards') {
    const car = document.getElementById('mcCarousel');
    if (car) delete car.dataset.mcCarouselBound;
  }
}

function _mcSlideHtml(i) {
  return `<div class="mc-carousel-slide" data-mc-i="${i}">
  <div class="mc-scene">
    <div class="mc-card">
      <div class="mc-face mc-front">
        <div class="mc-study-shell">
          <div class="mc-front-top">
            <div class="mc-photo-wrap"></div>
            <span class="mc-front-year-chip" style="display:none" aria-hidden="true"></span>
          </div>
          <div class="mc-front-lower">
            <div class="mc-author-name"></div>
          </div>
        </div>
        <div class="mc-theory-block" style="display:none">
          <div class="mc-theory-label">Teoria / Contributo</div>
          <div class="mc-theory-text mc-theory-front-text"></div>
          <div class="mc-year-badge mc-theory-front-year"></div>
        </div>
      </div>
      <div class="mc-face mc-back">
        <div class="mc-back-photo-wrap" style="display:none"></div>
        <div class="mc-back-author" style="display:none"></div>
        <div class="mc-back-theory">
          <div class="mc-theory-label">Teoria / Contributo</div>
          <div class="mc-theory-text mc-theory-back-text"></div>
          <div class="mc-year-badge mc-theory-back-year"></div>
          <div class="mc-theory-detail" style="display:none"></div>
          <div class="mc-key-idea" style="display:none"></div>
        </div>
        <div class="mc-source-ref"></div>
      </div>
    </div>
  </div>
</div>`;
}

function _mcBuildCarouselTrack() {
  const track = document.getElementById('mcCarouselTrack');
  if (!track) return;
  track.innerHTML = _mcCards.map((_, i) => _mcSlideHtml(i)).join('');
}

function _mcCarouselSnapIndex() {
  const car = document.getElementById('mcCarousel');
  if (!car || !_mcCards.length) return 0;
  const w = car.clientWidth || 1;
  return Math.min(_mcCards.length - 1, Math.max(0, Math.round(car.scrollLeft / w)));
}

function _mcScrollToIdx(i, smooth) {
  const car = document.getElementById('mcCarousel');
  if (!car || !_mcCards.length) return;
  const maxI = _mcCards.length - 1;
  const idx = Math.max(0, Math.min(maxI, i));
  const w = car.clientWidth || 1;
  const beh = smooth && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ? 'smooth' : 'auto';
  car.scrollTo({ left: idx * w, behavior: beh });
}

function _mcUnflipAll() {
  document.querySelectorAll('#mcCarouselTrack .mc-card').forEach(c => c.classList.remove('flipped'));
  _mcFlipped = false;
}

function _mcFillSlide(slideEl, i) {
  const card = _mcCards[i];
  if (!card || !slideEl) return;
  const sheet = slideEl.querySelector('.mc-card');
  const front = slideEl.querySelector('.mc-front');
  const back = slideEl.querySelector('.mc-back');
  if (!sheet || !front || !back) return;

  sheet.classList.remove('flipped');
  const studyShell = front.querySelector('.mc-study-shell');
  const theoryBlock = front.querySelector('.mc-theory-block');
  const photoWrap = front.querySelector('.mc-photo-wrap');
  const nameEl = front.querySelector('.mc-author-name');
  const yChip = front.querySelector('.mc-front-year-chip');
  const tf = front.querySelector('.mc-theory-front-text');
  const yf = front.querySelector('.mc-theory-front-year');
  const bp = back.querySelector('.mc-back-photo-wrap');
  const ba = back.querySelector('.mc-back-author');
  const bthy = back.querySelector('.mc-back-theory');
  const tb = back.querySelector('.mc-theory-back-text');
  const yb = back.querySelector('.mc-theory-back-year');
  const detailEl = back.querySelector('.mc-theory-detail');
  const kEl = back.querySelector('.mc-key-idea');
  const src = back.querySelector('.mc-source-ref');

  if (_mcMode === 'study') {
    front.classList.add('mc-front--study-layout');
    if (studyShell) studyShell.style.display = '';
    if (theoryBlock) theoryBlock.style.display = 'none';
    if (photoWrap) photoWrap.style.display = '';
    if (nameEl) { nameEl.style.display = ''; nameEl.textContent = card.author; }
    _mcSetPhotoEl(photoWrap, card.photoUrl, card.author);
    if (yChip) {
      const y = (card.year || '').trim();
      if (y && y !== '—') {
        yChip.textContent = y;
        yChip.style.display = 'inline-flex';
      } else {
        yChip.textContent = '';
        yChip.style.display = 'none';
      }
    }
    if (bp) bp.style.display = 'none';
    if (ba) ba.style.display = 'none';
    if (bthy) bthy.style.display = '';
  } else {
    front.classList.remove('mc-front--study-layout');
    if (studyShell) studyShell.style.display = 'none';
    if (theoryBlock) theoryBlock.style.display = '';
    if (photoWrap) photoWrap.style.display = 'none';
    if (nameEl) nameEl.style.display = 'none';
    if (tf) tf.textContent = card.theory;
    if (yf) yf.textContent = card.year;
    if (bp) { bp.style.display = ''; _mcSetPhotoEl(bp, card.photoUrl, card.author); }
    if (ba) { ba.style.display = ''; ba.textContent = card.author; }
    if (bthy) bthy.style.display = 'none';
  }

  if (tb) tb.textContent = card.theory;
  if (yb) yb.textContent = card.year;
  const det = (card.theoryDetail || '').trim();
  if (detailEl) {
    if (det) {
      detailEl.textContent = det;
      detailEl.style.display = '';
    } else {
      detailEl.textContent = '';
      detailEl.style.display = 'none';
    }
  }
  const ki = (card.keyIdea || '').trim();
  if (kEl) {
    kEl.textContent = ki || '';
    kEl.style.display = ki ? '' : 'none';
  }
  if (src) src.textContent = '';

  back.classList.toggle('mc-back--theory-panel', _mcMode === 'study');
}

function _mcFillAllSlides() {
  const track = document.getElementById('mcCarouselTrack');
  if (!track) return;
  track.querySelectorAll('.mc-carousel-slide').forEach(sl => {
    const j = +sl.dataset.mcI;
    if (!Number.isNaN(j)) _mcFillSlide(sl, j);
  });
}

function _mcBindCarousel() {
  const carousel = document.getElementById('mcCarousel');
  const track = document.getElementById('mcCarouselTrack');
  if (!carousel || !track || carousel.dataset.mcCarouselBound === '1') return;
  carousel.dataset.mcCarouselBound = '1';

  let scrollT = null;
  function syncFromScroll() {
    const snap = _mcCarouselSnapIndex();
    if (snap !== _mcIdx) {
      _mcIdx = snap;
      _mcUnflipAll();
      const counter = document.getElementById('mcCounter');
      if (counter) counter.textContent = `${_mcIdx + 1} / ${_mcCards.length}`;
      _mcUpdateNav();
    }
  }
  carousel.addEventListener('scroll', () => {
    if (scrollT) clearTimeout(scrollT);
    scrollT = setTimeout(syncFromScroll, 80);
  }, { passive: true });
  try { carousel.addEventListener('scrollend', syncFromScroll, { passive: true }); } catch (_) {}

  track.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const slide = e.target.closest('.mc-carousel-slide');
    if (!slide) return;
    const i = +slide.dataset.mcI;
    // Use _mcIdx (state variable) instead of recalculating from scrollLeft,
    // which can differ by sub-pixels on desktop (DPR, native scrollbar width, etc.)
    if (i !== _mcIdx) return;
    const cardEl = slide.querySelector('.mc-card');
    if (!cardEl) return;
    cardEl.classList.toggle('flipped');
    _mcFlipped = cardEl.classList.contains('flipped');
  });
}

function _mcRender() {
  if (!_mcCards.length) { _mcShowView('empty'); return; }
  _mcShowView('cards');

  const dayLabelEl = document.getElementById('mcDayLabel');
  if (dayLabelEl && _mcDayId) {
    const day = getActiveDays().find(d => d.id === _mcDayId);
    dayLabelEl.textContent = day?.title || day?.label || '';
  }

  const car = document.getElementById('mcCarousel');
  if (car) delete car.dataset.mcCarouselBound;
  _mcBuildCarouselTrack();
  _mcSetMode(_mcMode, true);
  _mcIdx = Math.min(Math.max(0, _mcIdx), _mcCards.length - 1);
  _mcUnflipAll();
  _mcFillAllSlides();
  const counter = document.getElementById('mcCounter');
  if (counter) counter.textContent = `${_mcIdx + 1} / ${_mcCards.length}`;
  _mcUpdateNav();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _mcBindCarousel();
      _mcScrollToIdx(_mcIdx, false);
    });
  });
}

function _mcUpdateCardDOM() {
  if (!_mcCards.length) return;
  _mcUnflipAll();
  const counter = document.getElementById('mcCounter');
  if (counter) counter.textContent = `${_mcIdx + 1} / ${_mcCards.length}`;
  _mcFillAllSlides();
  _mcScrollToIdx(_mcIdx, false);
  _mcUpdateNav();
}

function _mcSetPhotoEl(wrap, photoUrl, authorName) {
  const el = typeof wrap === 'string' ? document.getElementById(wrap) : wrap;
  if (!el) return;
  el.innerHTML = '';
  if (photoUrl) {
    const img = document.createElement('img');
    img.src = photoUrl;
    img.alt = authorName;
    img.draggable = false;
    img.setAttribute('draggable', 'false');
    img.onerror = () => { el.innerHTML = _mcAvatarHTML(authorName); };
    el.appendChild(img);
  } else {
    el.innerHTML = _mcAvatarHTML(authorName);
  }
}

function _mcAvatarHTML(name) {
  const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  return `<div class="mc-photo-avatar">${initials}</div>`;
}

function _mcUpdateNav() {
  const prevBtn = document.getElementById('mcPrevBtn');
  const nextBtn = document.getElementById('mcNextBtn');
  if (prevBtn) prevBtn.disabled = _mcIdx === 0;
  if (nextBtn) nextBtn.disabled = _mcIdx === _mcCards.length - 1;

  // Dots (max 12 shown)
  const dotsEl = document.getElementById('mcDots');
  if (!dotsEl) return;
  const max = Math.min(_mcCards.length, 12);
  dotsEl.innerHTML = _mcCards.slice(0, max).map((_, i) =>
    `<div class="mc-dot${i === _mcIdx ? ' active' : ''}" onclick="_mcGoTo(${i})"></div>`
  ).join('');
}

// ── User interactions (carosello = swipe orizzontale; tap sulla card = flip) ──
function _mcFlip() {
  const slide = document.querySelector('.mc-carousel-slide[data-mc-i="' + _mcIdx + '"]');
  const card = slide && slide.querySelector('.mc-card');
  if (!card) return;
  card.classList.toggle('flipped');
  _mcFlipped = card.classList.contains('flipped');
}

function _mcNext() {
  if (_mcIdx >= _mcCards.length - 1) return;
  _mcIdx++;
  _mcUnflipAll();
  _mcScrollToIdx(_mcIdx, false);
  const counter = document.getElementById('mcCounter');
  if (counter) counter.textContent = `${_mcIdx + 1} / ${_mcCards.length}`;
  _mcUpdateNav();
}

function _mcPrev() {
  if (_mcIdx <= 0) return;
  _mcIdx--;
  _mcUnflipAll();
  _mcScrollToIdx(_mcIdx, false);
  const counter = document.getElementById('mcCounter');
  if (counter) counter.textContent = `${_mcIdx + 1} / ${_mcCards.length}`;
  _mcUpdateNav();
}

function _mcGoTo(i) {
  _mcIdx = Math.max(0, Math.min(_mcCards.length - 1, i));
  _mcUnflipAll();
  _mcScrollToIdx(_mcIdx, false);
  const counter = document.getElementById('mcCounter');
  if (counter) counter.textContent = `${_mcIdx + 1} / ${_mcCards.length}`;
  _mcUpdateNav();
}

function _mcSetMode(mode, silent) {
  _mcMode = mode;
  const studyBtn     = document.getElementById('mcModeStudy');
  const challengeBtn = document.getElementById('mcModeChallenge');
  const strip        = document.getElementById('mcChallengeStrip');

  if (studyBtn)     studyBtn.classList.toggle('active',     mode === 'study');
  if (challengeBtn) challengeBtn.classList.toggle('active', mode === 'challenge');

  if (strip) strip.style.display = mode === 'challenge' ? 'flex' : 'none';

  if (mode === 'challenge') {
    _mcKnown    = 0;
    _mcAnswered = 0;
    _mcUpdateChallengeScore();
  }

  if (!silent) {
    _mcIdx = 0;
    _mcUpdateCardDOM();
    _mcUpdateNav();
  } else {
    const tr = document.getElementById('mcCarouselTrack');
    if (tr && tr.children.length) _mcFillAllSlides();
  }
}

function _mcMark(known, immediateNext) {
  if (!_mcFlipped) return; // must have flipped first
  if (known) _mcKnown++;
  _mcAnswered++;
  _mcUpdateChallengeScore();
  const go = () => {
    if (_mcIdx < _mcCards.length - 1) {
      _mcIdx++;
      _mcUpdateCardDOM();
    } else {
      _mcUnflipAll();
    }
    _mcFlipped = false;
  };
  if (immediateNext) go();
  else setTimeout(go, 320);
}

function _mcUpdateChallengeScore() {
  const el = document.getElementById('mcChallengeScore');
  if (el) el.textContent = `${_mcKnown} / ${_mcAnswered} corretti`;
}

// ── Brain Dump ────────────────────────────────────────────────
const BD_DURATION = 180; // seconds
let _bdDayId      = null;
let _bdTopic      = null;
let _bdInterval   = null;
let _bdSecsLeft   = BD_DURATION;
let _bdStarted    = false;

function startBrainDump(dayId, topic) {
  _bdDayId  = dayId;
  _bdTopic  = topic;
  _bdStarted = false;
  _bdSecsLeft = BD_DURATION;

  // Reset all views
  document.getElementById('bdInputView').style.display    = '';
  document.getElementById('bdLoadingView').style.display  = 'none';
  document.getElementById('bdResultsView').style.display  = 'none';
  document.getElementById('bdTopic').textContent          = topic;
  document.getElementById('bdTextarea').value             = '';
  document.getElementById('bdTextarea').disabled          = true;
  document.getElementById('bdSubmitBtn').style.display    = 'none';
  document.getElementById('bdStartBtn').style.display     = '';
  document.getElementById('bdMicBtn').disabled            = true;
  _bdSetTimer(BD_DURATION, BD_DURATION);

  document.getElementById('brainDumpOverlay').classList.add('open');
  lucide.createIcons();
}

function _bdStart() {
  if (_bdStarted) return;
  _bdStarted = true;
  document.getElementById('bdStartBtn').style.display  = 'none';
  document.getElementById('bdSubmitBtn').style.display = '';
  document.getElementById('bdTextarea').disabled       = false;
  document.getElementById('bdMicBtn').disabled         = false;
  document.getElementById('bdTextarea').focus();

  clearInterval(_bdInterval);
  _bdInterval = setInterval(() => {
    _bdSecsLeft--;
    _bdSetTimer(_bdSecsLeft, BD_DURATION);
    if (_bdSecsLeft <= 0) {
      clearInterval(_bdInterval);
      _submitBrainDump();
    }
  }, 1000);
}

function _bdSetTimer(secs, total) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const label = document.getElementById('bdTimerLabel');
  const fill  = document.getElementById('bdTimerFill');
  if (label) {
    label.textContent = m + ':' + String(s).padStart(2, '0');
    label.className = 'bd-timer-label' + (secs <= 30 ? ' urgent' : '');
  }
  if (fill) {
    fill.style.width = (secs / total * 100) + '%';
    fill.className = 'bd-timer-fill' + (secs <= 30 ? ' urgent' : '');
  }
}

function _bdToggleMic() {
  const ta = document.getElementById('bdTextarea');
  if (ta) startVoiceDictationInto('bdTextarea');
}

async function _submitBrainDump() {
  clearInterval(_bdInterval);
  const text = (document.getElementById('bdTextarea')?.value || '').trim();

  document.getElementById('bdInputView').style.display   = 'none';
  document.getElementById('bdLoadingView').style.display = '';
  lucide.createIcons();

  const { context: sourceCtx, rule: sourceRule } = _buildWeightedSourceContext({ primaryMax: 6000, secondaryMax: 1000, totalMax: 8000 });
  const day = getActiveDays().find(d => d.id === _bdDayId);
  const qList = (state[_bdDayId]?.aiQuestions) || (day?.questions) || [];
  const knownConcepts = qList.map(q => q.text).slice(0, 12).join('\n');

  const systemPrompt = `Sei un professore di Psicologia Cognitiva (corso UNINETTUNO, Prof. Laura Serra).
Hai ricevuto un "brain dump" testuale di uno studente: tutto quello che ricorda su un argomento specifico, scritto liberamente senza guardare gli appunti.
Il tuo compito è analizzare quanto lo studente ha compreso e ricordato rispetto al materiale delle fonti primarie.
${sourceCtx ? `\n${sourceRule}\n\nMateriale del corso:\n${sourceCtx}` : ''}
${knownConcepts ? `\nConcetti noti dall'argomento:\n${knownConcepts}` : ''}

Rispondi ESCLUSIVAMENTE con JSON valido, nessun altro testo:
{
  "score": <numero 0-100>,
  "covered": [<lista concetti chiave che lo studente ha menzionato, stringhe brevi>],
  "missing": [<lista concetti chiave importanti che mancano, max 8, stringhe brevi>],
  "feedback": "<1-2 frasi di feedback motivante e specifico in italiano>"
}`;

  try {
    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Argomento: ${_bdTopic}\n\nBrain dump dello studente:\n${text || '(nessun testo inserito)'}` }]
    });
    const raw = data.content[0].text.trim();
    const result = _extractJson(raw);
    _showBrainDumpResults(result.score || 0, result.covered || [], result.missing || [], result.feedback || '');

  } catch(e) {
    document.getElementById('bdLoadingView').style.display  = 'none';
    document.getElementById('bdInputView').style.display    = '';
    document.getElementById('bdTextarea').disabled          = false;
    alert('Errore nell\'analisi: ' + e.message);
    lucide.createIcons();
  }
}

function _showBrainDumpResults(score, covered, missing, feedback) {
  document.getElementById('bdLoadingView').style.display  = 'none';
  document.getElementById('bdResultsView').style.display  = '';

  // Save best score
  if (_bdDayId) {
    if (!state[_bdDayId]) state[_bdDayId] = {};
    const prev = state[_bdDayId].brainDumpBest || 0;
    if (score > prev) state[_bdDayId].brainDumpBest = score;
    state[_bdDayId].brainDumpLast = score;
    saveState();
    // Update readiness + ring
    if (typeof renderDayReadiness  === 'function') renderDayReadiness(_bdDayId);
    if (typeof renderReadinessPanel === 'function') renderReadinessPanel();
    if (typeof _renderSessionRing   === 'function') _renderSessionRing(_bdDayId, true);
    // Refresh button badge
    const bdBtn = document.getElementById('bd-btn-' + _bdDayId);
    if (bdBtn) {
      const best = state[_bdDayId].brainDumpBest;
      bdBtn.innerHTML = `<i data-lucide="brain" style="width:11px;height:11px;stroke-width:2;flex-shrink:0"></i> Brain Dump<span class="bd-best-score">${best}%</span>`;
      lucide.createIcons();
    }
  }

  // Score circle
  const tier = score >= 75 ? 'good' : score >= 45 ? 'medium' : 'poor';
  const label = score >= 75 ? 'Ottima padronanza' : score >= 45 ? 'In sviluppo' : 'In apprendimento';
  const circle = document.getElementById('bdScoreCircle');
  circle.className = 'bd-score-circle ' + tier;
  document.getElementById('bdScoreNum').textContent = score;
  const badge = document.getElementById('bdBadge');
  badge.className = 'bd-badge ' + tier;
  badge.textContent = label;
  document.getElementById('bdFeedback').textContent = feedback;

  // Concepts columns
  const cols = document.getElementById('bdConcepts');
  const mkItems = (arr, cls) => arr.length
    ? arr.map(c => `<div class="bd-concept-item"><span class="bd-concept-dot"></span>${c}</div>`).join('')
    : `<div class="bd-concept-item" style="opacity:.5">—</div>`;

  cols.innerHTML = `
    <div class="bd-concept-col covered">
      <div class="bd-concept-col-title">✓ Coperti (${covered.length})</div>
      ${mkItems(covered, 'covered')}
    </div>
    <div class="bd-concept-col missing">
      <div class="bd-concept-col-title">✗ Mancanti (${missing.length})</div>
      ${mkItems(missing, 'missing')}
    </div>`;

  lucide.createIcons();
}

function _retryBrainDump() {
  startBrainDump(_bdDayId, _bdTopic);
}

function _closeBrainDump() {
  clearInterval(_bdInterval);
  _bdInterval  = null;
  _bdStarted   = false;
  document.getElementById('brainDumpOverlay').classList.remove('open');
}

// ── Debug/test helper (available in browser console) ─────────
// Usage: _debugInactivity()        → print state
// Usage: _debugInactivity(true)    → simulate inactivity NOW
// Usage: _debugInactivity('tab')   → simulate tab-hidden for 5 min
window._debugInactivity = function(action) {
  const running = _timerIsRunning();
  const idleSec = Math.round((Date.now() - _lastActivityAt) / 1000);
  const info = {
    timerRunning: running,
    activeDay: _activeTimerDayId,
    inactivityTimerSet: TimerRegistry._t.has('inactivity'),
    stillThereShown: _stillThereShown,
    idleSec,
    idleUntilFireSec: Math.max(0, INACTIVITY_MS/1000 - idleSec),
    hiddenAt: _hiddenAt ? new Date(_hiddenAt).toLocaleTimeString() : null,
    elapsed: _activeTimerDayId && timerState[_activeTimerDayId]
      ? timerState[_activeTimerDayId].elapsed + 's' : '—',
    INACTIVITY_MIN: INACTIVITY_MS / 60000,
    HIDDEN_GRACE_SEC: HIDDEN_GRACE_MS / 1000,
    AUTO_STOP_SEC: ST_AUTO_STOP_MS / 1000
  };
  console.table(info);
  if (action === true) {
    if (!running) { console.warn('[inactivity] Timer not running — start a session first'); return; }
    console.log('[inactivity] Triggering inactivity NOW…');
    _onTimerInactive();
  } else if (action === 'tab') {
    if (!running) { console.warn('[inactivity] Timer not running — start a session first'); return; }
    console.log('[inactivity] Simulating 5-min tab-hidden away…');
    _hiddenAt = Date.now() - (5 * 60 * 1000); // pretend hidden 5 min ago
    timerPause(_activeTimerDayId);
    _showStillThereModal('hidden', 5 * 60 * 1000);
  }
};

function _showStillThereModal(reason, awayMs) {
  const modal    = document.getElementById('stillThereModal');
  const bodyEl   = document.getElementById('stBody');
  const iconEl   = document.getElementById('stIcon');
  const countEl  = document.getElementById('stCountdown');
  if (!modal) return;
  // Clear any lingering timers from a previous invocation
  TimerRegistry.clear('stillThere');
  TimerRegistry.clearInterval('stillThereCountdown');

  _stillThereShown = true;

  if (reason === 'hidden') {
    const awayMin = Math.round(awayMs / 60000);
    iconEl.innerHTML = '<i data-lucide="moon" style="width:32px;height:32px;stroke-width:1.5"></i>';
    bodyEl.textContent = awayMin >= 1
      ? `Il timer è stato messo in pausa mentre eri via (${awayMin} min). Vuoi riprendere la sessione?`
      : 'Il timer è stato messo in pausa mentre eri via. Vuoi riprendere?';
  } else {
    iconEl.innerHTML = '<i data-lucide="clock" style="width:32px;height:32px;stroke-width:1.5"></i>';
    bodyEl.textContent = 'Nessuna attività da 15 minuti. Il timer è in pausa — stavi ancora studiando?';
  }
  lucide.createIcons();

  // Auto-stop countdown
  let secsLeft = Math.round(ST_AUTO_STOP_MS / 1000);
  countEl.textContent = `La sessione si chiuderà automaticamente tra ${secsLeft}s`;
  TimerRegistry.set('stillThere', function() { _stillThereStop(); }, ST_AUTO_STOP_MS);
  TimerRegistry.interval('stillThereCountdown', function() {
    secsLeft--;
    if (secsLeft > 0) {
      countEl.textContent = `La sessione si chiuderà automaticamente tra ${secsLeft}s`;
    } else {
      TimerRegistry.clearInterval('stillThereCountdown');
      countEl.textContent = 'Chiusura in corso…';
    }
  }, 1000);

  modal.classList.add('open');
}

function _hideStillThereModal() {
  _stillThereShown = false;
  const modal = document.getElementById('stillThereModal');
  if (modal) modal.classList.remove('open');
  TimerRegistry.clear('stillThere');
  TimerRegistry.clearInterval('stillThereCountdown');
}

function _stillThereResume() {
  _hideStillThereModal();
  if (_activeTimerDayId) {
    timerResume(_activeTimerDayId);
    _resetInactivity();
  }
}

function _stillThereStop() {
  // If user has an edit open, don't stop the session — just dismiss the modal.
  // Stopping would re-render the panel and erase their unsaved edits.
  if (document.querySelector('.q-done-edit-area.open')) {
    _hideStillThereModal();
    if (_activeTimerDayId) timerResume(_activeTimerDayId);
    _resetInactivity();
    return;
  }
  _hideStillThereModal();
  if (_activeTimerDayId) {
    timerStop(_activeTimerDayId);
  }
}

function timerStart(dayId) {
  if (timerState[dayId] && timerState[dayId].running) return;
  if (!timerState[dayId]) timerState[dayId] = { elapsed: 0 };
  timerState[dayId].running = true;
  timerState[dayId].startedAt = Date.now() - (timerState[dayId].elapsed * 1000);
  timerState[dayId].interval = setInterval(function() { timerTick(dayId); }, 1000);
  var disp = document.getElementById('timerDisplay-' + dayId);
  if (disp) {
    const alreadyElapsed = timerState[dayId].elapsed || 0;
    disp.textContent = formatSeconds(Math.max(SESSION_DURATION - alreadyElapsed, 0));
    disp.classList.add('running');
    disp.classList.remove('paused', 'timer-warning');
  }
  var resumeBtn = document.getElementById('timerResumeBtn-' + dayId);
  if (resumeBtn) resumeBtn.style.display = 'none';
  var pauseBtn = document.getElementById('timerPauseBtn-' + dayId);
  if (pauseBtn) pauseBtn.style.display = '';
  var stopBtn = document.getElementById('timerStopBtn-' + dayId);
  if (stopBtn) stopBtn.style.display = '';
  _focusModeOn();
  _autoSetStatus(dayId);
  _activeTimerDayId = dayId;
  _resetInactivity();
}

function timerTick(dayId) {
  var elapsed = Math.floor((Date.now() - timerState[dayId].startedAt) / 1000);
  timerState[dayId].elapsed = elapsed;
  var remaining = Math.max(SESSION_DURATION - elapsed, 0);
  var el = document.getElementById('timerDisplay-' + dayId);
  if (el) {
    el.textContent = formatSeconds(remaining);
    // Warning color when < 30 minutes remaining
    el.classList.toggle('timer-warning', remaining > 0 && remaining <= 30 * 60);
  }
  // Checkpoint: persist elapsed every 60s so PWA kills don't lose time
  if (elapsed > 0 && elapsed % 60 === 0) {
    _saveTimerCheckpoint(dayId, elapsed);
  }
  // Countdown expired → show session summary
  if (remaining === 0) {
    _onCountdownExpired(dayId);
  }
}

function _saveTimerCheckpoint(dayId, elapsed) {
  try {
    sessionStorage.setItem('_timerCheckpoint', JSON.stringify({
      dayId, elapsed, savedAt: Date.now()
    }));
  } catch(e) {}
}

function _restoreTimerCheckpoint() {
  try {
    const raw = sessionStorage.getItem('_timerCheckpoint');
    if (!raw) return;
    const cp = JSON.parse(raw);
    sessionStorage.removeItem('_timerCheckpoint');
    if (!cp || !cp.dayId || !cp.elapsed) return;
    // Only restore if the checkpoint is recent (< 2 hours old) and meaningful
    const ageMs = Date.now() - (cp.savedAt || 0);
    if (ageMs > 2 * 60 * 60 * 1000) return;
    if (!state[cp.dayId]) state[cp.dayId] = {};
    const alreadySaved = state[cp.dayId].totalSeconds || 0;
    // Only add if the checkpoint has MORE seconds than what's already saved
    // (avoids double-counting if timerStop was already called)
    if (cp.elapsed > alreadySaved) {
      const extra = cp.elapsed - alreadySaved;
      if (extra > 60) { // ignore tiny deltas (< 1 min) from normal stops
        state[cp.dayId].totalSeconds = (state[cp.dayId].totalSeconds || 0) + extra;
        saveState();
        console.log('[Timer] Restored', extra + 's from checkpoint for', cp.dayId);
      }
    }
  } catch(e) {}
}

function timerPause(dayId) {
  if (!timerState[dayId] || !timerState[dayId].running) return;
  clearInterval(timerState[dayId].interval);
  timerState[dayId].running = false;
  timerState[dayId].elapsed = Math.floor((Date.now() - timerState[dayId].startedAt) / 1000);
  var disp = document.getElementById('timerDisplay-' + dayId);
  disp.classList.remove('running');
  disp.classList.add('paused');
  document.getElementById('timerPauseBtn-' + dayId).style.display = 'none';
  var resumeBtn = document.getElementById('timerResumeBtn-' + dayId);
  if (resumeBtn) { resumeBtn.style.display = ''; resumeBtn.textContent = '▶ Riprendi'; }
  _focusModeOff();
  _clearInactivity();
}

function timerResume(dayId) {
  if (!timerState[dayId]) timerState[dayId] = { elapsed: 0 };
  timerState[dayId].startedAt = Date.now() - ((timerState[dayId].elapsed || 0) * 1000);
  timerState[dayId].running = true;
  timerState[dayId].interval = setInterval(function() { timerTick(dayId); }, 1000);
  // Restore full timer-active view
  var tb = document.getElementById('timer-' + dayId);
  if (tb) { tb.classList.remove('timer-idle'); tb.classList.add('timer-active'); }
  var disp = document.getElementById('timerDisplay-' + dayId);
  if (disp) {
    const alreadyElapsed = timerState[dayId].elapsed || 0;
    disp.textContent = formatSeconds(Math.max(SESSION_DURATION - alreadyElapsed, 0));
    disp.classList.add('running'); disp.classList.remove('paused');
  }
  var resumeBtn = document.getElementById('timerResumeBtn-' + dayId);
  if (resumeBtn) resumeBtn.style.display = 'none';
  var pauseBtn = document.getElementById('timerPauseBtn-' + dayId);
  if (pauseBtn) pauseBtn.style.display = '';
  var stopBtn = document.getElementById('timerStopBtn-' + dayId);
  if (stopBtn) stopBtn.style.display = '';
  _focusModeOn();
  _activeTimerDayId = dayId;
  _resetInactivity();
}

function timerStop(dayId) {
  if (timerState[dayId] && timerState[dayId].running) {
    clearInterval(timerState[dayId].interval);
    timerState[dayId].elapsed = Math.floor((Date.now() - timerState[dayId].startedAt) / 1000);
  }
  var sessionSecs = timerState[dayId] ? timerState[dayId].elapsed : 0;
  if (!state[dayId]) state[dayId] = {};
  state[dayId].totalSeconds = (state[dayId].totalSeconds || 0) + sessionSecs;
  timerState[dayId] = { elapsed: 0, running: false };
  var disp = document.getElementById('timerDisplay-' + dayId);
  if (disp) { disp.textContent = formatSeconds(SESSION_DURATION); disp.classList.remove('running', 'paused', 'timer-warning'); }
  var pauseBtn = document.getElementById('timerPauseBtn-' + dayId);
  if (pauseBtn) { pauseBtn.style.display = 'none'; pauseBtn.textContent = 'Pausa'; }
  var stopBtn2 = document.getElementById('timerStopBtn-' + dayId);
  if (stopBtn2) stopBtn2.style.display = 'none';
  var savedEl = document.getElementById('timerSaved-' + dayId);
  if (savedEl) savedEl.textContent = formatSeconds(state[dayId].totalSeconds);
  // Reset session: go back to pre-session state
  state[dayId].sessionStarted = false;

  var tb = document.getElementById('timer-' + dayId);
  if (tb) {
    tb.classList.remove('timer-active', 'timer-idle');
    // Hide timer block entirely — pre-session view has its own hours badge
    tb.style.display = 'none';
  }
  // Hide action bar (only visible during session)
  var sAct = document.getElementById('section-actions-' + dayId);
  if (sAct) sAct.style.display = 'none';

  _focusModeOff();
  _clearInactivity();
  TimerRegistry.clearSession(); // clear inactivity + stillThere + autoSave
  _activeTimerDayId = null;
  _hiddenAt = null;
  saveState();
  updateTotalHours();
  // Force immediate cloud sync on session end (don't rely on debounce)
  TimerRegistry.clear('sync');
  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  // Rebuild questions panel (needed for correct state if user returns to this day).
  if (typeof _renderQsPanel === 'function' && !document.querySelector('.q-done-edit-area.open')) {
    _renderQsPanel(dayId);
  }
  // Return to calendar overview after closing the session
  if (typeof showPlanOverview === 'function') showPlanOverview();
}

// ── Countdown expired ─────────────────────────────────────────
function _onCountdownExpired(dayId) {
  // Stop the interval but save the full 3h as elapsed
  if (timerState[dayId]) {
    clearInterval(timerState[dayId].interval);
    timerState[dayId].running = false;
    timerState[dayId].elapsed = SESSION_DURATION;
  }
  if (!state[dayId]) state[dayId] = {};
  state[dayId].totalSeconds = (state[dayId].totalSeconds || 0) + SESSION_DURATION;
  timerState[dayId] = { elapsed: 0, running: false };

  // Reset timer UI
  var disp = document.getElementById('timerDisplay-' + dayId);
  if (disp) { disp.textContent = '0:00:00'; disp.classList.remove('running', 'paused', 'timer-warning'); }
  var pauseBtn  = document.getElementById('timerPauseBtn-' + dayId);
  var stopBtn   = document.getElementById('timerStopBtn-' + dayId);
  var resumeBtn = document.getElementById('timerResumeBtn-' + dayId);
  if (pauseBtn)  pauseBtn.style.display  = 'none';
  if (stopBtn)   stopBtn.style.display   = 'none';
  if (resumeBtn) resumeBtn.style.display = 'none';
  var tb = document.getElementById('timer-' + dayId);
  if (tb) tb.style.display = 'none';
  var sAct = document.getElementById('section-actions-' + dayId);
  if (sAct) sAct.style.display = 'none';

  state[dayId].sessionStarted = false;
  _focusModeOff();
  _clearInactivity();
  TimerRegistry.clearSession();
  _activeTimerDayId = null;
  _hiddenAt = null;
  saveState();
  TimerRegistry.clear('sync');
  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  if (!document.querySelector('.q-done-edit-area.open')) _renderQsPanel(dayId);

  // Show summary modal (slightly delayed so DOM settles)
  setTimeout(() => _showSessionEndModal(dayId, SESSION_DURATION), 300);
}

// ── Session end summary modal ─────────────────────────────────
// Reuses the coachOverlay CSS + _renderSessionRing data.
function _showSessionEndModal(dayId, elapsedSecs) {
  const dayState  = state[dayId] || {};
  const day       = getActiveDays().find(d => d.id === dayId);
  const qList     = dayState.aiQuestions || day?.questions || [];
  const feedbacks = dayState.feedbacks   || {};
  const total     = qList.length;
  const verified  = Object.keys(feedbacks).length;

  const WEIGHT = { good: 1.0, partial: 0.6, poor: 0.25 };
  let weightedSum = 0;
  qList.forEach((_, i) => { const fb = feedbacks[i]; if (fb) weightedSum += WEIGHT[fb.grade] || 0; });
  const coveragePct = total ? Math.round((weightedSum / total) * 100) : 0;
  const goodCount   = Object.values(feedbacks).filter(f => f.grade === 'good').length;
  const partialCount= Object.values(feedbacks).filter(f => f.grade === 'partial').length;

  // Grade tier for color
  const grade = coveragePct >= 75 ? 'ottimo' : coveragePct >= 40 ? 'buono' : verified > 0 ? 'parziale' : '';

  const statsHtml = total
    ? `<div class="session-end-stats">
        <div class="se-stat"><span class="se-num">${verified}</span><span class="se-lbl">domande<br>verificate</span></div>
        <div class="se-stat"><span class="se-num">${coveragePct}%</span><span class="se-lbl">copertura<br>degli argomenti</span></div>
        ${goodCount > 0 ? `<div class="se-stat"><span class="se-num">${goodCount}</span><span class="se-lbl">risposte<br>ottime</span></div>` : ''}
      </div>`
    : '';

  const bodyMsg = verified > 0
    ? `${goodCount > 0 ? `Hai risposto ottimamente a <strong>${goodCount}</strong> domande${partialCount > 0 ? ` e parzialmente a <strong>${partialCount}</strong>` : ''}. ` : ''}Salva i punti deboli emersi nelle note prima di chiudere.`
    : `Hai completato 3 ore di studio. Segnati nelle note i concetti che vuoi ripassare.`;

  let overlay = document.getElementById('sessionEndOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sessionEndOverlay';
    overlay.className = 'coach-overlay'; // reuse overlay style
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="coach-modal session-end-modal grade-${grade || 'buono'}" id="sessionEndModal">
      <div class="coach-top">
        <span class="coach-grade-label ${grade || 'buono'}">⏱ Sessione completata</span>
        <span class="session-end-time">3 ore di studio</span>
      </div>
      ${statsHtml}
      <div class="coach-body">
        <div class="coach-text">${bodyMsg}</div>
      </div>
      <div class="coach-actions">
        <button class="coach-cta" onclick="document.getElementById('sessionEndOverlay').style.display='none'">
          Continua a studiare
        </button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };
}

function updateTotalHours() {
  var total = 0;
  Object.values(state).forEach(function(d) { total += d.totalSeconds || 0; });
  // Include live elapsed from the currently running session (not yet saved to state)
  if (_activeTimerDayId && timerState[_activeTimerDayId]) {
    total += timerState[_activeTimerDayId].elapsed || 0;
  }
  var el = document.getElementById('totalHoursDisplay');
  if (el) el.textContent = formatHoursMinutes(total);
}

function resetTotalHours() {
  if (!confirm("Azzerare il contatore delle ore totali? I progressi salvati nelle singole giornate verranno mantenuti.")) return;
  Object.keys(state).forEach(function(k) { state[k].totalSeconds = 0; });
  getActiveDays().forEach(function(d) {
    var el = document.getElementById("timerSaved-" + d.id);
    if (el) el.textContent = "00:00:00";
  });
  saveState();
  updateTotalHours();
}

function toggleCheck(dayId, idx, el) {
  if (!state[dayId]) state[dayId] = {};
  if (!state[dayId].checks) state[dayId].checks = {};
  state[dayId].checks[idx] = !state[dayId].checks[idx];
  el.classList.toggle('checked', state[dayId].checks[idx]);
  saveState();
}

// ── Auto-status system ─────────────────────────────────────────
const _STATUS_LABEL = { done: '✓ Completata', partial: '◑ In corso', skip: '✗ Saltata' };

function _autoSetStatus(dayId) {
  const day = getActiveDays().find(d => d.id === dayId);
  if (!day || day.type === 'rest' || day.type === 'exam') return;
  const ds = state[dayId] || {};
  // Never override an explicit manual skip
  if (ds.status === 'skip') return;

  const qList = (ds.aiQuestions && ds.aiQuestions.length > 0)
    ? ds.aiQuestions : (day.questions || []);
  const qCount = qList.length;
  const feedbacks    = ds.feedbacks || {};
  const answers      = ds.answers   || {};
  const verifiedCount = Object.keys(feedbacks).length;
  const answeredCount = Object.keys(answers).filter(k => (answers[k] || '').trim().length >= 20).length;

  let newStatus = ds.status || null;
  if (qCount > 0 && verifiedCount >= qCount) {
    newStatus = 'done';
  } else if (verifiedCount > 0 || answeredCount > 0 || ds.sessionStarted || (ds.totalSeconds || 0) > 60) {
    newStatus = 'partial';
  } else {
    newStatus = null;
  }

  if (newStatus !== (ds.status || null)) {
    if (!state[dayId]) state[dayId] = {};
    if (newStatus) state[dayId].status = newStatus;
    else delete state[dayId].status;
    _updateDayStatusDisplay(dayId);
    _syncNavStatus(dayId, newStatus);
    updateProgress(); // keep the header progress bar in sync
  }
}

// ── Day Complete Modal ────────────────────────────────────────
/** Media qualità verifiche: `score` in app è rubrica 1–5 (non percentuale). */
function _dcmVerifyQualityPct(feedbacks) {
  const arr = Object.values(feedbacks || {});
  if (!arr.length) return null;
  const gradeFallback = { good: 4, partial: 2, poor: 1 };
  const parts = [];
  for (const f of arr) {
    let v = typeof f.score === 'number' && f.score > 0 ? f.score : null;
    if (v == null && f.grade) v = gradeFallback[f.grade] || null;
    if (v != null && v > 0) parts.push(v);
  }
  if (!parts.length) return null;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  const maxV = Math.max.apply(null, parts);
  const pct = maxV <= 5
    ? Math.min(100, Math.round((avg / 5) * 100))
    : Math.min(100, Math.round(avg));
  return { pct, mean5: Math.round(avg * 10) / 10 };
}

function _showDayCompleteModal(dayId) {
  const _sKey = 'dcm_' + dayId;
  if (localStorage.getItem(_sKey)) return;

  const day = getActiveDays().find(d => d.id === dayId);
  if (!day) return;

  const ds        = state[dayId] || {};
  const feedbacks = ds.feedbacks || {};
  const qList     = (ds.aiQuestions && ds.aiQuestions.length > 0)
                      ? ds.aiQuestions : (day.questions || []);
  const total     = qList.length;

  const qual = _dcmVerifyQualityPct(feedbacks);

  // Readiness label + colour
  const { prepLevel } = calcDayReadiness(dayId);
  const _lvlLabel = ['Inizio', 'Base', 'Buona', 'Ottima', 'Eccellente'];
  const _lvlColor = ['#666',   '#f59e0b','#3b82f6','#22c55e','#d97757'];
  const readLabel = _lvlLabel[prepLevel] || '—';
  const readColor = _lvlColor[prepLevel] || '#888';

  // Sub-title
  const overlay = document.getElementById('dayCompleteOverlay');
  if (!overlay) return;

  const dayTitle = day.title || day.subtitle || 'oggi';
  document.getElementById('dcm-sub').textContent =
    'Hai verificato tutte le ' + total + ' domande di "' + dayTitle + '"';

  // Stats
  let statsHtml = `<div class="dcm-stat">
    <span class="dcm-stat-num">${total}</span>
    <span class="dcm-stat-label">Domande</span>
  </div>`;
  if (qual) {
    const tip = 'Media delle valutazioni per domanda (scala 1–5: es. BUONO = 4/5), espressa in percentuale.';
    statsHtml += `<div class="dcm-stat" title="${tip}">
      <span class="dcm-stat-num">${qual.pct}%</span>
      <span class="dcm-stat-label">Media verifiche</span>
    </div>`;
  }
  statsHtml += `<div class="dcm-stat">
    <span class="dcm-stat-num" style="color:${readColor}">${readLabel}</span>
    <span class="dcm-stat-label">Preparazione</span>
  </div>`;
  document.getElementById('dcm-stats').innerHTML = statsHtml;

  // Action buttons
  const _et = (s) => (s || '').replace(/'/g, "\\'");
  const _dt = _et(day.title || '');
  document.getElementById('dcm-actions').innerHTML = `
    <button class="dcm-action-btn dcm-quiz"
      onclick="closeDayCompleteModal();startQuiz('${dayId}','${_dt}')">
      <span class="dcm-action-icon">🎯</span>
      <span class="dcm-action-label">Quiz</span>
      <span class="dcm-action-desc">Verifica le conoscenze</span>
    </button>
    <button class="dcm-action-btn dcm-bd"
      onclick="closeDayCompleteModal();startBrainDump('${dayId}','${_dt}')">
      <span class="dcm-action-icon">🧠</span>
      <span class="dcm-action-label">Brain Dump</span>
      <span class="dcm-action-desc">Scrivi tutto quel che sai</span>
    </button>
    <button class="dcm-action-btn dcm-mc"
      onclick="closeDayCompleteModal();startMemoryCards('${dayId}')">
      <span class="dcm-action-icon">🃏</span>
      <span class="dcm-action-label">Cards Autori</span>
      <span class="dcm-action-desc">Memorizza teorie e date</span>
    </button>`;

  // Segna come già visto solo se il modale viene effettivamente mostrato
  try { localStorage.setItem(_sKey, '1'); } catch (_) {}

  overlay.style.display = 'flex';

  // Confetti
  _dcConfetti();
}

window.closeDayCompleteModal = function() {
  const overlay = document.getElementById('dayCompleteOverlay');
  if (overlay) overlay.style.display = 'none';
};

function _dcConfetti() {
  const area = document.getElementById('dcm-confetti');
  if (!area) return;
  area.innerHTML = '';
  const colors = ['#d97757','#f59e0b','#3b82f6','#22c55e','#ec4899','#8b5cf6','#f43f5e'];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('span');
    p.className = 'dcm-particle';
    const size = 5 + Math.random() * 7;
    p.style.cssText = [
      'left:'   + (Math.random() * 100) + '%',
      'background:' + colors[Math.floor(Math.random() * colors.length)],
      'width:'  + size + 'px',
      'height:' + size + 'px',
      'border-radius:' + (Math.random() > .45 ? '50%' : '2px'),
      'animation-delay:' + (Math.random() * 0.9) + 's',
      'animation-duration:' + (1.4 + Math.random() * 0.8) + 's'
    ].join(';');
    area.appendChild(p);
  }
}

function _updateDayStatusDisplay(dayId) {
  const ds     = state[dayId] || {};
  const status = ds.status || 'none';
  const badge  = document.getElementById('statusBadge-' + dayId);
  const skipBtn = document.getElementById('skipBtn-' + dayId);
  if (badge) {
    badge.className = 'day-status-badge ' + status;
    badge.textContent = _STATUS_LABEL[status] || '';
  }
  if (skipBtn) {
    skipBtn.textContent = status === 'skip' ? '↩ Annulla skip' : 'Salta giornata';
  }
}

function _syncNavStatus(dayId, status) {
  const navItem = document.querySelector('[data-id="' + dayId + '"]');
  if (!navItem) return;
  navItem.classList.remove('status-done', 'status-partial', 'status-skip');
  if (status) navItem.classList.add('status-' + status);
  _refreshNavLocks();
}

function toggleSkip(dayId) {
  if (!state[dayId]) state[dayId] = {};
  if (state[dayId].status === 'skip') {
    delete state[dayId].status;
    _autoSetStatus(dayId); // recompute from actual work
  } else {
    state[dayId].status = 'skip';
    _updateDayStatusDisplay(dayId);
    _syncNavStatus(dayId, 'skip');
  }
  saveState();
}

// Legacy internal helper (no longer tied to buttons)
function setStatus(dayId, status) {
  if (!state[dayId]) state[dayId] = {};
  state[dayId].status = status;
  _updateDayStatusDisplay(dayId);
  _syncNavStatus(dayId, status);
  saveState();
}

function _refreshNavLocks() {
  const activeDays = getActiveDays();
  activeDays.forEach(d => {
    const el = document.querySelector(`[data-id="${d.id}"]`);
    if (!el) return;
    const locked = !isDayNavigable(d.id);
    // Toggle locked class
    el.classList.toggle('locked', locked);
    // Update/insert lock icon
    let lockEl = el.querySelector('.nav-lock-icon');
    if (locked) {
      if (!lockEl) {
        lockEl = document.createElement('i');
        lockEl.setAttribute('class', 'nav-lock-icon');
        lockEl.setAttribute('data-lucide', 'lock');
        lockEl.style.cssText = 'width:10px;height:10px;stroke-width:2.5;flex-shrink:0';
        el.appendChild(lockEl);
        lucide.createIcons({ nodes: [lockEl] });
      }
    } else {
      lockEl?.remove();
    }
  });
}

function saveNotes(dayId, value) {
  if (!state[dayId]) state[dayId] = {};
  state[dayId].notes = value;
  saveState();
}

function showApiModal() { openSetupDrawer('api'); }

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key.startsWith('sk-ant-')) {
    alert('Chiave non valida. Deve iniziare con sk-ant-');
    return;
  }
  _safeLSSet('anthropic_api_key', key);
  const statusEl = document.getElementById('setupApiStatus');
  if (statusEl) { statusEl.style.display = ''; statusEl.textContent = '✓ Chiave salvata e connessa'; }
  updateApiIndicator();
  _obValidate();
}

function updateApiIndicator() {
  const key = localStorage.getItem('anthropic_api_key');
  // Update Setup drawer status label if visible
  const statusEl = document.getElementById('setupApiStatus');
  if (statusEl) {
    if (key) {
      statusEl.style.display = '';
      statusEl.textContent = '✓ Chiave connessa';
      statusEl.style.color = '#27ae60';
    } else {
      statusEl.style.display = '';
      statusEl.textContent = 'Nessuna chiave configurata';
      statusEl.style.color = 'var(--text-3)';
    }
  }
}

// ── Coach feedback modal ───────────────────────────────────────
const _COACH_MSGS = {
  ottimo: [
    { headline: 'Eccellente', body: 'Risposta precisa e completa. Hai dimostrato comprensione profonda, non semplice memorizzazione — è esattamente questo che l\'esaminatore percepisce.' },
    { headline: 'Questo è il livello', body: 'Memorizza questa sensazione: è quello che vuoi replicare il giorno dell\'esame. Avanti con la stessa chiarezza.' },
    { headline: 'Hai davvero capito', body: 'Non stai ripetendo concetti — li stai applicando. Questa è la differenza tra chi supera l\'esame e chi lo eccelle.' },
  ],
  buono: [
    { headline: 'Bene fatto', body: 'Hai colto l\'essenziale. Qualche dettaglio in più separa questa risposta da una perfetta. Rileggi il feedback per affinare.' },
    { headline: 'Solida', body: 'La struttura è corretta. Concentrati sulle sfumature evidenziate — poi questo argomento è completamente tuo.' },
    { headline: 'Quasi perfetta', body: 'Ottima base. Piccoli affinamenti e la porti al livello successivo. Sei esattamente sulla strada giusta.' },
  ],
  parziale: [
    { headline: 'Quasi — ma non ancora', body: 'Sai di cosa si tratta, ma la risposta manca di completezza. Dieci minuti di ripasso stasera chiuderanno questo gap.' },
    { headline: 'Direzione giusta, precisione da migliorare', body: 'Identifica esattamente cosa ti è mancato e aggiungi quel dettaglio specifico al prossimo studio. Il percorso è corretto.' },
    { headline: 'Non basta per l\'esame', body: 'Serve più precisione. Hai i concetti base — affina la terminologia e la struttura. Non scoraggiarti: è un lavoro di calibrazione.' },
  ],
  insuff: [
    { headline: 'Gap identificato', body: 'Hai trovato un punto debole — è esattamente a questo che servono questi esercizi. Meglio ora che il 12 maggio. Torna su questo materiale.' },
    { headline: 'Questo argomento richiede lavoro', body: 'Informazione preziosa: segnalo nelle note e affrontalo prima di procedere. La preparazione seria parte da qui.' },
    { headline: 'Ogni gap di oggi è un punto guadagnato domani', body: 'Non ci sei ancora su questo punto. Rileggi il materiale specifico — non tutto, solo questo argomento. Poi rifai la domanda.' },
  ],
};

let _coachDismissTimer = null;
let _coachAdvanceFn   = null;

function _showCoachModal(grade, score, advanceFn, autoAdvance) {
  // Resolve message pool
  const key = score === 5 ? 'ottimo' : score === 4 ? 'buono' : score <= 1 ? 'insuff' : 'parziale';
  const msgs = _COACH_MSGS[key];
  const msg  = msgs[Math.floor(Math.random() * msgs.length)];

  // Grade display config
  const cfg = {
    ottimo:  { label: 'OTTIMO',        cls: 'ottimo',   cta: autoAdvance ? 'Prossima domanda →' : 'Avanti →' },
    buono:   { label: 'BUONO',         cls: 'buono',    cta: autoAdvance ? 'Prossima domanda →' : 'Avanti →' },
    parziale:{ label: 'PARZIALE',      cls: 'parziale', cta: 'Continua →' },
    insuff:  { label: 'INSUFFICIENTE', cls: 'insuff',   cta: 'Ho capito →' },
  }[key];

  const dots = Array.from({length: 5}, (_, i) =>
    `<span class="coach-dot${i < score ? ' ' + cfg.cls : ''}"></span>`
  ).join('');

  // Build overlay
  let overlay = document.getElementById('coachOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'coachOverlay';
    overlay.className = 'coach-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="coach-modal grade-${cfg.cls}" id="coachModal">
      <div class="coach-top">
        <div class="coach-dots">${dots}</div>
        <span class="coach-grade-label ${cfg.cls}">${cfg.label}</span>
      </div>
      <div class="coach-headline">${msg.headline}</div>
      <div class="coach-body">${msg.body}</div>
      <button class="coach-cta" onclick="_coachCtaClick()">${cfg.cta}</button>
      <div class="coach-timer-bar" id="coachTimerBar" style="--coach-bar-dur:${autoAdvance ? '3.5s' : '5s'}"></div>
    </div>`;

  _coachAdvanceFn = advanceFn || null;

  // Animate in
  requestAnimationFrame(() => {
    const m = document.getElementById('coachModal');
    if (m) {
      m.classList.add('visible');
      // Trigger countdown bar
      setTimeout(() => {
        const bar = document.getElementById('coachTimerBar');
        if (bar) bar.classList.add('run');
      }, 80);
    }
  });

  // Auto-dismiss: for good scores auto-advance, for weak scores just close
  clearTimeout(_coachDismissTimer);
  _coachDismissTimer = setTimeout(() => _dismissCoachModal(!!autoAdvance), autoAdvance ? 3500 : 5000);
}

function _coachCtaClick() {
  _dismissCoachModal(true); // true = also advance
}

function _dismissCoachModal(advance) {
  clearTimeout(_coachDismissTimer);
  const modal = document.getElementById('coachModal');
  if (modal) {
    modal.classList.remove('visible');
    setTimeout(() => {
      const overlay = document.getElementById('coachOverlay');
      if (overlay) overlay.innerHTML = '';
    }, 350);
  }
  if (advance && _coachAdvanceFn) {
    const fn = _coachAdvanceFn;
    _coachAdvanceFn = null;
    setTimeout(fn, 120); // slight delay so modal exit animates first
  } else {
    _coachAdvanceFn = null;
  }
}

// ── Auto-retry countdown for overloaded errors ───────────────
const _overloadedTimers = {};
function _showOverloadedUI(containerEl, retryFn, countdownSecs = 15) {
  const timerId = 'ol_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const btnId   = 'ol-btn-' + timerId;
  const lblId   = 'ol-lbl-' + timerId;

  containerEl.className = 'q-feedback poor visible';
  containerEl.innerHTML =
    '<div class="q-feedback-label feedback-poor" style="background:#f5a62322;color:#f5a623">⏳ Servizio sovraccarico</div>' +
    '<div style="font-size:13px;margin-top:6px;line-height:1.5">Il servizio AI è momentaneamente sovraccarico. Riprova tra qualche secondo.</div>' +
    `<div style="display:flex;align-items:center;gap:10px;margin-top:10px">` +
      `<button class="q-verify-btn" id="${btnId}" style="width:auto;padding:6px 14px">↩ Riprova</button>` +
      `<span id="${lblId}" style="font-size:12px;opacity:0.65">Riprova automatica tra <b>${countdownSecs}s</b></span>` +
    `</div>`;

  let remaining = countdownSecs;
  const lblEl = () => document.getElementById(lblId);
  const btnEl = () => document.getElementById(btnId);

  const tick = () => {
    remaining--;
    const l = lblEl();
    if (!l) { clearInterval(_overloadedTimers[timerId]); return; }
    if (remaining <= 0) {
      clearInterval(_overloadedTimers[timerId]);
      delete _overloadedTimers[timerId];
      const b = btnEl(); if (b) b.disabled = true;
      if (l) l.textContent = 'Nuovo tentativo…';
      retryFn();
    } else {
      l.innerHTML = `Riprova automatica tra <b>${remaining}s</b>`;
    }
  };

  _overloadedTimers[timerId] = setInterval(tick, 1000);

  // Manual retry button cancels the timer
  setTimeout(() => {
    const b = btnEl();
    if (b) b.onclick = () => {
      clearInterval(_overloadedTimers[timerId]);
      delete _overloadedTimers[timerId];
      retryFn();
    };
  }, 0);
}

async function verifyAnswer(dayId, qIdx, questionText, qType) {
  const answerEl = document.getElementById('answer-' + dayId + '-' + qIdx);
  const feedbackEl = document.getElementById('feedback-' + dayId + '-' + qIdx);
  const btn = document.getElementById('verify-' + dayId + '-' + qIdx) || answerEl.parentElement.querySelector('.q-verify-btn');
  const answer = answerEl.value.trim();
  if (!answer) {
    answerEl.focus();
    answerEl.style.borderColor = 'var(--skip-text)';
    setTimeout(() => { answerEl.style.borderColor = ''; }, 1500);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Valutazione in corso...';
  feedbackEl.className = 'q-feedback loading visible';
  feedbackEl.innerHTML = '<div class="q-feedback-label">Claude sta valutando...</div>';

  // Gather available sources for reference
  const _verifySrcs = getSources();  // uses correct SOURCES_KEY and s.content field
  // Only consider sources that actually have text content
  const _verifySrcsWithText = _verifySrcs.filter(s => (s.content || '').trim().length > 100);
  const _hasSrcs = _verifySrcsWithText.length > 0;
  // Order: text/syllabus first (compass), then PDFs, then textbook-ref (secondary AI)
  const _primarySrcs   = _verifySrcsWithText.filter(s => s.type !== 'textbook-ref');
  const _secondarySrcs = _verifySrcsWithText.filter(s => s.type === 'textbook-ref');
  const _orderedSrcs   = [..._primarySrcs, ..._secondarySrcs];
  // Primary sources get 12 000 chars each; secondary (AI textbook summaries) only 2 000
  const _srcContext = _hasSrcs
    ? '\n\nFONTI DI STUDIO DISPONIBILI:\n' +
      _orderedSrcs.map((s, i) => {
        const isPrimary = s.type !== 'textbook-ref';
        const label     = isPrimary
          ? '[FONTE PRIMARIA — contenuto caricato dallo studente]'
          : '[FONTE SECONDARIA — riepilogo AI del libro di testo, peso orientativo]';
        const charLimit = isPrimary ? 12000 : 2000;
        return `${label}\n[Fonte ${i+1} — ${s.title || 'senza titolo'}]:\n${(s.content || '').slice(0, charLimit)}`;
      }).join('\n\n---\n\n')
    : '';
  console.log(`[verify] Fonti disponibili: ${_verifySrcs.length} totali, ${_verifySrcsWithText.length} con contenuto`, _verifySrcsWithText.map(s => s.title + ' (' + Math.round((s.content||'').length/1000) + 'k chars)'));

  const systemPrompt = `Sei un coach universitario esperto di Psicologia Cognitiva. Il tuo ruolo non è solo valutare — è far crescere lo studente.
Il corso è "Psicologia Cognitiva" della Prof. Laura Serra (UNINETTUNO).
Rispondi SEMPRE in italiano.

Struttura la risposta così:
1. Prima riga: SOLO il giudizio: OTTIMO / BUONO / PARZIALE / INSUFFICIENTE
2. 2-4 frasi di feedback chirurgico: cosa è corretto (con precisione), cosa manca (specifica il concetto esatto), cosa è impreciso (perché è sbagliato).
3. Se mancano concetti chiave, elencali in modo conciso.
${_hasSrcs ? `4. Per giudizi PARZIALE o INSUFFICIENTE: OBBLIGATORIO. Dopo il feedback, aggiungi un blocco che inizia ESATTAMENTE con "📖 Rivedi:" su una nuova riga. Indica le sezioni delle fonti fornite dove lo studente può trovare i concetti mancanti. Usa il riferimento più specifico disponibile: numero di pagina, titolo di slide, titolo di capitolo o sezione. Se nelle fonti non ci sono pagine esplicite usa il titolo della slide o del paragrafo. Formato: "📖 Rivedi: [Fonte 1] — [titolo sezione o pag. N]". Più sezioni = più righe, ognuna con "📖 Rivedi:". Non inventare: cita solo ciò che è nelle fonti.` : ''}

GERARCHIA DELLE FONTI (rispettala rigorosamente):
- FONTI PRIMARIE (contenuto caricato dallo studente — dispense, slide, PDF): sono il riferimento PRINCIPALE e DETERMINANTE per la valutazione. Se la risposta è coerente con queste fonti, il giudizio deve premiarlo. Cita le fonti primarie nel feedback quando pertinente.
- FONTI SECONDARIE (riepiloghi AI di libri di testo): hanno valore ORIENTATIVO. Usale solo per integrare concetti non coperti dalle fonti primarie, mai per contraddirle. Non usarle come criterio per penalizzare una risposta.
- Se esistono solo fonti primarie, basa la valutazione esclusivamente su quelle.

Tono da mantenere:
- Per OTTIMO: riconosci l'eccellenza in modo specifico — non essere vago. Indica cosa rende la risposta davvero buona.
- Per BUONO: celebra senza compiacere. Indica chiaramente il delta tra questa risposta e la perfezione.
- Per PARZIALE: sii diretto e propositivo. Indica esattamente il gap e come colmarlo. Niente giri di parole.
- Per INSUFFICIENTE: non demolire, ma non edulcorare. Il fallimento è informazione utile — aiuta a capire perché e cosa fare subito.

Sii come un professore esigente ma dalla parte dello studente: onesto, preciso, motivante.`;

  const userPrompt = `Domanda (tipo: ${qType}): ${questionText}\n\nRisposta dello studente: ${answer}${_srcContext}`;

  try {
    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    const text = data.content[0].text.trim();
    const firstLine = text.split('\n')[0].toUpperCase();
    const rest = text.split('\n').slice(1).join('\n').trim();

    let grade = 'partial';
    let gradeLabel = 'PARZIALE';
    let gradeClass = 'feedback-partial';
    let score = 2;

    if (firstLine.includes('OTTIMO')) {
      grade = 'good'; gradeLabel = 'OTTIMO'; gradeClass = 'feedback-good'; score = 5;
    } else if (firstLine.includes('BUONO')) {
      grade = 'good'; gradeLabel = 'BUONO'; gradeClass = 'feedback-good'; score = 4;
    } else if (firstLine.includes('PARZIALE')) {
      grade = 'partial'; gradeLabel = 'PARZIALE'; gradeClass = 'feedback-partial'; score = 2;
    } else if (firstLine.includes('INSUFFICIENTE')) {
      grade = 'poor'; gradeLabel = 'INSUFFICIENTE'; gradeClass = 'feedback-poor'; score = 1;
    }

    const dots = Array.from({length: 5}, (_, i) =>
      `<span class="q-dot${i < score ? ' filled' : ''}"></span>`
    ).join('');

    // Split out source reference block — match several patterns Claude might use
    // Supports: "📖 Rivedi:", "Rivedi:", "**Rivedi**:", "📖 **Rivedi**:", etc.
    const _srcRefMatch = rest.match(/((?:📖\s*)?(?:\*{0,2})Rivedi(?:\*{0,2})\s*:[\s\S]*)/i);
    const _mainReview  = _srcRefMatch ? rest.slice(0, rest.indexOf(_srcRefMatch[0])).trim() : rest;
    let _srcRefBlock = '';
    if (_srcRefMatch) {
      // Normalise: ensure the emoji is present
      const _rawRef = _srcRefMatch[0].replace(/^(?!\📖)/, '📖 ');
      _srcRefBlock = `<span class="q-src-ref">${_rawRef.replace(/\n/g, '<br>').replace(/\*{1,2}([^*]+)\*{1,2}/g, '<strong>$1</strong>')}</span>`;
    } else if (_hasSrcs && (grade === 'poor' || grade === 'partial')) {
      // Fallback: sources exist but Claude didn't include the reference block
      const _srcNames = _verifySrcsWithText.map(s => s.title || 'Fonte').join(', ');
      _srcRefBlock = `<span class="q-src-ref" style="opacity:0.75">📖 Rivedi le fonti caricate per approfondire i concetti mancanti: <em>${_srcNames}</em></span>`;
    }

    const _srcsUsedBadge = _hasSrcs
      ? `<span class="q-srcs-badge"><i data-lucide="book-open" style="width:10px;height:10px;stroke-width:2;vertical-align:middle;margin-right:3px"></i>${_verifySrcsWithText.length} font${_verifySrcsWithText.length===1?'e':'i'} consultate</span>`
      : '';

    feedbackEl.className = 'q-feedback ' + grade + ' visible';
    feedbackEl.innerHTML =
      `<div class="q-rating-row">` +
        `<span class="q-rating-dots">${dots}</span>` +
        `<span class="q-rating-label ${gradeClass}">${gradeLabel}</span>` +
        _srcsUsedBadge +
      `</div>` +
      `<div class="q-review-text">${_mainReview.replace(/\n/g, '<br>')}${_srcRefBlock}</div>` +
      (grade === 'poor' || grade === 'partial'
        ? `<button class="q-show-answer-btn" id="show-ans-${dayId}-${qIdx}"
              onclick="showCorrectAnswer('${dayId}',${qIdx},'${questionText.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','${(qType||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
            <i data-lucide="lightbulb" style="width:12px;height:12px;stroke-width:2;flex-shrink:0"></i>
            Fornisci la risposta corretta
          </button>
          <div id="correct-ans-${dayId}-${qIdx}"></div>`
        : '');

    if (!state[dayId]) state[dayId] = {};
    if (!state[dayId].feedbacks) state[dayId].feedbacks = {};
    // Save review text separately so it can be fully restored without truncation
    // Do NOT save the show-answer button — it is always re-added dynamically on render
    state[dayId].feedbacks[qIdx] = {
      grade,
      score,
      reviewText: _mainReview,   // plain text of AI review (no HTML)
      srcRef: _srcRefMatch ? _srcRefMatch[0] : null,  // "📖 Rivedi:…" block if present
      ts: Date.now()
    };
    saveState();
    renderDayReadiness(dayId);
    renderReadinessPanel();
    _autoSetStatus(dayId); // may promote to 'done' if all questions verified
    _renderSessionRing(dayId, true);

    // Render Lucide icons inside the feedback (incl. "lightbulb" in show-answer btn)
    if (window.lucide) lucide.createIcons({ nodes: [feedbackEl] });

    // Show coach modal; good scores auto-advance with animation
    const _autoAdv = grade === 'good';
    _showCoachModal(grade, score, () => advanceQuestion(dayId, _autoAdv), _autoAdv);

  } catch(err) {
    if (err.name === 'OverloadedError') {
      _showOverloadedUI(feedbackEl, () => verifyAnswer(dayId, qIdx, questionText, qType));
    } else {
      feedbackEl.className = 'q-feedback poor visible';
      feedbackEl.innerHTML = '<div class="q-feedback-label feedback-poor">ERRORE</div><div style="font-size:13px;margin-top:4px">' + (err.message || 'Errore sconosciuto') + '</div>';
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="check-circle" style="width:13px;height:13px;stroke-width:2.2;flex-shrink:0"></i> Verifica risposta'; lucide.createIcons();
  }
}

// ── Improve (re-edit + re-verify) done answers ──────────────
function openImproveAnswer(dayId, qIdx) {
  const area     = document.getElementById(`done-edit-${dayId}-${qIdx}`);
  const btn      = document.getElementById(`done-improve-btn-${dayId}-${qIdx}`);
  const fbEl     = document.getElementById(`done-fb-${dayId}-${qIdx}`);
  const ansText  = document.getElementById(`done-ans-text-${dayId}-${qIdx}`);
  const ansLabel = document.getElementById(`done-ans-label-${dayId}-${qIdx}`);
  const card     = document.getElementById(`done-q-${dayId}-${qIdx}`);
  if (!area) return;

  // Hide previous answer and AI feedback — the edit area replaces them
  if (fbEl)     fbEl.style.display     = 'none';
  if (ansText)  ansText.style.display  = 'none';
  if (ansLabel) ansLabel.style.display = 'none';

  area.classList.add('open');
  if (btn) btn.style.display = 'none';

  // Switch card to "improving" mode: shows full question, hides collapsed toggle
  if (card) {
    card.classList.add('improving');
    card.classList.add('expanded'); // keep body visible
  }

  const ta = document.getElementById(`done-edit-ta-${dayId}-${qIdx}`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  _syncReverifyBtn(dayId, qIdx, ta?.value || '');
}

function closeImproveAnswer(dayId, qIdx) {
  const area     = document.getElementById(`done-edit-${dayId}-${qIdx}`);
  const btn      = document.getElementById(`done-improve-btn-${dayId}-${qIdx}`);
  const fbEl     = document.getElementById(`done-fb-${dayId}-${qIdx}`);
  const ansText  = document.getElementById(`done-ans-text-${dayId}-${qIdx}`);
  const ansLabel = document.getElementById(`done-ans-label-${dayId}-${qIdx}`);
  const card     = document.getElementById(`done-q-${dayId}-${qIdx}`);

  if (area) area.classList.remove('open');
  if (btn)      btn.style.display      = '';
  if (fbEl)     fbEl.style.display     = '';
  if (ansText)  ansText.style.display  = '';
  if (ansLabel) ansLabel.style.display = '';

  // Restore normal card state
  if (card) card.classList.remove('improving');

  // If a full reinit was deferred while the edit was open, run it now
  if (window._deferredReinit) {
    window._deferredReinit = false;
    if (typeof window._reinitApp === 'function') window._reinitApp();
  }
}

function _syncReverifyBtn(dayId, qIdx, val) {
  const btn = document.getElementById(`done-reverify-btn-${dayId}-${qIdx}`);
  if (btn) btn.disabled = val.trim().length < MIN_ANSWER_CHARS;
}

function _syncClearBtn(ta) {
  const btn = ta.parentElement?.querySelector('.q-clear-btn');
  if (!btn) return;
  btn.classList.toggle('has-text', ta.value.length > 0);
}

function _clearAnswerField(taId) {
  const ta = document.getElementById(taId);
  if (!ta) return;
  ta.value = '';
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

async function showCorrectAnswer(dayId, qIdx, questionText, qType, context) {
  const prefix = context === 'done' ? 'done-' : '';
  const btn    = document.getElementById(`${prefix}show-ans-${dayId}-${qIdx}`);
  const panel  = document.getElementById(`${prefix}correct-ans-${dayId}-${qIdx}`);
  if (!panel) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Recupero risposta…'; }

  const sourcesCtx = (() => {
    const srcs = getSources().filter(s => (s.content || '').trim().length > 100);
    if (!srcs.length) return '';
    const primary   = srcs.filter(s => s.type !== 'textbook-ref');
    const secondary = srcs.filter(s => s.type === 'textbook-ref');
    const ordered   = [...primary, ...secondary];
    return '\n\nFONTI DISPONIBILI (usa le PRIMARIE come riferimento principale):\n' +
      ordered.map((s, i) => {
        const isPrimary = s.type !== 'textbook-ref';
        const label = isPrimary ? '[FONTE PRIMARIA]' : '[FONTE SECONDARIA — orientativa]';
        return `${label} [${i+1}] ${s.title || 'Fonte'}:\n${(s.content||'').slice(0, isPrimary ? 8000 : 2000)}`;
      }).join('\n\n---\n\n');
  })();

  try {
    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `Sei un docente universitario di Psicologia Cognitiva. Fornisci una risposta modello completa, chiara e accademica alla domanda dello studente.
Gerarchia fonti: basa la risposta PRIORITARIAMENTE sulle FONTI PRIMARIE (dispense, slide, PDF caricati). Le fonti secondarie (riepiloghi AI libri di testo) sono solo integrative. Se un concetto è nelle fonti primarie, usalo come riferimento principale.
Scrivi in italiano. Rispondi direttamente, senza preamboli.`,
      messages: [{
        role: 'user',
        content: `Domanda: "${questionText}"\nTipo: ${qType || 'concettuale'}${sourcesCtx}\n\nFornisci la risposta corretta e completa a questa domanda.`
      }]
    });
    const answerText = data.content[0].text.trim();

    panel.innerHTML =
      `<div class="q-correct-answer-panel">` +
        `<div class="q-correct-answer-label"><i data-lucide="lightbulb" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:4px"></i>Risposta Corretta</div>` +
        `<div class="q-correct-answer-body">${answerText.replace(/\n/g, '<br>')}</div>` +
      `</div>`;

    if (window.lucide) lucide.createIcons({ nodes: [panel] });
    if (btn) btn.remove();
  } catch(err) {
    panel.innerHTML = `<div class="q-correct-answer-panel"><div class="q-correct-answer-label">Errore</div>${err.message}</div>`;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="lightbulb" style="width:12px;height:12px;stroke-width:2;flex-shrink:0"></i> Fornisci la risposta corretta'; if(window.lucide) lucide.createIcons({nodes:[btn]}); }
  }
}

async function reverifyAnswer(dayId, qIdx, questionText, qType) {

  const ta   = document.getElementById(`done-edit-ta-${dayId}-${qIdx}`);
  const fbEl = document.getElementById(`done-fb-${dayId}-${qIdx}`);
  const rvBtn = document.getElementById(`done-reverify-btn-${dayId}-${qIdx}`);
  if (!ta || !fbEl) return;

  const answer = ta.value.trim();
  if (answer.length < MIN_ANSWER_CHARS) return;

  rvBtn.disabled = true;
  rvBtn.textContent = 'Valutazione…';
  fbEl.className = 'q-feedback loading visible';
  fbEl.innerHTML = '<div class="q-feedback-label">Claude sta valutando…</div>';

  // Build source context with the same priority logic as verifyAnswer
  const _rvAllSrcs     = getSources().filter(s => (s.content || '').trim().length > 100);
  const _rvPrimary     = _rvAllSrcs.filter(s => s.type !== 'textbook-ref');
  const _rvSecondary   = _rvAllSrcs.filter(s => s.type === 'textbook-ref');
  const _rvOrdered     = [..._rvPrimary, ..._rvSecondary];
  const _rvHasSrcs     = _rvOrdered.length > 0;
  const _rvSrcCtx      = _rvHasSrcs
    ? '\n\nFONTI DI STUDIO DISPONIBILI:\n' +
      _rvOrdered.map((s, i) => {
        const isPrimary = s.type !== 'textbook-ref';
        const label     = isPrimary
          ? '[FONTE PRIMARIA — contenuto caricato dallo studente]'
          : '[FONTE SECONDARIA — riepilogo AI libro, peso orientativo]';
        return `${label}\n[Fonte ${i+1} — ${s.title || 'senza titolo'}]:\n${(s.content || '').slice(0, isPrimary ? 10000 : 1500)}`;
      }).join('\n\n---\n\n')
    : '';

  const systemPrompt = `Sei un coach universitario esperto di Psicologia Cognitiva. Il tuo ruolo non è solo valutare — è far crescere lo studente.
Il corso è "Psicologia Cognitiva" della Prof. Laura Serra (UNINETTUNO).
Rispondi SEMPRE in italiano.

Struttura la risposta così:
1. Prima riga: SOLO il giudizio: OTTIMO / BUONO / PARZIALE / INSUFFICIENTE
2. 2-4 frasi di feedback chirurgico: cosa è corretto, cosa manca, cosa è impreciso.
3. Se mancano concetti chiave, elencali in modo conciso.
${_rvHasSrcs ? '4. Per PARZIALE o INSUFFICIENTE: OBBLIGATORIO. Aggiungi un blocco "📖 Rivedi:" con le sezioni delle FONTI PRIMARIE dove trovare i concetti mancanti.' : ''}

GERARCHIA DELLE FONTI:
- FONTI PRIMARIE: riferimento principale e determinante per la valutazione.
- FONTI SECONDARIE: solo orientamento integrativo — non usarle per penalizzare.

Tono da mantenere:
- Per OTTIMO: riconosci l'eccellenza in modo specifico.
- Per BUONO: celebra senza compiacere. Indica il delta verso la perfezione.
- Per PARZIALE: sii diretto e propositivo. Indica esattamente il gap.
- Per INSUFFICIENTE: non demolire, ma non edulcorare. Aiuta a capire perché e cosa fare subito.`;

  try {
    const data = await _callClaude({
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Domanda (tipo: ${qType}): ${questionText}\n\nRisposta dello studente: ${answer}${_rvSrcCtx}` }]
    });
    const text = data.content[0].text.trim();
    const firstLine = text.split('\n')[0].toUpperCase();
    const rest = text.split('\n').slice(1).join('\n').trim();

    let grade = 'partial', gradeLabel = 'PARZIALE', gradeClass = 'feedback-partial', score = 2;
    if (firstLine.includes('OTTIMO'))       { grade='good';    gradeLabel='OTTIMO';        gradeClass='feedback-good';    score=5; }
    else if (firstLine.includes('BUONO'))   { grade='good';    gradeLabel='BUONO';         gradeClass='feedback-good';    score=4; }
    else if (firstLine.includes('INSUFFICIENTE')) { grade='poor'; gradeLabel='INSUFFICIENTE'; gradeClass='feedback-poor'; score=1; }

    const dots = Array.from({length:5},(_,i)=>`<span class="q-dot${i<score?' filled':''}"></span>`).join('');
    const fbHtml = `<div class="q-rating-row"><span class="q-rating-dots">${dots}</span><span class="q-rating-label ${gradeClass}">${gradeLabel}</span></div><div class="q-review-text">${rest.replace(/\n/g,'<br>')}</div>`;

    fbEl.className = `q-feedback ${grade} visible`;
    fbEl.innerHTML = fbHtml;

    // Update answer text (mostrata per intero)
    const previewEl = document.getElementById(`done-ans-text-${dayId}-${qIdx}`);
    if (previewEl) previewEl.textContent = answer;

    // Update grade icon on toggle button
    const iconEl = document.querySelector(`#done-q-${dayId}-${qIdx} .q-done-grade-icon`);
    if (iconEl) {
      iconEl.className = `q-done-grade-icon grade-${grade}`;
      iconEl.textContent = { good:'✓', partial:'◑', poor:'✗' }[grade] || '?';
    }

    // Persist
    if (!state[dayId]) state[dayId] = {};
    if (!state[dayId].answers) state[dayId].answers = {};
    state[dayId].answers[qIdx] = answer;
    const _fbTmp = document.createElement('div'); _fbTmp.innerHTML = fbHtml;
    state[dayId].feedbacks[qIdx] = {
      grade, text: (_fbTmp.textContent||'').slice(0,1200),
      html: fbHtml.length < 3000 ? fbHtml : null,
      ts: Date.now()
    };
    saveState();
    renderDayReadiness(dayId);
    renderReadinessPanel();
    _autoSetStatus(dayId);
    _renderSessionRing(dayId, true);

    // Close edit area, show coach modal
    closeImproveAnswer(dayId, qIdx);
    _showCoachModal(grade, score, null);

  } catch(err) {
    if (err.name === 'OverloadedError') {
      _showOverloadedUI(fbEl, () => reverifyAnswer(dayId, qIdx, questionText, qType));
    } else {
      fbEl.className = 'q-feedback poor visible';
      fbEl.innerHTML = '<div class="q-feedback-label feedback-poor">ERRORE</div>' + escHtml(err.message);
    }
  } finally {
    rvBtn.disabled = false;
    rvBtn.textContent = 'Riverifica →';
  }
}

// ── Voice Dictation Modal ───────────────────────────────────
let _mic = null; // stato globale sessione microfono

// Write into any textarea by ID (used by "improve done answer" mic button)
function startVoiceDictationInto(targetId) {
  const el = document.getElementById(targetId);
  if (el) startVoiceDictation(null, null, el);
}

function startVoiceDictation(dayId, qIdx, overrideTextarea) {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    if (!window.isSecureContext) {
      alert('La registrazione vocale richiede una connessione sicura (HTTPS).\n\nApri l\'app tramite https:// per usare questa funzione.');
    } else {
      alert('Il tuo browser non supporta la trascrizione vocale.\nUsa Chrome, Edge o Safari aggiornato per questa funzione.');
    }
    return;
  }

  const textarea  = overrideTextarea || document.getElementById('answer-' + dayId + '-' + qIdx);
  const qTextEls  = dayId ? document.querySelectorAll('#block-' + dayId + ' .q-text') : [];
  const questionText = (qTextEls[qIdx] ? qTextEls[qIdx].textContent.trim() : '');

  // Prepara UI modal
  const modal       = document.getElementById('micModal');
  const timerEl     = document.getElementById('micModalTimer');
  const transcriptEl = document.getElementById('micModalTranscript');
  const waveEl      = document.getElementById('micWave');
  const pauseBtn    = document.getElementById('micModalPause');

  document.getElementById('micModalQuestion').textContent = questionText;
  timerEl.textContent = '00:00';
  transcriptEl.textContent = 'Avvio microfono...';
  transcriptEl.className = 'mic-modal-transcript placeholder';
  _setMicPauseIcon(false);
  waveEl.classList.remove('paused');
  waveEl.classList.add('preparing');
  pauseBtn.classList.remove('paused');
  const labelEl = document.getElementById('micModalLabel');
  if (labelEl) labelEl.classList.remove('listening');
  modal.classList.remove('listening');
  modal.classList.add('open');
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const baseText    = textarea.value;
  let finalAdded    = '';
  let timerSecs     = 0;
  let isPaused      = false;
  let closing       = false;
  let timerStarted  = false; // true once rec.onstart fires

  // Timer — increments only after recognition has actually started
  const timerInterval = setInterval(() => {
    if (isPaused || !timerStarted) return;
    timerSecs++;
    const m = String(Math.floor(timerSecs / 60)).padStart(2, '0');
    const s = String(timerSecs % 60).padStart(2, '0');
    timerEl.textContent = m + ':' + s;
  }, 1000);

  function buildRecognition() {
    const rec = new SpeechRec();
    rec.lang = 'it-IT';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      // Only act the very first time (not on auto-restart)
      if (timerStarted) return;
      timerStarted = true;
      waveEl.classList.remove('preparing');
      transcriptEl.textContent = 'Parla ora...';
      const lbl = document.getElementById('micModalLabel');
      if (lbl) lbl.classList.add('listening');
      modal.classList.add('listening');
    };

    rec.onresult = (event) => {
      let interim = '', final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t; else interim += t;
      }
      if (final) {
        finalAdded += (finalAdded ? ' ' : '') + final.trim();
        transcriptEl.textContent = finalAdded;
        transcriptEl.className = 'mic-modal-transcript';
        textarea.value = baseText + (baseText && finalAdded ? ' ' : '') + finalAdded.trim();
        textarea.dispatchEvent(new Event('input'));
      } else if (interim) {
        transcriptEl.textContent = (finalAdded ? finalAdded + ' ' : '') + interim;
        transcriptEl.className = 'mic-modal-transcript interim';
      }
    };

    rec.onerror = (event) => {
      if (event.error === 'not-allowed') {
        _closeMicModal(false);
        alert('Permesso microfono negato.\nAbilita il microfono nelle impostazioni del browser e riprova.');
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        console.warn('[VoiceDictation]', event.error);
      }
    };

    rec.onend = () => {
      // Riavvio automatico se non è una chiusura/pausa intenzionale
      if (!closing && !isPaused && _mic) {
        setTimeout(() => {
          if (!closing && !isPaused && _mic) {
            try { _mic.rec = buildRecognition(); _mic.rec.start(); } catch(e) {}
          }
        }, 120);
      }
    };

    return rec;
  }

  _mic = {
    rec: buildRecognition(),
    timerInterval,
    textarea,
    baseText,
    build:        buildRecognition,
    getFinal:     () => finalAdded,
    getIsPaused:  () => isPaused,
    setIsPaused:  (v) => { isPaused = v; },
    close:        () => { closing = true; },
    // Audio visualizer (riempito da setupAudioVisualizer)
    animFrameId:  null,
    audioStream:  null,
    audioCtx:     null,
    stopViz:      null,
    resumeViz:    null,
  };

  _mic.rec.start();
  _setupAudioVisualizer();
}

async function _setupAudioVisualizer() {
  if (!_mic) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!_mic) { stream.getTracks().forEach(t => t.stop()); return; }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx      = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;           // 128 bin
    analyser.smoothingTimeConstant = 0.75;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const bufferLen  = analyser.frequencyBinCount; // 128
    const dataArray  = new Uint8Array(bufferLen);
    const bars       = document.querySelectorAll('#micWave span');
    const numBars    = bars.length; // 7
    const MAX_H      = 44;
    const MIN_H      = 4;

    // Mappa logaritmica: enfatizza frequenze vocali (100-3500 Hz)
    // Con fftSize=256 e SR~44100: bin_size ≈ 172 Hz
    // Bin 1-20 copre ~172-3440 Hz
    const bandEdges = [1, 2, 4, 6, 9, 13, 18, 24]; // bin start per ogni barra

    let rafId = null;

    function draw() {
      if (!_mic || _mic.getIsPaused()) return;
      rafId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      bars.forEach((bar, i) => {
        const lo = bandEdges[i];
        const hi = bandEdges[i + 1] || lo + 6;
        let sum  = 0;
        for (let b = lo; b < hi; b++) sum += dataArray[b];
        const avg    = sum / (hi - lo);
        const ratio  = avg / 255;
        const height = MIN_H + ratio * (MAX_H - MIN_H);
        bar.style.height  = height.toFixed(1) + 'px';
        bar.style.opacity = (0.25 + ratio * 0.75).toFixed(2);
      });
    }

    _mic.audioStream = stream;
    _mic.audioCtx    = ctx;
    _mic.animFrameId = rafId;

    _mic.stopViz = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      bars.forEach(b => { b.style.height = MIN_H + 'px'; b.style.opacity = '0.2'; });
    };

    _mic.resumeViz = () => {
      if (rafId) cancelAnimationFrame(rafId);
      draw();
    };

    draw();

  } catch(e) {
    // Fallback: nessun visualizer, le barre rimangono statiche
    console.warn('[AudioVisualizer]', e.message);
  }
}

function pauseVoiceDictation() {
  if (!_mic) return;
  const waveEl   = document.getElementById('micWave');
  const pauseBtn = document.getElementById('micModalPause');

  if (!_mic.getIsPaused()) {
    _mic.setIsPaused(true);
    try { _mic.rec.stop(); } catch(e) {}
    if (_mic.stopViz) _mic.stopViz();
    waveEl.classList.add('paused');
    pauseBtn.classList.add('paused');
    pauseBtn.title = 'Riprendi';
    _setMicPauseIcon(true);
  } else {
    _mic.setIsPaused(false);
    _mic.rec = _mic.build();
    _mic.rec.start();
    if (_mic.resumeViz) _mic.resumeViz();
    waveEl.classList.remove('paused');
    pauseBtn.classList.remove('paused');
    pauseBtn.title = 'Pausa';
    _setMicPauseIcon(false);
  }
}

function stopVoiceDictation(apply) {
  if (!_mic) return;
  _closeMicModal(apply);
}

function _closeMicModal(apply) {
  if (!_mic) return;
  _mic.close();
  clearInterval(_mic.timerInterval);
  try { _mic.rec.abort(); } catch(e) {}
  // Ferma visualizer e rilascia microfono
  if (_mic.stopViz) _mic.stopViz();
  if (_mic.audioStream) _mic.audioStream.getTracks().forEach(t => t.stop());
  if (_mic.audioCtx)   _mic.audioCtx.close().catch(() => {});

  if (apply) {
    const final = _mic.getFinal().trim();
    const base  = _mic.baseText;
    _mic.textarea.value = base + (base && final ? ' ' : '') + final;
    _mic.textarea.dispatchEvent(new Event('input'));
  } else {
    _mic.textarea.value = _mic.baseText;
    _mic.textarea.dispatchEvent(new Event('input'));
  }

  _mic = null;
  const _modal = document.getElementById('micModal');
  _modal.classList.remove('open');
  _modal.classList.remove('listening');
  const _lbl = document.getElementById('micModalLabel');
  if (_lbl) _lbl.classList.remove('listening');
}

function _setMicPauseIcon(isPlaying) {
  const el = document.getElementById('micPauseIcon');
  if (!el) return;
  el.setAttribute('data-lucide', isPlaying ? 'play' : 'pause');
  lucide.createIcons({ nodes: [el] });
}

// ── Photo OCR ────────────────────────────────────────────────
let _ocr = null; // { textarea, dayId, qIdx, worker }

function startPhotoOcr(dayId, qIdx, targetId) {
  const taId = targetId || ('answer-' + dayId + '-' + qIdx);
  const textarea = document.getElementById(taId);
  if (!textarea) return;
  _ocr = { textarea, dayId, qIdx, worker: null };
  _ocrResetModal();
  document.getElementById('ocrModal').classList.add('open');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function _ocrResetModal() {
  _el('ocrPickArea').style.display = '';
  _el('ocrPreviewWrap').classList.remove('visible');
  _el('ocrProgressWrap').classList.remove('visible');
  _el('ocrResultWrap').classList.remove('visible');
  _el('ocrResultEmpty').style.display = 'none';
  _el('ocrResultTa').value = '';
  _el('ocrProgressFill').style.width = '0%';
  _el('ocrApplyBtn').disabled = true;
  // Reset file inputs so same file can be reselected
  _el('ocrInputCamera').value = '';
  _el('ocrInputGallery').value = '';
}

function _ocrRetry() {
  _ocrResetModal();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function _ocrTriggerCamera() { _el('ocrInputCamera').click(); }
function _ocrGallery() { _el('ocrInputGallery').click(); }
function _ocrTriggerGallery() { _ocrGallery(); }

function _el(id) { return document.getElementById(id); }

function _ocrFileSelected(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  // Show preview
  const url = URL.createObjectURL(file);
  _el('ocrPreviewImg').src = url;
  _el('ocrPickArea').style.display = 'none';
  _el('ocrPreviewWrap').classList.add('visible');
  _el('ocrProgressWrap').classList.add('visible');
  _el('ocrResultWrap').classList.remove('visible');
  _el('ocrProgressFill').style.width = '15%';
  _el('ocrProgressLabel').textContent = 'Trascrizione AI in corso…';
  if (typeof lucide !== 'undefined') lucide.createIcons();

  _ocrRunVision(file);
}

/** Ridimensiona l'immagine a max maxPx sul lato lungo e restituisce { base64, mediaType } */
async function _ocrResizeImage(file, maxPx) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else        { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        resolve({
          base64: dataUrl.split(',')[1],
          mediaType: 'image/jpeg'
        });
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function _ocrRunVision(file) {
  const progressFill  = _el('ocrProgressFill');
  const progressLabel = _el('ocrProgressLabel');

  // Animated progress: while waiting for the API the bar pulses between 55% and 85%
  let _progressAnim = null;
  function _startProgressPulse() {
    let pct = 55; let dir = 1;
    _progressAnim = setInterval(() => {
      pct += dir * 2;
      if (pct >= 85) dir = -1;
      if (pct <= 55) dir = 1;
      progressFill.style.width = pct + '%';
    }, 200);
  }
  function _stopProgressPulse() {
    if (_progressAnim) { clearInterval(_progressAnim); _progressAnim = null; }
  }

  function _ocrShowError(msg) {
    _stopProgressPulse();
    _el('ocrProgressWrap').classList.remove('visible');
    _el('ocrResultWrap').classList.add('visible');
    _el('ocrResultTa').value = '';
    _el('ocrResultEmpty').style.display = '';
    _el('ocrResultEmpty').textContent = msg || 'Errore durante la trascrizione. Riprova.';
    _el('ocrApplyBtn').disabled = true;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  try {
    progressFill.style.width = '30%';
    progressLabel.textContent = 'Elaborazione immagine…';

    // Higher resolution = more detail for cursive handwriting recognition
    const { base64, mediaType } = await _ocrResizeImage(file, 1568);

    progressFill.style.width = '55%';
    progressLabel.textContent = 'Lettura testo con AI… (può richiedere 20–40s)';

    _startProgressPulse();

    // Infer source context for domain-aware transcription
    const _srcCtx = (() => {
      try {
        const sources = getSources ? getSources() : [];
        const primary = sources.filter(s => s.type !== 'textbook-ref').slice(0, 2);
        if (!primary.length) return '';
        const hint = primary.map(s => s.title).join(', ');
        return `\nIl contenuto è relativo al corso universitario: ${hint}.`;
      } catch { return ''; }
    })();

    // AbortController with 90-second timeout
    const _ocrAbort = new AbortController();
    const _ocrTimeout = setTimeout(() => _ocrAbort.abort(), 90_000);

    let data;
    try {
      data = await _callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        temperature: 0,
        system: `Sei un esperto trascrittore di testo accademico scritto a mano in italiano. Il tuo compito è trascrivere con la massima fedeltà possibile, sfruttando il contesto disciplinare per riconoscere correttamente termini tecnici, nomi di autori e concetti specialistici.${_srcCtx}

Regole:
- Trascrivi TUTTO il testo visibile, riga per riga, rispettando i paragrafi originali.
- Per parole illeggibili o incerte usa [?] come segnaposto; non inventare parole.
- Usa il vocabolario tecnico del dominio (psicologia, neuroscienze, scienze cognitive) per disambiguare le parole dalla grafia simile.
- Non aggiungere spiegazioni, titoli, commenti o formattazione extra — solo il testo trascritto.
- Se il testo è tagliato o parzialmente visibile ai bordi, trascrivi comunque la parte leggibile.`,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: 'Trascrivi il testo scritto a mano in questa immagine.'
            }
          ]
        }]
      }, _ocrAbort.signal);
    } finally {
      clearTimeout(_ocrTimeout);
    }

    _stopProgressPulse();
    progressFill.style.width = '100%';

    // Extract text — handle both standard and error response shapes
    const rawText = (
      data?.content?.[0]?.text ||
      data?.content?.find?.(c => c.type === 'text')?.text ||
      ''
    ).trim();

    _el('ocrProgressWrap').classList.remove('visible');
    _el('ocrResultWrap').classList.add('visible');

    if (rawText) {
      _el('ocrResultTa').value = rawText;
      _el('ocrResultEmpty').style.display = 'none';
      _el('ocrApplyBtn').disabled = false;
    } else {
      // If API returned but no text — possible content policy or blank image
      const stopReason = data?.stop_reason || data?.stop_sequence || '';
      _el('ocrResultTa').value = '';
      _el('ocrResultEmpty').style.display = '';
      _el('ocrResultEmpty').textContent = stopReason
        ? `Nessun testo rilevato (stop: ${stopReason}). Assicurati che la foto sia nitida e ben illuminata.`
        : 'Nessun testo rilevato. Assicurati che la foto sia nitida e ben illuminata.';
      _el('ocrApplyBtn').disabled = true;
    }

  } catch(err) {
    console.error('[OCR Vision]', err);
    const isTimeout = err.name === 'AbortError';
    _ocrShowError(isTimeout
      ? 'Timeout: la trascrizione ha impiegato troppo. Prova con una foto più piccola o con migliore illuminazione.'
      : `Errore: ${err.message || 'controlla la connessione e riprova.'}`
    );
    return;
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeOcrModal(apply) {
  if (apply && _ocr) {
    const extracted = (_el('ocrResultTa').value || '').trim();
    if (extracted && _ocr.textarea) {
      const base = _ocr.textarea.value;
      _ocr.textarea.value = base + (base && extracted ? '\n' : '') + extracted;
      _ocr.textarea.dispatchEvent(new Event('input'));
    }
  }
  _ocr = null;
  document.getElementById('ocrModal').classList.remove('open');
}

function _ocrOverlayClick(e) {
  if (e.target === document.getElementById('ocrModal')) closeOcrModal(false);
}

// ══════════════════════════════════════════════════════════
// TUTOR ASSISTANT — text-first study helper (mic = dettatura)
// ══════════════════════════════════════════════════════════
const _tutor = {
  open: false,
  listening: false,
  loading: false,
  messages: [],   // [{role:'user'|'ai', text, ts}]
  recognition: null,
  liveTranscript: '',
  history: []     // last N pairs for Claude context [{role,content}]
};
const TUTOR_MAX_HISTORY = 8; // messaggi Claude da tenere in contesto

function toggleTutor() {
  _tutor.open = !_tutor.open;
  const panel = document.getElementById('tutorPanel');
  const fab   = document.getElementById('tutorFab');
  panel.classList.toggle('open', _tutor.open);
  fab.classList.toggle('open', _tutor.open);
  if (_tutor.open) {
    _tutorUpdateHeader();
    lucide.createIcons({ nodes: [panel] });
    document.getElementById('tutorTextInput')?.focus();
  } else {
    _tutorStopListening(false);
  }
}

function _tutorUpdateHeader() {
  const sub = document.getElementById('tutorHeaderSub');
  if (!sub) return;
  const info = getExamInfo();
  sub.textContent = info.subject ? `Esame: ${info.subject}` : 'Chiedi un chiarimento sull\'esame';
}

// ── System prompt ──────────────────────────────────────────
function _tutorBuildSystem() {
  const info    = getExamInfo();
  const subject = info.subject   || 'questo esame';
  const prof    = info.professor ? ` (Prof. ${info.professor})` : '';

  // ── Snippet fonti pesato (fonti primarie prima, secondarie ridotte) ──────
  const { context: _srcRaw, rule: _srcRule } = _buildWeightedSourceContext({ primaryMax: 900, secondaryMax: 300, totalMax: 6000 });
  const srcCtx = _srcRaw
    ? `\n\n${_srcRule}\n\nFONTI DI STUDIO DISPONIBILI:\n${_srcRaw}`
    : '';

  // ── Indice domande con tracciabilità fonte ───────────────────
  // Costruisce un indice compatto: giorno → lista domande (piano + AI)
  // con numero progressivo e sourceRef, in modo che il tutor possa
  // rispondere a "da quale fonte viene la domanda n°X di [giorno]?"
  let questionIndex = '';
  try {
    const activeDays = typeof getActiveDays === 'function' ? getActiveDays() : [];
    const st = (typeof state !== 'undefined') ? state : {};
    const indexLines = [];

    for (const day of activeDays) {
      if (day.type === 'rest' || day.type === 'exam') continue;
      const planQs = day.questions || [];
      const aiQs   = (st[day.id]?.aiQuestions) || [];
      if (!planQs.length && !aiQs.length) continue;

      indexLines.push(`\n${day.label || day.id}${day.title ? ' — ' + day.title : ''}:`);
      let n = 1;
      for (const q of planQs) {
        const src = q.sourceRef ? ` | Fonte: ${q.sourceRef.slice(0, 120)}` : '';
        indexLines.push(`  ${n}. [${q.type || 'domanda'}] ${q.text.slice(0, 100)}${src}`);
        n++;
      }
      for (const q of aiQs) {
        const src = q.sourceRef ? ` | Fonte: ${q.sourceRef.slice(0, 120)}` : '';
        indexLines.push(`  ${n}. [AI·${q.type || 'domanda'}] ${q.text.slice(0, 100)}${src}`);
        n++;
      }
    }

    if (indexLines.length) {
      questionIndex = `\n\nINDICE DOMANDE DEL PIANO DI STUDIO (tracciabilità fonte):
Quando lo studente chiede da quale fonte proviene una domanda specifica (es. "la domanda n°3 di mercoledì"), cerca nell'indice qui sotto e rispondi citando il sourceRef corrispondente.
${indexLines.join('\n')}`;
    }
  } catch(e) { /* non bloccare il tutor se l'indice fallisce */ }

  return `Sei l'assistente di studio Mnesti specializzato nell'esame di "${subject}"${prof}.

Il tuo ruolo è aiutare lo studente a chiarire dubbi, capire meglio gli argomenti dell'esame e verificare la tracciabilità delle domande.

REGOLE ASSOLUTE:
1. Rispondi SOLO a domande pertinenti all'esame di "${subject}" e ai suoi argomenti.
2. Se la domanda riguarda il FUNZIONAMENTO DELL'APP Mnesti (es. bug, problemi tecnici, come usare una funzione, account, pagamenti, suggerimenti di miglioramento), rispondi brevemente con quello che sai e aggiungi ESATTAMENTE questa stringa su una nuova riga alla fine: [SUPPORTO_UMANO]
3. Se la domanda è completamente fuori tema (né esame né app), rispondi: "Posso aiutarti sugli argomenti dell'esame di ${subject} o su come usare Mnesti."
4. Rispondi in italiano, in modo chiaro. Per domande semplici resta conciso (poche frasi); se la domanda richiede una spiegazione articolata, sviluppala per intero senza interromperti a metà.
5. Usa le fonti di studio disponibili quando pertinenti.
6. Parla come un tutor universitario esperto: preciso, diretto, incoraggiante.
7. Tono conversazionale, non da manuale accademico. Elenchi puntati solo quando aiutano davvero la comprensione.
8. Non aggiungere mai [SUPPORTO_UMANO] per domande sull'esame o sul suo contenuto.
9. TRACCIABILITÀ: se ti chiedono da quale fonte proviene una domanda del piano, usa l'indice domande qui sotto per rispondere con precisione — cita nome fonte, sezione/slide e l'estratto testuale del sourceRef.${srcCtx}${questionIndex}`;
}

// ── Render ─────────────────────────────────────────────────
function _tutorRender() {
  const container = document.getElementById('tutorMessages');
  const empty     = document.getElementById('tutorEmpty');
  if (!container) return;

  if (!_tutor.messages.length) {
    empty && (empty.style.display = '');
    return;
  }
  empty && (empty.style.display = 'none');

  // Build only new messages after existing ones
  const existing = container.querySelectorAll('.tutor-msg, .tutor-typing-dots');
  existing.forEach(el => el.remove());

  _tutor.messages.forEach((msg, i) => {
    const div = document.createElement('div');
    div.className = `tutor-msg ${msg.role}`;

    const time = new Date(msg.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

    const SUPPORT_TOKEN = '[SUPPORTO_UMANO]';
    if (msg.role === 'ai' && msg.text.includes(SUPPORT_TOKEN)) {
      const cleanText = msg.text.replace(SUPPORT_TOKEN, '').trim();
      const msgId = `tsup-${i}`;
      div.innerHTML = `
        <div class="tutor-bubble">
          ${_tutorEsc(cleanText)}
          <div class="tutor-support-wrap" id="${msgId}-wrap">
            <div class="tutor-support-note">Nessun problema — puoi scrivere direttamente al team Mnesti.</div>
            <button class="tutor-support-btn" id="${msgId}-btn" onclick="_tutorShowSupportForm('${msgId}', ${i})">
              <i data-lucide="mail" style="width:12px;height:12px;stroke-width:2.2;pointer-events:none"></i>
              Scrivi al team Mnesti
            </button>
            <div class="tutor-support-form" id="${msgId}-form" style="display:none">
              <textarea class="tutor-support-textarea" id="${msgId}-ta"
                placeholder="Descrivi il problema o la tua domanda…">${_tutorEsc(msg.userQuestion || '')}</textarea>
              <button class="tutor-support-send" id="${msgId}-send"
                onclick="_tutorSubmitSupport('${msgId}', ${i})">Invia messaggio</button>
            </div>
            <div class="tutor-support-sent" id="${msgId}-sent" style="display:none">
              ✓ Messaggio inviato — ti risponderemo via email.
            </div>
          </div>
        </div>
        <div class="tutor-msg-time">${time}</div>`;
    } else {
      div.innerHTML = `
        <div class="tutor-bubble">${_tutorEsc(msg.text)}</div>
        <div class="tutor-msg-time">${time}</div>`;
    }
    container.appendChild(div);
  });

  // Typing indicator
  if (_tutor.loading) {
    const dots = document.createElement('div');
    dots.className = 'tutor-typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(dots);
  }

  container.scrollTop = container.scrollHeight;
  lucide.createIcons();
}

// ── Support escalation ──────────────────────────────────────
function _tutorShowSupportForm(msgId, msgIdx) {
  // Pre-fill with the user's question that triggered this response
  const userQ = _tutor.messages[msgIdx - 1]?.text || '';
  const ta = document.getElementById(`${msgId}-ta`);
  if (ta && !ta.value) ta.value = userQ;

  document.getElementById(`${msgId}-btn`).style.display  = 'none';
  document.getElementById(`${msgId}-form`).style.display = 'flex';
  ta?.focus();
}

async function _tutorSubmitSupport(msgId, msgIdx) {
  const ta   = document.getElementById(`${msgId}-ta`);
  const send = document.getElementById(`${msgId}-send`);
  const msg  = (ta?.value || '').trim();
  if (!msg) return;

  send.disabled    = true;
  send.textContent = 'Invio…';

  try {
    const SB_URL  = 'https://olagntawajefdjrkkvcc.supabase.co';
    const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sYWdudGF3YWplZmRqcmtrdmNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDU2NTYwNTAsImV4cCI6MjA2MTIzMjA1MH0.ePDFMBNJMtCBSanKdxGJLDIs3GCJKMOmTnvAJOJJBww';
    const session  = (await _sb?.auth?.getSession())?.data?.session;
    const token    = session?.access_token || SB_ANON;

    const res = await fetch(`${SB_URL}/functions/v1/support-email`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ message: msg }),
    });
    if (!res.ok) throw new Error(await res.text());

    document.getElementById(`${msgId}-form`).style.display = 'none';
    document.getElementById(`${msgId}-sent`).style.display = '';
  } catch(e) {
    console.error('[support-email]', e);
    send.disabled    = false;
    send.textContent = 'Riprova';
  }
}

// ── Exam Day Good Luck Email ──────────────────────────────────────────────────
// Fires once at 08:00 on exam day — only if ≥70% giorni completati AND ≥65% preparazione.
// Idempotent: stores a sent-flag in localStorage keyed to the exam date.
async function _checkExamDayGoodLuck() {
  try {
    const info = getExamInfo();
    if (!info?.date) return;

    // Is today exam day?
    const today = new Date();
    const examD = _examInfoParseYMD(info.date);
    if (!examD) return;
    if (
      today.getFullYear() !== examD.getFullYear() ||
      today.getMonth()    !== examD.getMonth()    ||
      today.getDate()     !== examD.getDate()
    ) return;

    // Not before 08:00
    if (today.getHours() < 8) return;

    // Already sent for this exam date?
    const sentKey = 'psico_goodluck_sent_' + info.date;
    if (localStorage.getItem(sentKey)) return;

    // Conditions: ≥70% giorni completati, ≥65% preparazione
    const activeDays = getActiveDays();
    const studyDays  = activeDays.filter(d => d.type !== 'rest' && d.type !== 'exam');
    const done       = studyDays.filter(d => state[d.id]?.status === 'done').length;
    const total      = studyDays.length || 1;
    const studioPct  = Math.round((done / total) * 100);
    const readiness  = calculateGlobalReadiness()?.score ?? 0;

    if (studioPct < 70 || readiness < 65) {
      console.info('[GoodLuck] Condizioni non raggiunte:', studioPct + '% giorni,', readiness + '% preparazione');
      return;
    }

    // Get auth token
    const SB_URL  = 'https://olagntawajefdjrkkvcc.supabase.co';
    const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sYWdudGF3YWplZmRqcmtrdmNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDU2NTYwNTAsImV4cCI6MjA2MTIzMjA1MH0.ePDFMBNJMtCBSanKdxGJLDIs3GCJKMOmTnvAJOJJBww';
    const session = (await _sb?.auth?.getSession())?.data?.session;
    const token   = session?.access_token || SB_ANON;

    const res = await fetch(`${SB_URL}/functions/v1/exam-goodluck`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        subject:   info.subject   || '',
        professor: info.professor || '',
        studioPct,
        readiness,
        examDate:  info.date,
      }),
    });

    if (res.ok) {
      localStorage.setItem(sentKey, '1');
      console.info('[GoodLuck] Email inviata (', studioPct + '% giorni,', readiness + '% prep)');
    } else {
      console.warn('[GoodLuck] Edge function error:', res.status, await res.text());
    }
  } catch(e) {
    console.warn('[GoodLuck]', e.message);
  }
}

function _tutorEsc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    .replace(/\n/g,'<br>');
}

// ── Audio visualizer (same logic as voice dictation modal) ──
const _tutorViz = { stream: null, ctx: null, rafId: null };

async function _tutorStartVisualizer() {
  _tutorStopVisualizer();
  const waveEl = document.getElementById('tutorWave');
  if (waveEl) waveEl.style.display = 'flex';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!_tutor.listening) { stream.getTracks().forEach(t => t.stop()); return; }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx      = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    ctx.createMediaStreamSource(stream).connect(analyser);

    const dataArray  = new Uint8Array(analyser.frequencyBinCount);
    const bars       = waveEl ? waveEl.querySelectorAll('span') : [];
    const bandEdges  = [1, 2, 4, 6, 9, 13, 18, 24];
    const MAX_H = 28, MIN_H = 3;

    function draw() {
      if (!_tutor.listening) return;
      _tutorViz.rafId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      bars.forEach((bar, i) => {
        const lo = bandEdges[i], hi = bandEdges[i + 1] || lo + 6;
        let sum = 0;
        for (let b = lo; b < hi; b++) sum += dataArray[b];
        const ratio  = (sum / (hi - lo)) / 255;
        bar.style.height  = (MIN_H + ratio * (MAX_H - MIN_H)).toFixed(1) + 'px';
        bar.style.opacity = (0.25 + ratio * 0.75).toFixed(2);
      });
    }

    _tutorViz.stream = stream;
    _tutorViz.ctx    = ctx;
    draw();
  } catch(e) {
    console.warn('[TutorViz]', e.message);
  }
}

function _tutorStopVisualizer() {
  if (_tutorViz.rafId) { cancelAnimationFrame(_tutorViz.rafId); _tutorViz.rafId = null; }
  if (_tutorViz.stream) { _tutorViz.stream.getTracks().forEach(t => t.stop()); _tutorViz.stream = null; }
  if (_tutorViz.ctx)   { _tutorViz.ctx.close().catch(() => {}); _tutorViz.ctx = null; }
  const waveEl = document.getElementById('tutorWave');
  if (waveEl) {
    waveEl.style.display = 'none';
    waveEl.querySelectorAll('span').forEach(b => { b.style.height = '3px'; b.style.opacity = '0.3'; });
  }
}

// ── Microphone (dettatura nel campo di testo) ──────────────
function _tutorToggleMic() {
  if (_tutor.listening) {
    _tutorStopListening(true);
  } else {
    _tutorStartListening();
  }
}

function _tutorStartListening() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    alert('Il tuo browser non supporta la trascrizione vocale.\nUsa Chrome o Safari aggiornato.');
    return;
  }
  if (_tutor.loading) return;

  const rec = new SpeechRec();
  rec.lang = 'it-IT';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  _tutor.recognition   = rec;
  _tutor.listening     = true;
  _tutor.liveTranscript = '';
  _tutorSetMicState(true);
  _tutorStartVisualizer();

  const input = document.getElementById('tutorTextInput');
  // Testo già digitato prima della dettatura: la trascrizione si accoda
  const baseText = input ? input.value.trim() : '';
  if (input) input.placeholder = 'In ascolto…';

  const _applyTranscript = () => {
    if (!input) return;
    const t = _tutor.liveTranscript.trim();
    input.value = baseText ? (t ? baseText + ' ' + t : baseText) : t;
    _tutorInputChanged();
  };

  rec.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t; else interim += t;
    }
    _tutor.liveTranscript = final || interim;
    _applyTranscript();
  };

  rec.onerror = (e) => {
    _tutorStopListening(false);
    if (e.error === 'not-allowed') alert('Accesso al microfono negato. Abilita il microfono nelle impostazioni del browser.');
  };

  rec.onend = () => {
    _tutor.listening = false;
    _tutorSetMicState(false);
    _tutorStopVisualizer();
    _applyTranscript();
    if (input) {
      input.placeholder = 'Scrivi la tua domanda…';
      input.focus();
    }
  };

  try { rec.start(); } catch(e) { _tutorStopListening(false); }
}

function _tutorStopListening(commit) {
  if (_tutor.recognition) {
    try { _tutor.recognition.stop(); } catch(e) {}
    if (!commit) _tutor.recognition.onend = null;
    _tutor.recognition = null;
  }
  _tutor.listening = false;
  _tutorSetMicState(false);
  _tutorStopVisualizer();
  const input = document.getElementById('tutorTextInput');
  if (input) input.placeholder = 'Scrivi la tua domanda…';
}

function _tutorSetMicState(listening) {
  const btn = document.getElementById('tutorMicBtn');
  if (btn) btn.classList.toggle('listening', listening);
}

// ── Text input ─────────────────────────────────────────────
function _tutorInputChanged() {
  const input = document.getElementById('tutorTextInput');
  const btn   = document.getElementById('tutorSendBtn');
  if (!input) return;
  // Auto-grow fino a ~4 righe
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  if (btn) btn.disabled = !input.value.trim() || _tutor.loading;
}

function _tutorInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    _tutorSendFromInput();
  }
}

function _tutorSendFromInput() {
  if (_tutor.loading) return;
  const input = document.getElementById('tutorTextInput');
  const text  = (input?.value || '').trim();
  if (!text) return;
  if (_tutor.listening) _tutorStopListening(false);
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  _tutorInputChanged();
  _tutorSend(text);
}

// ── Send to Claude ─────────────────────────────────────────
async function _tutorSend(userText) {
  if (!userText.trim()) return;

  // Add user message
  _tutor.messages.push({ role: 'user', text: userText, ts: Date.now() });
  _tutor.history.push({ role: 'user', content: userText });
  _tutor.loading = true;
  _tutorRender();
  _tutorInputChanged();

  try {
    const messages = _tutor.history.slice(-TUTOR_MAX_HISTORY);
    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: _tutorBuildSystem(),
      messages
    });

    const reply = (data?.content?.[0]?.text || '').trim();
    if (!reply) throw new Error('Risposta vuota');

    _tutor.history.push({ role: 'assistant', content: reply });
    if (_tutor.history.length > TUTOR_MAX_HISTORY * 2) {
      _tutor.history = _tutor.history.slice(-TUTOR_MAX_HISTORY);
    }

    _tutor.messages.push({ role: 'ai', text: reply, ts: Date.now() });
    _tutor.loading = false;
    _tutorRender();
    _tutorInputChanged();

  } catch(err) {
    console.error('[Tutor]', err);
    const errMsg = err.message?.includes('Limite') ? err.message
                 : 'Errore nella risposta. Riprova.';
    _tutor.messages.push({ role: 'ai', text: errMsg, ts: Date.now() });
    _tutor.loading = false;
    _tutorRender();
    _tutorInputChanged();
  }
}

// ── Quiz ────────────────────────────────────────────────────
let _quiz = null;

/**
 * Estrae e parsa il primo valore JSON valido dalla risposta di Claude.
 * Gestisce: testo prima/dopo il JSON, code fence markdown, virgolette tipografiche.
 * @param {string} raw - testo grezzo dalla risposta
 * @returns {any} valore JSON parsato
 */
function _extractJson(raw) {
  // 1. Normalizza virgolette tipografiche
  let s = raw
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

  // 2. Rimuovi code fences (incluse varianti con spazi o newline extra)
  s = s.replace(/```\s*json\s*/gi, '').replace(/```/g, '');

  // Parser tollerante: prova JSON.parse e, se fallisce, riprova dopo aver
  // rimosso le virgole finali (errore JSON comune nelle risposte LLM, es.
  // [{...},] oppure {"a":1,}). Le virgole dentro le stringhe non sono mai
  // immediatamente seguite da ] o } quindi la sostituzione è sicura.
  const _tryParse = (txt) => {
    try { return JSON.parse(txt); } catch { /* retry below */ }
    // \u007d = '}' scritto come escape per non confondere il parser di test
    // che conta le graffe nel sorgente (vedi tests/helpers/extract.js).
    return JSON.parse(txt.replace(/,(\s*[\]\u007d])/g, '$1'));
  };

  // 3. Prova direttamente
  try {
    const parsed = _tryParse(s.trim());
    // Se il modello ha restituito un singolo oggetto "day" invece di un array,
    // avvolgilo automaticamente così il chiamante riceve sempre un array.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.date) {
      return [parsed];
    }
    return parsed;
  } catch { /* fall through */ }

  // 4. Estrai il primo array [...] o oggetto {...}
  const firstBracket = s.indexOf('[');
  const firstBrace   = s.indexOf('{');
  let start = -1, end = -1, closing = '';

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket; closing = ']';
    end = s.lastIndexOf(']');
  } else if (firstBrace !== -1) {
    start = firstBrace; closing = '}';
    end = s.lastIndexOf('}');
  }

  if (start !== -1 && end > start) {
    try {
      const parsed = _tryParse(s.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.date) {
        return [parsed];
      }
      return parsed;
    } catch { /* fall through */ }
  }

  // 5. Partial recovery: handle streaming truncation mid-array.
  // Find the last complete object "}" and close the array there.
  if (start !== -1 && closing === ']') {
    const chunk = s.slice(start);
    const lastCommaObj = chunk.lastIndexOf('},');
    if (lastCommaObj !== -1) {
      try { return _tryParse(chunk.slice(0, lastCommaObj + 1) + ']'); } catch { /* fall through */ }
    }
    const lastBrace = chunk.lastIndexOf('}');
    if (lastBrace !== -1) {
      try { return _tryParse(chunk.slice(0, lastBrace + 1) + ']'); } catch { /* fall through */ }
    }
  }

  // 6. Partial recovery for truncated single object → wrap in array
  if (start !== -1 && closing === '}') {
    const chunk = s.slice(start);
    const lastBrace = chunk.lastIndexOf('}');
    if (lastBrace !== -1) {
      try {
        const parsed = _tryParse(chunk.slice(0, lastBrace + 1));
        if (parsed && parsed.date) return [parsed];
      } catch { /* fall through */ }
    }
  }

  throw new Error('JSON non valido: ' + raw.slice(0, 120) + '…');
}

/** Ripara JSON quiz da risposte Claude con virgolette tipografiche o testo extra. */
function _repairAndParseQuiz(raw) {
  return _extractJson(raw);
}

async function startQuiz(dayId, topic) {

  _quiz = null;
  const modal   = document.getElementById('quizModal');
  const loading = document.getElementById('quizLoading');
  const qView   = document.getElementById('quizQuestionView');
  const rView   = document.getElementById('quizResultsView');

  // Build warm-up prompts from day questions (free retrieval practice while waiting)
  const day = getActiveDays().find(d => d.id === dayId);
  const dayQs = (day?.questions || []).filter(q => q.text);
  const hints = [
    'Cerca di ricordarlo con parole tue, senza guardare gli appunti.',
    'Prova a spiegarlo come se dovessi insegnarlo a qualcuno.',
    'Pensa a un esempio concreto che lo illustri.',
    'Quali sono le parole chiave di questo concetto?',
    'Come lo collegheresti a ciò che hai studiato prima?'
  ];
  const warmupQs = dayQs.length >= 2
    ? dayQs.sort(() => Math.random() - 0.5).slice(0, Math.min(dayQs.length, 5))
    : null;

  if (warmupQs) {
    const dots = warmupQs.map((_, i) => `<div class="quiz-warmup-dot${i===0?' active':''}"></div>`).join('');
    loading.innerHTML = `
      <div class="quiz-warmup">
        <div class="quiz-warmup-header"><i data-lucide="brain" style="width:14px;height:14px;stroke-width:2;vertical-align:middle;margin-right:4px"></i> Riscaldamento mentale</div>
        <div class="quiz-warmup-card" id="warmupCard">
          <div class="quiz-warmup-type" id="warmupType">Ripassa nella mente</div>
          <div class="quiz-warmup-q" id="warmupQ">${escHtml(warmupQs[0].text)}</div>
          <div class="quiz-warmup-hint" id="warmupHint">${hints[0]}</div>
        </div>
        <div class="quiz-warmup-nav" id="warmupDots">${dots}</div>
        <div class="quiz-warmup-footer">
          <div class="quiz-spinner" style="width:18px;height:18px" role="status" aria-label="Caricamento"></div>
          <div class="quiz-warmup-generating">Il quiz si sta preparando…</div>
        </div>
      </div>`;

    // Auto-cycle cards every 10 seconds
    let _warmupIdx = 0;
    const _warmupTimer = setInterval(() => {
      const card = document.getElementById('warmupCard');
      if (!card) { clearInterval(_warmupTimer); return; }
      card.classList.add('fade-out');
      setTimeout(() => {
        if (!document.getElementById('warmupCard')) { clearInterval(_warmupTimer); return; }
        _warmupIdx = (_warmupIdx + 1) % warmupQs.length;
        document.getElementById('warmupQ').textContent    = warmupQs[_warmupIdx].text;
        document.getElementById('warmupHint').textContent = hints[_warmupIdx % hints.length];
        // Update dots
        document.querySelectorAll('.quiz-warmup-dot').forEach((d, i) =>
          d.classList.toggle('active', i === _warmupIdx));
        card.classList.remove('fade-out');
      }, 420);
    }, 10000);
    // Expose timer so it can be cleared when quiz loads
    loading._warmupTimer = _warmupTimer;
  } else {
    loading.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div class="quiz-spinner" role="status" aria-label="Caricamento"></div>
        <div class="quiz-loading-label">Generazione domande in corso…<br><span style="font-size:10px;color:var(--text-3)">${escHtml(topic)}</span></div>
      </div>`;
  }

  loading.style.display = '';
  qView.style.display   = 'none';
  rView.style.display   = 'none';
  modal.classList.add('open');
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Include source context if available
  // primaryOnly: esclude i libri di testo quando ci sono fonti primarie (stesso motivo
  // della generazione domande — Claude attinge ai libri noti anche con pochi token).
  const { context: sourceCtx, rule: sourceRule } = _buildWeightedSourceContext({ primaryMax: 12000, secondaryMax: 2000, totalMax: 18000, primaryOnly: true });
  const hasSources = !!sourceCtx;
  const sourcePreamble = hasSources
    ? `${sourceRule}\n\nHai a disposizione il seguente materiale del corso. Le domande devono essere ricavate seguendo la gerarchia sopra:\n--- INIZIO FONTI ---\n${sourceCtx}\n--- FINE FONTI ---\n\n`
    : '';

  const sourceConstraint = hasSources
    ? `VINCOLO FONTI (critico): ogni domanda DEVE essere direttamente ricavabile dalle FONTI PRIMARIE fornite sopra. Ogni concetto, autore, modello, esperimento o termine tecnico citato deve essere esplicitamente presente nelle fonti primarie. Le fonti secondarie sono solo orientative. NON generare domande basate su conoscenza generale della disciplina.`
    : `ATTENZIONE: nessuna fonte fornita. Genera domande strettamente specifiche all'argomento indicato, con terminologia tecnica precisa, evitando qualsiasi domanda di carattere metodologico generale o metadisciplinare (es. evita domande sul "metodo scientifico in psicologia" o simili). Focalizzati solo sui concetti, modelli e autori specifici di quell'argomento.`;

  const systemPrompt = `Sei un professore universitario di Psicologia Cognitiva (corso UNINETTUNO, Prof. Laura Serra) che prepara uno studente a un esame universitario scritto.\n\n${sourcePreamble}${sourceConstraint}\n\nSTANDARD DI QUALITÀ — ogni domanda DEVE rispettare tutti questi criteri:
1. Specificità: testa un concetto, modello, autore o esperimento preciso — NON principi generali o metodologia scientifica generica
2. Chiarezza: formulazione inequivocabile, una sola interpretazione possibile
3. Distrattori plausibili: le opzioni errate devono sembrare credibili a chi non ha studiato bene — mai opzioni assurde o palesemente errate
4. Unicità: esattamente una risposta corretta, senza ambiguità
5. Livello accademico: richiede comprensione e ragionamento, non sola memorizzazione meccanica

DISTRIBUZIONE COGNITIVA (Tassonomia di Bloom) — distribuisci le 6 domande così:
• 2 domande "ricordo": definizioni precise, autori chiave, nomenclatura tecnica specifica dell'argomento
• 2 domande "comprensione": spiegare meccanismi, distinguere concetti simili, inferire conseguenze
• 2 domande "applicazione": applicare un modello teorico a un caso concreto, riconoscere un fenomeno in un esempio

AUTO-VALIDAZIONE — prima di finalizzare ogni domanda, verifica internamente:
✓ La domanda è specifica e non generica? (una domanda sul "metodo scientifico in generale" NON è accettabile)
✓ Il concetto testato è presente nelle fonti fornite (se disponibili)?
✓ C'è esattamente una risposta corretta, inequivocabilmente?
✓ I 3 distrattori sono plausibili ma sbagliati se si conosce la materia?
✓ Il livello è adeguato per un esame universitario scritto?
Se una domanda non supera la validazione, riscrivila prima di includerla.

TRACCIABILITÀ FONTE (obbligatoria): per ogni domanda includi il campo "sourceRef" con: nome del file/fonte, titolo sezione o numero slide, e un breve estratto tra virgolette (max 120 caratteri) che dimostri che il concetto è nelle fonti. Formato: "NomeFonte — Sezione/Slide N: «estratto»"

Rispondi ESCLUSIVAMENTE con un array JSON valido (nessun altro testo prima o dopo) nel formato:
[{"q":"testo domanda","opts":["opzione A","opzione B","opzione C","opzione D"],"ans":0,"exp":"spiegazione della risposta corretta (1-2 frasi, spiega perché è giusta e perché le altre sono errate)","diff":"base|intermedio|avanzato","bloom":"ricordo|comprensione|applicazione","sourceRef":"NomeFonte — Sezione: «estratto dal testo»"}]

REGOLA JSON CRITICA: i valori stringa NON devono contenere virgolette doppie non escapate. Se devi citare qualcosa, usa virgolette singole o il carattere \". USA SOLO virgolette ASCII standard ", mai virgolette tipografiche (" " ' ').

Dove "ans" è l'indice 0-3 dell'opzione corretta. Usa solo italiano.`;

  try {
    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 4200,
      temperature: 1,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Argomento: ${topic}\n\n[Sessione #${Date.now()}-${Math.random().toString(36).slice(2,7)}] Genera un set di domande COMPLETAMENTE NUOVO e DIVERSO rispetto a qualsiasi sessione precedente. Varia i concetti scelti, le formulazioni e i distrattori.\n\nRicorda: le domande devono riguardare concetti, modelli, autori ed esperimenti SPECIFICI di questo argomento${hasSources ? ', presenti nelle fonti fornite' : ''}. Evita domande generiche, metodologiche o metadisciplinari.\n\nOBBLIGATORIO: includi "sourceRef" per ogni domanda con la citazione della sezione/slide specifica e l'estratto testuale dalle fonti.`
      }]
    });
    const questions = _repairAndParseQuiz(data.content[0].text.trim());
    if (!Array.isArray(questions) || questions.length === 0) throw new Error('Risposta non valida');

    // Shuffle options so the correct answer is never predictably in position 0
    questions.forEach(q => {
      const order = [0, 1, 2, 3];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      q.opts = order.map(i => q.opts[i]);
      q.ans  = order.indexOf(q.ans);
    });

    _quiz = {
      dayId, topic, questions,
      current: 0, score: 0, correctCount: 0,
      results: [], timerRaf: null, timerDeadline: null,
      answered: false, TIMER_MS: 25000
    };

    // Clear warm-up carousel if active
    if (loading._warmupTimer) { clearInterval(loading._warmupTimer); loading._warmupTimer = null; }
    loading.style.display = 'none';
    qView.style.display   = '';
    _showQuizQuestion(0);

  } catch(e) {
    loading.innerHTML = `
      <div style="color:var(--skip-text);font-size:13px;margin-bottom:16px;">Errore: ${e.message}</div>
      <button onclick="closeQuiz()" style="padding:8px 18px;background:var(--accent);color:var(--bg);border:none;border-radius:7px;cursor:pointer;font-size:13px;">Chiudi</button>`;
  }
}

function _showQuizQuestion(idx) {
  if (!_quiz) return;
  const q = _quiz.questions[idx];
  _quiz.answered = false;
  _quiz.timerDeadline = Date.now() + _quiz.TIMER_MS;

  document.getElementById('quizTopicLabel').textContent = _quiz.topic;
  document.getElementById('quizScoreBadge').textContent = _quiz.score + ' pt';

  // Dots
  const dotsEl = document.getElementById('quizDots');
  dotsEl.innerHTML = _quiz.questions.map((_, i) => {
    let cls = 'quiz-dot-item';
    if      (i < idx)  cls += _quiz.results[i] ? ' correct' : ' wrong';
    else if (i === idx) cls += ' current';
    return `<span class="${cls}"></span>`;
  }).join('');

  document.getElementById('quizQuestionNum').textContent = (idx + 1) + ' / ' + _quiz.questions.length;

  const qtEl = document.getElementById('quizQuestionText');
  qtEl.style.opacity = '0';
  qtEl.textContent = q.q;
  requestAnimationFrame(() => { qtEl.style.opacity = '1'; });

  // Quality meta badges (diff + bloom level)
  const bloomLabels = { ricordo: '🔵 Ricordo', comprensione: '🟡 Comprensione', applicazione: '🔴 Applicazione' };
  const diffLabels  = { base: 'Base', intermedio: 'Intermedio', avanzato: 'Avanzato' };
  const metaEl = document.getElementById('quizQMeta');
  if (metaEl) {
    const diff  = q.diff  || '';
    const bloom = q.bloom || '';
    metaEl.innerHTML = [
      diff  ? `<span class="quiz-diff-badge diff-${diff}">${diffLabels[diff] || diff}</span>` : '',
      bloom ? `<span class="quiz-bloom-tag">${bloomLabels[bloom] || bloom}</span>` : ''
    ].join('');
    metaEl.style.display = (diff || bloom) ? '' : 'none';
  }

  // Source reference badge
  const srcWrap = document.getElementById('quizSourceRefWrap');
  const srcText = document.getElementById('quizSourceRefText');
  if (srcWrap && srcText) {
    if (q.sourceRef) {
      srcText.textContent = q.sourceRef;
      srcWrap.classList.remove('open');
      srcWrap.style.display = '';
    } else {
      srcWrap.style.display = 'none';
    }
  }

  const expEl  = document.getElementById('quizExplanation');
  const nextBtn = document.getElementById('quizNextBtn');
  expEl.style.display  = 'none';
  nextBtn.style.display = 'none';
  nextBtn.innerHTML = idx < _quiz.questions.length - 1
    ? 'Prossima <i data-lucide="arrow-right" style="width:13px;height:13px;stroke-width:2.2"></i>'
    : 'Risultati <i data-lucide="arrow-right" style="width:13px;height:13px;stroke-width:2.2"></i>';

  const letters = ['A','B','C','D'];
  document.getElementById('quizOptions').innerHTML = q.opts.map((opt, i) =>
    `<button class="quiz-opt" onclick="selectQuizAnswer(${i})">
      <span class="quiz-opt-letter">${letters[i]}</span>
      <span class="quiz-opt-text">${opt}</span>
    </button>`
  ).join('');

  _startQuizTimer();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function _startQuizTimer() {
  if (_quiz.timerRaf) cancelAnimationFrame(_quiz.timerRaf);
  const bar = document.getElementById('quizTimerBar');
  bar.style.width = '100%';
  bar.classList.remove('urgent');

  function tick() {
    if (!_quiz || _quiz.answered) return;
    const rem = _quiz.timerDeadline - Date.now();
    const pct = Math.max(0, rem / _quiz.TIMER_MS * 100);
    bar.style.width = pct.toFixed(1) + '%';
    if (pct < 25) bar.classList.add('urgent');
    if (rem <= 0) { selectQuizAnswer(-1); return; }
    _quiz.timerRaf = requestAnimationFrame(tick);
  }
  _quiz.timerRaf = requestAnimationFrame(tick);
}

function selectQuizAnswer(optIdx) {
  if (!_quiz || _quiz.answered) return;
  _quiz.answered = true;
  if (_quiz.timerRaf) { cancelAnimationFrame(_quiz.timerRaf); _quiz.timerRaf = null; }

  const q       = _quiz.questions[_quiz.current];
  const correct = q.ans;
  const isOk    = optIdx === correct;
  const elapsed = _quiz.TIMER_MS - Math.max(0, _quiz.timerDeadline - Date.now());

  _quiz.results.push(isOk);
  if (isOk) {
    _quiz.correctCount++;
    _quiz.score += 10 + (elapsed < 8000 ? 5 : 0);
    const badge = document.getElementById('quizScoreBadge');
    badge.style.transform = 'scale(1.18)';
    setTimeout(() => { badge.style.transform = ''; }, 250);
    document.getElementById('quizScoreBadge').textContent = _quiz.score + ' pt';
  }

  // Colour options
  document.querySelectorAll('.quiz-opt').forEach((btn, i) => {
    btn.disabled = true;
    if      (i === correct && i === optIdx) btn.classList.add('correct');
    else if (i === correct)                 btn.classList.add('correct');
    else if (i === optIdx)                  btn.classList.add('wrong');
  });

  // Explanation
  const expEl = document.getElementById('quizExplanation');
  const correctLetter = ['A','B','C','D'][correct];
  if (isOk) {
    expEl.className = 'quiz-explanation';
    expEl.innerHTML = `<span class="quiz-exp-verdict quiz-exp-correct">✓ Risposta corretta</span>${q.exp ? q.exp : ''}`;
  } else if (optIdx === -1) {
    expEl.className = 'quiz-explanation wrong-exp';
    expEl.innerHTML = `<span class="quiz-exp-verdict quiz-exp-timeout">⏱ Tempo scaduto</span>La risposta corretta era <strong>${correctLetter} — ${q.opts[correct]}</strong>${q.exp ? '<br><br>' + q.exp : ''}`;
  } else {
    expEl.className = 'quiz-explanation wrong-exp';
    expEl.innerHTML = `<span class="quiz-exp-verdict quiz-exp-wrong">✗ Risposta errata</span>La risposta corretta era <strong>${correctLetter} — ${q.opts[correct]}</strong>${q.exp ? '<br><br>' + q.exp : ''}`;
  }
  expEl.style.display = '';

  // Drain timer bar
  const bar = document.getElementById('quizTimerBar');
  bar.style.transition = 'width 0.4s ease';
  bar.style.width = '0%';
  setTimeout(() => { bar.style.transition = ''; }, 450);

  // Update dot
  const dotSpans = document.getElementById('quizDots').querySelectorAll('.quiz-dot-item');
  if (dotSpans[_quiz.current]) {
    dotSpans[_quiz.current].classList.remove('current');
    dotSpans[_quiz.current].classList.add(isOk ? 'correct' : 'wrong');
  }

  document.getElementById('quizNextBtn').style.display = '';
}

function nextQuizQuestion() {
  if (!_quiz) return;
  const next = _quiz.current + 1;
  if (next >= _quiz.questions.length) {
    _showQuizResults();
    return;
  }
  _quiz.current = next;
  const qView = document.getElementById('quizQuestionView');
  qView.style.opacity = '0';
  setTimeout(() => {
    _showQuizQuestion(next);
    qView.style.transition = 'opacity 0.2s';
    qView.style.opacity = '1';
    setTimeout(() => { qView.style.transition = ''; }, 220);
  }, 130);
}

function _showQuizResults() {
  if (!_quiz) return;
  document.getElementById('quizQuestionView').style.display = 'none';
  const rView = document.getElementById('quizResultsView');
  rView.style.display = '';
  rView.style.opacity = '0';
  requestAnimationFrame(() => {
    rView.style.transition = 'opacity 0.3s';
    rView.style.opacity = '1';
    setTimeout(() => { rView.style.transition = ''; }, 320);
  });

  const total   = _quiz.questions.length;
  const correct = _quiz.correctCount;
  const score   = _quiz.score;
  const pct     = correct / total;

  document.getElementById('quizResultScore').textContent   = score;
  document.getElementById('quizResultCorrect').textContent = correct + ' / ' + total + ' corrette';

  let stars;
  if      (pct >= 0.84) stars = '★★★';
  else if (pct >= 0.5)  stars = '★★☆';
  else                  stars = '★☆☆';
  document.getElementById('quizResultStars').textContent = stars;

  // Best score
  const dayId  = _quiz.dayId;
  const stored = state[dayId]?.quizBestScore;
  let bestText = stored ? stored.score + ' pt — ' + stored.date : '—';
  if (!stored || score > stored.score) {
    if (!state[dayId]) state[dayId] = {};
    state[dayId].quizBestScore = { score, date: new Date().toLocaleDateString('it-IT') };
    saveState();
    bestText = score + ' pt — oggi 🏆';
  }
  document.getElementById('quizBestScore').textContent = bestText;

  // Distribuzione cognitiva (Bloom)
  const bloomDist = { ricordo: [], comprensione: [], applicazione: [] };
  _quiz.questions.forEach((q, i) => {
    const lvl = q.bloom;
    if (bloomDist[lvl]) bloomDist[lvl].push(_quiz.results[i]);
  });
  const distEl = document.getElementById('quizBloomDist');
  if (distEl) {
    const bloomMeta = [
      { key: 'ricordo',       label: '🔵 Ricordo',        cls: 'bloom-ricordo-fill' },
      { key: 'comprensione',  label: '🟡 Comprensione',   cls: 'bloom-comprensione-fill' },
      { key: 'applicazione',  label: '🔴 Applicazione',   cls: 'bloom-applicazione-fill' }
    ];
    distEl.innerHTML = `
      <div class="quiz-bloom-dist-label">Distribuzione cognitiva</div>
      ${bloomMeta.map(({ key, label, cls }) => {
        const arr  = bloomDist[key];
        const tot  = arr.length;
        const ok   = arr.filter(Boolean).length;
        const pct  = tot > 0 ? Math.round(ok / tot * 100) : 0;
        return tot === 0 ? '' : `
        <div class="quiz-bloom-row">
          <span class="quiz-bloom-row-label">${label}</span>
          <span class="quiz-bloom-row-bar"><span class="quiz-bloom-row-fill ${cls}" style="width:${pct}%"></span></span>
          <span class="quiz-bloom-row-count">${ok}/${tot}</span>
        </div>`;
      }).join('')}`;
    distEl.style.display = '';
  }

  // Aggiorna l'indicatore di preparazione nella sidebar
  renderDayReadiness(dayId);
  _renderSessionRing(dayId, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function retryQuiz() {
  if (!_quiz) return;
  const { dayId, topic } = _quiz;
  closeQuiz();
  setTimeout(() => startQuiz(dayId, topic), 80);
}

function closeQuiz() {
  if (_quiz?.timerRaf) cancelAnimationFrame(_quiz.timerRaf);
  _quiz = null;
  document.getElementById('quizModal').classList.remove('open');
}

function abandonQuiz() {
  if (!_quiz) { closeQuiz(); return; }
  const answered = _quiz.current;
  const total    = _quiz.questions.length;
  const msg = answered === 0
    ? 'Vuoi davvero abbandonare il quiz? Non verrà registrato nessun punteggio.'
    : `Hai risposto a ${answered} domanda${answered>1?'e':''} su ${total}. Abbandonando ora il punteggio parziale non verrà salvato. Continuare?`;
  if (confirm(msg)) closeQuiz();
}

// ── Theme ──────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = document.getElementById('themeSwitchLabel');
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
  _safeLSSet('psico_theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Mobile sidebar state — must be declared BEFORE any showDay() call
let _mobileSidebarOpen = false;

// Applica il tema salvato (o dark di default)
applyTheme(localStorage.getItem('psico_theme') || 'dark');

// Recover any elapsed time from a session that ended without timerStop
_restoreTimerCheckpoint();

buildNav();
buildDays();
updateProgress();
updateTotalHours();
updateApiIndicator();
updateHeaderTitle();
renderReadinessPanel();
// Recompute auto-status for all study days based on actual work done
(function() {
  getActiveDays().forEach(d => {
    if (d.type !== 'rest' && d.type !== 'exam') _autoSetStatus(d.id);
  });
  _refreshNavLocks();
})();
// Show plan calendar overview as default home view
buildPlanOverview();
showPlanOverview();
// Initialize Lucide icons (after all DOM is set up)
if (typeof lucide !== 'undefined') lucide.createIcons();

// ── Sources (PDF fonti) ────────────────────────────────────
const SOURCES_KEY  = 'psico_sources';
const SOURCE_MAX_CHARS = 30000; // ~7500 tokens per fonte

function getSources() {
  try { return JSON.parse(localStorage.getItem(SOURCES_KEY) || '[]'); }
  catch(e) { return []; }
}
function saveSources(arr) {
  _safeLSSet(SOURCES_KEY, JSON.stringify(arr));
  _debouncedSync();
}

function addSource(title, content, sizeBytes) {
  const sources = getSources();
  sources.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    title,
    content: content.slice(0, SOURCE_MAX_CHARS),
    sizeBytes,
    addedAt: Date.now()
  });
  saveSources(sources);
  invalidateMemoryCards(); // cards must be re-extracted with new source
  renderSourcesList();
  updateSourcesBtn();
}

function removeSource(id) {
  saveSources(getSources().filter(s => s.id !== id));
  invalidateMemoryCards(); // cards must be re-extracted without removed source
  // invalidate ai questions for all days (source context changed)
  getActiveDays().forEach(d => {
    if (state[d.id]?.aiQuestions) {
      delete state[d.id].aiQuestions;
    }
  });
  saveState();
  renderSourcesList();
  updateSourcesBtn();
  buildDays({ force: true }); // plan structure may have changed
  buildNav();
}


function updateSourcesBtn() {
  const n = getSources().length;
  const btn = document.getElementById('sourcesBtn');
  const cnt = document.getElementById('sourcesCount');
  if (!btn) return;
  if (n > 0) {
    btn.classList.add('has-sources');
    cnt.textContent = n;
    cnt.style.display = '';
  } else {
    btn.classList.remove('has-sources');
    cnt.style.display = 'none';
  }
  updateGenPlanBtn();
  updateGenPlanStatus();
}

// ── Device sync: export / import ──────────────────────────────
const _SYNC_KEYS = [
  'psico_state', 'psico_sources', 'psico_exam_info',
  'psico_ai_plan', 'anthropic_api_key', 'psico_objective', 'psico_theme'
];

function exportAllData() {
  const data = {};
  _SYNC_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  });
  data._exportedAt  = new Date().toISOString();
  data._exportedFrom = 'mnesti';
  const json = JSON.stringify(data, null, 2);

  // Try file download (desktop); fall back to copy on mobile
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'mnesti-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) {
    // Clipboard fallback for mobile environments
    navigator.clipboard?.writeText(json).then(() => {
      _showStorageWarning('✓ Backup copiato negli appunti. Incollalo sull\'altro dispositivo.');
    }).catch(() => {
      // Last resort: show in textarea
      openImportModal(json);
    });
  }
}

function openImportModal(prefill) {
  const ta = document.getElementById('importJsonTextarea');
  if (ta && prefill) ta.value = prefill;
  document.getElementById('importModalOverlay')?.classList.add('open');
}

function closeImportModal() {
  document.getElementById('importModalOverlay')?.classList.remove('open');
  const ta = document.getElementById('importJsonTextarea');
  if (ta) ta.value = '';
}

function importAllData() {
  const ta = document.getElementById('importJsonTextarea');
  if (!ta || !ta.value.trim()) return;
  try {
    const data = JSON.parse(ta.value.trim());
    // Basic validation
    if (!data || typeof data !== 'object') throw new Error('Formato non valido');
    let imported = 0;
    _SYNC_KEYS.forEach(k => {
      if (data[k] !== undefined) {
        _safeLSSet(k, data[k]);
        imported++;
      }
    });
    if (imported === 0) throw new Error('Nessuna chiave riconosciuta nel backup');
    closeImportModal();
    setTimeout(() => location.reload(), 200);
  } catch(e) {
    const ta = document.getElementById('importJsonTextarea');
    if (ta) {
      ta.style.borderColor = 'var(--skip-text)';
      setTimeout(() => { ta.style.borderColor = ''; }, 2000);
    }
    _showStorageWarning('❌ ' + (e.message || 'File non valido'));
  }
}

function _renderStorageUsage() {
  const bar = document.getElementById('storageUsageBar');
  if (!bar) return;
  const usedKB = _storageUsageKB();
  const maxKB  = 5120; // 5 MB typical localStorage limit
  const pct    = Math.min(100, Math.round(usedKB / maxKB * 100));
  const color  = pct > 80 ? '#c0392b' : pct > 60 ? '#e67e22' : 'var(--accent)';
  bar.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-bottom:4px">
      <span>Spazio archiviazione locale</span>
      <span style="color:${color}">${usedKB} KB / ~5 MB (${pct}%)</span>
    </div>
    <div style="background:var(--border);border-radius:4px;height:4px;overflow:hidden">
      <div style="background:${color};width:${pct}%;height:100%;border-radius:4px;transition:width 0.3s"></div>
    </div>
    ${pct > 80 ? `<div style="color:#c0392b;font-size:10px;margin-top:4px">⚠️ Spazio quasi esaurito. Rimuovi alcune fonti per liberare spazio.</div>` : ''}`;
}

function _renderSrcDiagSummary() {
  const el = document.getElementById('srcDiagSummary');
  if (!el) return;
  const all = getSources();
  const withContent = all.filter(s => (s.content || '').trim().length > 100);
  const totalChars = withContent.reduce((a, s) => a + (s.content || '').length, 0);

  if (!all.length) {
    el.innerHTML = `<i data-lucide="alert-circle" style="width:13px;height:13px;stroke-width:2;flex-shrink:0;color:var(--text-3)"></i><span style="color:var(--text-3)">Nessuna fonte caricata — le domande saranno generiche</span>`;
  } else if (!withContent.length) {
    el.innerHTML = `<i data-lucide="alert-triangle" style="width:13px;height:13px;stroke-width:2;flex-shrink:0;color:#e67e22"></i><span style="color:#e67e22;font-weight:600">${all.length} font${all.length>1?'i':'e'} caricata${all.length>1?'e':''} ma nessun testo estratto — ricarica i PDF</span>`;
  } else {
    const kb = Math.round(totalChars / 1000);
    el.innerHTML = `<i data-lucide="check-circle" style="width:13px;height:13px;stroke-width:2;flex-shrink:0;color:var(--accent)"></i>
      <span style="color:var(--accent);font-weight:600">${withContent.length}/${all.length} font${all.length>1?'i':'e'} attive · ${kb}k caratteri</span>
      <span style="color:var(--text-3);font-size:11px;margin-left:auto">domande e feedback usano queste fonti</span>`;
  }
  if (window.lucide) lucide.createIcons({ nodes: [el] });
}

function renderSourcesList() {
  const el = document.getElementById('sourcesList');
  if (!el) return;
  _renderSrcDiagSummary();
  _renderStorageUsage();
  const sources = getSources();
  if (!sources.length) {
    el.innerHTML = `<div class="sources-empty">Nessuna fonte caricata.<br>Carica le tue dispense PDF per generare<br>domande basate sul tuo programma.</div>`;
    return;
  }

  const totalUsableChars = sources.reduce((acc, s) => acc + (s.content || '').length, 0);
  const usableSrcs = sources.filter(s => (s.content || '').trim().length > 100);
  const allOk = usableSrcs.length === sources.length;

  // Diagnostic summary bar
  const diagColor = allOk ? 'var(--accent)' : '#e67e22';
  const diagIcon  = allOk ? 'check-circle' : 'alert-triangle';
  const diagMsg   = allOk
    ? `${usableSrcs.length} font${usableSrcs.length===1?'e':'i'} disponibili · ${Math.round(totalUsableChars/1000)}k caratteri · domande e verifiche basate su queste fonti`
    : `${usableSrcs.length}/${sources.length} font${sources.length===1?'e':'i'} con contenuto estraibile — le altre vengono ignorate`;

  const diagHtml = `<div class="src-diag-bar" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:10px;border-radius:8px;border:1px solid ${diagColor}20;background:${diagColor}0d;font-size:11.5px;font-family:'Inter',sans-serif;color:var(--text-1);">
    <i data-lucide="${diagIcon}" style="width:13px;height:13px;stroke-width:2;flex-shrink:0;color:${diagColor}"></i>
    <span style="color:${diagColor};font-weight:600">${diagMsg}</span>
  </div>`;

  el.innerHTML = diagHtml + sources.map(s => {
    const isText      = s.type === 'text';
    const isTextbook  = s.type === 'textbook-ref';
    const charLen     = (s.content || '').length;
    const hasContent  = charLen > 100;

    const icon = isTextbook
      ? `<i data-lucide="book-marked" style="width:16px;height:16px;stroke-width:2"></i>`
      : isText
        ? `<i data-lucide="clipboard-list" style="width:16px;height:16px;stroke-width:2"></i>`
        : `<i data-lucide="file-text" style="width:16px;height:16px;stroke-width:2"></i>`;

    // Detect sparse image-based PDF: < 20 chars/KB, file > 50 KB, and content still low.
    // If content >= 10000 chars the Vision/OCR extraction succeeded — no warning needed.
    const charsPerKb = (s.sizeBytes && s.sizeBytes > 50000) ? charLen / (s.sizeBytes / 1024) : 999;
    const isSparse   = !isTextbook && !isText && hasContent && charsPerKb < 20 && charLen < 10000;

    // Status indicator
    let statusDot, statusText, sparseWarning = '';
    if (!hasContent) {
      statusDot = `<span style="width:7px;height:7px;border-radius:50%;background:#e74c3c;flex-shrink:0;display:inline-block"></span>`;
      statusText = `<span style="color:#e74c3c;font-weight:600">Testo non estratto — ricarica il file</span>`;
    } else if (isSparse) {
      statusDot = `<span style="width:7px;height:7px;border-radius:50%;background:#e67e22;flex-shrink:0;display:inline-block"></span>`;
      statusText = `<span style="color:#e67e22;font-weight:600">${charLen.toLocaleString('it-IT')} caratteri estratti — slide image-based</span>`;
      sparseWarning = `<div style="margin-top:6px;padding:7px 9px;border-radius:6px;background:#e67e2215;border:1px solid #e67e2240;font-size:10.5px;font-family:'Inter',sans-serif;color:#e67e22;line-height:1.5;">
        ⚠️ <strong>Estratto solo il ${Math.round(charsPerKb)} char/KB — le slide sono image-based.</strong><br>
        Rimuovi questa fonte e ricarica il PDF: ora l'app usa l'OCR automatico per estrarre il testo dalle immagini delle slide (prime 50 pagine).
      </div>`;
    } else if (charLen < 500) {
      statusDot = `<span style="width:7px;height:7px;border-radius:50%;background:#e67e22;flex-shrink:0;display:inline-block"></span>`;
      statusText = `<span style="color:#e67e22">${charLen.toLocaleString('it-IT')} caratteri (contenuto limitato)</span>`;
    } else {
      statusDot = `<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);flex-shrink:0;display:inline-block"></span>`;
      const wasVision = !isTextbook && !isText && s.sizeBytes > 50000 && charsPerKb < 20;
      const label = isTextbook ? 'caratteri · fonte secondaria AI'
                  : isText     ? 'caratteri · fonte primaria'
                  : wasVision  ? 'caratteri estratti con AI Vision · fonte primaria'
                  :              'caratteri estratti · fonte primaria';
      statusText = `<span style="color:var(--accent);font-weight:500">${charLen.toLocaleString('it-IT')} ${label}</span>`;
    }

    const badge = isTextbook
      ? `<span style="font-size:9px;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.07em;color:#8e44ad;border:1px solid #8e44ad;border-radius:10px;padding:1px 6px;margin-left:6px;">libro AI</span>`
      : isText
        ? `<span style="font-size:9px;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.07em;color:var(--accent);border:1px solid var(--accent);border-radius:10px;padding:1px 6px;margin-left:6px;">timone</span>`
        : '';

    const preview = hasContent
      ? `<div class="src-diag-preview" onclick="this.classList.toggle('expanded')" title="Clicca per espandere">${escHtml((s.content||'').slice(0, 200))}…</div>`
      : '';

    const sizeInfo = !isText && !isTextbook && s.sizeBytes
      ? `${(s.sizeBytes/1024).toFixed(0)} KB · ` : '';

    return `<div class="source-item${isText ? ' text-type' : ''}${isTextbook ? ' textbook-type' : ''}${!hasContent ? ' src-error' : ''}${isSparse ? ' src-sparse' : ''}">
      <div class="source-item-icon">${icon}</div>
      <div class="source-item-info" style="min-width:0">
        <div class="source-item-title" title="${escHtml(s.title||'')}">${escHtml(s.title||'Senza titolo')}${badge}</div>
        <div class="source-item-meta" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          ${statusDot}${statusText}
          ${sizeInfo ? `<span style="color:var(--text-3)">· ${sizeInfo.replace(' · ','')}</span>` : ''}
        </div>
        ${sparseWarning}
        ${preview}
      </div>
      <button class="source-item-del" onclick="removeSource('${s.id}')" title="Rimuovi"><i data-lucide="trash-2" style="width:12px;height:12px;stroke-width:2"></i></button>
    </div>`;
  }).join('');
  lucide.createIcons();
}

function openSourcesPanel() { openSetupDrawer('fonti'); }
function closeSourcesPanel() { closeSetupDrawer(); }

// ── Setup Drawer ──────────────────────────────────────────────
function openSetupDrawer(tab) {
  tab = tab || 'fonti';
  const overlay = document.getElementById('setupOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  switchSetupTab(tab); // handles scroll-reset + data loading for all tabs
}

function closeSetupDrawer() {
  const overlay = document.getElementById('setupOverlay');
  if (overlay) overlay.classList.remove('open');
}

function switchSetupTab(tab) {
  ['fonti', 'tema', 'account'].forEach(t => {
    const key  = t.charAt(0).toUpperCase() + t.slice(1);
    const btn  = document.getElementById('setupTab'  + key);
    const pane = document.getElementById('setupPane' + key);
    if (btn)  btn.classList.toggle('active',  t === tab);
    if (pane) pane.classList.toggle('active', t === tab);
  });
  const body = document.querySelector('.setup-body');
  if (body) body.scrollTop = 0;
  if (tab === 'fonti')   { renderSourcesList(); loadExamInfoUI(); }
  if (tab === 'tema')    { _renderColorPresets(); }
  if (tab === 'account') { _loadAccountPane(); }
}

// ── Account pane ─────────────────────────────────────────────
async function _loadAccountPane() {
  const usageLoad = document.getElementById('acctUsageLoading');
  const usageCont = document.getElementById('acctUsageContent');
  const planLoad  = document.getElementById('acctPlanLoading');
  const planCont  = document.getElementById('acctPlanContent');

  // ── Email (always try, no _currentUserId gate) ─────────────
  try {
    const { data: { user } } = await _sb.auth.getUser();
    const emailEl = document.getElementById('acctEmail');
    if (emailEl && user) emailEl.textContent = user.email || '—';
  } catch { /* leave '—' */ }

  // ── Guard: Supabase must be ready ─────────────────────────
  if (!_sb) {
    if (usageLoad) usageLoad.textContent = 'Servizio non disponibile';
    if (planLoad)  planLoad.textContent  = 'Servizio non disponibile';
    return;
  }

  // ── Fetch usage + plan in parallel ────────────────────────
  const today      = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';
  let usageRows = [], planData = null;

  try {
    const [usageRes, planRes] = await Promise.all([
      _sb.from('api_usage')
         .select('date, call_count, input_tokens, output_tokens')
         .gte('date', monthStart),
      _sb.from('user_plans')
         .select('plan_type, valid_until')
         .maybeSingle(),
    ]);
    if (usageRes.error) console.error('[account] api_usage error:', usageRes.error);
    if (planRes.error)  console.error('[account] user_plans error:', planRes.error);
    usageRows = usageRes.data || [];
    planData  = planRes.data  || null;
  } catch (err) {
    console.error('[account] fetch error:', err);
    if (usageLoad) usageLoad.textContent = 'Errore di rete';
    if (planLoad)  planLoad.textContent  = 'Errore di rete';
    return;
  }

  const planType   = planData?.plan_type || 'free';
  const dailyLimit = planType !== 'free' ? 500 : 150;
  const fmt = n => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
                 : n >= 1000      ? (n / 1000).toFixed(1) + 'k'
                 : String(n);

  // ── API usage ──────────────────────────────────────────────
  try {
    const todayRow   = usageRows.find(r => r.date === today);
    const callsToday = todayRow?.call_count ?? 0;
    const callsMonth = usageRows.reduce((s, r) => s + (r.call_count    || 0), 0);
    const tokensIn   = usageRows.reduce((s, r) => s + (r.input_tokens  || 0), 0);
    const tokensOut  = usageRows.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const pct = Math.min(100, Math.round(callsToday / dailyLimit * 100));

    document.getElementById('acctCallsToday').textContent  = callsToday;
    document.getElementById('acctCallsLimit').textContent  = dailyLimit;
    document.getElementById('acctCallsMonth').textContent  = fmt(callsMonth);
    document.getElementById('acctTokensIn').textContent    = fmt(tokensIn);
    document.getElementById('acctTokensOut').textContent   = fmt(tokensOut);

    const fill = document.getElementById('acctUsageBarFill');
    fill.style.width = pct + '%';
    fill.className   = 'acct-usage-fill' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
    document.getElementById('acctUsagePct').textContent = pct + '%';

    // Fonti caricate
    const srcs = JSON.parse(localStorage.getItem('psico_sources') || '[]');
    document.getElementById('acctSources').textContent = srcs.length;

    // ── Storage breakdown ────────────────────────────────────
    const storageLimitMB = planType !== 'free' ? 20 : 5;
    const fmtSize = bytes => bytes < 1024 * 1024
      ? Math.round(bytes / 1024) + ' KB'
      : (bytes / (1024 * 1024)).toFixed(1) + ' MB';

    let totalBytes = 0;
    const breakdown = {};
    const fontiKeys  = new Set(['psico_sources']);
    const pianoKeys  = new Set(['psico_ai_plan', 'psico_state', 'psico_exam_info']);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      const bytes = (k.length + v.length) * 2;
      totalBytes += bytes;
      if      (fontiKeys.has(k))          breakdown['Fonti']        = (breakdown['Fonti']        || 0) + bytes;
      else if (pianoKeys.has(k))          breakdown['Piano/stato']  = (breakdown['Piano/stato']  || 0) + bytes;
      else if (k.startsWith('psico_mc_')) breakdown['Memory cards'] = (breakdown['Memory cards'] || 0) + bytes;
      else if (k.startsWith('psico_'))    breakdown['Altro']        = (breakdown['Altro']        || 0) + bytes;
    }

    const storagePct = Math.min(100, Math.round(totalBytes / (storageLimitMB * 1024 * 1024) * 100));
    const storageFill = document.getElementById('acctStorageBarFill');
    storageFill.style.width = storagePct + '%';
    storageFill.className   = 'acct-usage-fill' + (storagePct >= 90 ? ' danger' : storagePct >= 70 ? ' warn' : '');
    document.getElementById('acctStorageUsed').textContent  = fmtSize(totalBytes);
    document.getElementById('acctStorageLimit').textContent = storageLimitMB + ' MB';
    document.getElementById('acctStoragePct').textContent   = storagePct + '%';

    const bdEl = document.getElementById('acctStorageBreakdown');
    if (bdEl) {
      bdEl.innerHTML = Object.entries(breakdown)
        .filter(([, b]) => b > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([label, bytes]) =>
          `<span class="acct-storage-chip"><span class="acct-storage-chip-lbl">${label}</span><span class="acct-storage-chip-val">${fmtSize(bytes)}</span></span>`
        ).join('');
    }

    if (usageLoad) usageLoad.style.display = 'none';
    if (usageCont) usageCont.style.display = 'block';
  } catch {
    if (usageLoad) usageLoad.textContent = 'Dati non disponibili';
  }

  // ── Piano attivato ─────────────────────────────────────────
  try {
    const planMeta = {
      free:    { badge: 'FREE',  name: 'Piano gratuito',      desc: '150 chiamate/giorno · 1 esame · 5 MB',               color: 'var(--text-3)' },
      exam:    { badge: 'ESAME', name: 'Piano per esame (€29,99)',  desc: '500 chiamate/giorno · 2 esami · 50 MB · 90 giorni',  color: '#27ae60' },
      monthly: { badge: 'PRO',   name: 'Abbonamento mensile (€9,99/mese)', desc: '1000 chiamate/giorno · esami illimitati · 200 MB',   color: 'var(--accent)' },
    };
    const meta = planMeta[planType] || planMeta.free;

    document.getElementById('acctPlanBadge').textContent      = meta.badge;
    document.getElementById('acctPlanBadge').style.background = meta.color;
    document.getElementById('acctPlanName').textContent       = meta.name;
    document.getElementById('acctPlanDesc').textContent       = meta.desc;

    if (planData?.valid_until) {
      const exp = new Date(planData.valid_until).toLocaleDateString('it-IT');
      document.getElementById('acctPlanDesc').textContent += ` · scade il ${exp}`;
    }

    const upgradeEl = document.getElementById('acctPlanUpgrade');
    const manageEl  = document.getElementById('acctPlanManage');

    if (planType === 'free') {
      if (upgradeEl) upgradeEl.style.display = 'block';
      if (manageEl)  manageEl.style.display  = 'none';
    } else {
      if (upgradeEl) upgradeEl.style.display = 'none';
      if (manageEl)  manageEl.style.display  = 'block';
      const manageInfo = document.getElementById('acctPlanManageInfo');
      if (manageInfo) {
        const cancelAtEnd = planData?.cancel_at_period_end || false;
        const cancelAt    = planData?.cancel_at ? new Date(planData.cancel_at).toLocaleDateString('it-IT') : null;
        const validUntil  = planData?.valid_until ? new Date(planData.valid_until).toLocaleDateString('it-IT') : null;

        if (cancelAtEnd) {
          const endDate = cancelAt || validUntil || '—';
          manageInfo.innerHTML =
            `<span style="color:var(--accent);font-weight:600">⚠ Cancellazione programmata il ${endDate}</span><br>` +
            `<span style="font-size:11px;color:var(--text-2)">Accesso attivo fino a quella data, poi il piano diventa gratuito.</span>`;
        } else {
          const expTxt = validUntil
            ? `Attivo fino al <strong>${validUntil}</strong>`
            : 'Abbonamento attivo';
          manageInfo.innerHTML = expTxt;
        }
      }
      // Nascondi il pulsante di cancellazione per il piano esame (one-time)
      const cancelBtn = document.querySelector('.acct-cancel-btn');
      if (cancelBtn) cancelBtn.style.display = planType === 'monthly' ? '' : 'none';
    }

    if (planLoad) planLoad.style.display = 'none';
    if (planCont) planCont.style.display = 'block';
  } catch {
    if (planLoad) planLoad.textContent = 'Dati non disponibili';
  }
}

// ── Stripe Checkout ───────────────────────────────────────────
async function startCheckout(planType) {
  const btnId = planType === 'exam' ? 'acctOptionExam' : 'acctOptionMonthly';
  const btn   = document.querySelector(`#${btnId} .acct-pay-btn`);
  if (btn) { btn.classList.add('loading'); btn.textContent = 'Apertura checkout…'; }

  try {
    const token = window._getSBToken ? await window._getSBToken() : null;
    if (!token) throw new Error('Sessione scaduta — effettua di nuovo il login.');

    const res = await fetch(`${window._SB_URL}/functions/v1/create-checkout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_type: planType }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
    if (!data.url) throw new Error('URL checkout non ricevuto');

    // Redirect alla pagina Stripe
    window.location.href = data.url;

  } catch (err) {
    if (btn) { btn.classList.remove('loading'); lucide.createIcons({ nodes: [btn] }); }
    alert('Errore nell\'apertura del checkout:\n' + (err.message || err));
  }
}

async function cancelSubscription() {
  const btn = document.querySelector('.acct-cancel-btn');
  if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; btn.textContent = 'Apertura…'; }

  try {
    const token = window._getSBToken ? await window._getSBToken() : null;
    if (!token) throw new Error('Sessione scaduta');

    const res = await fetch(`${window._SB_URL}/functions/v1/create-portal-session`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ return_url: window.location.origin + '/app.html' }),
    });

    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Errore apertura portale');

    window.open(data.url, '_blank');
  } catch (err) {
    console.error('[cancelSubscription]', err);
    alert('Impossibile aprire il portale Stripe. Riprova o contatta support@mnesti.it.');
  } finally {
    if (btn) {
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
      btn.innerHTML = 'Accedi al tuo abbonamento su Stripe <span style="font-size:10px;opacity:.7">↗</span>';
    }
  }
}

// ── Paywall ────────────────────────────────────────────────────
// Cache del piano utente: aggiornata al login e dopo ogni checkout.
window._userPlanType      = null; // 'free' | 'exam' | 'monthly' | null (not loaded)
window._userPlanValidUntil = null;

async function _loadUserPlan() {
  if (!_sb) return;
  try {
    const { data, error } = await _sb.from('user_plans')
      .select('plan_type, valid_until, cancel_at_period_end, cancel_at')
      .maybeSingle();
    if (error) { console.warn('[paywall] user_plans fetch error:', error.message); return; }
    window._userPlanType            = data?.plan_type            || 'free';
    window._userPlanValidUntil      = data?.valid_until          || null;
    window._userPlanCancelAtEnd     = data?.cancel_at_period_end || false;
    window._userPlanCancelAt        = data?.cancel_at            || null;
  } catch(e) { console.warn('[paywall] _loadUserPlan failed:', e.message); }
}

function _isPaidUser() {
  if (window._userPlanType === null) return false; // not loaded yet → conservative
  if (window._userPlanType === 'free' || !window._userPlanType) return false;
  if (window._userPlanValidUntil && new Date(window._userPlanValidUntil) <= new Date()) return false;
  return true;
}

// Chiamato da _createNewExam: ritorna true se si può procedere, false se è stato mostrato il paywall.
async function _checkPaywallBeforeNewExam() {
  // Piano già caricato? Se no, prova a caricarlo (bloccante ma rapido).
  if (window._userPlanType === null) await _loadUserPlan();

  // Utente paid → nessun paywall
  if (_isPaidUser()) return true;

  // Utente free: verifica se ha già usato il primo esame gratuito.
  // "Ha usato il primo esame" = ha almeno un esame nell'archivio.
  const archive = _getExamArchive ? _getExamArchive() : [];
  const hasUsedFreeExam = archive.length > 0;

  if (!hasUsedFreeExam) return true; // primo esame — procedi gratis

  // Mostra il paywall
  _showPaywallModal();
  return false;
}

// Stato interno della modale
let _pwSelectedPlan = 'monthly';

function _showPaywallModal() {
  const overlay = document.getElementById('paywallOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [overlay] });
  _pwSelectPlan('monthly');
}

function _closePaywall() {
  const overlay = document.getElementById('paywallOverlay');
  if (overlay) overlay.style.display = 'none';
}

function _pwSelectPlan(plan) {
  _pwSelectedPlan = plan;

  const planExam    = document.getElementById('pwPlanExam');
  const planMonthly = document.getElementById('pwPlanMonthly');
  const ctaLabel    = document.getElementById('pwCtaLabel');

  if (planExam)    planExam.classList.toggle('selected',    plan === 'exam');
  if (planMonthly) planMonthly.classList.toggle('selected', plan === 'monthly');

  if (ctaLabel) {
    ctaLabel.textContent = plan === 'monthly'
      ? 'Abbonati — €9,99/mese'
      : 'Acquista esame singolo — €29,99';
  }
}

async function _pwStartCheckout() {
  const btn = document.getElementById('pwCtaBtn');
  if (btn) {
    btn.classList.add('loading');
    btn.disabled = true;
    const lbl = document.getElementById('pwCtaLabel');
    if (lbl) lbl.textContent = 'Apertura checkout…';
  }
  try {
    await startCheckout(_pwSelectedPlan);
  } catch(e) {
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    _pwSelectPlan(_pwSelectedPlan); // restore label
  }
}

// ── Gestione redirect post-checkout ──────────────────────────
(function _handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');
  const plan     = params.get('plan');
  if (!checkout) return;

  // Pulisci l'URL senza ricaricare la pagina
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);

  if (checkout === 'success') {
    // Piccolo ritardo per dare tempo al webhook di aggiornare il DB
    setTimeout(async () => {
      // Aggiorna cache piano utente (paywall si sblocca subito)
      await _loadUserPlan();
      const msg = plan === 'monthly'
        ? 'Abbonamento attivato! Esami illimitati e 1.000 chiamate AI/giorno sono ora disponibili.'
        : 'Acquisto completato! Hai 1 nuovo esame disponibile e 500 chiamate AI/giorno per 90 giorni.';
      // Mostra messaggio di conferma con CTA per creare il nuovo esame
      _showCheckoutSuccessToast(msg, plan);
      // Ricarica il tab account per mostrare il nuovo piano
      _loadAccountPane();
      // Avvia automaticamente l'onboarding per il nuovo esame dopo un breve delay
      setTimeout(() => _createNewExam(), 1800);
    }, 2000);
  } else if (checkout === 'cancelled') {
    console.log('[checkout] pagamento annullato dall\'utente');
  }
})();

function _showCheckoutSuccessToast(message, plan) {
  // Rimuovi toast precedenti
  document.querySelectorAll('.checkout-success-toast').forEach(el => el.remove());

  const toast = document.createElement('div');
  toast.className = 'checkout-success-toast';
  toast.innerHTML = `
    <div class="cst-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
    <div class="cst-body">
      <div class="cst-title">${plan === 'monthly' ? 'Abbonamento attivato' : 'Acquisto completato'}</div>
      <div class="cst-msg">${message}</div>
      <button class="cst-new-exam-btn" onclick="this.closest('.checkout-success-toast').remove(); _createNewExam()">
        Crea il tuo nuovo esame →
      </button>
    </div>
    <button class="cst-close" onclick="this.closest('.checkout-success-toast').remove()">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

async function _acctChangePassword() {
  const pw1   = document.getElementById('acctNewPw')?.value || '';
  const pw2   = document.getElementById('acctNewPwConfirm')?.value || '';
  const msgEl = document.getElementById('acctPwMsg');
  const btn   = document.getElementById('acctPwBtn');

  msgEl.className = 'acct-msg';
  if (pw1.length < 8) { msgEl.className = 'acct-msg err'; msgEl.textContent = 'La password deve avere almeno 8 caratteri.'; return; }
  if (pw1 !== pw2)    { msgEl.className = 'acct-msg err'; msgEl.textContent = 'Le due password non coincidono.'; return; }

  btn.disabled = true; btn.textContent = 'Aggiornamento…';
  const { error } = await _sb.auth.updateUser({ password: pw1 });
  btn.disabled = false; btn.textContent = 'Aggiorna password';

  if (error) {
    msgEl.className = 'acct-msg err';
    msgEl.textContent = error.message;
  } else {
    msgEl.className = 'acct-msg ok';
    msgEl.textContent = '✓ Password aggiornata con successo';
    document.getElementById('acctNewPw').value = '';
    document.getElementById('acctNewPwConfirm').value = '';
  }
}

// ── Accent color system ───────────────────────────────────────
// (moved to top of script — see below)

function _hexToRgb(hex) {
  const h = hex.replace('#','');
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}

function applyAccentColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const {r,g,b} = _hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent',        hex);
  root.style.setProperty('--accent-bg',     `rgba(${r},${g},${b},0.10)`);
  root.style.setProperty('--accent-border', `rgba(${r},${g},${b},0.25)`);
  _safeLSSet('psico_accent_color', hex);
  // Update picker UI if open
  const picker = document.getElementById('accentColorPicker');
  const hexInp = document.getElementById('accentHexInput');
  if (picker) picker.value = hex;
  if (hexInp) hexInp.value = hex.toUpperCase();
  _renderColorPresets();
}

function _loadAccentColor() {
  const saved = localStorage.getItem('psico_accent_color');
  if (saved) applyAccentColor(saved);
}

function _resetAccentColor() {
  applyAccentColor(_ACCENT_DEFAULT);
}

function _onAccentPickerChange(hex) { applyAccentColor(hex); }

function _onAccentHexChange(val) {
  val = val.trim();
  if (!val.startsWith('#')) val = '#' + val;
  if (/^#[0-9a-fA-F]{6}$/.test(val)) applyAccentColor(val);
}

function _renderColorPresets() {
  const wrap = document.getElementById('colorPresets');
  if (!wrap) return;
  const current = (localStorage.getItem('psico_accent_color') || _ACCENT_DEFAULT).toLowerCase();
  wrap.innerHTML = _ACCENT_PRESETS.map(c =>
    `<button class="color-preset${c.toLowerCase()===current?' active':''}"
      style="background:${c}" onclick="applyAccentColor('${c}')" title="${c}"></button>`
  ).join('');
}

// PDF.js extraction
function _initPdfJs() {
  if (typeof pdfjsLib === 'undefined') return false;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return true;
}

const OCR_MAX_PAGES = 50; // limit OCR to first N pages to keep it fast

async function _extractPdfText(arrayBuffer) {
  if (!_initPdfJs()) throw new Error('PDF.js non disponibile');
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
    if (text.length > SOURCE_MAX_CHARS * 2) break;
  }
  return { text: text.trim(), pdf };
}

async function _extractPdfTextOCR(pdf, onStatus) {
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js non disponibile');
  const maxPages = Math.min(OCR_MAX_PAGES, pdf.numPages);

  if (onStatus) onStatus('init', 0, maxPages, 'Caricamento motore OCR…');
  const worker = await Tesseract.createWorker('ita', 1, {
    logger: m => {
      if (!onStatus) return;
      if (m.status === 'loading tesseract core')    onStatus('init', 0, maxPages, 'Caricamento motore OCR…');
      if (m.status === 'loading language traineddata') onStatus('init', Math.round((m.progress||0)*30), maxPages, 'Download dizionario OCR…');
      if (m.status === 'initializing tesseract')    onStatus('init', 30, maxPages, 'Inizializzazione OCR…');
      if (m.status === 'recognizing text')          onStatus('init', 35, maxPages, 'Riconoscimento in corso…');
    }
  });

  let text = '';
  try {
    for (let i = 1; i <= maxPages; i++) {
      const pct = 35 + Math.round((i / maxPages) * 65);
      if (onStatus) onStatus('page', pct, maxPages, `Pagina ${i} di ${maxPages}…`);
      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.2 });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const { data: { text: pageText } } = await worker.recognize(canvas);
      text += pageText + '\n';
      if (text.length > SOURCE_MAX_CHARS * 2) break;
    }
  } finally {
    await worker.terminate();
  }
  return text.trim();
}

/**
 * Extract educational content from image-based slide PDFs using Claude Vision.
 * Processes pages in batches of 6, far more accurate than Tesseract for slides.
 */
async function _extractPdfVision(pdf, onStatus) {
  const BATCH_SIZE  = 6;
  const totalPages  = pdf.numPages;
  const sampleCount = Math.min(OCR_MAX_PAGES, totalPages);

  // Distributed sampling: spread pages evenly across the ENTIRE document
  // so all lessons/topics are represented, not just the first N pages.
  // e.g. a 200-page PDF → sample pages 1, 5, 9, 13, ... 197 (every 4th page)
  const sampledPages = [];
  if (totalPages <= sampleCount) {
    for (let i = 1; i <= totalPages; i++) sampledPages.push(i);
  } else {
    for (let i = 0; i < sampleCount; i++) {
      const p = 1 + Math.round(i * (totalPages - 1) / (sampleCount - 1));
      sampledPages.push(Math.min(p, totalPages));
    }
  }

  const totalBatches = Math.ceil(sampledPages.length / BATCH_SIZE);
  if (onStatus) onStatus(0, sampleCount, `Analisi AI slide (${sampleCount} di ${totalPages} pagine distribuite)…`);

  let allText = '';

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchPages = sampledPages.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
    const pct        = Math.round((batch / totalBatches) * 88);
    if (onStatus) onStatus(pct, sampleCount, `Pagine ${batchPages[0]}–${batchPages[batchPages.length - 1]} (batch ${batch + 1}/${totalBatches})…`);

    // Render pages to compressed JPEG base64
    const images = [];
    for (const pageNum of batchPages) {
      const page   = await pdf.getPage(pageNum);
      const baseVp = page.getViewport({ scale: 1.0 });
      const scale  = Math.min(1.0, 900 / baseVp.width);
      const vp     = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      images.push({ b64: canvas.toDataURL('image/jpeg', 0.72).split(',')[1], pageNum });
    }

    // Build Claude Vision message with all slide images in one call
    const msgContent = [];
    images.forEach(({ b64, pageNum }) => {
      msgContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b64 }
      });
      msgContent.push({ type: 'text', text: `--- Pagina ${pageNum} ---` });
    });
    msgContent.push({
      type: 'text',
      text: `Queste sono ${images.length} slide di un corso universitario di psicologia. Per OGNI slide estrai in italiano: tutti i testi visibili, definizioni, concetti chiave, nomi di autori, esperimenti citati, schemi o liste. Sii completo e fedele. Se una slide ha pochi testi ma un'immagine significativa (es. schema, grafico), descrivi brevemente il contenuto visivo. Formato: "Pag. N: [contenuto]" per ciascuna.`
    });

    try {
      const result = await _callClaude({
        model:      'claude-haiku-4-5',
        max_tokens: 2500,
        system:     'Sei un sistema di estrazione contenuto da slide universitarie. Estrai fedelmente tutto il testo e i concetti visibili nelle slide.',
        messages:   [{ role: 'user', content: msgContent }]
      });
      const txt = (result?.content?.[0]?.text || '').trim();
      if (txt) allText += '\n\n' + txt;
    } catch (e) {
      console.warn(`[PDF Vision] batch ${batch + 1} failed:`, e.message);
      // On failure, skip this batch and continue with next
    }

    if (allText.length >= SOURCE_MAX_CHARS) break;
  }

  if (onStatus) onStatus(92, maxPages, 'Elaborazione completata…');
  return allText.trim().slice(0, SOURCE_MAX_CHARS);
}

function _setExtractUI(title, msg, pct) {
  const el    = document.getElementById('sourcesExtracting');
  const tEl   = document.getElementById('sourcesExtractTitle');
  const mEl   = document.getElementById('sourcesExtractingMsg');
  const barEl = document.getElementById('sourcesExtractBar');
  if (el)    { el.classList.add('active'); }
  if (tEl)   tEl.textContent = title;
  if (mEl)   mEl.textContent = msg;
  if (barEl) barEl.style.width = pct + '%';
}

async function _processPdfFile(file) {
  const extractEl  = document.getElementById('sourcesExtracting');
  const uploadArea = document.getElementById('sourcesUploadArea');

  // Show overlay
  if (extractEl) extractEl.classList.add('active');
  if (uploadArea) { uploadArea.style.opacity = '0.3'; uploadArea.style.pointerEvents = 'none'; }
  _setExtractUI('Lettura PDF…', `${file.name} — caricamento in corso…`, 5);

  try {
    const buffer = await file.arrayBuffer();
    _setExtractUI('Analisi testo…', 'Estrazione layer testo…', 15);
    const { text: directText, pdf } = await _extractPdfText(buffer);

    let finalText = directText;
    // Trigger AI extraction if: no text at all, or the PDF is likely image-based slides
    // (avg < 150 chars/page → headers only, real content is in slide images)
    const charsPerPage = pdf.numPages > 0 ? directText.length / pdf.numPages : 0;
    const isSparse     = directText.length < 100 || charsPerPage < 150;
    if (isSparse) {
      const reason = directText.length < 100
        ? 'PDF senza testo selezionabile'
        : `slide image-based (${Math.round(charsPerPage)} char/pag)`;
      _setExtractUI('AI Vision', `${reason} — estrazione AI in corso…`, 20);
      try {
        // Claude Vision: understands slide layout and visual content (much better than Tesseract)
        finalText = await _extractPdfVision(pdf, (pct, total, msg) => {
          _setExtractUI(`AI Vision — ${Math.round(pct)}%`, msg, 20 + Math.round(pct * 0.75));
        });
        // If Vision returned very little, try Tesseract as backup
        if (finalText.length < 200 && typeof Tesseract !== 'undefined') {
          _setExtractUI('OCR backup…', 'AI Vision ha restituito poco testo — avvio OCR Tesseract…', 75);
          const ocrText = await _extractPdfTextOCR(pdf, (phase, pct, total, msg) => {
            _setExtractUI(`OCR — ${Math.round(pct)}%`, msg, pct);
          });
          if (ocrText.length > finalText.length) finalText = ocrText;
        }
      } catch (visionErr) {
        // Fallback to Tesseract if Vision completely fails
        console.warn('[PDF] Vision failed, trying Tesseract:', visionErr.message);
        _setExtractUI('OCR fallback…', 'Avvio OCR Tesseract…', 25);
        finalText = await _extractPdfTextOCR(pdf, (phase, pct, total, msg) => {
          const title = phase === 'init' ? 'Preparazione OCR…' : `OCR — ${Math.round(pct)}%`;
          _setExtractUI(title, msg, pct);
        });
      }
    } else {
      _setExtractUI('Quasi pronto…', 'Salvataggio fonte…', 95);
    }

    if (!finalText || finalText.length < 20) {
      throw new Error('Nessun testo estraibile dal PDF. Il file potrebbe essere criptato o non contenere testo.');
    }
    _setExtractUI('Completato ✓', 'Fonte aggiunta con successo!', 100);
    await new Promise(r => setTimeout(r, 600));
    addSource(file.name.replace(/\.pdf$/i, ''), finalText, file.size);
  } catch(e) {
    alert('Errore nell\'estrazione del PDF:\n' + e.message);
  } finally {
    if (extractEl) extractEl.classList.remove('active');
    if (uploadArea) { uploadArea.style.opacity = ''; uploadArea.style.pointerEvents = ''; }
  }
}

function handlePdfFileInput(input) {
  const file = input.files[0];
  if (file) _processPdfFile(file);
  input.value = '';
}
function handlePdfDrop(e) {
  e.preventDefault();
  document.getElementById('sourcesUploadArea').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') _processPdfFile(file);
}

// ── Free text source ────────────────────────────────────────
function toggleTextbookInput() {
  const body    = document.getElementById('textbookInputBody');
  const chevron = document.getElementById('textbookChevron');
  const isOpen  = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  chevron.classList.toggle('open', !isOpen);
}

async function generateTextbookReference() {
  const title   = (document.getElementById('textbookTitle')?.value || '').trim();
  const author  = (document.getElementById('textbookAuthor')?.value || '').trim();
  const edition = (document.getElementById('textbookEdition')?.value || '').trim();
  if (!title) { alert('Inserisci almeno il titolo del libro.'); return; }


  const btn    = document.getElementById('textbookGenBtn');
  const status = document.getElementById('textbookGenStatus');
  btn.disabled = true;
    btn.innerHTML = '<span class="quiz-spinner quiz-spinner--inline" style="width:13px;height:13px" aria-hidden="true"></span> Generazione in corso…';
  status.style.display = 'flex';
    status.innerHTML = '<span class="quiz-spinner quiz-spinner--inline" style="width:11px;height:11px" aria-hidden="true"></span> Claude sta elaborando il riferimento bibliografico…';

  const bookRef = [title, author && `di ${author}`, edition].filter(Boolean).join(' — ');
  const examInfo = JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
  const courseCtx = examInfo.subject ? `Il corso è "${examInfo.subject}"${examInfo.professor ? ` (Prof. ${examInfo.professor})` : ''}.` : '';

  try {
    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: `Sei un esperto di letteratura accademica universitaria italiana e internazionale. ${courseCtx}
Genera un riferimento strutturato e dettagliato del libro di testo indicato, basandoti sulla tua conoscenza del testo.
Il riferimento deve coprire:
1. Panoramica generale del libro (approccio, struttura, edizione)
2. Per ogni capitolo principale: titolo, argomenti trattati, concetti chiave, termini tecnici rilevanti
3. Teorie principali, autori citati, esperimenti e studi di riferimento
4. Glossario dei termini fondamentali con breve definizione

Se non conosci con certezza il contenuto esatto del libro, indica chiaramente cosa sai con certezza e cosa è inferito. Non inventare capitoli o contenuti specifici se non ne sei sicuro.
Scrivi in italiano. Sii preciso e accademico. Questo contenuto servirà come fonte secondaria per generare domande d'esame universitarie.`,
      messages: [{
        role: 'user',
        content: `Genera il riferimento strutturato per: "${bookRef}"\n\nSe hai conoscenza diretta di questo libro, fornisci i dettagli capitolo per capitolo. Se è una versione italiana di un testo straniero, includi anche la struttura dell'edizione originale.`
      }]
    });
    const content = data.content[0].text.trim();

    // Save as a secondary source (type: 'textbook-ref')
    const sources = getSources();
    // Remove any previous textbook-ref with same title to avoid duplicates
    const filtered = sources.filter(s => !(s.type === 'textbook-ref' && s.textbookTitle === title));
    filtered.push({
      id:             Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      title:          `📚 ${bookRef}`,
      textbookTitle:  title,
      textbookAuthor: author,
      content:        content.slice(0, SOURCE_MAX_CHARS),
      sizeBytes:      content.length,
      type:           'textbook-ref',
      addedAt:        Date.now()
    });
    saveSources(filtered);

    // Reset UI
    document.getElementById('textbookTitle').value   = '';
    document.getElementById('textbookAuthor').value  = '';
    document.getElementById('textbookEdition').value = '';
    document.getElementById('textbookInputBody').style.display = 'none';
    document.getElementById('textbookChevron').classList.remove('open');
    status.style.display = 'none';
    renderSourcesList();
    updateSourcesBtn();
    _renderSrcDiagSummary();

  } catch(err) {
    status.innerHTML = `<i data-lucide="alert-triangle" style="width:12px;height:12px;stroke-width:2;flex-shrink:0;color:#e74c3c"></i><span style="color:#e74c3c">Errore: ${err.message}</span>`;
    if (window.lucide) lucide.createIcons({ nodes: [status] });
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="sparkles" style="width:13px;height:13px;stroke-width:2;flex-shrink:0"></i> Genera riferimento con AI';
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }
}

function toggleTextInput() {
  const body    = document.getElementById('textInputBody');
  const chevron = document.getElementById('textChevron');
  const isOpen  = body.style.display !== 'none';
  body.style.display    = isOpen ? 'none' : '';
  chevron.classList.toggle('open', !isOpen);
}

function saveTextSource() {
  const titleEl   = document.getElementById('textSourceTitle');
  const contentEl = document.getElementById('textSourceContent');
  const title   = titleEl.value.trim() || 'Testo incollato';
  const content = contentEl.value.trim();
  if (!content) { alert('Incolla del testo prima di salvare.'); return; }

  const sources = getSources();
  sources.push({
    id:        Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    title,
    content:   content.slice(0, SOURCE_MAX_CHARS),
    sizeBytes: content.length,
    type:      'text',   // marks it as text (timone) — shown first in context
    addedAt:   Date.now()
  });
  saveSources(sources);
  titleEl.value   = '';
  contentEl.value = '';
  // close the panel
  document.getElementById('textInputBody').style.display = 'none';
  document.getElementById('textChevron').classList.remove('open');
  renderSourcesList();
  updateSourcesBtn();
}

// Text sources (programma/lista lezioni) go FIRST in context — they are the compass
/**
 * Costruisce il contesto fonti pesato per i prompt AI.
 * Fonti primarie (materiale caricato dallo studente) hanno priorità e budget maggiori.
 * Fonti secondarie (riepiloghi AI di libri di testo, type='textbook-ref') hanno peso orientativo.
 *
 * Questo criterio è il riferimento unico per TUTTI i contesti AI dell'app:
 * generazione domande, quiz, memory cards, brain dump, tutor, valutazione risposte.
 *
 * @param {object} [opts]
 * @param {number}  [opts.primaryMax=12000]  - max chars per fonte primaria
 * @param {number}  [opts.secondaryMax=2000] - max chars per fonte secondaria
 * @param {number}  [opts.totalMax=40000]    - max chars totali
 * @param {boolean} [opts.primaryOnly=false] - se true E esistono fonti primarie, esclude
 *                                             completamente le secondarie (usare per
 *                                             generazione domande/quiz per evitare che
 *                                             Claude attinga al libro di testo noto)
 * @returns {{ context: string, rule: string, hasPrimary: boolean, hasSecondary: boolean,
 *             primaryCount: number, secondaryCount: number }}
 */
function _buildWeightedSourceContext({ primaryMax = 12000, secondaryMax = 2000, totalMax = 40000, primaryOnly = false } = {}) {
  const all = getSources().filter(s => (s.content || '').trim().length > 100);
  const empty = { context: '', rule: '', hasPrimary: false, hasSecondary: false, primaryCount: 0, secondaryCount: 0 };
  if (!all.length) return empty;

  const primary   = all.filter(s => s.type !== 'textbook-ref');

  // Minimum usable content check: if primary sources exist but total content is < 3000 chars
  // the PDF was likely image-based and extracted poorly → include secondary as fallback
  // to avoid Claude generating purely from training knowledge.
  const totalPrimaryChars = primary.reduce((acc, s) => acc + (s.content || '').trim().length, 0);
  const primaryIsUsable   = primary.length > 0 && totalPrimaryChars >= 3000;

  // When primaryOnly=true AND primary sources have usable content, suppress secondary entirely.
  const secondary = (primaryOnly && primaryIsUsable)
    ? []
    : all.filter(s => s.type === 'textbook-ref');

  // Build a note if primary sources exist but are too sparse (user needs to re-upload)
  const sparseNote = (primary.length > 0 && !primaryIsUsable)
    ? '\n\n⚠️ NOTA: le fonti primarie caricate contengono pochissimo testo (probabilmente slide image-based non ancora ri-caricate con OCR). In mancanza di contenuto testuale sufficiente, integra con le fonti secondarie disponibili.'
    : '';

  const RULE = `GERARCHIA DELLE FONTI (regola assoluta — si applica a domande, quiz, valutazioni e risposte):
• FONTI PRIMARIE (dispense, slide, PDF, appunti caricati dallo studente): riferimento PRINCIPALE e DETERMINANTE. Genera domande, valuta risposte e produci contenuti basandoti ESCLUSIVAMENTE su queste. Se un concetto è nelle fonti primarie, usalo; se una risposta è coerente con esse, è corretta.
• FONTI SECONDARIE (riepiloghi AI di libri di testo): valore ORIENTATIVO. Usale solo per integrare concetti non presenti nelle fonti primarie. Non usarle per contraddire le fonti primarie né per penalizzare chi le segue.
• In assenza di fonti primarie (o se le fonti primarie hanno pochissimo contenuto testuale): usa le fonti secondarie come riferimento disponibile.${sparseNote}`;

  const parts = [];
  let totalChars = 0;

  for (const s of primary) {
    if (totalChars >= totalMax) break;
    const chunk = (s.content || '').slice(0, primaryMax);
    parts.push(`[FONTE PRIMARIA — ${s.title || 'senza titolo'}]\n${chunk}`);
    totalChars += chunk.length;
  }
  for (const s of secondary) {
    if (totalChars >= totalMax) break;
    const chunk = (s.content || '').slice(0, secondaryMax);
    parts.push(`[FONTE SECONDARIA — orientativa — ${s.title || 'senza titolo'}]\n${chunk}`);
    totalChars += chunk.length;
  }

  return {
    context:        parts.join('\n\n---\n\n'),
    rule:           RULE,
    hasPrimary:     primary.length > 0,
    hasSecondary:   secondary.length > 0,
    primaryCount:   primary.length,
    secondaryCount: secondary.length,
    primaryIsUsable,
    totalPrimaryChars,
  };
}

/** Retrocompatibilità — restituisce solo il testo delle fonti, pesato. */
function getAllSourcesContext() {
  return _buildWeightedSourceContext({ primaryMax: 12000, secondaryMax: 2000, totalMax: 30000 }).context;
}

// ── Generate open-ended questions from sources ─────────────
async function generateQuestionsFromSource(dayId) {
  // primaryOnly: se esistono dispense/PDF caricati, non includere i libri di testo citati.
  // Claude conosce già quei libri dal training — anche 2000 chars bastano a fargli
  // generare domande "da manuale". Le domande devono venire SOLO dal materiale caricato.
  const { context: sourceCtx, rule: sourceRule } = _buildWeightedSourceContext({ primaryMax: 12000, secondaryMax: 2000, totalMax: 20000, primaryOnly: true });
  if (!sourceCtx) {
    alert('Carica prima almeno una fonte PDF nel pannello Fonti.');
    return;
  }
  const day = getActiveDays().find(d => d.id === dayId);
  if (!day) return;
  const topic = day.title || dayId;

  // ── Raccoglie TUTTE le domande esistenti (piano + AI) ─────────
  // Necessario perché le domande del piano statico non devono essere
  // sovrapposte da quelle generate, e viceversa.
  const planQs = (day.questions || []);
  const aiQs   = (state[dayId]?.aiQuestions || []);
  const allExisting = [...planQs, ...aiQs];

  // ── Analisi copertura sezioni ─────────────────────────────────
  const daySections = (day.sections || []).filter(s => s.title);

  // Considera una sezione "già coperta" se almeno una domanda esistente
  // cita nel testo o nel sourceRef almeno 2 parole significative del titolo
  function _isSectionCovered(sec, questions) {
    const words = sec.title.toLowerCase()
      .split(/[\s\-–—,;:()/]+/)
      .filter(w => w.length > 3);
    if (!words.length) return false;
    return questions.some(q => {
      const hay = ((q.text || '') + ' ' + (q.sourceRef || '')).toLowerCase();
      const hits = words.filter(w => hay.includes(w));
      return hits.length >= Math.min(2, words.length);
    });
  }

  const coveredSections   = daySections.filter(s =>  _isSectionCovered(s, allExisting));
  const uncoveredSections = daySections.filter(s => !_isSectionCovered(s, allExisting));

  // Sezioni target = scoperte; se tutto è coperto genera domande extra su tutto
  const targetSections = uncoveredSections.length > 0 ? uncoveredSections : daySections;
  const nQuestions     = Math.max(3, targetSections.length);

  // Mappe per il prompt
  const targetCoverageMap = targetSections.length
    ? targetSections.map((s, i) => `  ${i + 1}. ${s.title}${s.ref ? ' (' + s.ref + ')' : ''}`).join('\n')
    : null;

  const coveredNote = coveredSections.length > 0
    ? `SEZIONI GIÀ COPERTE — NON generare domande che si sovrappongano a queste sezioni o ai loro concetti chiave:\n${coveredSections.map(s => `  • ${s.title}`).join('\n')}\n\n`
    : '';

  const btn = document.getElementById('genq-btn-' + dayId);
  if (btn) {
    btn.classList.add('loading');
    btn.innerHTML = '<span class="quiz-spinner quiz-spinner--inline" style="width:11px;height:11px" aria-hidden="true"></span> Generazione…';
    lucide.createIcons();
  }

  const systemPrompt = `Sei un professore universitario di Psicologia Cognitiva (corso UNINETTUNO, Prof. Laura Serra) che prepara uno studente a un esame universitario scritto.

${sourceRule}

Hai a disposizione il seguente materiale del corso:
--- INIZIO FONTI ---
${sourceCtx}
--- FINE FONTI ---

Genera esattamente ${nQuestions} domande a risposta aperta sull'argomento specificato, basandoti ESCLUSIVAMENTE sulle fonti fornite.

${coveredNote}${targetCoverageMap ? `SEZIONI DA COPRIRE (obbligatorio — genera domande SOLO per queste sezioni, una domanda per sezione):
${targetCoverageMap}

` : ''}VINCOLO FONTI (critico): ogni domanda deve essere direttamente ricavabile dal materiale fornito. Ogni concetto, autore, modello o esperimento citato deve essere esplicitamente presente nelle fonti. NON generare domande basate su conoscenza generale della disciplina. NON fare domande generiche, metodologiche o metadisciplinari.

DIVERSITÀ CONCETTUALE (critica — regola assoluta):
• Ogni domanda deve testare un concetto, fenomeno o modello DISTINTO rispetto a TUTTE le altre domande del set E rispetto alle domande già presenti (elencate nel messaggio utente)
• È VIETATO generare due domande che trattino lo stesso fenomeno anche se formulate diversamente
• Ogni domanda deve fare riferimento a una sezione/slide DIVERSA — il campo "sourceRef" non può ripetere la stessa sezione
• Se noti sovrapposizioni concettuali con le domande già presenti, riscrivi subito la nuova domanda su un argomento non ancora esplorato

DISTRIBUZIONE (Tassonomia di Bloom):
• domande tipo "definizione" (ricordo): definizioni precise, nomenclatura tecnica, autori chiave
• domande tipo "meccanismo" (comprensione): spiegare meccanismi, descrivere processi, distinguere concetti
• domande tipo "connessione" (applicazione/analisi): collegare concetti, confrontare teorie, applicare a casi

AUTO-VALIDAZIONE ANTI-DUPLICATI (obbligatoria prima di produrre il JSON):
✓ Nessuna nuova domanda si sovrappone concettualmente alle domande già presenti
✓ Nessuna coppia di nuove domande testa lo stesso concetto/fenomeno
✓ Ogni domanda cita una sezione/slide range diversa nel "sourceRef"
✓ Il set copre tutte le sezioni elencate in "SEZIONI DA COPRIRE"
Se trovi violazioni, riscrivi la domanda problematica prima di includerla nel JSON finale.

TRACCIABILITÀ FONTE (obbligatoria): il campo "sourceRef" deve contenere nome del file/fonte, titolo sezione o numero slide, e un breve estratto testuale tra virgolette (max 120 caratteri). Formato: "NomeFonte — Sezione/Slide N: «estratto»"

Rispondi ESCLUSIVAMENTE con un array JSON valido (nessun altro testo):
[{"text":"testo della domanda","type":"definizione|meccanismo|connessione","sourceRef":"NomeFonte — Sezione: «estratto dal testo»"}]`;

  try {
    // Passa solo le ultime 15 domande esistenti per contenere i token del prompt.
    // Con 30+ domande l'existingBlock supererebbe 5.000 token; le ultime 15 sono
    // sufficienti per evitare duplicati concettuali sugli argomenti più recenti.
    const MAX_EXISTING_IN_PROMPT = 15;
    const existingForPrompt = allExisting.slice(-MAX_EXISTING_IN_PROMPT);
    const existingBlock = allExisting.length
      ? `\n\nDOMANDE GIÀ PRESENTI — NON ripetere, NON riformulare, NON sovrapporre concettualmente.\nOgni nuova domanda deve esplorare un aspetto NON ancora coperto da queste${allExisting.length > MAX_EXISTING_IN_PROMPT ? ` (mostrate le ${MAX_EXISTING_IN_PROMPT} più recenti su ${allExisting.length} totali)` : ''}:\n${existingForPrompt.map((q, i) => `${i + 1}. [${q.type || 'domanda'}] ${q.text}`).join('\n')}`
      : '';

    const userMsg = `Argomento: ${topic}${existingBlock}

Genera esattamente ${nQuestions} domande per le SEZIONI DA COPRIRE elencate sopra.
Ogni domanda deve testare un concetto DISTINTO da tutti quelli già presenti e fare riferimento a una sezione/slide DIVERSA.
Esegui la validazione anti-duplicati prima di produrre il JSON.
OBBLIGATORIO: includi "sourceRef" per ogni domanda con sezione/slide e estratto testuale specifico.`;

    const data = await _callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 1,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }]
    });

    const questions = _extractJson(data.content[0].text.trim());
    if (!Array.isArray(questions) || !questions.length) throw new Error('Risposta non valida');

    if (!state[dayId]) state[dayId] = {};
    const prev = state[dayId].aiQuestions || [];

    // ── First-time AI generation: archive plan-question progress ──
    // Plan feedbacks/answers are indexed 0,1,2… same as AI questions.
    // If we kept them active, _autoSetStatus would count them as AI
    // verifications → the day would appear instantly "done".
    // We archive them so they're not lost but don't pollute status logic.
    if (!prev.length) {
      if (state[dayId].feedbacks && Object.keys(state[dayId].feedbacks).length) {
        state[dayId].planFeedbacks = state[dayId].feedbacks;
      }
      if (state[dayId].answers && Object.keys(state[dayId].answers).length) {
        state[dayId].planAnswers = state[dayId].answers;
      }
      delete state[dayId].feedbacks;
      delete state[dayId].answers;
      delete state[dayId].skipped;
      delete state[dayId].sessionStarted;
      delete state[dayId].status;
    }

    state[dayId].aiQuestions = [...prev, ...questions];
    saveState();
    // Push to Supabase immediately (don't wait for debounce) so the remote copy
    // is up to date before any visibility-change pull can overwrite local state.
    TimerRegistry.clear('sync');
    if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
    _patchDay(dayId); // targeted single-card refresh — avoids full DOM rebuild
    buildNav();
    showDay(dayId);
  } catch(e) {
    alert('Errore nella generazione:\n' + e.message);
  } finally {
    const b = document.getElementById('genq-btn-' + dayId);
    if (b) {
      const hasQ = (state[dayId]?.aiQuestions?.length || 0) > 0;
      b.classList.remove('loading');
      b.innerHTML = `<i data-lucide="sparkles" style="width:11px;height:11px;stroke-width:2;flex-shrink:0"></i> ${hasQ ? 'Aggiungi domande' : 'Genera domande'}`;
      lucide.createIcons();
    }
  }
}

// ── Exam info persistence ────────────────────────────────────
function getExamInfo() {
  return JSON.parse(localStorage.getItem('psico_exam_info') || '{}');
}

/** Local calendar date from YYYY-MM-DD (no UTC shift). */
function _examInfoParseYMD(s) {
  const p = (s || '').trim().split('-');
  if (p.length !== 3) return null;
  const y = parseInt(p[0], 10), m = parseInt(p[1], 10) - 1, d = parseInt(p[2], 10);
  if (!y || m < 0 || m > 11 || d < 1 || d > 31) return null;
  return new Date(y, m, d);
}

/** True when the exam day is strictly before today (local). */
function _examDateHasPassed(examDateStr) {
  const exam = _examInfoParseYMD(examDateStr);
  if (!exam) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  exam.setHours(0, 0, 0, 0);
  return exam < today;
}

window._examOutcomeShowGrade = function() {
  const wrap = document.getElementById('examOutcomeGradeWrap');
  const err = document.getElementById('examOutcomeErr');
  if (err) err.textContent = '';
  if (wrap) wrap.style.display = 'block';
  document.getElementById('examOutcomeGrade')?.focus();
};

window._saveExamOutcome = function(outcome) {
  const errEl = document.getElementById('examOutcomeErr');
  if (errEl) errEl.textContent = '';

  const info = getExamInfo();
  if (!info.date) return;

  let grade = null;
  if (outcome === 'passed') {
    const raw = (document.getElementById('examOutcomeGrade')?.value || '').trim();
    const g = parseInt(raw, 10);
    if (!Number.isFinite(g) || g < 18 || g > 30) {
      if (errEl) errEl.textContent = 'Inserisci un voto valido tra 18 e 30.';
      window._examOutcomeShowGrade();
      return;
    }
    grade = g;
  }

  const readiness = typeof calculateGlobalReadiness === 'function' ? calculateGlobalReadiness() : null;

  info.result = {
    outcome,
    grade,
    examDate: info.date,
    recordedAt: new Date().toISOString(),
    readiness
  };
  _safeLSSet('psico_exam_info', JSON.stringify(info));

  const overlay = document.getElementById('examOutcomeOverlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  const wrap = document.getElementById('examOutcomeGradeWrap');
  if (wrap) wrap.style.display = 'none';
  const inp = document.getElementById('examOutcomeGrade');
  if (inp) inp.value = '';

  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  // Propaga l'esito nell'archivio
  if (typeof _archiveCurrentExam === 'function') try { _archiveCurrentExam(); } catch {}
};

// ══════════════════════════════════════════════════════════════
// ── Archivio Esami ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

const _ARCHIVE_KEY = 'psico_exams_archive';

function _getExamArchive() {
  try { return JSON.parse(localStorage.getItem(_ARCHIVE_KEY) || '[]'); } catch { return []; }
}

function _saveExamArchive(archive) {
  _safeLSSet(_ARCHIVE_KEY, JSON.stringify(archive));
}

// Genera un ID stabile dall'esame corrente (data + materia)
function _currentExamId() {
  const info = getExamInfo();
  const slug = (info.date || 'nodate').replace(/-/g, '') +
               '_' + (info.subject || 'nosubj').replace(/\s+/g, '').toLowerCase().slice(0, 12);
  return 'exam_' + slug;
}

// Archivia il piano e lo stato correnti, aggiorna outcome se disponibile
function _archiveCurrentExam() {
  const planRaw = localStorage.getItem('psico_ai_plan');
  const info    = getExamInfo();
  if (!planRaw && !info.date) return null;

  const id      = _currentExamId();
  const archive = _getExamArchive();
  const existing = archive.find(e => e.id === id) || {};

  const entry = {
    ...existing,
    id,
    subject:   info.subject   || '',
    professor: info.professor || '',
    examDate:  info.date      || '',
    createdAt: existing.createdAt || (() => {
      try { return JSON.parse(planRaw || '{}').generatedAt || new Date().toISOString(); } catch { return new Date().toISOString(); }
    })(),
  };

  // Aggiorna outcome dall'info corrente
  if (info.result) {
    entry.outcome  = info.result.outcome || null;
    entry.grade    = info.result.grade   || null;
    entry.readiness = info.result.readiness || null;
  }

  // Salva piano e stato in localStorage
  if (planRaw) _safeLSSet('psico_ai_plan_' + id, planRaw);
  const stateRaw = localStorage.getItem('psico_state');
  if (stateRaw) _safeLSSet('psico_state_' + id, stateRaw);

  const idx = archive.findIndex(e => e.id === id);
  if (idx >= 0) archive[idx] = entry; else archive.unshift(entry);
  _saveExamArchive(archive);

  // Sync piano/stato su Supabase user_exam_plans (fire-and-forget)
  _syncExamPlanToSupabase(id, planRaw, stateRaw, JSON.stringify(info));

  return id;
}

// Salva il piano di un singolo esame su Supabase user_exam_plans
async function _syncExamPlanToSupabase(examId, planRaw, stateRaw, infoRaw) {
  if (!_sb || !examId) return;
  try {
    const session = (await _sb.auth.getSession()).data.session;
    if (!session) return;
    let planData = null, stateData = null, examInfo = null;
    try { planData  = JSON.parse(planRaw  || 'null'); } catch {}
    try { stateData = JSON.parse(stateRaw || 'null'); } catch {}
    try { examInfo  = JSON.parse(infoRaw  || 'null'); } catch {}
    await _sb.from('user_exam_plans').upsert({
      user_id:    session.user.id,
      exam_id:    examId,
      plan_data:  planData,
      state_data: stateData,
      exam_info:  examInfo,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,exam_id' });
  } catch(e) {
    console.warn('[Supabase] syncExamPlan error:', e);
  }
}

// Svuota il Proxy state in-memory e lo popola opzionalmente con newData
function _resetStateInMemory(newData) {
  Object.keys(state).forEach(k => { try { delete state[k]; } catch {} });
  if (newData && typeof newData === 'object') {
    Object.keys(newData).forEach(k => { try { state[k] = newData[k]; } catch {} });
  }
}

// Carica un esame archiviato come esame attivo
async function _switchToExam(examId) {
  // Utenti free non possono switchare a un esame archiviato (richiede multi-slot = piano a pagamento)
  if (!_isPaidUser()) {
    // Aggiorna il piano prima di giudicare (potrebbe essere stato appena acquistato)
    await _loadUserPlan();
    if (!_isPaidUser()) {
      _showPaywallModal();
      return;
    }
  }

  _archiveCurrentExam(); // salva quello corrente

  const archive = _getExamArchive();
  const entry   = archive.find(e => e.id === examId);
  if (!entry) { alert('Esame non trovato nell\'archivio.'); return; }

  let planRaw   = localStorage.getItem('psico_ai_plan_' + examId);
  let stateRaw  = localStorage.getItem('psico_state_' + examId);

  // Se il piano non è in localStorage, proviamo a scaricarlo da Supabase
  if (!planRaw && _sb) {
    try {
      const session = (await _sb.auth.getSession()).data.session;
      if (session) {
        const { data: row } = await _sb
          .from('user_exam_plans')
          .select('plan_data,state_data,exam_info')
          .eq('user_id', session.user.id)
          .eq('exam_id', examId)
          .single();
        if (row) {
          if (row.plan_data)  { planRaw  = JSON.stringify(row.plan_data);  _safeLSSet('psico_ai_plan_' + examId, planRaw);  }
          if (row.state_data) { stateRaw = JSON.stringify(row.state_data); _safeLSSet('psico_state_'   + examId, stateRaw); }
        }
      }
    } catch(e) { console.warn('[Supabase] fetchExamPlan error:', e); }
  }

  if (!planRaw) { alert('Piano non disponibile per questo esame.'); return; }

  // 1. Carica il nuovo piano
  _safeLSSet('psico_ai_plan', planRaw);

  // 2. Carica lo stato dell'esame nel Proxy in-memory e in localStorage
  const savedState = stateRaw ? (() => { try { return JSON.parse(stateRaw); } catch { return {}; } })() : {};
  _resetStateInMemory(savedState);
  if (stateRaw) _safeLSSet('psico_state', stateRaw);
  else try { localStorage.removeItem('psico_state'); } catch {}

  // 3. Carica le info esame
  const examInfo = { subject: entry.subject, professor: entry.professor, date: entry.examDate };
  if (entry.outcome) {
    examInfo.result = { outcome: entry.outcome, grade: entry.grade, examDate: entry.examDate };
  }
  _safeLSSet('psico_exam_info', JSON.stringify(examInfo));

  // 4. Ricostruisci tutto il DOM
  try { localStorage.removeItem('psico_last_day'); } catch {}
  buildDays({ force: true });
  buildNav();
  loadExamInfoUI();       // aggiorna form + abilita pulsante "Rigenera piano"
  updateHeaderTitle();    // aggiorna titolo e data esame nell'header
  updateProgress();       // aggiorna donut/barra progresso
  updateGenPlanStatus();  // aggiorna stato nella sezione fonti

  // 5. Mostra il giorno attivo corretto (primo incompleto, non solo il primo della lista)
  const startDay = _resolveStartDay();
  if (startDay) showDay(startDay.id);

  _closeExamsArchive();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Elimina definitivamente un esame dall'archivio
function _deleteExam(examId) {
  const archive = _getExamArchive();
  const entry   = archive.find(e => e.id === examId);
  if (!entry) return;

  if (!confirm(`Eliminare l'esame "${entry.subject || 'senza titolo'}"?\nIl piano e i progressi salvati verranno rimossi definitivamente.`)) return;

  const isCurrent = (examId === _currentExamId());

  const newArchive = archive.filter(e => e.id !== examId);
  _saveExamArchive(newArchive);
  try { localStorage.removeItem('psico_ai_plan_'  + examId); } catch {}
  try { localStorage.removeItem('psico_state_'    + examId); } catch {}

  // Rimuovi da Supabase user_exam_plans (fire-and-forget)
  if (_sb) {
    _sb.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        _sb.from('user_exam_plans')
          .delete()
          .eq('user_id', session.user.id)
          .eq('exam_id', examId)
          .then(() => {});
      }
    });
  }

  if (isCurrent) {
    // L'esame eliminato era quello attivo: resetta tutto e mostra onboarding
    _resetStateInMemory();
    try {
      localStorage.removeItem('psico_ai_plan');
      localStorage.removeItem('psico_exam_info');
      localStorage.removeItem('psico_state');
      localStorage.removeItem('psico_last_day');
    } catch {}
    window._lastLocalWrite = Date.now();
    if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
    _closeExamsArchive();
    buildDays({ force: true });
    buildNav();
    updateGenPlanStatus();
    _showOnboarding(1);
  } else {
    _renderExamsArchiveBody();
  }
}

// Apre il flusso per un nuovo esame
async function _createNewExam() {
  // Controllo paywall: dal secondo esame in poi serve un piano a pagamento
  const canProceed = await _checkPaywallBeforeNewExam();
  if (!canProceed) return;

  _archiveCurrentExam();

  // Chiudi il welcome modal (potrebbe essere aperto con dati del vecchio esame)
  const _wo = document.getElementById('welcomeOverlay');
  if (_wo) { _wo.classList.remove('open'); _wo.setAttribute('aria-hidden', 'true'); }
  // Forza il re-show del welcome al termine del nuovo piano
  try { sessionStorage.removeItem('ss_welcome_shown'); } catch {}

  // Reset stato in-memory prima di pulire localStorage
  _resetStateInMemory();

  // Reset dati esame corrente
  try {
    localStorage.removeItem('psico_ai_plan');
    localStorage.removeItem('psico_exam_info');
    localStorage.removeItem('psico_state');
    localStorage.removeItem('psico_last_day');
  } catch {}

  // Imposta _lastLocalWrite per attivare i 30s di protezione contro il pull Supabase,
  // e sincronizza subito lo stato vuoto in modo che il cloud non ripristini il vecchio piano.
  window._lastLocalWrite = Date.now();
  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();

  buildDays({ force: true });
  buildNav();
  updateGenPlanStatus();
  _closeExamsArchive();
  closeMobileSidebar();

  // Apri onboarding step 1
  _showOnboarding(1);
}

// Aggiorna l'esito di un esame archiviato
function _updateArchivedExamOutcome(examId, outcome, grade) {
  const archive = _getExamArchive();
  const entry   = archive.find(e => e.id === examId);
  if (!entry) return;
  entry.outcome = outcome;
  entry.grade   = (outcome === 'passed' && grade) ? Number(grade) : null;
  _saveExamArchive(archive);
  // Se è l'esame corrente, aggiorna anche psico_exam_info
  if (examId === _currentExamId()) {
    const info = getExamInfo();
    info.result = { outcome, grade: entry.grade, examDate: entry.examDate, recordedAt: new Date().toISOString() };
    _safeLSSet('psico_exam_info', JSON.stringify(info));
  }
  // Sincronizza l'archivio aggiornato su Supabase
  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  _renderExamsArchiveBody();
}

// ── Panel UI ──────────────────────────────────────────────────

function _openExamsArchive() {
  _archiveCurrentExam(); // aggiorna archivio con dati recenti
  _renderExamsArchiveBody();
  const el = document.getElementById('examsArchiveOverlay');
  if (el) { el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  closeMobileSidebar();
}

function _closeExamsArchive() {
  const el = document.getElementById('examsArchiveOverlay');
  if (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }
}

function _renderExamsArchiveBody() {
  const body    = document.getElementById('examsArchiveBody');
  if (!body) return;
  const archive = _getExamArchive();
  const curId   = _currentExamId();

  if (!archive.length) {
    body.innerHTML = `
      <div class="exams-archive-empty">
        <i data-lucide="folder-open" style="width:36px;height:36px;stroke-width:1.5;color:var(--text-3)"></i>
        <p>Nessun esame archiviato.<br>Crea il tuo primo piano di studio.</p>
        <button class="exams-archive-new-btn" onclick="_createNewExam()">
          <i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5"></i>
          Crea nuovo esame
        </button>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // Banner per utenti free con esami bloccati
  const lockedCount = !_isPaidUser() ? archive.filter(e => e.id !== curId).length : 0;
  if (lockedCount > 0) {
    const banner = document.createElement('div');
    banner.className = 'ea-locked-banner';
    banner.innerHTML = `
      <i data-lucide="lock" style="width:14px;height:14px;stroke-width:2;flex-shrink:0"></i>
      <span>${lockedCount} esame${lockedCount > 1 ? 'i' : ''} bloccato${lockedCount > 1 ? 'i' : ''} — attiva un piano Pro per accedere a tutti i tuoi esami.</span>
      <button class="ea-locked-banner-cta" onclick="_showPaywallModal()">Sblocca</button>`;
    body.appendChild(banner);
    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [banner] });
  }

  const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  const _fmtDate = iso => {
    if (!iso) return '—';
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };
  const _outcomeChip = entry => {
    if (entry.id === curId && !entry.outcome) {
      return `<span class="ea-chip ea-chip-active">In corso</span>`;
    }
    if (!entry.outcome) {
      const past = entry.examDate && new Date(entry.examDate + 'T12:00:00') < new Date();
      return past
        ? `<span class="ea-chip ea-chip-pending">Esito mancante</span>`
        : `<span class="ea-chip ea-chip-future">Futuro</span>`;
    }
    if (entry.outcome === 'passed') {
      return `<span class="ea-chip ea-chip-passed">Superato${entry.grade ? ' · ' + entry.grade + '/30' : ''}</span>`;
    }
    return `<span class="ea-chip ea-chip-failed">Non superato</span>`;
  };

  const _outcomeFormId = id => 'eaof_' + id.replace(/[^a-z0-9]/gi, '');

  const cards = archive.map(entry => {
    const isCurrent = entry.id === curId;
    const past = entry.examDate && new Date(entry.examDate + 'T12:00:00') < new Date();
    const canUpdateOutcome = !entry.outcome || true; // sempre aggiornabile
    const isLocked = !isCurrent && !_isPaidUser();
    const switchBtn = isCurrent
      ? `<span class="ea-current-badge">Esame attivo</span>`
      : isLocked
        ? `<button class="ea-action-btn ea-action-locked" onclick="_showPaywallModal()" title="Richiede piano Pro">
             <i data-lucide="lock" style="width:12px;height:12px;stroke-width:2"></i>
             Bloccato
           </button>`
        : `<button class="ea-action-btn ea-action-open" onclick="_switchToExam('${entry.id}')">
             <i data-lucide="folder-open" style="width:12px;height:12px;stroke-width:2"></i>
             Apri piano
           </button>`;
    const deleteBtn = `<button class="ea-action-btn ea-action-delete" onclick="_deleteExam('${entry.id}')">
           <i data-lucide="trash-2" style="width:12px;height:12px;stroke-width:2"></i>
           Elimina
         </button>`;

    const outcomeFormId = _outcomeFormId(entry.id);
    const outcomeForm = `
      <div class="ea-outcome-form" id="${outcomeFormId}" style="display:none">
        <div class="ea-outcome-row">
          <button class="ea-out-btn ea-out-fail" onclick="_updateArchivedExamOutcome('${entry.id}','failed',null)">Non superato</button>
          <div class="ea-out-pass-group">
            <button class="ea-out-btn ea-out-pass" onclick="(function(){
              var g=document.getElementById('eaGrade_${entry.id.replace(/[^a-z0-9]/gi,'')}');
              var v=g?parseInt(g.value):0;
              if(v>=18&&v<=30){_updateArchivedExamOutcome('${entry.id}','passed',v);document.getElementById('${outcomeFormId}').style.display='none';}
              else{g&&g.classList.add('ea-inp-err');setTimeout(()=>g&&g.classList.remove('ea-inp-err'),800);}
            })()">Superato</button>
            <input type="number" class="ea-grade-inp" id="eaGrade_${entry.id.replace(/[^a-z0-9]/gi,'')}"
              min="18" max="30" placeholder="voto" value="${entry.grade || ''}">
          </div>
        </div>
      </div>`;

    const updateBtn = past
      ? `<button class="ea-action-btn ea-action-outcome"
           onclick="var f=document.getElementById('${outcomeFormId}');f.style.display=f.style.display==='none'?'flex':'none'">
           <i data-lucide="edit-2" style="width:12px;height:12px;stroke-width:2"></i>
           ${entry.outcome ? 'Modifica esito' : 'Registra esito'}
         </button>
         ${outcomeForm}`
      : '';

    return `
      <div class="ea-card${isCurrent ? ' ea-card-current' : ''}">
        <div class="ea-card-head">
          <div class="ea-card-info">
            <div class="ea-subject">${escHtml(entry.subject || 'Esame senza titolo')}</div>
            ${entry.professor ? `<div class="ea-professor">${escHtml(entry.professor)}</div>` : ''}
            <div class="ea-date">
              <i data-lucide="calendar" style="width:11px;height:11px;stroke-width:2"></i>
              ${_fmtDate(entry.examDate)}
            </div>
          </div>
          <div class="ea-card-meta">
            ${_outcomeChip(entry)}
          </div>
        </div>
        <div class="ea-card-actions">
          ${switchBtn}
          ${deleteBtn}
          ${updateBtn}
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="ea-toolbar">
      <button class="exams-archive-new-btn" onclick="_createNewExam()">
        <i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5"></i>
        Crea nuovo esame
      </button>
    </div>
    <div class="ea-list">${cards}</div>`;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

window._skipExamOutcomeForNow = function() {
  const overlay = document.getElementById('examOutcomeOverlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  // Snooze per la sessione corrente — riappare alla prossima apertura dell'app
  try { sessionStorage.setItem('exam_outcome_snoozed', '1'); } catch(e) {}
};

window._maybeShowExamOutcomeModal = function() {
  const ob = document.getElementById('obOverlay');
  if (ob?.classList.contains('active')) return;
  if (document.getElementById('welcomeOverlay')?.classList.contains('open')) return;

  const info = getExamInfo();
  if (!info.date || info.skipped) return;
  if (!_examDateHasPassed(info.date)) return;
  if (info.result && info.result.examDate === info.date) return;
  try { if (sessionStorage.getItem('exam_outcome_snoozed')) return; } catch(e) {}

  const overlay = document.getElementById('examOutcomeOverlay');
  if (!overlay) return;

  const intro = document.getElementById('examOutcomeIntro');
  if (intro) {
    const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
    const ex = _examInfoParseYMD(info.date);
    const dateHuman = ex
      ? `${ex.getDate()} ${months[ex.getMonth()]} ${ex.getFullYear()}`
      : info.date;
    const subj = (info.subject || 'Esame').trim();
    intro.textContent = `L'esame del ${dateHuman}${subj ? ' (' + subj + ')' : ''} è nel passato. Come è andato? Il voto e la tua preparazione (punteggi) verranno salvati nel profilo.`;
  }

  const err = document.getElementById('examOutcomeErr');
  if (err) err.textContent = '';
  const wrap = document.getElementById('examOutcomeGradeWrap');
  if (wrap) wrap.style.display = 'none';
  const inp = document.getElementById('examOutcomeGrade');
  if (inp) inp.value = '';

  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('open');
};

function saveExamInfo() {
  const prev = getExamInfo();
  const info = {
    subject:   (document.getElementById('examSubject')?.value   || '').trim(),
    professor: (document.getElementById('examProfessor')?.value || '').trim(),
    date:      (document.getElementById('examDate')?.value      || '').trim()
  };
  if (prev.skipped) info.skipped = prev.skipped;
  if (prev.result && prev.result.examDate === info.date) info.result = prev.result;
  _safeLSSet('psico_exam_info', JSON.stringify(info));
  updateGenPlanBtn();
  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
  setTimeout(() => {
    if (typeof window._maybeShowExamOutcomeModal === 'function') window._maybeShowExamOutcomeModal();
  }, 500);
}
function loadExamInfoUI() {
  // Difesa: se il form è vuoto ma un piano esiste, ripristina i dati dal piano
  if (typeof _healExamInfoFromPlan === 'function') _healExamInfoFromPlan();
  const info = getExamInfo();
  const s = document.getElementById('examSubject');
  const p = document.getElementById('examProfessor');
  const d = document.getElementById('examDate');
  if (s && info.subject)   s.value = info.subject;
  if (p && info.professor) p.value = info.professor;
  if (d && info.date)      d.value = info.date;
  updateGenPlanBtn();
  updateGenPlanStatus();
}

function updateGenPlanBtn() {
  const btn  = document.getElementById('genPlanBtn');
  if (!btn) return;
  const info = getExamInfo();
  const hasSubject = !!(info.subject || '').trim();
  const hasDate    = !!info.date;
  btn.disabled = !(hasSubject && hasDate);
  const hint = !hasSubject ? 'Inserisci il titolo della materia per continuare'
             : !hasDate    ? 'Inserisci la data dell\'esame per continuare'
             : '';
  btn.title = hint;
}

// ── Plan quality tier ─────────────────────────────────────────
function _calcSourceQualityTier() {
  const sources = getSources();

  // Programma: type 'syllabus' (new) or legacy ob-syllabus with any non-textbook type
  const hasSyllabus = sources.some(s =>
    s.type === 'syllabus' ||
    (s.id === 'ob-syllabus' && s.type !== 'textbook-ref')
  );

  // Dispense: any source that is NOT a syllabus, NOT a textbook-ref, has real content
  // Includes: uploaded PDFs (no type), pasted text (type 'text') from the sources panel,
  //           and uploaded files from onboarding (type 'text' with id != ob-syllabus)
  const hasFiles = sources.some(s =>
    s.type !== 'textbook-ref' &&
    s.type !== 'syllabus' &&
    s.id   !== 'ob-syllabus' &&
    (s.content || '').trim().length > 100
  );

  // Manuali: textbook references
  const hasBooks = sources.some(s =>
    s.type === 'textbook-ref' &&
    (s.title || s.content || '').trim().length > 3
  );

  // Massima (4): programma + dispense + manuale
  // Ottima  (3): programma + dispense  OR  programma + manuale
  // Buona   (2): programma (o solo manuale)
  // Base    (1): solo materia
  if (hasSyllabus && hasFiles && hasBooks) return 4;
  if (hasSyllabus && (hasFiles || hasBooks)) return 3;
  if (hasSyllabus || hasBooks) return 2;
  return 1;
}

function updatePlanQualityWidget() {
  const lbl       = document.getElementById('hpqLabel');
  const cta       = document.getElementById('hpqCta');
  const container = document.getElementById('hdrPlanQual');
  if (!lbl) return;

  const planRaw = localStorage.getItem('psico_ai_plan');

  // Helper: paint the 4-segment bar
  function _paintBars(tier, color) {
    for (let i = 1; i <= 4; i++) {
      const bar = document.getElementById('hpqBar' + i);
      if (!bar) continue;
      bar.classList.remove('active', 'prev');
      if (i < tier)  bar.classList.add('prev');
      if (i === tier) bar.classList.add('active');
    }
    // Set CSS variable for color-mix fallback
    const barsEl = document.querySelector('.hpq-bars');
    if (barsEl) barsEl.style.setProperty('--hpq-color', color);
  }

  if (!planRaw) {
    _paintBars(0, '#6b7280');
    lbl.textContent = 'Nessun piano generato';
    lbl.style.color = 'var(--text-3)';
    if (cta) cta.style.display = 'none';
    if (container) container.title = '';
    return;
  }

  let planTier = 1;
  try { planTier = JSON.parse(planRaw).sourceTier || 1; } catch { /* leave default */ }
  planTier = Math.min(Math.max(planTier, 1), 4);

  const t = _PLAN_QUALITY[planTier - 1];
  _paintBars(planTier, t.color);

  // Label: "Base — solo materia"
  lbl.textContent = `${t.label} — ${t.shortDesc}`;
  lbl.style.color = planTier === 1 ? 'var(--text-3)' : 'var(--text-2)';
  if (container) container.title = t.hint;

  // CTA: show if plan is improvable (< Ottimale) and current sources > planTier
  const currentTier = _calcSourceQualityTier();
  const canImprove  = planTier < 4;
  if (cta) {
    cta.style.display = canImprove ? 'inline-flex' : 'none';
    if (canImprove && currentTier > planTier) {
      // Sources already improved — trigger regeneration directly
      cta.textContent = '↑ Rigenera il piano';
      cta.onclick = () => generateStudyPlan();
    } else if (canImprove) {
      cta.innerHTML = '<i data-lucide="arrow-up-right" style="width:10px;height:10px;stroke-width:2.5;pointer-events:none"></i> Migliora il piano';
      cta.onclick = () => openSetupDrawer('fonti');
      if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [cta] });
    }
  }
}

function updateGenPlanStatus() {
  const statusEl = document.getElementById('genPlanStatus');
  const resetEl  = document.getElementById('genPlanReset');
  if (!statusEl) return;
  const existing = localStorage.getItem('psico_ai_plan');
  if (existing) {
    const plan = JSON.parse(existing);
    const d = new Date(plan.generatedAt).toLocaleDateString('it-IT');
    statusEl.textContent = `✓ Piano per "${plan.subject || 'la materia'}" generato il ${d}`;
    statusEl.className = 'gen-plan-status has-plan';
    if (resetEl) resetEl.style.display = 'block';
  } else {
    const info = getExamInfo();
    statusEl.textContent = (info.subject && info.date)
      ? 'Clicca "Sviluppa piano di studio" per generare il piano.'
      : 'Inserisci materia e data esame per abilitare la generazione.';
    statusEl.className = 'gen-plan-status';
    if (resetEl) resetEl.style.display = 'none';
  }
  updateGenPlanBtn();
  updatePlanQualityWidget();
}

function resetAiPlan() {
  if (!confirm('Ripristinare il piano predefinito? Il piano generato dall\'AI verrà cancellato (le risposte date restano).')) return;
  localStorage.removeItem('psico_ai_plan');
  buildDays({ force: true }); // completely new plan structure
  buildNav();
  updateGenPlanStatus();
  const first = getActiveDays()[0];
  if (first) showDay(first.id);
}

// ── Generate study plan ──────────────────────────────────────
// ── Plan generation animation controller ─────────────────────────────────────
const _planAnim = (() => {
  // 4 weeks × 7 days — replica il pattern del canvas preview
  const PLAN = [
    'studio','studio','studio','studio','studio','riposo','riposo',
    'studio','studio','studio','riposo','studio','riposo','riposo',
    'studio','studio','studio','studio','riposo','riposo','riposo',
    'riposo','studio','studio','studio','riposo','studio','esame',
  ];
  const PHASES = [
    { at: 0,    msg: 'Analisi della materia…'               },
    { at: 0.20, msg: 'Strutturazione degli argomenti…'      },
    { at: 0.46, msg: 'Costruzione del calendario…'          },
    { at: 0.68, msg: 'Generazione domande per ogni giorno…' },
    { at: 0.88, msg: 'Ottimizzazione finale del piano…'     },
  ];
  const TOTAL = PLAN.length; // 28

  return {
    _phaseTimer: null,
    _calTimer: null,
    _progressTimer: null,
    _tokTimer: null,
    _calFilled: 0,
    _progress: 0,
    _tokens: 0,
    _running: false,

    start() {
      if (this._running) return;
      this._running = true;
      this._calFilled = 0;
      this._progress = 0;
      this._tokens = 0;
      this._buildCalGrid();
      // Prima cella subito visibile
      this._fillCalCell(0); this._calFilled = 1;
      this._updatePhase();

      // Fase basata sul progresso reale
      this._phaseTimer = setInterval(() => this._updatePhase(), 800);

      // Calendario: una cella ogni ~3s (28 celle × 3s = 84s)
      this._calTimer = setInterval(() => {
        if (this._calFilled < TOTAL) this._fillCalCell(this._calFilled++);
      }, 3000);

      // Fake progress: 0 → 85% in ~90s
      this._progressTimer = setInterval(() => {
        if (this._progress < 85) {
          this._progress = Math.min(85, this._progress + 0.65);
          const b = document.getElementById('planGenBar');
          if (b) b.style.width = this._progress + '%';
        }
      }, 700);

      // Token counter (decorativo, come nel canvas)
      this._tokTimer = setInterval(() => {
        this._tokens += Math.floor(Math.random() * 15 + 5);
        const s = document.getElementById('planGenStep');
        if (s && s.textContent !== 'Caricamento…') {
          s.textContent = this._tokens.toLocaleString('it') + ' tok';
        }
      }, 72);
    },

    stop() {
      this._running = false;
      [this._phaseTimer, this._calTimer, this._progressTimer, this._tokTimer]
        .forEach(t => clearInterval(t));
      this._phaseTimer = this._calTimer = this._progressTimer = this._tokTimer = null;
    },

    setProgress(pct) {
      if (pct > this._progress) {
        this._progress = pct;
        const b = document.getElementById('planGenBar');
        if (b) b.style.width = pct + '%';
      }
    },

    showStats(days, topics, weeks) {
      const _count = (id, target) => {
        const el = document.getElementById(id);
        if (!el) return;
        let v = 0;
        const step = Math.ceil(target / 30);
        const tid = setInterval(() => {
          v = Math.min(target, v + step);
          el.textContent = v;
          if (v >= target) clearInterval(tid);
        }, 55);
      };
      _count('planStatDays', days);
      _count('planStatTopics', topics);
      _count('planStatWeeks', weeks);
    },

    resetStats() {
      ['planStatDays','planStatTopics','planStatWeeks'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '—';
      });
    },

    _updatePhase() {
      const p = this._progress / 100;
      let msg = PHASES[0].msg;
      for (const ph of PHASES) { if (p >= ph.at) msg = ph.msg; }
      const el = document.getElementById('planGenPhase');
      if (el && el.textContent !== msg) el.textContent = msg;
    },

    _buildCalGrid() {
      const grid = document.getElementById('planGenCalGrid');
      if (!grid) return;
      grid.innerHTML = '';
      for (let i = 0; i < TOTAL; i++) {
        const cell = document.createElement('div');
        cell.className = 'pgcal-cell';
        cell.id = 'pgcal-' + i;
        grid.appendChild(cell);
      }
    },

    _fillCalCell(idx) {
      const cell = document.getElementById('pgcal-' + idx);
      if (!cell) return;
      const type = PLAN[idx] || 'studio';
      cell.classList.add(
        type === 'esame'  ? 'pgcal-cell--exam' :
        type === 'riposo' ? 'pgcal-cell--rest' :
                            'pgcal-cell--active'
      );
    }
  };
})();

function _setPlanGenUI(title, msg, pct, step) {
  const overlay = document.getElementById('planGenOverlay');
  const wasActive = overlay && overlay.classList.contains('active');
  if (overlay) overlay.classList.add('active');
  if (!wasActive) _planAnim.start();
  if (typeof pct === 'number') _planAnim.setProgress(pct);
  const s = document.getElementById('planGenStep');
  if (s) s.textContent = step || '';
  // hidden compat
  const t = document.getElementById('planGenTitle');
  const m = document.getElementById('planGenMsg');
  if (t) t.textContent = title;
  if (m) m.textContent = msg;
  // Reset error state if the overlay is being reused for a new attempt
  const errEl = document.getElementById('planGenError');
  if (errEl) errEl.style.display = 'none';
  const card = document.querySelector('.plan-gen-card');
  if (card) card.style.display = '';
  const stats = document.querySelector('.plan-gen-stats');
  if (stats) stats.style.display = '';
  const headline = document.querySelector('.plan-gen-headline');
  if (headline) headline.textContent = 'Stiamo preparando il tuo piano di studio';
}

function _hidePlanGenUI() {
  _planAnim.stop();
  _planAnim.resetStats();
  const overlay = document.getElementById('planGenOverlay');
  if (overlay) overlay.classList.remove('active');
  // Always hide the error panel when closing
  const errEl = document.getElementById('planGenError');
  if (errEl) errEl.style.display = 'none';
}

function _showPlanGenError(msg) {
  // Hide the animated card, show the error panel inside the overlay
  const card = document.querySelector('.plan-gen-card');
  if (card) card.style.display = 'none';
  const stats = document.querySelector('.plan-gen-stats');
  if (stats) stats.style.display = 'none';
  const headline = document.querySelector('.plan-gen-headline');
  if (headline) headline.textContent = 'Errore nella generazione';
  const errEl  = document.getElementById('planGenError');
  const msgEl  = document.getElementById('planGenErrorMsg');
  if (msgEl) msgEl.textContent = msg;
  if (errEl) errEl.style.display = 'block';
  // Keep the overlay open so the user can read the message and retry
}

function _dateRange(startDate, endDate) {
  // Return array of {date, dayOfWeek} between start and end (inclusive)
  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function _formatDateLabel(d) {
  const days = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}
function _shortLabel(d) {
  return `${d.getDate()}/${d.getMonth()+1}`;
}
function _isoDate(d) {
  // Use local-time getters to avoid UTC offset shifting the date
  // (toISOString() returns UTC: at midnight in UTC+2, midnight local = 22:00 UTC → previous day)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Safety net contro la troncatura dell'output AI.
 * Garantisce che il piano copra OGNI data da oggi all'esame (incluso),
 * senza buchi nel calendario. Le date assenti dall'output AI vengono
 * riempite con giornate di studio segnaposto (le domande vengono generate
 * on-demand all'avvio del quiz). Le date fuori intervallo vengono scartate.
 *
 * @param {Array} planDays   giornate restituite dall'AI (oggetti con .date ISO)
 * @param {Array<string>} skeletonIso  tutte le date ISO attese, ordinate, oggi→esame
 * @param {string} examIso   data ISO dell'esame
 * @returns {Array} piano contiguo e ordinato che copre tutte le date dello skeleton
 */
function _fillPlanGaps(planDays, skeletonIso, examIso) {
  const byDate = new Map();
  (planDays || []).forEach(d => { if (d && d.date) byDate.set(d.date, d); });

  return skeletonIso.map(iso => {
    if (byDate.has(iso)) return byDate.get(iso);
    if (iso === examIso) {
      return { date: iso, type: 'exam', title: 'Giorno dell\'esame', subtitle: 'In bocca al lupo!', questions: [] };
    }
    return {
      date: iso,
      type: 'studio',
      title: 'Sessione di studio',
      subtitle: 'Ripasso e approfondimento',
      questions: []
    };
  });
}

async function generateStudyPlan(fromOnboarding = false) {

  const info = getExamInfo();
  let _planGenHadError = false;

  // ── Pre-flight validation ──────────────────────────────────────────────────
  // Only subject and date are strictly required. Sources improve quality but
  // are optional — the system falls back to Claude's knowledge of the subject.
  const _missing = [];
  if (!(info.subject || '').trim()) _missing.push('• Titolo materia (es. Psicologia Cognitiva)');
  if (!info.date)                   _missing.push('• Data dell\'esame');
  if (_missing.length) {
    alert('Per generare il piano completa i seguenti campi:\n\n' + _missing.join('\n'));
    return;
  }

  // ── Archive current exam before overwriting ───────────────────────────────
  if (typeof _archiveCurrentExam === 'function') {
    try { _archiveCurrentExam(); } catch(e) { console.warn('Archive failed:', e); }
  }

  // ── Confirm overwrite if a plan already exists ─────────────────────────────
  if (!fromOnboarding) {
    const existingRaw = localStorage.getItem('psico_ai_plan');
    if (existingRaw) {
      let ex; try { ex = JSON.parse(existingRaw); } catch { ex = {}; }
      const genDate = ex.generatedAt
        ? new Date(ex.generatedAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })
        : null;
      const currentTier = _calcSourceQualityTier();
      const planTier    = ex.sourceTier || 1;
      const tierLabel   = _PLAN_QUALITY[currentTier - 1]?.label || '';
      const improvement = currentTier > planTier
        ? `\n\nCon le fonti attuali la qualità migliorerà a "${tierLabel}".`
        : '';
      const msg = `Esiste già un piano per "${ex.subject || info.subject.trim()}"` +
        (genDate ? ` (generato il ${genDate})` : '') + '.' +
        improvement +
        '\n\nRigenerare il piano? Le risposte già date verranno conservate.';
      if (!confirm(msg)) return;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // primaryOnly: il piano di studio deve strutturarsi sulle dispense caricate,
  // non sul programma del manuale che Claude già conosce.
  // Source context ridotto rispetto al default: meno input token = generazione più veloce.
  const { context: sourceCtx, rule: sourceRule } = _buildWeightedSourceContext({ primaryMax: 8000, secondaryMax: 1500, totalMax: 12000, primaryOnly: true });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const examDate = new Date(info.date);
  if (examDate <= today) { alert('La data dell\'esame deve essere nel futuro.'); return; }

  const totalDays = Math.round((examDate - today) / (1000 * 60 * 60 * 24));
  const subject   = info.subject.trim();
  const professor = info.professor || '';

  if (totalDays < 3) { alert('La data dell\'esame è troppo vicina. Inserisci una data ad almeno 3 giorni di distanza.'); return; }

  _setPlanGenUI(
    sourceCtx ? 'Analisi fonti…' : 'Preparazione piano…',
    `Claude sta costruendo un piano ottimale per ${subject}…`,
    10,
    sourceCtx ? 'Lettura fonti…' : 'Analisi materia…'
  );

  // Build a compact date skeleton (ISO only, no labels) so Claude knows which
  // dates to assign. Labels are computed client-side after generation.
  const allDates = _dateRange(today, examDate);
  const skeleton = allDates.map(d => _isoDate(d));

  const sourcePart = sourceCtx
    ? `${sourceRule}\n\nFONTI DEL CORSO (usa queste per costruire i contenuti delle giornate — priorità assoluta alle fonti primarie):\n--- INIZIO FONTI ---\n${sourceCtx}\n--- FINE FONTI ---\n\nIMPORTANTE — struttura implicita: se le fonti non contengono un programma o indice esplicito (solo dispense, slide o capitoli di libro), ricava tu stesso la struttura degli argomenti dai titoli di sezione, capitoli, intestazioni e contenuti. Usa questa struttura implicita per organizzare le giornate in ordine progressivo (dalle basi agli approfondimenti).\n\n`
    : `NESSUNA FONTE CARICATA: genera un piano strutturato basandoti sulla tua conoscenza della materia "${subject}". Distribuisci i topic principali della disciplina in modo progressivo, dal più fondamentale al più avanzato, seguendo la struttura tipica di un corso universitario italiano su questo argomento. Le domande devono essere pertinenti alla materia e di livello universitario.\n\n`;

  const systemPrompt = `Sei un pedagogista esperto di pianificazione universitaria. Il tuo compito è costruire un piano di studio ottimale per uno studente universitario che deve prepararsi a un esame.

MATERIA: ${subject}${professor ? ' — Prof. ' + professor : ''}
DATA ESAME: ${info.date} (tra ${totalDays} giorni)
OGGI: ${_isoDate(today)}

${sourcePart}ISTRUZIONI PER LA PIANIFICAZIONE:
1. Distribuisci i contenuti del corso in modo progressivo: prima le basi, poi gli approfondimenti
2. Inserisci almeno 1 giorno di riposo ogni 6 giorni di studio (preferibilmente la domenica)
3. Gli ultimi 2-3 giorni prima dell'esame devono essere di revisione + simulazione
4. Il giorno prima dell'esame deve essere riposo

DATE DISPONIBILI (ISO, ${allDates.length} giorni):
${skeleton.join(',')}

Rispondi ESCLUSIVAMENTE con un array JSON valido che inizia con "[" e finisce con "]" (nessun altro testo, nessun markdown, nessun code fence).
La risposta deve essere SOLO: [ {...}, {...}, ... ]
Ogni oggetto "day" deve avere ESATTAMENTE questi campi:

{
  "date": "YYYY-MM-DD",                        // data ISO dalla lista sopra
  "type": "studio|rest|revisione|exam",         // tipo giornata
  "title": "Titolo breve (max 8 parole)",       // es. "Lezioni 1-3 — Fondamenti"
  "subtitle": "Sottotitolo (max 6 parole)"      // breve descrizione
}

REGOLE SUI TESTI (per garantire JSON valido):
- NON usare mai virgolette doppie (") dentro "title" o "subtitle". Se devi citare un termine, usa gli apici singoli (') o nessuna virgoletta.
- Niente a capo dentro le stringhe. Niente campo "questions": le domande vengono generate altrove.

REGOLE ASSOLUTE (non derogabili):
- Includi TUTTE le date da ${_isoDate(today)} a ${info.date} inclusa, senza aggiungere date successive
- La data ESATTA ${info.date} DEVE avere type "exam" — non un giorno prima, non un giorno dopo
- Il giorno prima dell'esame (${_isoDate(new Date(new Date(info.date).getTime() - 86400000))}) deve avere type "rest"
- Non includere MAI date successive al ${info.date}
- ${sourceCtx ? 'Basa i titoli ESCLUSIVAMENTE sul materiale delle fonti fornite' : 'Usa titoli specifici e pertinenti alla materia, coprendo i topic principali della disciplina universitaria'}
- Titoli e sottotitoli specifici e di livello universitario, non generici`;

  _setPlanGenUI('Generazione piano…', 'Claude sta costruendo il calendario…', 30, 'Chiamata API…');

  const _apiMsg = `Genera il piano di studio completo per ${subject}, da oggi (${_isoDate(today)}) al giorno dell'esame (${info.date}). Rispondi SOLO con l'array JSON — nessun testo, nessun markdown. Formato: [{...},{...},...]`;

  try {

    // ── Chiamata API con retry automatico ────────────────────────
    // L'AI a volte restituisce JSON malformato (virgolette non escapate,
    // troncature, virgole finali). _extractJson può quindi LANCIARE: il retry
    // deve catturare sia le eccezioni sia i risultati non-array, altrimenti una
    // singola risposta sbagliata fa fallire l'intera generazione.
    let planDays = null;
    let lastErr  = null;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        _setPlanGenUI('Nuovo tentativo…', `Risposta non valida, riprovo (${attempt + 1}/${MAX_ATTEMPTS})…`, 35, 'Richiesta API…');
        await new Promise(r => setTimeout(r, 1200));
      }
      const data = await _callClaudeStream({
        model: 'claude-haiku-4-5',
        // Schema snello senza "questions": ~60 token/giorno (date+type+title+subtitle).
        // Stima bassa = troncatura → buco nel calendario; per questo teniamo margine
        // e un floor generoso. Le domande vere si generano on-demand all'avvio del quiz.
        max_tokens: Math.min(12000, Math.max(2500, Math.ceil(totalDays * 80))),
        // Temperatura più bassa ai retry → output più deterministico e meno malformato.
        temperature: attempt === 0 ? 0.6 : 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content: _apiMsg }]
      });
      let parsed;
      try {
        parsed = _extractJson(data.content[0].text.trim());
      } catch (parseErr) {
        lastErr = parseErr;
        console.warn(`[generateStudyPlan] tentativo ${attempt + 1}: parsing fallito —`, parseErr.message);
        continue;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        lastErr = new Error('Risposta AI non in formato array');
        console.warn(`[generateStudyPlan] tentativo ${attempt + 1}: risultato non-array, riprovo`);
        continue;
      }
      planDays = parsed;
      break;
    }
    if (!planDays) {
      throw new Error(`Impossibile generare un piano valido dopo ${MAX_ATTEMPTS} tentativi. Riprova tra poco.${lastErr ? ` (${lastErr.message})` : ''}`);
    }

    _setPlanGenUI('Struttura pronta…', 'Costruzione del calendario…', 55, 'Quasi pronto…');

    // ── Fill gaps + hard-validate ──────────────────────────────
    // L'AI può troncare l'output su piani lunghi e saltare le settimane finali,
    // lasciando un buco nel calendario fino all'esame. _fillPlanGaps garantisce
    // che ogni data oggi→esame sia presente (segnaposto di studio dove manca) e
    // scarta eventuali date fuori intervallo. Lo skeleton è già ordinato.
    const examIso = info.date; // e.g. "2026-05-12"
    const filledDays = _fillPlanGaps(planDays, skeleton, examIso);
    planDays.length = 0; filledDays.forEach(d => planDays.push(d));

    // Force the exam date to type "exam" regardless of what the AI returned,
    // and demote any stray "exam" placed on a different date.
    const examInPlan = planDays.find(d => d.date === examIso);
    if (examInPlan) {
      examInPlan.type = 'exam';
      examInPlan.questions = [];
      planDays.forEach(d => { if (d.date !== examIso && d.type === 'exam') d.type = 'rest'; });
    }
    // Also ensure the day immediately before the exam is "rest" (if it exists and isn't already rest)
    const examIdx = planDays.findIndex(d => d.date === examIso);
    if (examIdx > 0) {
      const dayBefore = planDays[examIdx - 1];
      if (dayBefore.type !== 'rest') { dayBefore.type = 'rest'; dayBefore.questions = []; }
    }

    // Normalize and add id fields.
    // label, shortLabel, weekStart are no longer in the AI output — compute them here.
    let _weekNum = 0;
    let _lastWeekKey = '';
    const normalizedDays = planDays.map((d, i) => {
      const dateObj = new Date(d.date + 'T00:00:00');
      // ISO week: week starts on Monday
      const dow = dateObj.getDay() || 7; // Sun=0 → 7
      const mon = new Date(dateObj);
      mon.setDate(dateObj.getDate() - (dow - 1));
      const weekKey = _isoDate(mon);
      let weekStart = null;
      if (weekKey !== _lastWeekKey) {
        _lastWeekKey = weekKey;
        _weekNum++;
        weekStart = `Settimana ${_weekNum}`;
      }
      return {
        ...d,
        id:         'ai-' + (d.date || i).toString().replace(/-/g, ''),
        label:      _formatDateLabel(dateObj),
        shortLabel: _shortLabel(dateObj),
        weekStart,
        questions:  d.questions || [],
        notes: d.type !== 'rest' && d.type !== 'exam'
      };
    });

    const plan = {
      subject,
      professor,
      examDate:    info.date,
      generatedAt: new Date().toISOString(),
      sourceTier:  _calcSourceQualityTier(), // snapshot of source quality at generation
      days:        normalizedDays
    };
    _safeLSSet('psico_ai_plan', JSON.stringify(plan));
    // Aggiorna il timestamp locale e sincronizza subito: evita che _pullAndReinit
    // (scatenato da visibilitychange durante la generazione) ripristini il vecchio piano.
    window._lastLocalWrite = Date.now();
    if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
    updatePlanQualityWidget();

    // Sync exam to Supabase user_exams (for admin dashboard tracking)
    if (typeof window._syncExamInfoToSupabase === 'function') {
      window._syncExamInfoToSupabase(window._currentUserId);
    }

    // ── Fase 2: domande pre-caricate (non fatale) ──────────────
    // La struttura è già salvata e sincronizzata sopra: se questa fase fallisce,
    // il piano resta valido e le domande si generano on-demand all'avvio sessione.
    // Generate a lotti piccoli → JSON robusto. Salva e aggiorna il calendario man mano.
    try {
      await _populatePlanQuestions(plan, { sourceCtx, sourceRule, subject });
    } catch (e) {
      console.warn('[generateStudyPlan] popolamento domande non riuscito (non fatale):', e);
    }

    _setPlanGenUI('Piano completato ✓', `${normalizedDays.length} giorni pianificati fino all\'esame.`, 100, 'Caricamento…');
    const _studyDays = normalizedDays.filter(d => d.type === 'studio' || d.type === 'revision').length;
    const _topicCount = normalizedDays.filter(d => d.type === 'studio').length;
    const _weeks = Math.ceil(totalDays / 7);
    _planAnim.showStats(_studyDays, _topicCount, _weeks);
    await new Promise(r => setTimeout(r, 1200));

    // Rebuild UI — new plan starts fresh from day 1
    try { localStorage.removeItem('psico_last_day'); } catch(e) {}
    buildDays({ force: true }); // completely new plan structure
    buildNav();
    updateGenPlanStatus();

    if (fromOnboarding) {
      // After onboarding: always land on calendar overview, not a specific day
      if (typeof buildPlanOverview === 'function') buildPlanOverview();
      if (typeof showPlanOverview  === 'function') showPlanOverview();
      // Show welcome modal with fresh plan data on top of calendar
      if (typeof showWelcomeModal === 'function') setTimeout(() => showWelcomeModal(), 400);
    } else {
      const first = getActiveDays()[0];
      if (first) showDay(first.id);
      closeSourcesPanel();
    }

  } catch(e) {
    const isTimeout = e?.name === 'TimeoutError' || (e?.message || '').toLowerCase().includes('troppo tempo');
    const userMsg = isTimeout
      ? 'La generazione ha impiegato troppo tempo.\n\nSe l\'esame è lontano (>60 giorni) o hai molte fonti caricate, il piano richiede più tempo. Riprova tra qualche momento — di solito basta un secondo tentativo.'
      : (e?.message || 'Errore sconosciuto. Riprova.');
    _planAnim.stop();
    _showPlanGenError(userMsg);
    // overlay stays open; _hidePlanGenUI skipped via flag below
    _planGenHadError = true;
  } finally {
    if (!_planGenHadError) _hidePlanGenUI();
  }
}

/**
 * Fase 2 della generazione: popola le domande pre-caricate del piano a lotti
 * piccoli (JSON piccolo = robusto), salvando e aggiornando il calendario man mano.
 * Non fatale: se un lotto fallisce, quelle giornate restano senza domande e
 * useranno la generazione on-demand. Riempie SOLO le giornate studio/revisione
 * ancora prive di domande → retrocompatibile coi piani che le hanno già.
 */
async function _populatePlanQuestions(plan, { sourceCtx = '', sourceRule = '', subject = '' } = {}) {
  if (!plan || !Array.isArray(plan.days)) return;
  const targets = plan.days.filter(d =>
    (d.type === 'studio' || d.type === 'revisione') &&
    !(Array.isArray(d.questions) && d.questions.length > 0)
  );
  if (!targets.length) return;

  const BATCH = 8;
  const totalBatches = Math.ceil(targets.length / BATCH);

  for (let b = 0; b < totalBatches; b++) {
    const batch = targets.slice(b * BATCH, b * BATCH + BATCH);
    const pct = 60 + Math.round((b / totalBatches) * 35); // 60→95%
    _setPlanGenUI('Generazione domande…', `Preparo le domande delle giornate (${b + 1}/${totalBatches})…`, pct, 'Domande…');

    let byDate = null;
    try {
      byDate = await _genPlanQuestionBatch(batch, { subject, sourceCtx, sourceRule });
    } catch (e) {
      console.warn(`[populatePlanQuestions] lotto ${b + 1} fallito (non fatale):`, e?.message || e);
    }
    if (!byDate) continue;

    // Merge nel piano più recente in localStorage (evita di sovrascrivere altri write)
    let latest = plan;
    try {
      const raw = localStorage.getItem('psico_ai_plan');
      if (raw) latest = JSON.parse(raw);
    } catch { latest = plan; }
    let changed = false;
    latest.days.forEach(d => {
      if (byDate[d.date] && byDate[d.date].length) { d.questions = byDate[d.date]; changed = true; }
    });
    // Mantieni allineato anche l'oggetto in memoria
    plan.days.forEach(d => { if (byDate[d.date] && byDate[d.date].length) d.questions = byDate[d.date]; });

    if (changed) {
      _safeLSSet('psico_ai_plan', JSON.stringify(latest));
      window._lastLocalWrite = Date.now();
      try { if (typeof buildPlanOverview === 'function') buildPlanOverview(); } catch {}
    }
  }

  if (typeof window._syncToSupabase === 'function') window._syncToSupabase();
}

/**
 * Genera le domande per un lotto di giornate in una sola chiamata.
 * Ritorna una mappa { "YYYY-MM-DD": [{text,type}, …] } oppure null se non parsabile.
 */
async function _genPlanQuestionBatch(days, { subject = '', sourceCtx = '', sourceRule = '' } = {}) {
  const list = days.map(d =>
    `${d.date} | ${d.type} | ${(d.title || '').replace(/"/g, "'")}${d.subtitle ? ' — ' + d.subtitle.replace(/"/g, "'") : ''}`
  ).join('\n');

  const fontiBlock = sourceCtx
    ? `${sourceRule}\n--- INIZIO FONTI ---\n${sourceCtx}\n--- FINE FONTI ---\nBasa le domande ESCLUSIVAMENTE sulle fonti fornite.`
    : `Basa le domande sulla tua conoscenza universitaria della materia "${subject}".`;

  const systemPrompt = `Sei un professore universitario di ${subject || 'questa materia'} che prepara uno studente a un esame scritto.

${fontiBlock}

Per OGNI giornata elencata genera ESATTAMENTE 3 domande a risposta aperta, specifiche per il titolo della giornata e di livello universitario.

DISTRIBUZIONE (Tassonomia di Bloom, 3 per giornata di studio):
- 1 "definizione" (ricordo)
- 1 "meccanismo" (comprensione)
- 1 "connessione" (analisi)
- Per le giornate di tipo "revisione" usa invece 3 domande di tipo "simulazione" (livello esame).

REGOLE JSON (tassative, pena risposta inutilizzabile):
- NON usare MAI virgolette doppie (") dentro il testo delle domande: per citare un termine usa gli apici singoli (').
- Niente a capo dentro le stringhe.
- Rispondi SOLO con un array JSON valido: nessun testo, nessun markdown, nessun code fence.

Formato ESATTO (una voce per OGNI data elencata):
[{"date":"YYYY-MM-DD","questions":[{"text":"testo","type":"definizione|meccanismo|connessione|simulazione"}]}]`;

  const userMsg = `Giornate:\n${list}\n\nGenera le domande per tutte le date elencate. Rispondi SOLO con l'array JSON.`;

  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await _callClaudeStream({
      model: 'claude-haiku-4-5',
      max_tokens: Math.min(8000, Math.max(2000, days.length * 240)),
      temperature: attempt === 0 ? 0.6 : 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }]
    });
    try { parsed = _extractJson(data.content[0].text.trim()); }
    catch { parsed = null; }
    if (Array.isArray(parsed) && parsed.length) break;
    parsed = null;
  }
  if (!parsed) return null;

  const byDate = {};
  parsed.forEach(p => {
    if (!p || !p.date || !Array.isArray(p.questions)) return;
    const qs = p.questions
      .filter(q => q && typeof q.text === 'string' && q.text.trim())
      .map(q => ({ text: q.text.trim(), type: q.type || 'definizione' }));
    if (qs.length) byDate[p.date] = qs;
  });
  return Object.keys(byDate).length ? byDate : null;
}

// ── Patch: getActiveDays helper ──────────────────────────────
function getActiveDays() {
  const aiPlan = localStorage.getItem('psico_ai_plan');
  if (aiPlan) return JSON.parse(aiPlan).days;
  // Authenticated users without their own plan see an empty calendar,
  // not the hardcoded demo plan. Onboarding will prompt them to generate one.
  if (window._currentUserId) return [];
  // Unauthenticated / dev mode: fall back to hardcoded plan
  return days;
}

// ── Mobile sidebar & navigation ──────────────────────────────
function toggleMobileSidebar() {
  _mobileSidebarOpen ? closeMobileSidebar() : openMobileSidebar();
}
function openMobileSidebar() {
  _mobileSidebarOpen = true;
  document.querySelector('.sidebar')?.classList.add('mobile-open');
  document.getElementById('sidebarBackdrop')?.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeMobileSidebar() {
  _mobileSidebarOpen = false;
  document.querySelector('.sidebar')?.classList.remove('mobile-open');
  document.getElementById('sidebarBackdrop')?.classList.remove('open');
  document.body.style.overflow = '';
}

// Override showDay to also close sidebar on mobile
const _origShowDay = showDay;
window.showDay = function(id) {
  _origShowDay(id);
  if (window.innerWidth <= 768) {
    closeMobileSidebar();
    updateMobileDayNav(id);
  }
};

function updateMobileDayNav(currentId) {
  const active = getActiveDays();
  const idx = active.findIndex(d => d.id === currentId);
  if (idx === -1) return;
  const day = active[idx];
  const labelEl = document.getElementById('mobileDayLabel');
  const prevBtn = document.getElementById('mobilePrevBtn');
  const nextBtn = document.getElementById('mobileNextBtn');
  if (labelEl) labelEl.textContent = day.label || day.title || '—';
  // Disable Prec. if no navigable day exists before current
  const hasPrev = active.slice(0, idx).some(d => isDayNavigable(d.id));
  if (prevBtn) prevBtn.disabled = !hasPrev;
  // Disable Succ. if no navigable day exists after current
  const hasNext = active.slice(idx + 1).some(d => isDayNavigable(d.id));
  if (nextBtn) nextBtn.disabled = !hasNext;
}

function _showNavTooltip(msg) {
  const btn = document.getElementById('mobileNextBtn');
  if (!btn) return;
  let tip = btn.querySelector('.nav-session-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'nav-session-tooltip';
    btn.appendChild(tip);
  }
  tip.textContent = msg;
  requestAnimationFrame(() => tip.classList.add('visible'));
  clearTimeout(tip._hideTimer);
  tip._hideTimer = setTimeout(() => {
    tip.classList.remove('visible');
  }, 2800);
}

function mobileNavDay(dir) {
  const active = getActiveDays();
  const cur = document.querySelector('.day-nav-item.active');
  const curId = cur?.dataset.id;
  let idx = curId ? active.findIndex(d => d.id === curId) : 0;

  // Forward navigation: warn if current study day has an open (partial) session
  if (dir === 1 && curId) {
    const curDay   = active[idx];
    const curState = state[curId] || {};
    const isStudy  = curDay && curDay.type !== 'rest' && curDay.type !== 'exam';
    const isPartial = isStudy && curState.sessionStarted && curState.status !== 'done' && curState.status !== 'skip';
    if (isPartial) {
      _showNavTooltip('Completa prima questa sessione');
      return;
    }
  }

  // Walk in dir until we find a navigable day (done/skip/rest or current working day)
  let steps = 0;
  while (steps < active.length) {
    idx += dir;
    if (idx < 0 || idx >= active.length) break;
    if (isDayNavigable(active[idx].id)) { showDay(active[idx].id); break; }
    steps++;
  }
}

// Close sidebar on swipe left
(function() {
  let startX = 0;
  document.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!_mobileSidebarOpen) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (dx < -50) closeMobileSidebar();
  }, { passive: true });
  // Swipe right from edge to open sidebar
  document.addEventListener('touchstart', e => {
    if (e.touches[0].clientX < 20 && !_mobileSidebarOpen) startX = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (_mobileSidebarOpen) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (startX < 20 && dx > 50) openMobileSidebar();
  }, { passive: true });
})();

// Self-heal plan exam date on startup (in case of AI off-by-one)
_healPlanExamDate();
// Self-heal: ripristina i dati esame dal piano se mancano (form/header vuoti)
_healExamInfoFromPlan();
if (typeof updateHeaderTitle === 'function') updateHeaderTitle();

// Apply saved accent color
_loadAccentColor();

// Init mobile nav on first load
(function() {
  const active = getActiveDays();
  if (active[0]) updateMobileDayNav(active[0].id);
})();

// Init sources
updateSourcesBtn();

// ═══════════════════════════════════════════════════════════════════════════
// NAMESPACE INDEX — OPT-09
// Functions remain globally accessible for backward compatibility with
// HTML onclick="..." attributes and existing call sites.
// These namespace objects serve as:
//   1. A structured catalog (replaces grepping for function names)
//   2. A seam for future unit testing (mock MnestiSync.save in tests)
//   3. The extraction target for a future ES-module migration (OPT-09 phase 2)
//
// Usage:  MnestiSync.save()         — same as saveState()
//         MnestiAI.verify(...)      — same as verifyAnswer(...)
//         const { buildDays } = MnestiUI  — destructuring for internal use
// ═══════════════════════════════════════════════════════════════════════════

/** Timer & study-session time tracking. */
const MnestiTimer = Object.freeze({
  start:          timerStart,
  stop:           timerStop,
  pause:          timerPause,
  resume:         timerResume,
  tick:           timerTick,
  updateHours:    updateTotalHours,
  resetHours:     resetTotalHours,
  formatSeconds,
  formatHoursMinutes,
  isRunning:      _timerIsRunning,
  resetInactivity: _resetInactivity,
  clearInactivity: _clearInactivity,
  registry:       TimerRegistry,
});

/** State persistence, localStorage safety, and Supabase cloud sync. */
const MnestiSync = Object.freeze({
  save:           saveState,
  syncToCloud:    () => window._syncToSupabase?.(),
  pullFromCloud:  () => window._pullAndReinit?.(),
  reinit:         () => window._reinitApp?.(),
  debouncedSync:  _debouncedSync,
  safeLSSet:      _safeLSSet,
  compactState:   _compactState,
  storageUsageKB: _storageUsageKB,
  showStorageWarning: _showStorageWarning,
  getSources,
  saveSources,
  addSource,
  removeSource,
  exportAllData,
  importAllData,
});

/** All AI / Claude interactions: questions, verification, plan, quiz, OCR. */
const MnestiAI = Object.freeze({
  callClaude:         _callClaude,
  generateQuestions:  generateQuestionsFromSource,
  verify:             verifyAnswer,
  reverify:           reverifyAnswer,
  showCorrectAnswer,
  generatePlan:       generateStudyPlan,
  generateTextbook:   generateTextbookReference,
  generateQuiz:       startQuiz,
  buildSourceContext: _buildWeightedSourceContext,
  getAllSourcesContext,
  extractJson:        _extractJson,
  repairQuiz:         _repairAndParseQuiz,
  tutorSend:          _tutorSend,
  startOcr:           startPhotoOcr,
  runOcrVision:       _ocrRunVision,
});

/** DOM rendering: day cards, navigation, panels, themes, progress. */
const MnestiUI = Object.freeze({
  buildDays,
  buildNav,
  buildDayCard:     _buildDayCard,
  patchDay:         _patchDay,
  wireDayCard:      _wireDayCard,
  renderQsPanel:    _renderQsPanel,
  renderReadiness:  renderReadinessPanel,
  renderSessionRing: _renderSessionRing,
  renderDayReadiness,
  showDay,
  updateProgress,
  updateTotalHours,
  updateHeaderTitle,
  updateMobileExamBanner,
  updateMobileDayNav,
  updateApiIndicator,
  updateSourcesBtn,
  applyTheme,
  toggleTheme,
  applyAccentColor,
  showWelcomeModal,
  closeWelcomeModal,
  toggleTutor,
  buildNavTooltip:  _showNavTooltip,
  escHtml,
});

/** Study session logic: answers, questions, skips, readiness, notes. */
const MnestiSession = Object.freeze({
  startDay:         startDaySession,
  toggleSkip,
  toggleDoneQ,
  saveAnswer,
  saveNotes,
  advanceQuestion,
  skipQuestion,
  resumeSkipped:    resumeSkippedQuestion,
  autoSetStatus:    _autoSetStatus,
  calcReadiness:    calcDayReadiness,
  calculateGlobalReadiness,
  isDayUnlocked,
  isDayNavigable,
  getActiveDays,
  getObjective,
  setObjective,
  getExamInfo,
  saveExamInfo,
  startVoiceDictation,
  pauseVoiceDictation,
  stopVoiceDictation,
  startBrainDump,
  startQuiz,
  startMemoryCards: typeof startMemoryCards !== 'undefined' ? startMemoryCards : undefined,
  nextUnverifiedIdx: _nextUnverifiedIdx,
});

// Expose namespaces globally for console inspection and future test harnesses
window.MnestiTimer   = MnestiTimer;
window.MnestiSync    = MnestiSync;
window.MnestiAI      = MnestiAI;
window.MnestiUI      = MnestiUI;
window.MnestiSession = MnestiSession;
