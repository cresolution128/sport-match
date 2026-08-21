/* ------------------------------------------------------------------
   MLB live match tracker.

   Replaces the Sportradar LMT Plus widget, which cannot run on a public
   domain without a licensed client key. Data comes from MLB's public
   StatsAPI (no key, no domain check); the markup reuses Sportradar's
   class names so vendor/sr-layout.css + theme.css style it unchanged.
   ------------------------------------------------------------------ */

const GAME_PK      = 824639;   // CWS @ CHC, 18 Aug 2026 — same game the widget showed
const REFRESH_MS   = 15000;    // poll while a game is in progress
const API          = "https://statsapi.mlb.com/api";

/* ---------- tiny DOM helper ---------- */
function el(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    n.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
  }
  return n;
}
const txt = (t) => document.createTextNode(String(t));
function raw(cls, html) { const n = el("div", cls); n.innerHTML = html; return n; }

/* ---------- data ---------- */
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function seasonHitting(teamId, season) {
  try {
    const d = await getJSON(`${API}/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&sportId=1`);
    return ((((d.stats || [])[0] || {}).splits || [])[0] || {}).stat || {};
  } catch (e) { return {}; }
}

/* Team leaders. "strikeouts" exists in several stat groups, so we ask for the
   group explicitly and keep the matching one. */
async function teamLeaders(teamId, season, cats, group) {
  try {
    const g = group ? `&group=${group}` : "";
    const d = await getJSON(`${API}/v1/teams/${teamId}/leaders?leaderCategories=${cats}&season=${season}&leaderGameTypes=R&limit=5${g}`);
    const out = {};
    for (const L of (d.teamLeaders || [])) {
      if (group && L.statGroup !== group) continue;
      out[L.leaderCategory] = L.leaders || [];
    }
    return out;
  } catch (e) { return {}; }
}

/* Last ten completed games, newest first, as W/L letters. */
async function recentForm(teamId, season) {
  try {
    const d = await getJSON(`${API}/v1/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R`);
    const games = [];
    for (const day of (d.dates || [])) for (const g of day.games) {
      if (g.status.abstractGameState !== "Final") continue;
      const home = g.teams.home.team.id === teamId;
      const us = home ? g.teams.home.score : g.teams.away.score;
      const them = home ? g.teams.away.score : g.teams.home.score;
      games.push({ date: day.date, res: us > them ? "W" : us < them ? "L" : "D" });
    }
    games.sort((a, b) => (a.date < b.date ? 1 : -1));
    return games.slice(0, 10).map((g) => g.res);
  } catch (e) { return []; }
}

/* The widget paints from the match feed alone, then fetches each tab's extra
   data when you open that tab. We do the same: loading everything up front
   cost ~13 requests before first paint and left tab switches with nothing to
   wait for (which is why they used to feel different from the real widget). */
async function loadFeed(gamePk) {
  const feed = await getJSON(`${API}/v1.1/game/${gamePk}/feed/live`);
  /* MLB answers 200 with a stub (gamePk 0, no teams) for ids it does not know,
     so an unknown id has to be detected from the payload, not the status. */
  if (!feed || !feed.gameData || !feed.gameData.teams || !feed.gameData.teams.away) {
    throw new Error(`No MLB game with id ${gamePk}`);
  }
  return { feed };
}

/* Per-tab data, fetched once and cached on the data object. Tabs not listed
   here (box score, timeline) render straight from the feed. */
const TAB_DATA = {
  statistics: {
    key: "season",
    async load(feed) {
      const season = feed.gameData.game.season;
      const [away, home] = await Promise.all([
        seasonHitting(feed.gameData.teams.away.id, season),
        seasonHitting(feed.gameData.teams.home.id, season),
      ]);
      return { season: { away, home } };
    },
  },

  headToHead: {
    key: "leaders",
    async load(feed) {
      const season = feed.gameData.game.season;
      const awayId = feed.gameData.teams.away.id, homeId = feed.gameData.teams.home.id;
      const [standings, awayHit, homeHit, awayPit, homePit, awayForm, homeForm] = await Promise.all([
        getJSON(`${API}/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`)
          .catch(() => ({ records: [] })),
        teamLeaders(awayId, season, "homeRuns,battingAverage,runsBattedIn", "hitting"),
        teamLeaders(homeId, season, "homeRuns,battingAverage,runsBattedIn", "hitting"),
        teamLeaders(awayId, season, "earnedRunAverage,wins,strikeouts", "pitching"),
        teamLeaders(homeId, season, "earnedRunAverage,wins,strikeouts", "pitching"),
        recentForm(awayId, season),
        recentForm(homeId, season),
      ]);
      return {
        standings,
        leaders: { away: { ...awayHit, ...awayPit }, home: { ...homeHit, ...homePit } },
        form: { away: awayForm, home: homeForm },
      };
    },
  },

  standings: {
    key: "byLeague",
    async load(feed) {
      const season = feed.gameData.game.season;
      const [standings, byLeague, teams] = await Promise.all([
        getJSON(`${API}/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`)
          .catch(() => ({ records: [] })),
        getJSON(`${API}/v1/standings?leagueId=103,104&season=${season}&standingsTypes=byLeague`)
          .catch(() => ({ records: [] })),
        /* standings rows carry only team ids, so we need the directory for
           abbreviations and full names */
        getJSON(`${API}/v1/teams?sportId=1&season=${season}`).catch(() => ({ teams: [] })),
      ]);
      const teamById = {};
      for (const t of (teams.teams || [])) teamById[t.id] = t;
      return { standings, byLeague, teamById };
    },
  },
};

/* Resolves a tab's data, at most once per tab. */
function ensureTabData(data, tab) {
  const spec = TAB_DATA[tab];
  if (!spec || data[spec.key]) return null;
  if (!data._pending) data._pending = {};
  if (!data._pending[tab]) {
    data._pending[tab] = spec.load(data.feed)
      .then((extra) => { Object.assign(data, extra); })
      .catch(() => { data[spec.key] = data[spec.key] || {}; });
  }
  return data._pending[tab];
}

const tabReady = (data, tab) => {
  const spec = TAB_DATA[tab];
  return !spec || Boolean(data[spec.key]);
};

/* ---------- responsive classes ----------
   The widget re-implements CSS container queries in JS: each component carries
   a data-responsive map of width ranges -> classes. We reproduce it with a
   ResizeObserver so the vendored stylesheets get the modifiers they expect. */
const RESPONSIVE = {
  "lmt-plus": {"small":{"width":"- 310","classes":"sr-lmt-plus--small"},"large":{"width":"420 -","classes":"sr-lmt-plus--large"},"largeDouble":{"width":"- 560","classes":"sr-lmt-plus--double-single"}},
  "lmt-plus-tabs": {"small":{"width":"- 560","classes":"sr-lmt-plus-tabs-small"}},
  "lmt": {"s0":{"width":"-320","classes":"sr-lmt--xsmall"},"s1":{"width":"-420","classes":"sr-lmt--small"},"s1.5":{"width":"420-","classes":"sr-lmt--notsmall"},"s2":{"width":"-640","classes":"sr-lmt--medium"},"s3":{"width":"720-","classes":"sr-lmt--large"},"rm":{"width":"-360","classes":"sr-lmt-rmcrest"},"state1":{"width":"568-","classes":"sr-lmt--state-large"},"state2":{"width":"400-568","classes":"sr-lmt--state-medium"},"state3":{"width":"-400","classes":"sr-lmt--state-small"}},
  "lmt-plus-3-statistics": {"xsmall":{"width":" - 320","classes":"sr-lmt-plus-3-statistics--xsmall sr-lmt-plus-0-hor-chart--small"},"small":{"width":" - 560","classes":"sr-lmt-plus-3-statistics--small"},"large":{"width":"560 -","classes":"sr-lmt-plus-3-statistics--large"}},
  "lmt-plus-3-box": {"small":{"width":"- 560","classes":"sr-lmt-plus-3-box--small"},"large":{"width":"560 -","classes":"sr-lmt-plus-3-box--large"}},
  "lmt-plus-3-h2h": {"xsmall":{"width":"- 320","classes":"sr-lmt-plus-3-h2h--xsmall sr-lmt-0-ms-league-position-form--xsmall"},"small":{"width":"- 560","classes":"sr-lmt-plus-3-h2h--small sr-lmt-plus-3-h2h-leaders--small sr-lmt-0-ms-league-position-form--small sr-lmt-wdl--small"},"large":{"width":"560 -","classes":"sr-lmt-plus-3-h2h--large sr-lmt-0-ms-league-position-form--small sr-lmt-wdl--small"}},
  "livetable": {"xxsmall":{"width":"- 320","classes":"sr-lmt-plus-livetable-xxsmall"},"xsmall":{"width":"- 360","classes":"sr-lmt-plus-livetable-xsmall"},"small":{"width":" - 480","classes":"sr-lmt-plus-livetable-small"},"medium":{"width":" - 540","classes":"sr-lmt-plus-livetable-medium"},"large":{"width":" - 680","classes":"sr-lmt-plus-livetable-large"}},
};

function parseRange(spec) {
  const s = String(spec).replace(/\s+/g, "");
  const m = s.match(/^(\d*)-(\d*)$/);
  if (!m) return { min: 0, max: Infinity };
  return { min: m[1] ? Number(m[1]) : 0, max: m[2] ? Number(m[2]) : Infinity };
}

const RESIZE_OBS = new ResizeObserver((entries) => {
  for (const e of entries) applyResponsive(e.target, e.contentRect.width);
});

function applyResponsive(node, width) {
  const map = RESPONSIVE[node.dataset.responsiveKey];
  if (!map) return;
  for (const key of Object.keys(map)) {
    const { min, max } = parseRange(map[key].width);
    const on = width >= min && width <= max;
    for (const c of map[key].classes.split(/\s+/).filter(Boolean)) node.classList.toggle(c, on);
  }
}

/* Marks a node as responsive and wires the observer. */
function responsive(node, key) {
  node.dataset.responsiveKey = key;
  requestAnimationFrame(() => {
    applyResponsive(node, node.getBoundingClientRect().width);
    RESIZE_OBS.observe(node);
  });
  return node;
}

/* The widget wraps every panel in a loader container. */
/* The widget's three-dot spinner. Colour comes from the theme token. */
function loaderOverlay() {
  const dots = el("div", "sr-loader-dots srt-base-1-primary");
  for (let i = 0; i < 3; i++) dots.appendChild(el("div", "sr-loader-dots__dot"));
  return el("div", "sr-loader__overlay", dots);
}

function panelShell(componentClass, key, ...kids) {
  const root = el("div", `sr-bb ${componentClass} sr-ltr`);
  if (key) responsive(root, key);
  root.appendChild(el("div", "sr-loader__container", loaderOverlay(), ...kids));
  return root;
}

/* An empty panel showing only the spinner, while a tab's data is in flight.
   srm-loading is the widget's own hook: it reveals the overlay and blurs
   whatever is behind it. */
function loadingPanel(title) {
  const root = el("div", "sr-bb sr-lmt-plus-3-statistics sr-ltr");
  const container = el("div", "sr-loader__container srm-loading",
    loaderOverlay(),
    el("div", "sr-lmt-plus-3-statistics__container srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper", sliderTitle(title, 0, 1))));
  root.appendChild(container);
  return root;
}

/* The widget's scroll wrappers. Panels get no usable height without them. */
function scrollbars(extraClass, ...kids) {
  const outer = el("div");
  outer.style.cssText = "height:100%;max-height:inherit;margin-right:-15px;z-index:0;overflow:hidden scroll;";
  const inner = el("div", "sr-scrollbars__inner");
  inner.style.cssText = "direction:ltr;display:inline-block;width:100%;";
  for (const k of kids) inner.appendChild(k);
  outer.appendChild(inner);
  return el("div", "sr-scrollbars__container" + (extraClass ? " " + extraClass : ""), outer);
}

/* slider__wrapper > slides > slide, the container every panel body sits in. */
function sliderBody(base, ...kids) {
  const slide = el("div", `${base}__slide sr-slider-flex__slide srm-slide-0`);
  slide.style.transform = "translate3d(0%, 0px, 0px)";
  for (const k of kids) slide.appendChild(k);
  return el("div", `sr-lmt-plus-slider__slides ${base}__slider sr-slider-flex__slider`, slide);
}

/* ---------- tab bar ---------- */
const TAB_ICONS = {
  statistics: '<path d="M4.636 9.912H1.727A.728.728 0 0 0 1 10.64v6.631c0 .403.326.729.727.729h2.91a.728.728 0 0 0 .727-.729v-6.63a.728.728 0 0 0-.728-.73Zm-.727 6.63H2.455V11.37h1.454v5.174ZM10.455 0h-2.91a.728.728 0 0 0-.727.729V17.27c0 .403.326.729.727.729h2.91a.728.728 0 0 0 .727-.729V.73A.728.728 0 0 0 10.455 0Zm-.728 16.543H8.273V1.457h1.454v15.086Zm6.546-11.675h-2.91a.728.728 0 0 0-.727.728v11.675c0 .403.326.729.728.729h2.909a.728.728 0 0 0 .727-.729V5.596a.728.728 0 0 0-.727-.728Zm-.728 11.675h-1.454V6.325h1.454v10.218Z" fill-rule="nonzero"/>',
  boxScore:   '<path d="M17.357 0H5.786a.634.634 0 0 0-.643.625v2.5c0 .345.288.625.643.625h11.571c.355 0 .643-.28.643-.625v-2.5A.634.634 0 0 0 17.357 0Zm-.643 2.5H6.43V1.25h10.285V2.5Zm.643 3.125H5.786a.634.634 0 0 0-.643.625v2.5c0 .345.288.625.643.625h11.571c.355 0 .643-.28.643-.625v-2.5a.634.634 0 0 0-.643-.625Zm-.643 2.5H6.43v-1.25h10.285v1.25Zm.643 3.125H5.786a.634.634 0 0 0-.643.625v2.5c0 .345.288.625.643.625h11.571c.355 0 .643-.28.643-.625v-2.5a.634.634 0 0 0-.643-.625Zm-.643 2.5H6.43V12.5h10.285v1.25ZM1.93 0C.863 0 0 .84 0 1.875 0 2.911.863 3.75 1.929 3.75c1.065 0 1.928-.84 1.928-1.875C3.857.839 2.994 0 1.93 0Zm0 2.5a.634.634 0 0 1-.643-.625c0-.345.288-.625.643-.625.355 0 .642.28.642.625a.634.634 0 0 1-.642.625Zm0 8.75C.863 11.25 0 12.09 0 13.125 0 14.161.863 15 1.929 15c1.065 0 1.928-.84 1.928-1.875 0-1.036-.863-1.875-1.928-1.875Zm0 2.5a.634.634 0 0 1-.643-.625c0-.345.288-.625.643-.625.355 0 .642.28.642.625a.634.634 0 0 1-.642.625Zm0-8.125C.863 5.625 0 6.465 0 7.5c0 1.036.863 1.875 1.929 1.875 1.065 0 1.928-.84 1.928-1.875 0-1.036-.863-1.875-1.928-1.875Zm0 2.5a.634.634 0 0 1-.643-.625c0-.345.288-.625.643-.625.355 0 .642.28.642.625a.634.634 0 0 1-.642.625Z" fill-rule="nonzero"/>',
  headToHead: '<path d="M18 11.386V16h-1.126v-4.614a.36.36 0 0 0-.104-.281l-2.403-1.21a1.252 1.252 0 0 1-.785-.833l-.002-.008a1.225 1.225 0 0 1 .501-1.023c.635-.587.635-2.113.635-2.933 0-.754-.244-2.02-1.873-2.02-1.63 0-1.879 1.266-1.879 2.02 0 .82 0 2.346.633 2.933.329.244.516.624.502 1.023-.103.385-.398.7-.787.84L9.3 11.078a.575.575 0 0 1-.59-.001l.003.001-2.048-1.2a1.217 1.217 0 0 1-.759-.816l-.002-.008a1.23 1.23 0 0 1 .509-1.022c.633-.587.633-2.113.633-2.933-.006-.755-.249-2.02-1.877-2.02-1.63 0-1.88 1.265-1.88 2.019 0 .82 0 2.347.634 2.933.304.237.47.602.443.976a1.243 1.243 0 0 1-.708.874l-2.45 1.235a.427.427 0 0 0-.082.27V16H0v-4.614a1.377 1.377 0 0 1 .663-1.212L3.11 8.942c.045-.026.078-.048.102-.065-.018-.02-.039-.043-.072-.073-.9-.834-.975-2.35-.975-3.706a2.588 2.588 0 0 1-.018-.308C2.147 3.25 3.452 2 5.062 2c.037 0 .075 0 .112.002h-.005L5.27 2c1.608 0 2.912 1.248 2.912 2.788 0 .109-.006.217-.019.323l.001-.013c0 1.355-.075 2.871-.976 3.706-.032.03-.059.056-.08.08l.113.059L9 9.985l1.747-1.026c.06-.03.107-.056.144-.076a2.404 2.404 0 0 0-.08-.08c-.9-.834-.976-2.35-.976-3.705a2.588 2.588 0 0 1-.018-.308c0-1.54 1.305-2.79 2.915-2.79.037 0 .074 0 .112.002h-.006L12.94 2c1.61 0 2.914 1.249 2.914 2.789 0 .109-.006.216-.02.322l.002-.013c0 1.355-.076 2.871-.977 3.706a2.4 2.4 0 0 0-.079.078l-.001.002.112.059 2.421 1.22c.441.26.703.727.687 1.223Zm-15.75 2.46h5.625V12.77H2.251v1.076Zm0 2.154h5.625v-1.077H2.251V16Zm7.875-2.154h5.624V12.77h-5.624v1.076Zm0 2.154h5.624v-1.077h-5.624V16Z" fill-rule="nonzero"/>',
  standings:  '<path d="M17.357 0H5.786a.634.634 0 0 0-.643.625v2.5c0 .345.288.625.643.625h11.571c.355 0 .643-.28.643-.625v-2.5A.634.634 0 0 0 17.357 0Zm.643 5.625H5.786a.634.634 0 0 0-.643.625v2.5c0 .345.288.625.643.625h11.571c.355 0 .643-.28.643-.625v-2.5a.634.634 0 0 0-.643-.625Zm0 5.625H5.786a.634.634 0 0 0-.643.625v2.5c0 .345.288.625.643.625h11.571c.355 0 .643-.28.643-.625v-2.5a.634.634 0 0 0-.643-.625ZM1.93 0C.863 0 0 .84 0 1.875 0 2.911.863 3.75 1.929 3.75c1.065 0 1.928-.84 1.928-1.875C3.857.839 2.994 0 1.93 0Zm0 5.625C.863 5.625 0 6.465 0 7.5c0 1.036.863 1.875 1.929 1.875 1.065 0 1.928-.84 1.928-1.875 0-1.036-.863-1.875-1.928-1.875Zm0 5.625C.863 11.25 0 12.09 0 13.125 0 14.161.863 15 1.929 15c1.065 0 1.928-.84 1.928-1.875 0-1.036-.863-1.875-1.928-1.875Z" fill-rule="nonzero"/>',
  timeline:   '<path d="M9 0a9 9 0 1 0 0 18A9 9 0 0 0 9 0Zm0 16.364A7.364 7.364 0 1 1 9 1.636a7.364 7.364 0 0 1 0 14.728ZM9.818 4.09H8.182v5.25l4.09 2.455.819-1.343-3.273-1.94V4.09Z" fill-rule="nonzero"/>',
};
const TAB_LABELS = {
  statistics: "Statistics", boxScore: "Box Score", headToHead: "Head to Head",
  standings: "Standings", timeline: "Timeline",
};

function renderTabs(active, onSelect) {
  const flex = el("div", "sr-tabs__flexcontainer");
  for (const key of Object.keys(TAB_LABELS)) {
    const isActive = key === active;
    const btn = el("button",
      "sr-tabs-tab__wrapper srct-tab srm-is-fullwidth" +
      (isActive ? " srt-base-1-primary srct-tab--active" : ""));
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.dataset.testTab = key;

    const content = el("span",
      "sr-tabs-tab__content srct-tab__content srm-is-start" + (isActive ? "" : " srt-text-secondary"));
    content.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" class="sr-tabs-tab__icon srct-tab__icon">${TAB_ICONS[key]}</svg>` +
      `<div class="sr-spacer srm-is-horizontal srm-is-xs"></div>` +
      `<span class="sr-tabs-tab__label srm-is-sentencecased srct-tab__text-label"><span>${TAB_LABELS[key]}</span></span>`;

    const ind = el("span",
      "sr-tabs-tab__indicator srct-tab__indicator" + (isActive ? " srct-tab__indicator--active srm-is-active" : ""),
      el("span", "sr-tabs-tab__indicator__content srct-tab__indicator-content"));

    btn.appendChild(content);
    btn.appendChild(ind);
    btn.addEventListener("click", () => onSelect(key));
    flex.appendChild(btn);
  }
  return el("div", "sr-lmt-plus__segment-tabs",
    el("div", "sr-bb sr-lmt-plus-tabs sr-ltr",
      el("div", "sr-lmt-plus-tabs__wrapper srt-base-1",
        el("div", "sr-tabs srct-tabs srm-is-fullwidth srt-base-1",
          el("div", "sr-tabs__scrollable", flex)))));
}

/* Paging behaviour for the widget's flex sliders: auto-advance plus pointer
   drag. The widget does both; without it the venue box is a dead panel. */
function attachSlider(track, slides, autoMs) {
  if (slides.length < 2) return;
  let idx = 0, timer = 0, dragging = false, startX = 0, dx = 0;

  const place = (offsetPx) => {
    const w = track.getBoundingClientRect().width || 1;
    const pct = (-idx * 100) + (offsetPx / w) * 100;
    for (const n of slides) {
      n.style.transition = dragging ? "none" : "transform .45s";
      n.style.transform = `translate3d(${pct}%, 0px, 0px)`;
    }
  };
  const go = (n) => { idx = (n + slides.length) % slides.length; place(0); };
  const restart = () => {
    clearInterval(timer);
    if (autoMs) timer = setInterval(() => go(idx + 1), autoMs);
  };

  track.style.cursor = "grab";
  track.addEventListener("pointerdown", (e) => {
    dragging = true; startX = e.clientX; dx = 0;
    track.style.cursor = "grabbing";
    track.setPointerCapture(e.pointerId);
    clearInterval(timer);
  });
  track.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    place(dx);
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    track.style.cursor = "grab";
    const threshold = (track.getBoundingClientRect().width || 1) * 0.2;
    if (dx <= -threshold) go(idx + 1);
    else if (dx >= threshold) go(idx - 1);
    else place(0);
    restart();
  };
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);
  track.addEventListener("pointerleave", release);

  SLIDER_TIMERS.push(() => clearInterval(timer));
  place(0);
  restart();
}

/* ---------- header / scoreboard ---------- */
const CLOCK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="sr-lmt-0-minfos-header__icon srm-is-default"><path d="M13.29 9.45a1.55 1.55 0 0 0-2.53 1.79l2.95 4.16a2.29 2.29 0 0 0 3.92 2.03h3.32c.86 0 1.55-.69 1.55-1.55 0-.86-.69-1.55-1.55-1.55h-3.32a2.26 2.26 0 0 0-1.39-.71l-2.95-4.17zM26.89 10.94c.41.88.71 1.83.89 2.81.06.32.35.53.67.51l2.89-.27c.17-.02.33-.1.44-.24a.6.6 0 0 0 .12-.48 15.9 15.9 0 0 0-1.57-4.72.62.62 0 0 0-.42-.32.65.65 0 0 0-.52.12l-2.32 1.84a.62.62 0 0 0-.18.75z"/><path d="M24.73 24.79a.62.62 0 0 0-.76.05 11.86 11.86 0 0 1-6.87 2.96v-1.4a1.03 1.03 0 1 0-2.06 0v1.39A11.92 11.92 0 0 1 4.19 16.95h1.39a1.03 1.03 0 1 0 0-2.06h-1.4A11.93 11.93 0 0 1 14 4.19c.3-.05.51-.31.51-.61V.64a.64.64 0 0 0-.21-.47.65.65 0 0 0-.5-.15 16.06 16.06 0 1 0 13.45 27.4c.13-.13.2-.31.19-.5a.6.6 0 0 0-.27-.46l-2.44-1.67zM18.13 4.19c.41.07.81.16 1.2.27.3.08.61-.06.74-.35l1.18-2.66a.65.65 0 0 0 0-.51.64.64 0 0 0-.38-.34C20.05.34 19.2.14 18.34.02a.61.61 0 0 0-.5.15.6.6 0 0 0-.21.47v2.93a.6.6 0 0 0 .5.62zM24.52 7.54c.22.23.58.25.83.05l2.28-1.81a.6.6 0 0 0 .23-.44.62.62 0 0 0-.17-.47 15.6 15.6 0 0 0-2.75-2.31.63.63 0 0 0-.52-.08.6.6 0 0 0-.39.35l-1.2 2.67a.62.62 0 0 0 .2.75c.54.4 1.03.83 1.49 1.29zM31.82 17.3a.67.67 0 0 0-.5-.19l-2.95.27a.64.64 0 0 0-.56.52 11.63 11.63 0 0 1-1.28 3.69.63.63 0 0 0 .19.81l2.4 1.64c.14.1.32.13.49.09a.64.64 0 0 0 .4-.3 16.13 16.13 0 0 0 1.98-6.03.59.59 0 0 0-.17-.5z"/></svg>';

const SLIDER_TIMERS = [];

const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function titleString(s, extra) { return el("div", "sr-lmt-0-mis-title__t-string" + (extra || ""), s); }
function titleSep() { return el("div", "sr-lmt-0-mis-title__t-separator", "|"); }

function stateText(feed) {
  const st = feed.gameData.status;
  const ls = feed.liveData.linescore;
  if (st.abstractGameState === "Final") return "Match ended";
  if (st.abstractGameState === "Live")
    return `${ls.inningState || ""} ${ls.currentInningOrdinal || ""}`.trim() || "In progress";
  return st.detailedState || "Scheduled";
}

function renderHeader(feed) {
  const g = feed.gameData, ls = feed.liveData.linescore;
  const away = g.teams.away, home = g.teams.home;
  const aR = (ls.teams.away.runs ?? 0), hR = (ls.teams.home.runs ?? 0);
  const isFinal = g.status.abstractGameState === "Final";

  /* subtitle: "Winner: Cubs | 3 : 4 |" */
  const sub = el("div", "sr-lmt-0-mis-title__wrapper");
  if (isFinal && aR !== hR) {
    const winner = aR > hR ? away : home;
    const lbl = el("div", "sr-lmt-0-mis-title__t-string srm-has-ellipsis");
    lbl.innerHTML = "<span><span>Winner</span>:</span>";
    sub.appendChild(lbl);
    sub.appendChild(el("div", "sr-lmt-0-mis-title__t-space"));
    sub.appendChild(el("div", "sr-lmt-0-mis-title__t-string srm-is-bold srm-has-ellipsis", winner.teamName || winner.name));
    sub.appendChild(titleSep());
  }
  const scoreStr = el("div", "sr-lmt-0-mis-title__t-string srm-has-ellipsis");
  scoreStr.innerHTML = `${aR}&nbsp;:&nbsp;${hR}`;
  sub.appendChild(scoreStr);
  sub.appendChild(titleSep());

  const header = el("div", "sr-lmt-3-header__space sr-lmt-0-matchInfosCompHolder__header",
    el("div", "sr-lmt-0-minfos-header__wrapper",
      raw("sr-lmt-0-minfos-header__icon-wrapper", CLOCK_ICON),
      el("div", "sr-lmt-0-minfos-header__content srm-is-transparent",
        el("div", "sr-lmt-0-minfos-header__c-text srm-is-title srm-is-uppercase", stateText(feed)),
        el("div", "sr-lmt-0-minfos-header__c-text srt-text-secondary srm-is-subtitle srm-is-uppercase", sub))));

  /* score box */
  const col = (score, abbr) => el("div", "sr-lmt-0-ms-result__col",
    el("div", "sr-lmt-0-ms-result__result sr-lmt-0-minfos-countdown__box", score),
    el("div", "sr-lmt-0-ms-result__team", abbr));

  const scoreTitle = el("div", "sr-lmt-0-ms-result__title srm-light srm-is-uppercase",
    el("span", null, isFinal ? "Final Score" : "Score"));

  const info = el("div", "sr-lmt-0-matchInfosCompHolder__info-holder",
    el("div", "sr-lmt-0-minfos-countdown__wrapper",
      el("div", "sr-lmt-0-minfos-countdown__content sr-lmt-3-state__bg srt-elevation-2",
        el("div", "sr-lmt-0-ms-result__wrapper",
          scoreTitle,
          el("div", "sr-lmt-0-ms-result__row srm-light",
            col(aR, away.abbreviation),
            el("div", "sr-lmt-0-ms-result__col", el("div", "sr-lmt-0-ms-result__result-seperator", ":")),
            col(hR, home.abbreviation))))));

  /* venue / competition slider */
  const d = new Date(g.datetime.dateTime);
  const seasonType = g.game.type === "R" ? "Regular Season" : (g.game.type === "P" ? "Postseason" : "Spring Training");
  const compRow = el("div", "sr-lmt-0-mis-title__wrapper",
    el("div", "sr-lmt-0-mis-title__t-string srm-is-bold srm-has-ellipsis", "MLB"),
    titleSep(),
    titleString(seasonType),
    titleSep(),
    el("div", "sr-lmt-0-mis-title__t-string srm-is-bold", el("span", null, WEEKDAYS[d.getDay()])),
    el("div", "sr-lmt-0-mis-title__t-string", el("span", null, `, ${d.getDate()} ${MONTHS[d.getMonth()]}`)),
    titleSep());

  const venueRow = el("div", "sr-lmt-0-mis-title__wrapper",
    el("div", "sr-lmt-0-mis-title__t-string srm-is-bold srm-has-ellipsis", g.venue.name),
    titleSep(),
    titleString((g.venue.location && [g.venue.location.city, g.venue.location.stateAbbrev].filter(Boolean).join(", ")) || ""),
    titleSep());

  /* The venue box pages through four single-row slides, matching the widget at
     this column width: competition/date, venue, ground facts, distances.
     (The widget also carries wider combined variants tagged srm-hide-small;
     they are hidden at 400px, so we do not build them.) */
  const fi = g.venue.fieldInfo || {};
  const fieldCol = (title, value) => el("div", "sr-lmt-0-mis-field__col",
    el("div", "sr-lmt-0-mis-field__title sr-lmt-0-mis-field__t-font srm-is-uppercase",
      el("span", null, title)),
    el("div", "sr-lmt-0-mis-field__data sr-lmt-0-mis-field__t-font srm-is-uppercase srm-cap", value));

  const rowSlide = (row) => el("div", "sr-lmt-0-mis-venue__slide",
    el("div", "sr-lmt-0-matchinfoslider__main-title", row));
  const factSlide = (cols) => el("div", "sr-lmt-0-mis-field__content", ...cols);

  const groundCols = [];
  if (fi.turfType) groundCols.push(fieldCol("Surface", fi.turfType));
  if (fi.capacity) groundCols.push(fieldCol("Capacity", fi.capacity));

  const distCols = [];
  if (fi.leftLine) distCols.push(fieldCol("LF", `${fi.leftLine} ft`));
  if (fi.center) distCols.push(fieldCol("CF", `${fi.center} ft`));
  if (fi.rightLine) distCols.push(fieldCol("RF", `${fi.rightLine} ft`));

  const inners = [rowSlide(compRow), rowSlide(venueRow)];
  if (groundCols.length) inners.push(factSlide(groundCols));
  if (distCols.length) inners.push(factSlide(distCols));

  const slideNodes = inners.map((inner) =>
    el("div", "sr-slider-flex__slide sr-lmt-0-mis-slide__slide srm-show-small", inner));

  const sliderTrack = el("div", "sr-slider-flex__slider sr-lmt-0-matchinfoslider__slider", ...slideNodes);
  attachSlider(sliderTrack, slideNodes, 6000);

  const slider = el("div", "sr-lmt-0-matchInfosCompHolder__slider-holder",
    el("div", "sr-lmt-0-matchinfoslider__wrapper srt-elevation-2 sr-lmt-3-state__bg", sliderTrack));

  return el("div", "sr-lmt-3-state",
    el("div", "sr-lmt-3-header__space sr-lmt-3-header__shadow srt-elevation-2"),
    el("div", "sr-lmt-3-header__space sr-lmt-3-header__wrapper sr-lmt-3-state__bg"),
    el("div", "sr-lmt-0-matchInfosCompHolder__wrapper", header, info, slider));
}

/* ---------- statistics tab ---------- */
function horChart(label, aVal, hVal, aSub, hSub, aNum, hNum) {
  /* aVal/hVal are what the user sees; aNum/hNum override the bar weighting
     when the displayed value is not a plain number (e.g. ".239"). */
  const a = Number(aNum ?? aVal) || 0, h = Number(hNum ?? hVal) || 0;
  const total = a + h;
  /* Sportradar draws two stacks that slide in from the centre; the share of
     the bar each side owns is its share of the combined total. */
  const aPct = total ? (a / total) * 100 : 50;
  const hPct = total ? (h / total) * 100 : 50;

  const top = el("div", "sr-lmt-plus-0-hor-chart__top",
    el("div", "sr-lmt-plus-0-hor-chart__top-team srm-left",
      el("div", "sr-lmt-plus-0-hor-chart__display-value srm-left srm-is-bold srm-font-size-medium srm-top",
        el("div", null, aVal))),
    el("div", "sr-lmt-plus-0-hor-chart__title srt-text-secondary srm-is-uppercase",
      el("span", null, label)),
    el("div", "sr-lmt-plus-0-hor-chart__top-team srm-right",
      el("div", "sr-lmt-plus-0-hor-chart__display-value srm-right srm-is-bold srm-font-size-medium srm-top",
        el("div", null, hVal))));

  const wrap = el("div", "sr-dual-bar-chart__chart-wrapper");
  wrap.style.height = "3px";
  wrap.style.width = "100%";
  const right = el("div", "sr-dual-bar-chart__stack sr-dual-bar-chart__stack-right srt-home-1");
  right.style.transform = `translateX(-${(100 - hPct).toFixed(0)}%)`;
  const left = el("div", "sr-dual-bar-chart__stack sr-dual-bar-chart__stack-left srt-away-1");
  left.style.transform = `translateX(${(100 - aPct).toFixed(0)}%)`;
  wrap.appendChild(right);
  wrap.appendChild(left);

  const middle = el("div", "sr-lmt-plus-0-hor-chart__middle",
    el("div", "sr-bb sr-dual-bar-chart",
      el("div", "sr-dual-bar-chart__chart-container",
        el("div", "sr-dual-bar-chart__chart-content", wrap))));

  const kids = [top, middle];
  if (aSub !== undefined || hSub !== undefined) {
    kids.push(el("div", "sr-lmt-plus-0-hor-chart__bottom",
      el("div", "sr-lmt-plus-0-hor-chart__bottom-team srm-left",
        el("div", "sr-lmt-plus-0-hor-chart__display-value srt-text-secondary srm-left srm-font-size-small srm-bottom", aSub ?? "")),
      el("div", "sr-lmt-plus-0-hor-chart__bottom-team srm-right",
        el("div", "sr-lmt-plus-0-hor-chart__display-value srt-text-secondary srm-right srm-font-size-small srm-bottom", hSub ?? ""))));
  }
  return el("div", "sr-lmt-plus-0-hor-chart__wrapper", ...kids);
}

function sliderTitle(title, page, pages, onPrev, onNext) {
  const arrow = (dir, enabled, cb) => {
    const b = el("button",
      `sr-slider-button6 srt-fill-neutral-2 srm-dir-${dir} ` +
      (enabled ? "srt-fill-text-secondary" : "srt-fill-text-disabled") +
      " sr-lmt-plus-slider-title__button");
    b.type = "button";
    b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="sr-slider-button6__icon sr-lmt-plus-slider-title__button-icon"><path class="st0" d="M7 24c-.2 0-.4-.1-.6-.2l-1.2-1.2c-.1-.2-.2-.4-.2-.6 0-.2.1-.4.2-.6l9.5-9.5-9.5-9.4C5.1 2.4 5 2.2 5 2s.1-.4.2-.6L6.4.2c.2-.1.4-.2.6-.2.2 0 .4.1.6.2l11.2 11.2c.1.1.2.4.2.6 0 .2-.1.4-.2.6L7.6 23.8c-.2.1-.4.2-.6.2z"/></svg>';
    if (enabled) b.addEventListener("click", cb);
    return el("div", "sr-lmt-plus-slider-title__button-wrapper", b);
  };
  const kids = [el("div", "sr-lmt-plus-slider-title__title", el("span", null, title))];
  if (pages > 1) {
    kids.push(el("div", "sr-lmt-plus-slider-title__buttons",
      arrow("left", page > 0, onPrev),
      el("div", "sr-lmt-plus-slider-title__pagination",
        el("span", null, page + 1), el("span", null, "/"), el("span", null, pages)),
      arrow("right", page < pages - 1, onNext)));
  }
  return el("div", "sr-lmt-plus-slider-title__wrap srm-is-uppercase", ...kids);
}

/* The widget's second statistics slide is exactly four rows, every one of them
   a batting figure, with the team's season total printed underneath. The
   labels read oddly ("walks issued", "strikeouts thrown") but they are what
   happened to this team's batters - verified against the rendered widget. */
const STAT_ROWS = [
  { label: "Walks issued",      key: "baseOnBalls" },
  { label: "Stolen bases",      key: "stolenBases" },
  { label: "Strikeouts thrown", key: "strikeOuts" },
  { label: "Total bases",       key: "totalBases" },
];

/* W-L (or saves) for a decision pitcher, from whichever side he played for. */
function decisionRecord(feed, personId, type) {
  for (const side of ["away", "home"]) {
    const p = feed.liveData.boxscore.teams[side].players[`ID${personId}`];
    if (!p || !p.seasonStats || !p.seasonStats.pitching) continue;
    const st = p.seasonStats.pitching;
    return type === "save" ? String(st.saves ?? "-") : `${st.wins} - ${st.losses}`;
  }
  return "-";
}

function renderStatistics(feed, state, rerender, seasonStats) {
  const bs = feed.liveData.boxscore;
  const aB = bs.teams.away.teamStats.batting;
  const hB = bs.teams.home.teamStats.batting;

  const sub = (v) => (v === undefined || v === null ? "" : `(${v})`);
  const rows = STAT_ROWS.map(({ label, key }) =>
    horChart(label, aB[key] ?? 0, hB[key] ?? 0,
      sub(seasonStats.away[key]), sub(seasonStats.home[key])));

  /* pitching decisions, the WIN / LOSS / SAVE strip above the bars */
  const dec = feed.liveData.decisions || {};
  const records = [];
  for (const [type, person] of [["win", dec.winner], ["loss", dec.loser], ["save", dec.save]]) {
    if (!person) continue;
    records.push(el("div", "sr-lmt-plus-3-statistics__record",
      el("div", "sr-lmt-plus-3-statistics__record-top",
        el("div", "sr-lmt-plus-3-statistics__crest-divider-2"),
        el("span", "sr-lmt-plus-3-statistics__record-type srm-is-uppercase", type)),
      el("div", "sr-lmt-plus-3-statistics__record-bottom",
        el("span", "sr-lmt-plus-3-statistics__player-name", person.fullName),
        el("div", "sr-lmt-plus-3-statistics__record-value",
          el("span", "srt-test-secondary", decisionRecord(feed, person.id, type))))));
  }

  /* The widget pages this panel: slide 0 is the decision pitchers (a narrow
     248px column), slide 1 is the stat comparison bars. */
  const page = state.statsPage || 0;
  const slideWrap = page === 0 && records.length
    ? el("div", "sr-lmt-plus-3-statistics__slide-wrapper sr-lmt-plus-3-statistics__slide-wrapper-players", ...records)
    : el("div", "sr-lmt-plus-3-statistics__slide-wrapper", ...rows);
  const pages = records.length ? 2 : 1;

  return panelShell("sr-lmt-plus-3-statistics", "lmt-plus-3-statistics",
    el("div", "sr-lmt-plus-3-statistics__container srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper",
        sliderTitle("Statistics", page, pages,
          () => { state.statsPage = 0; rerender(); },
          () => { state.statsPage = 1; rerender(); }),
        sliderBody("sr-lmt-plus-3-statistics", slideWrap))));
}

/* ---------- box score tab ---------- */
const BAT_COLS   = [["AB","atBats"],["R","runs"],["H","hits"],["RBI","rbi"],["BA","avg"]];
const PITCH_COLS = [["IP","inningsPitched"],["H","hits"],["ER","earnedRuns"],["BB","baseOnBalls"],["K","strikeOuts"],["ERA","era"]];

function boxTable(headLabel, cols, rows, totals) {
  const thead = el("thead");
  const htr = el("tr", "sr-table__tr srt-neutral-9");
  const th0 = el("th", "sr-table__cell sr-table__th sr-lmt-plus-3-box__table-column-cell sr-lmt-plus-3-box__table-column-player srm-is-uppercase",
    el("span", null, headLabel));
  th0.setAttribute("scope", "col"); th0.colSpan = 1;
  htr.appendChild(th0);
  for (const [label] of cols) {
    const th = el("th", "sr-table__cell sr-table__th sr-lmt-plus-3-box__table-column-cell srt-text-secondary srm-is-uppercase",
      el("span", null, label));
    th.setAttribute("scope", "col"); th.colSpan = 1;
    htr.appendChild(th);
  }
  thead.appendChild(htr);

  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", "sr-table__tr");
    const td = el("td", "sr-table__cell sr-table__td sr-lmt-plus-3-box__table-column-cell sr-lmt-plus-3-box__table-column-player",
      el("span", "sr-lmt-plus-3-box__player-name", r.name),
      r.extra ? el("span", "sr-lmt-plus-3-box__player-name-extra", ` ${r.extra}`) : null);
    tr.appendChild(td);
    for (const [, key] of cols) {
      tr.appendChild(el("td", "sr-table__cell sr-table__td sr-lmt-plus-3-box__table-column-cell", r.stats[key] ?? "-"));
    }
    tbody.appendChild(tr);
  }
  if (totals) {
    const tr = el("tr", "sr-table__tr sr-lmt-plus-3-box__table-row-totals");
    tr.appendChild(el("td", "sr-table__cell sr-table__td sr-lmt-plus-3-box__table-column-cell sr-lmt-plus-3-box__table-column-player srm-is-uppercase", "Totals"));
    for (const [, key] of cols) {
      tr.appendChild(el("td", "sr-table__cell sr-table__td sr-lmt-plus-3-box__table-column-cell", totals[key] ?? "-"));
    }
    tbody.appendChild(tr);
  }
  return el("table", "sr-table__wrapper sr-lmt-plus-3-box__slide-table", thead, tbody);
}

/* the widget prints "S. Antonacci"; MLB gives "S Antonacci" in gameData */
function shortName(feed, id) {
  const gp = (feed.gameData.players || {})[`ID${id}`] || {};
  if (gp.firstName && gp.lastName) return `${gp.firstName[0]}. ${gp.lastName}`;
  if (gp.initLastName) return gp.initLastName.replace(/^(\w)\s/, "$1. ");
  return gp.fullName || "";
}

/* The "batting / baserunning" notes the widget prints under each box score.
   MLB serves them pre-formatted in boxscore.teams[side].info. */
function boxSummary(info) {
  const blocks = [];
  for (const section of (info || [])) {
    const wrap = el("div", "sr-lmt-plus-3-box-summary__wrapper",
      el("span", "sr-lmt-plus-3-box-summary__config-name", (section.title || "").toLowerCase()),
      el("br"));
    for (const f of (section.fieldList || [])) {
      const name = el("span", "sr-lmt-plus-3-box-summary__metric-name",
        el("span", null, el("span", null, (f.label || "").replace(/:$/, ""))));
      name.appendChild(document.createTextNode(": "));
      wrap.appendChild(el("div", "sr-lmt-plus-3-box-summary__data-line",
        name,
        el("span", "sr-lmt-plus-3-box-summary__metric-data srt-text-tertiary",
          el("span", null, (f.value || "").replace(/\.$/, "")))));
    }
    blocks.push(wrap);
  }
  return blocks;
}

function teamBoxSlide(feed, side) {
  const bs = feed.liveData.boxscore.teams[side];
  const team = feed.gameData.teams[side];
  const player = (id) => bs.players[`ID${id}`];

  const batters = bs.batters.map(player).filter(Boolean)
    .filter((p) => p.stats.batting && Object.keys(p.stats.batting).length)
    .map((p) => ({
      name: shortName(feed, p.person.id),
      extra: p.position && p.position.abbreviation,
      /* BA is a season figure; the per-game line does not carry one */
      stats: Object.assign({}, p.stats.batting, { avg: p.seasonStats && p.seasonStats.batting && p.seasonStats.batting.avg }),
    }));

  const pitchers = bs.pitchers.map(player).filter(Boolean)
    .filter((p) => p.stats.pitching && Object.keys(p.stats.pitching).length)
    .map((p) => ({
      name: shortName(feed, p.person.id),
      extra: "",
      stats: Object.assign({}, p.stats.pitching, { era: p.seasonStats && p.seasonStats.pitching && p.seasonStats.pitching.era }),
    }));

  return scrollbars(null,
    el("div", "sr-lmt-plus-3-box__slide-team srm-isSmall",
      el("div", "sr-lmt-plus-3-box__team-header srm-is-uppercase",
        el("div", "sr-lmt-plus-3-box__team-name", team.teamName || team.name)),
      boxTable("hitters", BAT_COLS, batters, bs.teamStats.batting),
      el("div", "sr-lmt-plus-3-box__team-header srm-is-uppercase",
        el("div", "sr-lmt-plus-3-box__team-name", "Pitchers")),
      boxTable("pitchers", PITCH_COLS, pitchers, bs.teamStats.pitching),
      ...boxSummary(bs.info)));
}

function renderBoxScore(feed, state, rerender) {
  const sides = ["away", "home"];
  const side = sides[state.boxPage || 0];
  return panelShell("sr-lmt-plus-3-box", "lmt-plus-3-box",
    el("div", "sr-lmt-plus-3-box__wrapper srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper",
        sliderTitle("box score", state.boxPage || 0, 2,
          () => { state.boxPage = 0; rerender(); },
          () => { state.boxPage = 1; rerender(); }),
        sliderBody("sr-lmt-plus-3-box", teamBoxSlide(feed, side)))));
}

/* ---------- head to head tab ---------- */
/* Three slides, matching the widget: league position / form, hitting leaders,
   pitching leaders. sr-lmt-wdl is a W/L form strip, one letter per match. */
function formStrip(results) {
  const wrapper = el("div", "sr-lmt-wdl__wrapper sr-lmt-wdl__wrapper-left");
  for (const r of results) {
    wrapper.appendChild(el("div", "sr-lmt-wdl__match",
      el("div", `sr-lmt-wdl__wdl ${r === "W" ? "srt-win" : r === "L" ? "srt-lose" : "srt-draw"}`,
        el("span", null, r)),
      el("div", "sr-lmt-wdl__vsep", el("div", "sr-lmt-wdl__vsep-line srt-base-1-primary"))));
  }
  return el("div", "sr-lmt-0-ms-league-position-form__wdls-item", wrapper);
}

/* The vertical form bar. The widget fills it by translating the inner element
   up by the percentage, so -60% reads as a 60% full bar. */
function formChart(pct, isTeam2) {
  const P = "sr-lmt-0-ms-league-position-form";
  const container = el("div", "sr-sc-verticalchart__chart-container srt-neutral-10 srm-is-radius");
  container.style.cssText = "height:100%;width:12px;border-radius:0px;";
  const inner = el("div", `sr-sc-verticalchart__inner ${isTeam2 ? "srt-home-1" : "srt-away-1"} srm-is-spacing`);
  inner.style.cssText = `transform: translateY(-${pct}%); border-radius: 0px;`;
  container.appendChild(inner);

  const valueWrap = el("div", `${P}__form-label-value-wrapper` + (isTeam2 ? " srm-is-team2" : ""),
    el("div", `${P}__form-label-value`, pct),
    el("div", `${P}__form-label-percent-sign`, "%"));
  const desc = el("div", `${P}__form-label-description srm-is-uppercase`, el("span", null, "Form"));
  desc.setAttribute("aria-hidden", "true");
  const label = el("div", `${P}__form-label ${isTeam2 ? "srt-base-1-home-1" : "srt-base-1-away-1"}`,
    valueWrap, desc);

  /* team 1 puts the bar first, team 2 the label first */
  return el("div", `${P}__form-chart` + (isTeam2 ? " srm-is-team2" : ""),
    ...(isTeam2 ? [label, container] : [container, label]));
}

/* The "Last 10" heading with a record badge per team. */
function lastTenBoxes(awayRec, homeRec) {
  const P = "sr-lmt-0-ms-league-position-form";
  const box = (rec, cls) => el("div", `${P}__last-10-stat ${cls}`,
    el("span", null, rec ? rec.wins : "-"), txt("-"), el("span", null, rec ? rec.losses : "-"));
  return el("div", `${P}__last-10-wrapper`,
    el("div", `${P}__last-10-title srt-text-secondary srm-is-uppercase`, el("span", null, "Last 10")),
    el("div", `${P}__last-10-boxes`,
      box(awayRec, "srt-away-1"),
      el("div", `${P}__last-10-seperator`),
      box(homeRec, "srt-home-1")));
}

/* One "29 Murakami vs 31 Crow-Armstrong / home runs" comparison. Element order
   matters: the title is positioned over the row and must come last. Ties are
   printed the way the widget does it - the value, then "N Tied". */
function leaderComparison(label, awayList, homeList) {
  const side = (list, isRight) => {
    const mod = isRight ? " srm-is-right" : "";
    const wrap = el("div", "sr-lmt-plus-3-h2h-leaders__player" + mod);
    const top = (list || [])[0];
    if (!top) {
      wrap.appendChild(el("div", "sr-lmt-plus-3-h2h-leaders__player-name", "-"));
      return wrap;
    }
    const tied = (list || []).filter((x) => x.value === top.value).length;
    wrap.appendChild(el("div", "sr-lmt-plus-3-h2h-leaders__player-top" + mod,
      el("div", `sr-lmt-plus-3-h2h-leaders__player-value ${isRight ? "srt-home-1" : "srt-away-1"}`, top.value)));
    wrap.appendChild(el("div", "sr-lmt-plus-3-h2h-leaders__player-name",
      tied > 1 ? `${tied} Tied` : lastFirst(top.person.fullName)));
    return wrap;
  };

  const title = el("div", "sr-lmt-plus-3-h2h-leaders__comparison-title srm-is-uppercase",
    el("span", "sr-lmt-plus-3-h2h-leaders__comparison-title-span", label));
  title.setAttribute("aria-hidden", "true");

  return el("div", "sr-lmt-plus-3-h2h-leaders__comparison",
    side(awayList, false), side(homeList, true), title);
}

/* A slide's own heading, above its rows. */
function h2hBlock(title, ...rows) {
  return el("div", "sr-lmt-plus-3-h2h__slide-wrapper",
    el("div", "sr-lmt-plus-3-h2h__block",
      el("div", "sr-lmt-plus-3-h2h__block-title srm-is-uppercase",
        el("span", "sr-lmt-plus-3-h2h__dspan", title)),
      el("div", "srt-base-1", ...rows)));
}

/* "Munetaka Murakami" -> "Murakami, Munetaka", as the widget prints it. */
function lastFirst(full) {
  const parts = String(full || "").trim().split(" ");
  if (parts.length < 2) return full || "";
  return `${parts.slice(1).join(" ")}, ${parts[0]}`;
}

function renderH2H(data, state, rerender) {
  const { feed, standings, leaders, form } = data;
  const ids = [feed.gameData.teams.away.id, feed.gameData.teams.home.id];

  const lastTen = (teamId) => {
    for (const r of (standings.records || [])) {
      const t = r.teamRecords.find((x) => x.team.id === teamId);
      if (!t) continue;
      const s = ((t.records || {}).splitRecords || []).find((x) => x.type === "lastTen");
      if (s) return s;
    }
    return null;
  };
  const a10 = lastTen(ids[0]), h10 = lastTen(ids[1]);

  /* The strip shows the last five results oldest-first, and the Form figure is
     simply how many of those five were wins. */
  const lastFive = (arr) => (arr || []).slice(0, 5).reverse();
  const formPct = (five) => (five.length ? Math.round((five.filter((r) => r === "W").length / five.length) * 100) : 0);
  const awayFive = lastFive(form.away), homeFive = lastFive(form.home);

  const P = "sr-lmt-0-ms-league-position-form";
  const positionSlide = el("div", "sr-lmt-plus-3-h2h__slide-wrapper",
    el("div", "sr-lmt-plus-3-h2h__block",
      el("div", `${P}__wrapper`,
        el("div", `${P}__container`,
          el("div", `${P}__chart-wrapper srm-padding-top`,
            formChart(formPct(awayFive), false),
            lastTenBoxes(a10, h10),
            formChart(formPct(homeFive), true)))),
      el("div", `${P}__wdls`,
        formStrip(awayFive),
        formStrip(homeFive))));

  const hittingSlide = h2hBlock("Hitting leaders",
      leaderComparison("home runs", leaders.away.homeRuns, leaders.home.homeRuns),
      leaderComparison("batting average", leaders.away.battingAverage, leaders.home.battingAverage),
      leaderComparison("RBI", leaders.away.runsBattedIn, leaders.home.runsBattedIn));

  const pitchingSlide = h2hBlock("Pitching leaders",
      leaderComparison("ERA", leaders.away.earnedRunAverage, leaders.home.earnedRunAverage),
      leaderComparison("Wins", leaders.away.wins, leaders.home.wins),
      leaderComparison("strikeouts", leaders.away.strikeouts, leaders.home.strikeouts));

  const slides = [positionSlide, hittingSlide, pitchingSlide];
  const page = Math.min(state.h2hPage || 0, slides.length - 1);

  return panelShell("sr-lmt-plus-3-h2h", "lmt-plus-3-h2h",
    el("div", "sr-lmt-plus-3-h2h__wrapper srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper",
        sliderTitle("Head to head", page, slides.length,
          () => { state.h2hPage = page - 1; rerender(); },
          () => { state.h2hPage = page + 1; rerender(); }),
        sliderBody("sr-lmt-plus-3-h2h", scrollbars(null, slides[page])))));
}

/* ---------- standings tab ---------- */
/* The livetable is a real <table>; div rows collapse. Column order and the
   srm-is-N / srm-wNN modifiers below mirror the widget's baseball layout. */
const STANDINGS_COLS = [
  { label: "W",   w: "srm-w30", get: (t) => t.wins },
  { label: "L",   w: "srm-w30", get: (t) => t.losses },
  { label: "%",   w: "srm-w40", get: (t) => t.winningPercentage },
  { label: "L10", w: "srm-w40", get: (t) => {
      const r = ((t.records || {}).splitRecords || []).find((x) => x.type === "lastTen");
      return r ? `${r.wins}-${r.losses}` : "-";
    } },
];

const DIVISION_NAMES = {
  200: "American League West", 201: "American League East", 202: "American League Central",
  203: "National League West", 204: "National League East", 205: "National League Central",
};
const LEAGUE_NAMES = { 103: "American League", 104: "National League" };
/* AL divisions (Central, East, West) then NL, then the two league tables -
   the order the widget lists them in. */
const DIVISION_ORDER = [202, 201, 200, 205, 204, 203];

function standingsTable(record, highlightIds, teamById, season) {
  const headCell = (label, extra, idx) => {
    const th = el("th",
      `sr-lmt-plus-livetable__t-data srt-text-secondary srm-is-head srm-is-uppercase ${extra} srm-is-${idx} srm-baseball srm-is-first`,
      el("span", null, el("span", null, label)));
    return th;
  };

  const head = el("tr", "sr-lmt-plus-livetable__t-row srt-neutral-9 srm-is-head",
    headCell("Pos", "", 0),
    el("th", "sr-lmt-plus-livetable__t-data srt-text-secondary srm-align-left srm-is-head srm-is-team srm-baseball srm-is-uppercase srm-is-first",
      el("span", null, "Team")),
    ...STANDINGS_COLS.map((c, i) => headCell(c.label, c.w, i + 2)));

  const tbody = el("tbody", "sr-lmt-plus-livetable__tbody", head);

  for (const t of record.teamRecords) {
    const hit = highlightIds.includes(t.team.id);
    const tr = el("tr", "sr-lmt-plus-livetable__t-row srt-neutral-9" + (hit ? " srt-base-1-is-active" : ""));
    tr.appendChild(el("td", "sr-lmt-plus-livetable__t-data srm-is-0 srm-baseball srm-border-left", t.divisionRank));
    tr.appendChild(el("td", "sr-lmt-plus-livetable__t-data srm-is-team srm-baseball",
      el("div", "sr-lmt-plus-livetable__team",
        el("div", "sr-lmt-plus-livetable__team-name" + (hit ? " srm-is-bold" : ""),
          (teamById[t.team.id] || {}).teamName || t.team.name),
        el("div", "sr-lmt-plus-livetable__team-abbr", (teamById[t.team.id] || {}).abbreviation || ""))));
    STANDINGS_COLS.forEach((c, i) => {
      tr.appendChild(el("td", `sr-lmt-plus-livetable__t-data ${c.w} srm-is-${i + 2} srm-baseball`, c.get(t) ?? "-"));
    });
    tbody.appendChild(tr);
  }

  const name = record.leagueWide
    ? (LEAGUE_NAMES[record.league && record.league.id] || "League")
    : (DIVISION_NAMES[record.division && record.division.id] || "Standings");

  return el("div", "sr-lmt-plus-livetable__table-holder",
    el("div", "sr-lmt-plus-livetable__league-name srm-is-uppercase", el("span", null, `MLB ${season}, ${name}`)),
    el("table", "sr-lmt-plus-livetable__table", tbody));
}

function renderStandings(feed, standings, teamById, byLeague) {
  const season = feed.gameData.game.season;
  const ids = [feed.gameData.teams.away.id, feed.gameData.teams.home.id];

  const divisions = (standings.records || []).slice().sort((a, b) =>
    DIVISION_ORDER.indexOf((a.division || {}).id) - DIVISION_ORDER.indexOf((b.division || {}).id));

  const leagues = ((byLeague || {}).records || []).map((r) =>
    Object.assign({}, r, { leagueWide: true }));

  const tables = [...divisions, ...leagues];

  return panelShell("sr-lmt-plus-livetable", "livetable",
    el("div", "sr-lmt-plus-livetable__container srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper",
        sliderTitle("Standings", 0, 1),
        sliderBody("sr-lmt-plus-livetable",
          scrollbars(null, ...tables.map((r) => standingsTable(r, ids, teamById, season)))))));
}

/* ---------- timeline tab ---------- */
const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const ordinal = (n) => ORDINALS[n] || `${n}th`;

function renderTimeline(feed) {
  const plays = feed.liveData.plays.allPlays || [];
  const g = feed.gameData;
  const abbr = { away: g.teams.away.abbreviation, home: g.teams.home.abbreviation };
  const nick = { away: g.teams.away.teamName || g.teams.away.name,
                 home: g.teams.home.teamName || g.teams.home.name };

  /* group into inning halves, newest first, the way the widget stacks them */
  const halves = [];
  for (const p of plays) {
    const key = `${p.about.inning}-${p.about.halfInning}`;
    let h = halves.find((x) => x.key === key);
    if (!h) {
      h = { key, inning: p.about.inning, half: p.about.halfInning, plays: [] };
      halves.push(h);
    }
    h.plays.push(p);
  }
  halves.reverse();

  const frames = halves.map((h) => {
    const side = h.half === "top" ? "away" : "home";
    const last = h.plays[h.plays.length - 1];
    const away = last && last.result ? last.result.awayScore : 0;
    const home = last && last.result ? last.result.homeScore : 0;

    /* "Bot 10th" on the left, the score at the end of the half on the right */
    const header = el("div", "sr-lmt-plus-3-pbp-row__inning-half-header srt-text-secondary",
      el("div", "sr-lmt-plus-3-pbp-row__inning-detail",
        el("span", "sr-lmt-plus-3-pbp-row__frame", h.half === "top" ? "Top" : "Bot"),
        txt(" " + ordinal(h.inning))),
      el("div", null,
        el("span", null, away), el("span", null, " - "), el("span", null, home)));

    const body = el("div", null,
      el("div", "sr-lmt-plus-3-pbp-row__data-row sr-lmt-plus-3-pbp-row__full-team-name", nick[side]));

    for (const p of h.plays) {
      if (!p.result || !p.result.description) continue;
      const scored = p.about.isScoringPlay;

      const top = el("div", "sr-lmt-plus-3-pbp-row__data-top",
        el("div", "sr-lmt-plus-3-pbp-row__abbr-and-type",
          el("div", "sr-lmt-plus-3-pbp-row__team-abbr", abbr[side]),
          el("div", "sr-lmt-plus-3-pbp-row__play-type" + (scored ? " srt-primary-1" : ""),
            el("span", null, p.result.event || ""))));

      if (scored) {
        top.appendChild(el("div", "sr-lmt-plus-3-pbp-elements__at-bat-1-result srt-primary-1",
          el("div", null,
            el("span", "sr-lmt-plus-3-pbp-elements", p.result.awayScore),
            el("span", null, " - "),
            el("span", "sr-lmt-plus-3-pbp-elements__result-bold", p.result.homeScore))));
      }

      body.appendChild(el("div", "sr-lmt-plus-3-pbp-row__data-row",
        top,
        el("div", null, p.result.description)));
    }

    const section = el("section", "sr-collapse__children", body);
    section.style.maxHeight = "none";

    return el("div", "sr-lmt-plus-3-pbp-row__frame",
      el("div", "sr-collapse__wrapper sr-lmt-plus-3-pbp-row__inning-half srm-no-border",
        header, section));
  });

  const content = frames.length ? frames
    : [el("div", "sr-lmt-plus-0-hor-chart__title srt-text-secondary srm-is-uppercase",
        el("span", null, "No plays yet"))];

  /* the timeline is a plain scroller, not a slider */
  return panelShell("sr-lmt-plus-3-pbp-row", null,
    el("div", "sr-lmt-plus-3-pbp-row__wrapper srt-base-1",
      sliderTitle("Timeline", 0, 1),
      scrollbars("sr-lmt-plus-3-pbp-row__scroller-wrapper",
        el("div", "sr-lmt-plus-3-pbp-row__scroller-inner", ...content))));
}

/* ---------- shell ---------- */
const PANELS = {
  statistics: (d, s, r) => renderStatistics(d.feed, s, r, d.season),
  boxScore:   (d, s, r) => renderBoxScore(d.feed, s, r),
  headToHead: (d, s, r) => renderH2H(d, s, r),
  standings:  (d, s, r) => renderStandings(d.feed, d.standings, d.teamById, d.byLeague),
  timeline:   (d, s, r) => renderTimeline(d.feed),
};

function renderWidget(data, state) {
  /* the previous render's slider intervals would otherwise keep firing */
  while (SLIDER_TIMERS.length) SLIDER_TIMERS.pop()();

  const root = document.querySelector(".sr-widget");
  const rerender = () => renderWidget(data, state);

  /* The field graphic is the widget's own markup, verbatim; the state header
     is ours and gets appended into the same wrap the widget uses. */
  const pitch = el("div");
  pitch.innerHTML = window.SR_PITCH_HTML || "";
  const pitchRoot = pitch.firstElementChild;
  const lmtNode = pitch.querySelector(".sr-lmt");
  if (lmtNode) responsive(lmtNode, "lmt");
  /* the state header is a sibling of .sr-lmt-3-pitch inside .sr-lmt__content;
     putting it in .sr-lmt-wrap instead leaves it under the pitch (z-index 1) */
  const lmtContent = pitch.querySelector(".sr-lmt__content");
  if (lmtContent) lmtContent.appendChild(renderHeader(data.feed));

  const lmtCol = el("div", "sr-lmt-plus__comp srm-double srm-isLmt",
    el("div", "sr-lmt-plus__comp-padding",
      el("div", "sr-lmt-plus__comp-wrap srm-double",
        el("div", "sr-lmt-plus__comp-size", pitchRoot))));

  const panel = tabReady(data, state.tab)
    ? PANELS[state.tab](data, state, rerender)
    : loadingPanel(TAB_LABELS[state.tab]);

  const panelCol = el("div", "sr-lmt-plus__comp srm-double srm-notLmt",
    el("div", "sr-lmt-plus__comp-padding",
      el("div", "sr-lmt-plus__comp-wrap srm-double",
        el("div", "sr-lmt-plus__comp-size", panel))));

  const tabs = renderTabs(state.tab, (t) => { selectTab(data, state, t); });
  const tabsNode = tabs.querySelector(".sr-lmt-plus-tabs");
  if (tabsNode) responsive(tabsNode, "lmt-plus-tabs");

  const wrapper = el("div", "sr-lmt-plus__wrapper srt-base-1 srm-double",
    tabs,
    el("div", "sr-lmt-plus__comp-wrapper srm-double srm-showLmt", lmtCol, panelCol));

  const lmtPlus = el("div", "sr-bb sr-lmt-plus sr-ltr",
    el("div", "sr-loader__container", el("div", "sr-loader__overlay"), wrapper));
  responsive(lmtPlus, "lmt-plus");

  const widget = el("div", "sr-wwrap srm-fullyloaded", lmtPlus);

  root.replaceChildren(widget);
}

/* Switch tabs at once, painting the spinner, then re-render when the tab's
   data resolves - the same order the real widget does it in. */
function selectTab(data, state, tab) {
  state.tab = tab;
  const pending = ensureTabData(data, tab);
  renderWidget(data, state);
  if (pending) pending.then(() => {
    if (state.tab === tab) renderWidget(data, state);
  });
}

function renderError(err) {
  const root = document.querySelector(".sr-widget");
  root.replaceChildren(el("div", "sr-bb sr-lmt-plus sr-ltr",
    el("div", "sr-lmt-plus__wrapper srt-base-1",
      el("div", "sr-lmt-0-minfos-header__c-text srm-is-title srm-is-uppercase", "Data unavailable"),
      el("div", "sr-lmt-0-minfos-header__c-text srt-text-secondary srm-is-subtitle", String(err && err.message || err)))));
}

/* ---------- routing ----------
   The id can come from the path (/824639, mirroring the tracker URL shape) or
   from ?game=. Note this is an MLB gamePk, not a Sportradar match id - the two
   are different id spaces and there is no public mapping between them. */
function gamePkFromLocation() {
  const fromPath = location.pathname.match(/(\d{4,})/);
  if (fromPath) return Number(fromPath[1]);
  const q = new URLSearchParams(location.search).get("game");
  if (q && /^\d+$/.test(q)) return Number(q);
  return GAME_PK;
}

let CURRENT = null;

async function show(gamePk, { push } = {}) {
  const state = { tab: "statistics", boxPage: 0, statsPage: 0, h2hPage: 0 };
  CURRENT = gamePk;
  setPickerValue(gamePk);
  setPickerMessage("");
  markCurrentGame();

  try {
    const data = await loadFeed(gamePk);
    if (CURRENT !== gamePk) return;          // a newer request won
    selectTab(data, state, state.tab);
    document.title = matchTitle(data.feed);

    /* first load: list the day this game belongs to */
    if (!panelDate) renderGames(data.feed.gameData.datetime.originalDate
      || isoDate(new Date(data.feed.gameData.datetime.dateTime)));
    else markCurrentGame();

    if (push) history.pushState({ gamePk }, "", `/${gamePk}`);

    if (data.feed.gameData.status.abstractGameState === "Live") {
      setInterval(async () => {
        if (CURRENT !== gamePk) return;
        try {
          /* refresh the match feed only; cached tab data stays put */
          data.feed = await getJSON(`${API}/v1.1/game/${gamePk}/feed/live`);
          renderWidget(data, state);
        } catch (e) { /* keep the last good render */ }
      }, REFRESH_MS);
    }
  } catch (e) {
    renderError(new Error(`No MLB game found for id ${gamePk}`));
    const complain = () =>
      setPickerMessage(`No MLB game with id ${gamePk}. Pick one from the list below.`, true);
    /* renderGames clears the message on success, so complain after it settles */
    if (!panelDate) renderGames(isoDate(new Date())).then(complain, complain);
    else complain();
  }
}

function matchTitle(feed) {
  const t = feed.gameData.teams;
  return `${t.away.abbreviation} @ ${t.home.abbreviation} - Live Match Tracker`;
}

/* ---------- games panel ---------- */
const PLAY_ICON = '<svg viewBox="0 0 8 10" aria-hidden="true"><path d="M0 0l8 5-8 5z"/></svg>';
const DAY_MS = 86400000;

let panelDate = null;      // the day currently listed
let teamDir = null;        // id -> team, for abbreviations

const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function setPickerValue(gamePk) {
  const input = document.getElementById("gameId");
  if (input && document.activeElement !== input) input.value = gamePk;
}

function setPickerMessage(msg, isError) {
  const box = document.getElementById("gamesMsg");
  if (!box) return;
  box.textContent = msg || "";
  box.classList.toggle("is-error", Boolean(isError));
}

async function teamDirectory(season) {
  if (teamDir) return teamDir;
  teamDir = {};
  try {
    const d = await getJSON(`${API}/v1/teams?sportId=1&season=${season}`);
    for (const t of (d.teams || [])) teamDir[t.id] = t;
  } catch (e) { /* fall back to full names */ }
  return teamDir;
}

const abbrOf = (team) => (teamDir && teamDir[team.id] && teamDir[team.id].abbreviation) || team.name;

/* "7:10 PM" in the viewer's own timezone. */
const startTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function gameRow(g) {
  const li = el("li", "games__row");
  li.dataset.gamePk = g.gamePk;
  if (g.gamePk === CURRENT) li.classList.add("is-current");

  const play = el("button", "games__play");
  play.type = "button";
  play.title = "Open this game";
  play.innerHTML = PLAY_ICON;

  const state = g.status.abstractGameState;
  const teams = el("div", "games__teams",
    el("span", "games__abbr", abbrOf(g.teams.away.team)),
    el("span", "games__at", "@"),
    el("span", "games__abbr", abbrOf(g.teams.home.team)));

  if (state !== "Preview") {
    teams.appendChild(el("span", "games__score",
      `${g.teams.away.score ?? 0} : ${g.teams.home.score ?? 0}`));
  }

  const label = state === "Preview" ? startTime(g.gameDate)
    : state === "Live" ? (g.status.detailedState || "Live")
    : (g.status.detailedState || "Final");
  const stateEl = el("div", "games__state" + (state === "Live" ? " is-live" : ""), label);

  li.appendChild(play);
  li.appendChild(teams);
  li.appendChild(stateEl);
  li.addEventListener("click", () => {
    if (g.gamePk !== CURRENT) show(g.gamePk, { push: true });
  });
  return li;
}

async function renderGames(date) {
  panelDate = date;
  const list = document.getElementById("gamesList");
  const label = document.getElementById("gamesDate");
  if (!list) return;

  const d = new Date(`${date}T12:00:00`);
  if (label) label.textContent = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  list.replaceChildren();
  setPickerMessage("Loading games…");
  try {
    const sched = await getJSON(`${API}/v1/schedule?sportId=1&date=${date}`);
    if (panelDate !== date) return;            // a newer day won
    const games = ((sched.dates || [])[0] || {}).games || [];
    await teamDirectory(d.getFullYear());
    if (panelDate !== date) return;

    setPickerMessage("");
    if (!games.length) {
      list.appendChild(el("li", "games__empty", "No MLB games on this date."));
      return;
    }
    games.sort((a, b) => (a.gameDate < b.gameDate ? -1 : 1));
    for (const g of games) list.appendChild(gameRow(g));

    /* bring the game being shown into view rather than making them hunt */
    const current = list.querySelector(".games__row.is-current");
    if (current) current.scrollIntoView({ block: "center" });
  } catch (e) {
    setPickerMessage("Could not load the schedule for this date.", true);
  }
}

/* Keep the highlight in step with whatever the widget is showing. */
function markCurrentGame() {
  let current = null;
  for (const row of document.querySelectorAll(".games__row")) {
    const on = Number(row.dataset.gamePk) === CURRENT;
    row.classList.toggle("is-current", on);
    if (on) current = row;
  }
  if (current) current.scrollIntoView({ block: "center" });
}

function shiftDay(days) {
  const d = new Date(`${panelDate}T12:00:00`);
  d.setTime(d.getTime() + days * DAY_MS);
  renderGames(isoDate(d));
}

function wirePicker() {
  const byId = (id) => document.getElementById(id);
  const prev = byId("prevDay"), next = byId("nextDay"), today = byId("todayBtn");
  const load = byId("loadId"), input = byId("gameId");

  if (prev) prev.addEventListener("click", () => shiftDay(-1));
  if (next) next.addEventListener("click", () => shiftDay(1));
  if (today) today.addEventListener("click", () => renderGames(isoDate(new Date())));

  const submitId = () => {
    /* tolerate a pasted URL as well as a bare id */
    const m = (input.value || "").trim().match(/(\d{4,})/);
    if (!m) { setPickerMessage("Enter a numeric game id.", true); return; }
    const pk = Number(m[1]);
    if (pk !== CURRENT) show(pk, { push: true });
  };
  if (load) load.addEventListener("click", submitId);
  if (input) input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitId(); }
  });
}

window.addEventListener("popstate", () => {
  const pk = gamePkFromLocation();
  if (pk !== CURRENT) show(pk);
});

function main() {
  wirePicker();
  show(gamePkFromLocation());
}

main();
