/**
 * sidepanel.js — UI controller for the side panel.
 * -----------------------------------------------------------------------------
 * No network calls here. Collects input, asks the service worker to run the
 * screen (SCREEN_PARCEL), renders the normalized result, and keeps a short
 * "recent" list in chrome.storage.local.
 * -----------------------------------------------------------------------------
 */

const $ = (id) => document.getElementById(id);

const els = {
  form: $('screen-form'),
  jurisdiction: $('jurisdiction'),
  input: $('query-input'),
  inputLabel: $('input-label'),
  run: $('run'),
  status: $('status'),
  result: $('result'),
  verdict: $('verdict'),
  verdictLabel: $('verdict-label'),
  verdictSrc: $('verdict-src'),
  flags: $('flags'),
  resolveNote: $('resolve-note'),
  candidates: $('candidates'),
  candidateList: $('candidate-list'),
  rApn: $('r-apn'),
  rArea: $('r-area'),
  rZoning: $('r-zoning'),
  rMinLot: $('r-minlot'),
  rSetbacks: $('r-setbacks'),
  rBuildable: $('r-buildable'),
  rFlood: $('r-flood'),
  rSfha: $('r-sfha'),
  rBfe: $('r-bfe'),
  rFault: $('r-fault'),
  rGeologic: $('r-geologic'),
  rSlope: $('r-slope'),
  rSoil: $('r-soil'),
  rWater: $('r-water'),
  rVacant: $('r-vacant'),
  rAirport: $('r-airport'),
  rowAirport: $('row-airport'),
  rLoc: $('r-loc'),
  errbox: $('errbox'),
  errors: $('errors'),
  standardsBox: $('standardsbox'),
  standardsDetail: $('standards-detail'),
  recentWrap: $('recent-wrap'),
  recent: $('recent'),
};

let mode = 'address';
const PLACEHOLDERS = {
  address: 'Enter a San Jose address…',
  apn: 'Enter an APN, e.g. 467-30-001',
};
const LABELS = { address: 'Street address', apn: 'Assessor parcel number' };
const RECENT_KEY = 'recent';
const RECENT_MAX = 6;

/* Mode toggle ----------------------------------------------------------- */
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    mode = btn.dataset.mode;
    els.inputLabel.textContent = LABELS[mode];
    els.input.placeholder = PLACEHOLDERS[mode];
    els.input.focus();
  });
});

/* Submit ---------------------------------------------------------------- */
function submit() {
  const value = els.input.value.trim();
  if (!value) {
    setStatus('Enter an address or APN first.', true);
    els.input.focus();
    return;
  }
  const payload = { jurisdictionId: els.jurisdiction.value };
  payload[mode] = value;
  run(payload);
}

// The run control is a plain button; bind its click directly rather than
// relying on form-submit (more robust across panel reloads).
els.run.addEventListener('click', submit);

// Keep Enter-to-search from the input field.
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submit(); }
});

// Belt-and-suspenders: if the form ever does fire a submit, prevent reload.
els.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

function setStatus(text, isError = false, spinner = false) {
  if (!text) { els.status.hidden = true; els.status.textContent = ''; return; }
  els.status.hidden = false;
  els.status.classList.toggle('is-error', isError);
  els.status.innerHTML = spinner ? '<span class="spinner"></span>' : '';
  els.status.append(document.createTextNode(text));
}

async function run(payload) {
  els.run.disabled = true;
  els.result.hidden = true;
  setStatus('Screening…', false, true);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SCREEN_PARCEL', payload });
    if (!resp?.ok) {
      setStatus(resp?.error || 'Screening failed.', true);
      return;
    }
    setStatus(resp.cached ? 'Cached result' : '');
    render(resp.result);
    await pushRecent(payload, resp.result);
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    els.run.disabled = false;
  }
}

/* Render ---------------------------------------------------------------- */
function render(r) {
  els.result.hidden = false;

  const v = r.verdict || 'unknown';
  els.verdict.className = 'verdict v-' + v;
  els.verdictLabel.textContent = v === 'no-go' ? 'No-Go' : v;
  els.verdictSrc.textContent = '';

  // Flags
  els.flags.innerHTML = '';
  if (r.flags && r.flags.length) {
    els.flags.hidden = false;
    for (const f of r.flags) {
      const li = document.createElement('li');
      li.textContent = f;
      if (/floodway/i.test(f)) li.classList.add('sev-no-go');
      els.flags.appendChild(li);
    }
  } else {
    els.flags.hidden = true;
  }

  // How the parcel was resolved — transparency about any approximation.
  const res = r.parcelResolution || {};
  const METHOD_TEXT = {
    'apn': null, // exact, no need to annotate
    'address-pt': null, // structure-level, exact
    'point': null, // exact point-in-polygon
    'buffer': res.note || 'Resolved to nearest parcel — confirm this is correct.',
    'ambiguous': res.note || 'Address falls between parcels — choose below.',
    'none': null,
  };
  const noteText = METHOD_TEXT[res.method];
  if (noteText) {
    els.resolveNote.hidden = false;
    els.resolveNote.textContent = noteText;
    els.resolveNote.className = 'resolve-note' + (res.method === 'ambiguous' ? ' is-warn' : '');
  } else {
    els.resolveNote.hidden = true;
  }

  // Candidate picker for the ambiguous case.
  els.candidateList.innerHTML = '';
  if (res.method === 'ambiguous' && Array.isArray(res.candidates) && res.candidates.length) {
    els.candidates.hidden = false;
    for (const c of res.candidates) {
      if (!c.apn) continue;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = `APN ${c.apn}`;
      btn.addEventListener('click', () => {
        // Re-screen by the chosen APN — routes through the exact Tier-0 path.
        els.input.value = c.apn;
        // flip mode to APN so the payload is built correctly
        document.querySelectorAll('.seg-btn').forEach((b) =>
          b.classList.toggle('is-active', b.dataset.mode === 'apn'));
        mode = 'apn';
        els.inputLabel.textContent = LABELS.apn;
        run({ jurisdictionId: els.jurisdiction.value, apn: c.apn });
      });
      li.appendChild(btn);
      els.candidateList.appendChild(li);
    }
  } else {
    els.candidates.hidden = true;
  }

  els.rApn.textContent = r.parcel?.apn ?? '—';
  els.rArea.textContent = r.parcel?.areaSqft != null
    ? `${r.parcel.areaSqft.toLocaleString()} sq ft · ${(r.parcel.areaSqft / 43560).toFixed(2)} ac`
    : '—';
  els.rZoning.textContent = r.zoning?.code
    ? `${r.zoning.code}${r.zoning.description ? ' · ' + r.zoning.description : ''}`
    : '—';
  els.rMinLot.textContent = r.buildable?.minLotSqft != null
    ? `${r.buildable.minLotSqft.toLocaleString()} sq ft${r.buildable.belowMinLot === true ? ' · lot below min' : ''}`
    : '—';
  const sb = r.buildable?.setbacks;
  els.rSetbacks.textContent = sb ? `${sb.front} / ${sb.side} / ${sb.rear} ft` : '—';
  els.rBuildable.textContent = r.buildable?.estMaxFloorAreaSqft != null
    ? `≤ ${r.buildable.estMaxFloorAreaSqft.toLocaleString()} sq ft @ ${r.buildable.farThreshold} FAR`
    : r.buildable?.farBasis ?? '—';
  els.rFlood.textContent = r.flood?.zone ?? '—';
  els.rSfha.textContent = r.flood?.sfha === true ? 'Yes' : r.flood?.sfha === false ? 'No' : '—';
  els.rBfe.textContent = r.flood?.bfe != null ? `${r.flood.bfe} ft` : '—';
  els.rFault.textContent = r.seismic?.inFaultZone === true
    ? (r.seismic.hazardType ? `Yes — ${r.seismic.hazardType}` : 'Yes')
    : r.seismic?.inFaultZone === false ? 'No' : '—';
  els.rGeologic.textContent = r.geologic?.inHazardZone === true
    ? (r.geologic.hazardType ? `Yes — ${r.geologic.hazardType}` : 'Yes')
    : r.geologic?.inHazardZone === false ? 'No' : '—';
  els.rSlope.textContent = r.slope?.overThreshold === true
    ? (r.slope.value != null ? `Over 15% — ${r.slope.value}` : 'Over 15%')
    : r.slope?.overThreshold === false ? 'Under 15%' : '—';
  els.rSoil.textContent = r.soil?.type ?? '—';
  els.rWater.textContent = r.water?.provider ?? '—';
  els.rVacant.textContent = r.vacant?.inInventory === true
    ? `Yes${r.vacant.gpDesignation ? ' — ' + r.vacant.gpDesignation : ''}` +
      `${r.vacant.areaAcres != null ? ` · ${r.vacant.areaAcres} ac` : ''}`
    : r.vacant?.inInventory === false ? 'No' : '—';
  // Airport row stays hidden until the (staged) airport layer is active.
  if (r.airport?.inInfluenceArea != null) {
    els.rowAirport.hidden = false;
    els.rAirport.textContent = r.airport.inInfluenceArea === true
      ? (r.airport.heightLimitFt != null
          ? `In AIA · ~${r.airport.heightLimitFt} ft AGL`
          : (r.airport.surface ? `In AIA · ${r.airport.surface}` : 'In AIA'))
      : 'Outside AIA';
  } else {
    els.rowAirport.hidden = true;
  }
  els.rLoc.textContent = r.location
    ? `${r.location.lat.toFixed(5)}, ${r.location.lng.toFixed(5)}`
    : '—';

  // Zoning standards detail (per-district note + optional setback matrix)
  renderStandardsDetail(r);

  // Service notes (errors)
  els.errors.innerHTML = '';
  if (r.errors && r.errors.length) {
    els.errbox.hidden = false;
    for (const e of r.errors) {
      const li = document.createElement('li');
      li.textContent = e;
      els.errors.appendChild(li);
    }
  } else {
    els.errbox.hidden = true;
  }
}

/* Standards detail: shows the per-district note and, when present, the full
   setback matrix (building / abutting-residential / corner / parking / truck /
   loading dock / street frontage). Only populated cells render. */
function renderStandardsDetail(r) {
  const b = r.buildable || {};
  const sb = b.setbacks || {};
  const m = sb.matrix || null;
  const cont = els.standardsDetail;
  cont.innerHTML = '';

  const hasNote = !!b.note;
  const hasMatrix = !!m;
  if (!hasNote && !hasMatrix) { els.standardsBox.hidden = true; return; }
  els.standardsBox.hidden = false;

  if (hasNote) {
    const p = document.createElement('p');
    p.className = 'resolve-note';
    p.style.margin = '8px 0';
    p.textContent = b.note;
    cont.appendChild(p);
  }

  if (hasMatrix) {
    const dl = document.createElement('dl');
    dl.className = 'readout';
    const addRow = (label, val) => {
      if (val == null || val === '') return;
      const row = document.createElement('div');
      row.className = 'row';
      const dt = document.createElement('dt');
      dt.className = 'micro';
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.className = 'mono';
      dd.textContent = val;
      row.append(dt, dd);
      dl.appendChild(row);
    };
    if (sb.front != null) addRow('Building F/S/R', `${sb.front} / ${sb.side} / ${sb.rear} ft`);
    if (m.abuttingResidential != null) addRow('Side/rear abutting residential', `${m.abuttingResidential} ft`);
    if (m.corner?.side != null) addRow('Corner-lot side', `${m.corner.side} ft`);
    if (m.frontMax != null) addRow('Front max (build-to)', `${m.frontMax} ft`);
    if (m.parking?.front != null) addRow('Passenger parking (front)', `${m.parking.front} ft`);
    if (m.truck?.front != null) addRow('Truck/bus parking (front)', `${m.truck.front} ft`);
    if (m.loadingDock?.front != null) {
      const ld = m.loadingDock;
      addRow('Loading dock (front)', `${ld.front} ft${ld.fromResidential != null ? ` · ${ld.fromResidential} ft from residential` : ''}`);
    }
    if (m.streetFrontageFt != null) addRow('Min street frontage', `${m.streetFrontageFt} ft`);
    if (dl.children.length) cont.appendChild(dl);
  }
}

/* Recent ---------------------------------------------------------------- */
async function pushRecent(payload, result) {
  const entry = {
    label: payload.apn || payload.address || '',
    jurisdictionId: payload.jurisdictionId,
    mode: payload.apn ? 'apn' : 'address',
    verdict: result.verdict || 'unknown',
    t: Date.now(),
  };
  let list = await loadRecent();
  list = list.filter((x) => !(x.label === entry.label && x.jurisdictionId === entry.jurisdictionId));
  list.unshift(entry);
  list = list.slice(0, RECENT_MAX);
  await chrome.storage.local.set({ [RECENT_KEY]: list });
  renderRecent(list);
}

async function loadRecent() {
  try {
    const obj = await chrome.storage.local.get(RECENT_KEY);
    return obj[RECENT_KEY] || [];
  } catch { return []; }
}

const VERDICT_COLOR = {
  'go': 'var(--go)', 'caution': 'var(--caution)', 'no-go': 'var(--nogo)', 'unknown': 'var(--unknown)',
};

function renderRecent(list) {
  els.recent.innerHTML = '';
  if (!list.length) { els.recentWrap.hidden = true; return; }
  els.recentWrap.hidden = false;
  for (const x of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const dot = document.createElement('span');
    dot.className = 'r-dot';
    dot.style.background = VERDICT_COLOR[x.verdict] || 'var(--unknown)';
    const text = document.createElement('span');
    text.textContent = x.label;
    btn.append(text, dot);
    btn.addEventListener('click', () => {
      const payload = { jurisdictionId: x.jurisdictionId };
      payload[x.mode] = x.label;
      // reflect in the form
      els.input.value = x.label;
      run(payload);
    });
    li.appendChild(btn);
    els.recent.appendChild(li);
  }
}

/* Pending query (from context menu A / assessor detection B) ------------- */
const PENDING_KEY = 'pendingQuery';
const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // ignore stale stages

function setMode(m) {
  mode = m === 'apn' ? 'apn' : 'address';
  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.mode === mode));
  els.inputLabel.textContent = LABELS[mode];
  els.input.placeholder = PLACEHOLDERS[mode];
}

async function consumePending() {
  try {
    const obj = await chrome.storage.local.get(PENDING_KEY);
    const p = obj[PENDING_KEY];
    if (!p || !p.value) return;
    // Consume once; clear immediately so it can't re-fire.
    await chrome.storage.local.remove(PENDING_KEY);
    if (Date.now() - (p.t || 0) > PENDING_MAX_AGE_MS) return; // too old, drop it
    if (p.jurisdictionId) els.jurisdiction.value = p.jurisdictionId;
    setMode(p.mode);
    els.input.value = p.value;
    run({ jurisdictionId: els.jurisdiction.value, [mode]: p.value });
  } catch { /* ignore */ }
}

// If the panel is already open when A/B stages a query, run it live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PENDING_KEY]?.newValue) consumePending();
});

/* Init ------------------------------------------------------------------ */
loadRecent().then(renderRecent);
consumePending();
els.input.focus();
