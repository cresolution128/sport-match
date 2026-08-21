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

async function loadAll(gamePk) {
  const feed = await getJSON(`${API}/v1.1/game/${gamePk}/feed/live`);
  const g = feed.gameData;
  const season = g.game.season;
  const homeId = g.teams.home.id, awayId = g.teams.away.id;

  const [h2h, standings, teams] = await Promise.all([
    getJSON(`${API}/v1/schedule?sportId=1&teamId=${awayId}&opponentId=${homeId}&season=${season}&gameType=R`)
      .catch(() => ({ dates: [] })),
    getJSON(`${API}/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`)
      .catch(() => ({ records: [] })),
    /* standings rows carry only team ids, so we need the directory for
       abbreviations and full names */
    getJSON(`${API}/v1/teams?sportId=1&season=${season}`).catch(() => ({ teams: [] })),
  ]);
  const teamById = {};
  for (const t of (teams.teams || [])) teamById[t.id] = t;
  return { feed, h2h, standings, teamById };
}

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
function panelShell(componentClass, key, ...kids) {
  const root = el("div", `sr-bb ${componentClass} sr-ltr`);
  if (key) responsive(root, key);
  root.appendChild(el("div", "sr-loader__container",
    el("div", "sr-loader__overlay"), ...kids));
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

/* ---------- header / scoreboard ---------- */
const CLOCK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="sr-lmt-0-minfos-header__icon srm-is-default"><path d="M13.29 9.45a1.55 1.55 0 0 0-2.53 1.79l2.95 4.16a2.29 2.29 0 0 0 3.92 2.03h3.32c.86 0 1.55-.69 1.55-1.55 0-.86-.69-1.55-1.55-1.55h-3.32a2.26 2.26 0 0 0-1.39-.71l-2.95-4.17zM26.89 10.94c.41.88.71 1.83.89 2.81.06.32.35.53.67.51l2.89-.27c.17-.02.33-.1.44-.24a.6.6 0 0 0 .12-.48 15.9 15.9 0 0 0-1.57-4.72.62.62 0 0 0-.42-.32.65.65 0 0 0-.52.12l-2.32 1.84a.62.62 0 0 0-.18.75z"/><path d="M24.73 24.79a.62.62 0 0 0-.76.05 11.86 11.86 0 0 1-6.87 2.96v-1.4a1.03 1.03 0 1 0-2.06 0v1.39A11.92 11.92 0 0 1 4.19 16.95h1.39a1.03 1.03 0 1 0 0-2.06h-1.4A11.93 11.93 0 0 1 14 4.19c.3-.05.51-.31.51-.61V.64a.64.64 0 0 0-.21-.47.65.65 0 0 0-.5-.15 16.06 16.06 0 1 0 13.45 27.4c.13-.13.2-.31.19-.5a.6.6 0 0 0-.27-.46l-2.44-1.67zM18.13 4.19c.41.07.81.16 1.2.27.3.08.61-.06.74-.35l1.18-2.66a.65.65 0 0 0 0-.51.64.64 0 0 0-.38-.34C20.05.34 19.2.14 18.34.02a.61.61 0 0 0-.5.15.6.6 0 0 0-.21.47v2.93a.6.6 0 0 0 .5.62zM24.52 7.54c.22.23.58.25.83.05l2.28-1.81a.6.6 0 0 0 .23-.44.62.62 0 0 0-.17-.47 15.6 15.6 0 0 0-2.75-2.31.63.63 0 0 0-.52-.08.6.6 0 0 0-.39.35l-1.2 2.67a.62.62 0 0 0 .2.75c.54.4 1.03.83 1.49 1.29zM31.82 17.3a.67.67 0 0 0-.5-.19l-2.95.27a.64.64 0 0 0-.56.52 11.63 11.63 0 0 1-1.28 3.69.63.63 0 0 0 .19.81l2.4 1.64c.14.1.32.13.49.09a.64.64 0 0 0 .4-.3 16.13 16.13 0 0 0 1.98-6.03.59.59 0 0 0-.17-.5z"/></svg>';

let VENUE_TIMER = 0;

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

  /* The venue box is a slider the widget auto-rotates. Slide 1 is the
     competition/venue line, slide 2 the field facts (surface, capacity,
     distances) - all of which MLB gives us in venue.fieldInfo. */
  const fi = g.venue.fieldInfo || {};
  const fieldCol = (title, value) => el("div", "sr-lmt-0-mis-field__col",
    el("div", "sr-lmt-0-mis-field__title sr-lmt-0-mis-field__t-font srm-is-uppercase",
      el("span", null, title)),
    el("div", "sr-lmt-0-mis-field__data sr-lmt-0-mis-field__t-font srm-is-uppercase srm-cap", value));

  /* two groups: five columns do not fit the 400px pane */
  const groundCols = [];
  if (fi.turfType) groundCols.push(fieldCol("Surface", fi.turfType));
  if (fi.capacity) groundCols.push(fieldCol("Capacity", fi.capacity));
  if (fi.roofType) groundCols.push(fieldCol("Roof", fi.roofType));

  const distCols = [];
  if (fi.leftLine) distCols.push(fieldCol("LF", `${fi.leftLine} ft`));
  if (fi.center) distCols.push(fieldCol("CF", `${fi.center} ft`));
  if (fi.rightLine) distCols.push(fieldCol("RF", `${fi.rightLine} ft`));

  const slides = [
    el("div", "sr-lmt-0-mis-venue__wrapper",
      el("div", "sr-lmt-0-mis-venue__slide",
        el("div", "sr-lmt-0-matchinfoslider__main-title srm-has-border", compRow),
        el("div", "sr-lmt-0-matchinfoslider__main-title", venueRow))),
  ];
  for (const cols of [groundCols, distCols]) {
    if (!cols.length) continue;
    slides.push(el("div", "sr-lmt-0-mis-field__wrapper srm-large",
      el("div", "sr-lmt-0-matchinfoslider__main-title srm-has-border", compRow.cloneNode(true)),
      el("div", "sr-slider-flex__slide sr-lmt-0-mis-field__slide sr-lmt-0-mis-slide__slide",
        el("div", "sr-lmt-0-mis-field__content", ...cols))));
  }

  const slideNodes = slides.map((inner) =>
    el("div", "sr-slider-flex__slide sr-lmt-0-mis-slide__slide", inner));

  const sliderTrack = el("div", "sr-slider-flex__slider sr-lmt-0-matchinfoslider__slider", ...slideNodes);

  if (slideNodes.length > 1) {
    let idx = 0;
    const show = () => slideNodes.forEach((n) => {
      n.style.transform = `translate3d(-${idx * 100}%, 0px, 0px)`;
      n.style.transition = "transform .5s";
    });
    show();
    clearInterval(VENUE_TIMER);
    VENUE_TIMER = setInterval(() => { idx = (idx + 1) % slideNodes.length; show(); }, 6000);
  }

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

const STAT_ROWS = [
  ["Hits",          (b, p) => b.hits],
  ["Runs",          (b, p) => b.runs],
  ["Doubles",       (b, p) => b.doubles],
  ["Triples",       (b, p) => b.triples],
  ["Home runs",     (b, p) => b.homeRuns],
  ["Strikeouts",    (b, p) => b.strikeOuts],
  ["Walks issued",  (b, p) => p.baseOnBalls],
  ["Stolen bases",  (b, p) => b.stolenBases],
  ["Left on base",  (b, p) => b.leftOnBase],
  ["Total bases",   (b, p) => b.totalBases],
  ["RBI",           (b, p) => b.rbi],
];

function decisionRecord(feed, personId, type) {
  for (const side of ["away", "home"]) {
    const p = feed.liveData.boxscore.teams[side].players[`ID${personId}`];
    if (!p || !p.seasonStats || !p.seasonStats.pitching) continue;
    const st = p.seasonStats.pitching;
    return type === "save" ? String(st.saves ?? "-") : `${st.wins} - ${st.losses}`;
  }
  return "-";
}

function renderStatistics(feed, state, rerender) {
  const bs = feed.liveData.boxscore;
  const aB = bs.teams.away.teamStats.batting, aP = bs.teams.away.teamStats.pitching;
  const hB = bs.teams.home.teamStats.batting, hP = bs.teams.home.teamStats.pitching;
  const aF = bs.teams.away.teamStats.fielding, hF = bs.teams.home.teamStats.fielding;

  const rows = STAT_ROWS
    .map(([label, pick]) => {
      const a = pick(aB, aP), h = pick(hB, hP);
      return (a === undefined && h === undefined) ? null : horChart(label, a ?? 0, h ?? 0);
    })
    .filter(Boolean);

  rows.push(horChart("Errors", aF.errors ?? 0, hF.errors ?? 0));
  rows.push(horChart("Batting average", aB.avg, hB.avg, undefined, undefined,
    Number(aB.avg), Number(hB.avg)));

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
const BAT_COLS   = [["AB","atBats"],["R","runs"],["H","hits"],["RBI","rbi"],["BB","baseOnBalls"],["SO","strikeOuts"],["AVG","avg"]];
const PITCH_COLS = [["IP","inningsPitched"],["H","hits"],["R","runs"],["ER","earnedRuns"],["BB","baseOnBalls"],["SO","strikeOuts"],["ERA","era"]];

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

function teamBoxSlide(feed, side) {
  const bs = feed.liveData.boxscore.teams[side];
  const team = feed.gameData.teams[side];
  const player = (id) => bs.players[`ID${id}`];

  const batters = bs.batters.map(player).filter(Boolean)
    .filter((p) => p.stats.batting && Object.keys(p.stats.batting).length)
    .map((p) => ({
      name: p.person.fullName,
      extra: p.position && p.position.abbreviation,
      /* avg is a season figure; the per-game line does not carry one */
      stats: Object.assign({}, p.stats.batting, { avg: p.seasonStats && p.seasonStats.batting && p.seasonStats.batting.avg }),
    }));

  const pitchers = bs.pitchers.map(player).filter(Boolean)
    .filter((p) => p.stats.pitching && Object.keys(p.stats.pitching).length)
    .map((p) => ({
      name: p.person.fullName,
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
      boxTable("pitchers", PITCH_COLS, pitchers, bs.teamStats.pitching)));
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
/* sr-lmt-wdl is a W/L form strip (one letter per match), not a score list. */
function formStrip(results) {
  const wrapper = el("div", "sr-lmt-wdl__wrapper sr-lmt-wdl__wrapper-left");
  for (const r of results) {
    wrapper.appendChild(el("div", "sr-lmt-wdl__match",
      el("div", `sr-lmt-wdl__wdl ${r === "W" ? "srt-win" : r === "L" ? "srt-lose" : "srt-draw"}`,
        el("span", null, r)),
      el("div", "sr-lmt-wdl__vsep", el("div", "sr-lmt-wdl__vsep-line srt-base-1-primary"))));
  }
  return el("div", "sr-lmt-0-ms-league-position-form__wdls",
    el("div", "sr-lmt-0-ms-league-position-form__wdls-item", wrapper));
}

function renderH2H(feed, h2h, teamById) {
  const g = feed.gameData;
  const awayId = g.teams.away.id, homeId = g.teams.home.id;

  const games = [];
  for (const d of (h2h.dates || [])) for (const gm of d.games) {
    if (gm.status.abstractGameState === "Final") games.push({ date: d.date, gm });
  }
  games.sort((a, b) => (a.date < b.date ? 1 : -1));

  let awayWins = 0, homeWins = 0;
  const rows = [];
  const form = [];
  for (const { date, gm } of games) {
    const a = gm.teams.away, h = gm.teams.home;
    const awayIsOurAway = a.team.id === awayId;
    const ourAwayScore = awayIsOurAway ? a.score : h.score;
    const ourHomeScore = awayIsOurAway ? h.score : a.score;
    if (ourAwayScore > ourHomeScore) { awayWins++; form.push("W"); }
    else if (ourHomeScore > ourAwayScore) { homeWins++; form.push("L"); }
    else form.push("D");

    const d = new Date(date + "T12:00:00Z");
    const abbr = (t) => (teamById[t.id] || {}).abbreviation || t.name;
    rows.push({
      name: `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`,
      extra: "",
      stats: { away: abbr(a.team), score: `${a.score} : ${h.score}`, home: abbr(h.team) },
    });
  }

  const awayName = g.teams.away.teamName || g.teams.away.name;
  /* __comparison-title is absolutely positioned and would sit on top of the
     bar label, so section headings use the normal-flow header class instead. */
  const heading = (t) => el("div", "sr-lmt-plus-3-box__team-header srm-is-uppercase",
    el("div", "sr-lmt-plus-3-box__team-name", t));

  const block = el("div", "sr-lmt-plus-3-h2h__block",
    heading("Season series"),
    horChart("Wins", awayWins, homeWins));

  if (form.length) {
    block.appendChild(heading(`${awayName} form`));
    block.appendChild(formStrip(form));
  }
  if (rows.length) {
    block.appendChild(boxTable("meetings",
      [["Away", "away"], ["Score", "score"], ["Home", "home"]], rows, null));
  } else {
    block.appendChild(el("div", "sr-lmt-plus-0-hor-chart__title srt-text-secondary srm-is-uppercase",
      el("span", null, "No completed meetings this season")));
  }

  return panelShell("sr-lmt-plus-3-h2h", "lmt-plus-3-h2h",
    el("div", "sr-lmt-plus-3-h2h__wrapper srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper",
        sliderTitle("head to head", 0, 1),
        sliderBody("sr-lmt-plus-3-h2h",
          scrollbars(null, el("div", "sr-lmt-plus-3-h2h__slide-wrapper", block))))));
}

/* ---------- standings tab ---------- */
/* The livetable is a real <table>; div rows collapse. Column order and the
   srm-is-N / srm-wNN modifiers below mirror the widget's baseball layout. */
const STANDINGS_COLS = [
  { label: "W",   w: "srm-w30", get: (t) => t.wins },
  { label: "L",   w: "srm-w30", get: (t) => t.losses },
  { label: "%",   w: "srm-w40", get: (t) => t.winningPercentage },
  { label: "GB",  w: "srm-w40", get: (t) => t.gamesBack },
  { label: "L10", w: "srm-w40", get: (t) => {
      const r = ((t.records || {}).splitRecords || []).find((x) => x.type === "lastTen");
      return r ? `${r.wins}-${r.losses}` : "-";
    } },
];

const DIVISION_NAMES = {
  200: "American League West", 201: "American League East", 202: "American League Central",
  203: "National League West", 204: "National League East", 205: "National League Central",
};

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

  const name = DIVISION_NAMES[record.division && record.division.id] || "Standings";

  return el("div", "sr-lmt-plus-livetable__table-holder",
    el("div", "sr-lmt-plus-livetable__league-name srm-is-uppercase", el("span", null, `MLB ${season}, ${name}`)),
    el("table", "sr-lmt-plus-livetable__table", tbody));
}

function renderStandings(feed, standings, teamById) {
  const season = feed.gameData.game.season;
  const ids = [feed.gameData.teams.away.id, feed.gameData.teams.home.id];
  const relevant = (standings.records || []).filter((r) =>
    r.teamRecords.some((t) => ids.includes(t.team.id)));
  const use = relevant.length ? relevant : (standings.records || []).slice(0, 2);

  return panelShell("sr-lmt-plus-livetable", "livetable",
    el("div", "sr-lmt-plus-livetable__container srt-base-1",
      el("div", "sr-lmt-plus-slider__wrapper",
        sliderTitle("standings", 0, 1),
        sliderBody("sr-lmt-plus-livetable", scrollbars(null, ...use.map((r) => standingsTable(r, ids, teamById, season)))))));
}

/* ---------- timeline tab ---------- */
function renderTimeline(feed) {
  const plays = feed.liveData.plays.allPlays || [];
  const g = feed.gameData;
  const abbr = { away: g.teams.away.abbreviation, home: g.teams.home.abbreviation };

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
    const header = el("div", "sr-lmt-plus-3-pbp-row__inning-half-header srt-text-secondary",
      el("div", "sr-lmt-plus-3-pbp-row__inning-detail srm-is-uppercase",
        `${h.half === "top" ? "Top" : "Bottom"} ${h.inning}`),
      el("div", "sr-lmt-plus-3-pbp-row__team-abbr", abbr[side]));

    const events = h.plays.filter((p) => p.result && p.result.description).map((p) => {
      const scored = (p.about.isScoringPlay);
      return el("div", "sr-lmt-plus-3-pbp-row__event",
        el("div", "sr-lmt-plus-3-pbp-row__data-row",
          el("div", "sr-lmt-plus-3-pbp-row__data-top",
            el("div", "sr-lmt-plus-3-pbp-row__abbr-and-type",
              el("span", "sr-lmt-plus-3-pbp-row__play-type" + (scored ? " srt-base-1-primary srm-is-bold" : " srt-text-secondary"),
                p.result.event || ""),
              scored ? el("span", "sr-lmt-plus-3-pbp-row__team-abbr srm-is-bold",
                ` ${p.result.awayScore} : ${p.result.homeScore}`) : null)),
          el("div", "sr-lmt-plus-3-pbp-row__text", p.result.description)));
    });

    return el("div", "sr-lmt-plus-3-pbp-row__frame",
      el("div", "sr-collapse__wrapper sr-lmt-plus-3-pbp-row__inning-half srm-no-border",
        header, ...events));
  });

  const content = frames.length ? frames
    : [el("div", "sr-lmt-plus-0-hor-chart__title srt-text-secondary srm-is-uppercase",
        el("span", null, "No plays yet"))];
  /* the timeline is a plain scroller, not a slider */
  return panelShell("sr-lmt-plus-3-pbp-row", null,
    el("div", "sr-lmt-plus-3-pbp-row__wrapper srt-base-1",
      sliderTitle("timeline", 0, 1),
      scrollbars("sr-lmt-plus-3-pbp-row__scroller-wrapper",
        el("div", "sr-lmt-plus-3-pbp-row__scroller-inner", ...content))));
}

/* ---------- shell ---------- */
const PANELS = {
  statistics: (d, s, r) => renderStatistics(d.feed, s, r),
  boxScore:   (d, s, r) => renderBoxScore(d.feed, s, r),
  headToHead: (d, s, r) => renderH2H(d.feed, d.h2h, d.teamById),
  standings:  (d, s, r) => renderStandings(d.feed, d.standings, d.teamById),
  timeline:   (d, s, r) => renderTimeline(d.feed),
};

function renderWidget(data, state) {
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

  const panelCol = el("div", "sr-lmt-plus__comp srm-double srm-notLmt",
    el("div", "sr-lmt-plus__comp-padding",
      el("div", "sr-lmt-plus__comp-wrap srm-double",
        el("div", "sr-lmt-plus__comp-size", PANELS[state.tab](data, state, rerender)))));

  const tabs = renderTabs(state.tab, (t) => { state.tab = t; renderWidget(data, state); });
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

function renderError(err) {
  const root = document.querySelector(".sr-widget");
  root.replaceChildren(el("div", "sr-bb sr-lmt-plus sr-ltr",
    el("div", "sr-lmt-plus__wrapper srt-base-1",
      el("div", "sr-lmt-0-minfos-header__c-text srm-is-title srm-is-uppercase", "Data unavailable"),
      el("div", "sr-lmt-0-minfos-header__c-text srt-text-secondary srm-is-subtitle", String(err && err.message || err)))));
}

async function main() {
  const state = { tab: "statistics", boxPage: 0 };
  const gamePk = Number(new URLSearchParams(location.search).get("game")) || GAME_PK;
  try {
    const data = await loadAll(gamePk);
    renderWidget(data, state);
    if (data.feed.gameData.status.abstractGameState === "Live") {
      setInterval(async () => {
        try {
          const fresh = await loadAll(gamePk);
          renderWidget(fresh, state);
        } catch (e) { /* keep the last good render */ }
      }, REFRESH_MS);
    }
  } catch (e) {
    renderError(e);
  }
}

main();
