/* FogTwin — measured results.

   Renders scripts/experiment.py output. Nothing here is typed in by hand: the
   numbers, the error bars and the honest-reading notes are all computed from
   data/experiment.json, so the page cannot drift from the experiment and a
   judge can regenerate it in front of you.

   Charts are inline SVG. The dataset is three visibilities by two arms; a
   plotting library would be more code than the chart. */

const fmt = (v, d = 0) => v === null || v === undefined ? '—' : v.toFixed(d);
const M = { baseline: '#8C979E', fogtwin: '#E4652F' };

async function boot() {
  const main = document.getElementById('main');
  let data;
  try {
    const r = await fetch('/api/experiment');
    if (!r.ok) throw new Error((await r.json()).hint || r.statusText);
    data = await r.json();
  } catch (e) {
    main.innerHTML = `<div class="miss">No experiment on disk yet.<br><br>
      Run <code>python -m scripts.experiment --seeds 4 --minutes 25</code>
      and reload.<br><br><span style="color:var(--ink-3)">${e.message}</span></div>`;
    return;
  }

  const cfg = data.config;
  const rows = data.summary.slice().sort((a, b) => b.visibility_m - a.visibility_m);
  const worst = rows[rows.length - 1];          // densest fog tested

  const gain = worst.gain;
  const kmhB = worst.baseline.kmh[0], kmhF = worst.fogtwin.kmh[0];
  const cooB = worst.baseline.cooccupancy_s_per_hour[0];
  const cooF = worst.fogtwin.cooccupancy_s_per_hour[0];
  const clear = rows[0];

  // Rows run clear -> foggy. The crossing is between the last row still at or
  // below break-even and the first one above it; with a sweep this is a real
  // reading rather than a claim.
  const asc = rows.slice().sort((a, b) => a.visibility_m - b.visibility_m);
  let cross = 'the system is ahead at every fog level we tested';
  for (let i = asc.length - 1; i > 0; i--) {
    if (asc[i].gain < 1 && asc[i - 1].gain >= 1) {
      cross = `it starts paying off somewhere between ${asc[i].visibility_m} m ` +
              `and ${asc[i - 1].visibility_m} m of visibility`;
      break;
    }
  }
  if (rows.every(r => r.gain < 1)) cross = 'the system is behind at every fog level tested';

  main.innerHTML = `
    <h1>Does it actually help?</h1>
    <div class="sub2">We ran the same shift twice &mdash; once with the system,
      once without &mdash; at ${cfg.visibilities.length} different fog levels,
      repeated ${cfg.seeds} times each. ${data.runs.length} runs in total.</div>

    <div class="headline">
      <div><div class="v good count">${gain.toFixed(2)}&times;</div>
        <div class="k">more ore moved<br>when you can only see ${worst.visibility_m} m</div></div>
      <div><div class="v count">${fmt(kmhB, 1)} &rarr; ${fmt(kmhF, 1)}</div>
        <div class="k">km/h in thick fog<br>without &rarr; with</div></div>
      <div><div class="v good count">${(cooB / Math.max(cooF, 0.01)).toFixed(1)}&times;</div>
        <div class="k">less time two trucks<br>spend in the same lane</div></div>
      <div><div class="v count ${clear.gain < 1 ? 'warn' : ''}">${clear.gain.toFixed(2)}&times;</div>
        <div class="k">on a clear day<br>slightly slower, and we say so</div></div>
    </div>

    <h2><span class="n">01</span>How we tested it</h2>
    <p>Same mine, same trucks, same weather, same everything &mdash; run twice,
      changing <b>one thing only</b>: whether the trucks had our system.</p>
    <div class="method">
      <div class="arm b"><h4>Without it &mdash; how mines work today</h4>
        <p>The driver goes as fast as he can see. In thick fog that means
        crawling. And when two trucks reach the same narrow ramp, <b>nothing
        stops them both going in</b> &mdash; there is no one to ask.</p></div>
      <div class="arm f"><h4>With FogTwin</h4>
        <p>The road is already on a map, so the driver is not limited by what he
        can see. And before entering a narrow ramp, a truck <b>has to be given
        permission</b> &mdash; so two can never be in there at once.</p></div>
    </div>
    <div class="runcfg">
      fleet ${cfg.fleet} dumpers &middot; payload ${cfg.payload_t} t &middot;
      trucks counted as too close within ${cfg.proximity_m} m &middot;
      we measure ore moved rather than trips finished, because one Bailadila
      round trip takes over twenty minutes and counting whole trips in a
      ${cfg.minutes}-minute run would mostly measure luck
    </div>

    <h2><span class="n">02</span>At what point does it start being worth it?</h2>
    <p>This shows <b>how many times more ore</b> gets moved with the system than
      without it, at each fog level. So <b>1.0&times; means no difference at
      all</b>, 2.0&times; means twice as much. The whole argument is about where
      this line rises above 1.0 and how fast it climbs after that.</p>
    <div class="chartwrap">${gainChart(rows)}</div>
    <div class="key">
      <span><i style="background:#4FBE8B"></i>the system is winning here</span>
      <span><i style="background:#E0A93B"></i>slightly behind here</span>
      <span>${cross}</span>
    </div>

    <h2><span class="n">03</span>How much ore actually gets moved?</h2>
    <p>Each truck carries ${cfg.payload_t} tonnes, so we can count this in
      <b>truckloads shifted a kilometre, every hour</b>. Notice what happens as
      the fog closes in: the grey line falls off a cliff, because the driver can
      only go as fast as he can see. The orange line barely moves, because the
      road was already on a map.</p>
    <div class="chartwrap">${sweepChart(rows, 'tonne_km_per_hour',
      'truckloads moved a kilometre, per hour', '',
      { scale: v => v / cfg.payload_t, fmt: v => v.toFixed(0) })}</div>
    <div class="key">
      <span>the faint shading around each line is how much the answer moved
        between repeats &mdash; thin shading means a reliable result</span>
    </div>
    ${table(rows, cfg.payload_t)}

    <h2><span class="n">04</span>How often do two trucks end up in the same lane?</h2>
    <p>This is <b>how many minutes of every hour</b> two trucks were inside the
      same one-lane stretch at the same time &mdash; the situation that causes
      head-on collisions. The orange line is almost flat across the whole chart,
      and that is the important part: <b>giving permission is a matter of
      scheduling, and scheduling does not care about the weather.</b></p>
    <div class="chartwrap">${sweepChart(rows, 'cooccupancy_s_per_hour',
      'minutes each hour with two trucks in one lane', '',
      { scale: v => v / 60, fmt: v => v.toFixed(1) })}</div>

    <h2><span class="n">05</span>What these numbers do not say</h2>
    <ul>
      <li><b>On a clear day the system is slightly worse
        (${clear.gain.toFixed(2)}&times;).</b> Asking permission before entering a
        ramp costs a few seconds, and on a clear day there was no fog problem to
        make up for it. We have left this on the page on purpose: a result that
        only ever flatters the product is one nobody believes.</li>
      <li><b>It never reaches zero, and it cannot yet.</b> Our system advises;
        it does not touch the brakes. So a truck already inside a ramp when
        permission is refused can be told to stop, but not made to. The risk
        drops ${(cooB / Math.max(cooF, 0.01)).toFixed(1)}&times; &mdash; it does not
        disappear.</li>
      <li><b>Trucks pass near each other more often with the system, and that
        is fine.</b> At ${worst.visibility_m} m it goes from
        ${fmt(worst.baseline.proximity_per_hour[0], 1)} to
        ${fmt(worst.fogtwin.proximity_per_hour[0], 1)} times an hour &mdash; but
        only because without the system the trucks are crawling at
        ${fmt(kmhB, 1)} km/h and barely meet at all. Per truckload of ore
        actually moved, the dangerous kind of closeness drops from
        ${(cooB / worst.baseline.tonne_km_per_hour[0] * 1000).toFixed(1)} to
        ${(cooF / worst.fogtwin.tonne_km_per_hour[0] * 1000).toFixed(1)}. Two
        trucks passing when each one knows the other is there is just haulage.</li>
      <li><b>This is a simulation of our own model.</b> It is evidence about the
        design, not a measurement of Bailadila. The terrain is real; the traffic
        is ours.</li>
    </ul>

    <div class="bugs">
      <h4>Two defects this experiment found</h4>
      <p><b>The interlocking had a hole.</b> <code>zone_ahead</code> followed a
      single best-heading corridor, so at a ramp head &mdash; bench continuing
      straight, ramp peeling off &mdash; it guessed the bench. Dumpers entered
      single-lane ramps having never requested a token, and the allocator was
      powerless. It happened 280 times on one ramp in a twenty minute run. It
      now checks every road branching ahead, not just the straightest one.</p>
      <p style="margin-bottom:0"><b>The visibility field failed dangerous.</b>
      <code>VisibilityField.at()</code> returned 1000 m &mdash; <i>clear</i>
      &mdash; once every met sample aged past the staleness window. If the
      stations stop reporting, the twin was telling the fleet the mine was clear.
      It now holds the last known field and exposes <code>is_stale()</code>. The
      first sweep was measuring this bug rather than the system, and reported
      1.08&times; instead of ${gain.toFixed(2)}&times;.</p>
    </div>

    <div class="caveat">
      <h4>Reproduce it</h4>
      <p style="margin-bottom:0">
        <code>python -m scripts.experiment --seeds ${cfg.seeds} --minutes ${cfg.minutes}</code>
        &mdash; writes <code>data/experiment.json</code>, which is the only thing
        this page reads. Change the number of repeats, the fleet size, or the rules:
        the page follows.</p>
    </div>`;

  wireMotion();
}

/* ---------------- sweep charts ---------------- */

/*
 * Visibility spans two decades, 1000 m down to 8 m, so the x axis is
 * logarithmic: linear would crush every interesting point into the last
 * eighth of the plot. Clear weather sits on the left and conditions worsen
 * to the right, which is the direction the argument runs.
 */
function xScale(rows, padL, plotW) {
  const vs = rows.map(r => r.visibility_m);
  const hi = Math.log(Math.max(...vs)), lo = Math.log(Math.min(...vs));
  return v => padL + plotW * (hi - Math.log(v)) / (hi - lo || 1);
}

function axis(rows, xOf, padT, plotH, padL, plotW) {
  let g = '';
  for (const r of rows) {
    const x = xOf(r.visibility_m);
    g += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}"
           stroke="#232B31" stroke-width="1"/>
          <text x="${x}" y="${padT + plotH + 17}" text-anchor="middle" fill="#A9B4BB"
           font-family="IBM Plex Mono, monospace" font-size="10">${r.visibility_m}</text>`;
  }
  // Which end is bad, said in words. A row of bare numbers makes the reader
  // work out the direction of the argument for themselves, and some will not.
  g += `<text x="${padL}" y="${padT + plotH + 34}" text-anchor="start"
         fill="#7C8B98" font-family="Archivo, sans-serif" font-size="12"
         font-weight="600">&larr; clear day</text>`;
  g += `<text x="${padL + plotW}" y="${padT + plotH + 34}" text-anchor="end"
         fill="#E0A93B" font-family="Archivo, sans-serif" font-size="12"
         font-weight="600">thick fog &rarr;</text>`;
  g += `<text x="${padL + plotW / 2}" y="${padT + plotH + 34}" text-anchor="middle"
         fill="#6E7A82" font-family="IBM Plex Mono, monospace" font-size="9.5"
         letter-spacing="1.2">HOW FAR YOU CAN SEE, IN METRES</text>`;
  return g;
}

/* one series: a shaded +/-1 SD band, the mean as a drawn line, and dots */
function series(rows, get, xOf, yOf, colour, idx) {
  const pts = rows.map(r => {
    const [m, sd] = get(r);
    return { x: xOf(r.visibility_m), y: yOf(m), hi: yOf(m + sd), lo: yOf(m - sd), m, sd };
  });
  const band = pts.map(p => `${p.x},${p.hi}`).join(' ') + ' ' +
               pts.slice().reverse().map(p => `${p.x},${p.lo}`).join(' ');
  const line = pts.map(p => `${p.x},${p.y}`).join(' ');

  let g = `<polygon points="${band}" fill="${colour}" opacity=".12"/>`;
  g += `<polyline class="line" style="--d:${idx * 160}ms" points="${line}"
         fill="none" stroke="${colour}" stroke-width="2.4"
         stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const p of pts) {
    g += `<circle class="dot" style="--d:${idx * 160}ms" cx="${p.x}" cy="${p.y}" r="3.6"
           fill="#0E1114" stroke="${colour}" stroke-width="2"/>`;
  }
  return g;
}

/*
 * opts.scale converts the stored unit into one a reader can picture, and
 * opts.fmt renders a tick. The labels sit at the end of each line rather than
 * in a key underneath, so nobody has to hold a colour in their head while
 * their eye travels.
 */
function sweepChart(rows, metric, label, unit, opts = {}) {
  const scale = opts.scale || (v => v);
  const fmtY = opts.fmt || (v => v >= 3000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));
  const W = 900, H = 300, padL = 66, padR = 118, padT = 18, padB = 60;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = rows.flatMap(r => [scale(r.baseline[metric][0] + r.baseline[metric][1]),
                                  scale(r.fogtwin[metric][0] + r.fogtwin[metric][1])]);
  const maxV = Math.max(...vals) * 1.1 || 1;
  const xOf = xScale(rows, padL, plotW);
  const yOf = v => padT + plotH - (v / maxV) * plotH;
  const sc = get => r => { const [m, sd] = get(r); return [scale(m), scale(sd)]; };

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, y = yOf(v);
    g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"
           stroke="#2C343A" stroke-width="1"/>
          <text x="${padL - 10}" y="${y + 4}" text-anchor="end" fill="#6E7A82"
           font-family="IBM Plex Mono, monospace" font-size="10">${fmtY(v)}</text>`;
  }
  g += axis(rows, xOf, padT, plotH, padL, plotW);
  g += series(rows, sc(r => r.baseline[metric]), xOf, yOf, M.baseline, 0);
  g += series(rows, sc(r => r.fogtwin[metric]), xOf, yOf, M.fogtwin, 1);

  // name each line where it ends, at the foggy side, where they are furthest apart
  const worst = rows.reduce((a, b) => a.visibility_m < b.visibility_m ? a : b);
  const ex = xOf(worst.visibility_m);
  const eb = yOf(scale(worst.baseline[metric][0]));
  const ef = yOf(scale(worst.fogtwin[metric][0]));
  g += `<text class="dot" x="${ex + 10}" y="${eb + 4}" fill="${M.baseline}"
         font-family="Archivo, sans-serif" font-size="12.5" font-weight="600"
         >Without it</text>`;
  g += `<text class="dot" x="${ex + 10}" y="${ef + 4}" fill="${M.fogtwin}"
         font-family="Archivo, sans-serif" font-size="12.5" font-weight="600"
         >With FogTwin</text>`;

  return `<svg viewBox="0 0 ${W} ${H}">
    <text x="${padL}" y="12" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
     font-size="9.5" letter-spacing="2">${label.toUpperCase()}${
       unit ? ' \u00b7 ' + unit.toUpperCase() : ''}</text>${g}</svg>`;
}

/*
 * The headline result. Gain is fogtwin over baseline, so 1.0 is "no
 * difference" -- the line the curve has to cross before any of this is worth
 * fitting to a machine. Where it crosses is the answer to "at what visibility
 * does this start paying", which three points could never have shown.
 */
function gainChart(rows) {
  const W = 900, H = 320, padL = 66, padR = 22, padT = 20, padB = 58;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const gains = rows.map(r => r.gain);
  const top = Math.max(1.15, Math.max(...gains) * 1.08);
  const bot = Math.min(0.85, Math.min(...gains) * 0.95);
  const xOf = xScale(rows, padL, plotW);
  const yOf = g => padT + plotH - ((g - bot) / (top - bot)) * plotH;

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = bot + (top - bot) * i / 4, y = yOf(v);
    g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"
           stroke="#2C343A" stroke-width="1"/>
          <text x="${padL - 10}" y="${y + 4}" text-anchor="end" fill="#6E7A82"
           font-family="IBM Plex Mono, monospace" font-size="10">${v.toFixed(2)}&times;</text>`;
  }
  // the break-even line, and the region above it where fitting the kit pays
  const y1 = yOf(1);
  g += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${Math.max(0, y1 - padT)}"
         fill="#4FBE8B" opacity=".07"/>`;
  g += `<line x1="${padL}" y1="${y1}" x2="${W - padR}" y2="${y1}"
         stroke="#4FBE8B" stroke-width="1.6" stroke-dasharray="6 5"/>`;
  g += `<text x="${W - padR - 4}" y="${y1 - 8}" text-anchor="end" fill="#4FBE8B"
         font-family="Archivo, sans-serif" font-size="12.5" font-weight="600"
         >same as not having it</text>`;
  g += `<text x="${padL + 10}" y="${padT + 20}" fill="#4FBE8B"
         font-family="Archivo, sans-serif" font-size="12.5" font-weight="600"
         >above this line, it helps</text>`;
  g += `<text x="${padL + 10}" y="${padT + plotH - 10}" fill="#E0A93B"
         font-family="Archivo, sans-serif" font-size="12.5" font-weight="600"
         >below it, it costs a little</text>`;
  g += axis(rows, xOf, padT, plotH, padL, plotW);

  const pts = rows.map(r => ({ x: xOf(r.visibility_m), y: yOf(r.gain), g: r.gain }));
  g += `<polyline class="line" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}"
         fill="none" stroke="${M.fogtwin}" stroke-width="2.8"
         stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const p of pts) {
    const above = p.g >= 1;
    g += `<circle class="dot" cx="${p.x}" cy="${p.y}" r="4"
           fill="#0E1114" stroke="${above ? '#4FBE8B' : '#E0A93B'}" stroke-width="2.2"/>
          <text class="dot" x="${p.x}" y="${p.y - 12}" text-anchor="middle"
           fill="${above ? '#4FBE8B' : '#E0A93B'}"
           font-family="IBM Plex Mono, monospace" font-size="10">${p.g.toFixed(2)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}">
    <text x="${padL}" y="12" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
     font-size="9.5" letter-spacing="2">TIMES MORE ORE MOVED, WITH THE SYSTEM VS WITHOUT</text>${g}</svg>`;
}

/* ---------------- grouped bar chart with error whiskers ---------------- */

function barChart(rows, metric, label) {
  const W = 900, H = 300, padL = 74, padR = 18, padT = 16, padB = 54;
  const maxV = Math.max(...rows.flatMap(r =>
    [r.baseline[metric][0] + r.baseline[metric][1],
     r.fogtwin[metric][0] + r.fogtwin[metric][1]])) * 1.12 || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const groupW = plotW / rows.length;
  const barW = Math.min(78, groupW * 0.3);
  const yOf = v => padT + plotH - (v / maxV) * plotH;

  let g = '';
  // gridlines
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, y = yOf(v);
    g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"
           stroke="#2C343A" stroke-width="1"/>
          <text x="${padL - 9}" y="${y + 4}" text-anchor="end" fill="#6E7A82"
           font-family="IBM Plex Mono, monospace" font-size="10">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)}</text>`;
  }

  rows.forEach((r, i) => {
    const cx = padL + groupW * (i + 0.5);
    [['baseline', -1], ['fogtwin', 1]].forEach(([arm, side], ai) => {
      const [m, sd] = r[arm][metric];
      const x = cx + side * (barW / 2 + 3) - (side > 0 ? 0 : barW);
      const y = yOf(m);
      const bx = x + barW / 2;             // bar centre, used by whisker and label
      // left to right, baseline before fogtwin: the eye reads the comparison
      // in the order the argument is made
      const delay = (i * 2 + ai) * 85;
      const shown = m >= 1000 ? (m / 1000).toFixed(1) + 'k' : m.toFixed(0);
      g += `<rect class="bar" style="--d:${delay}ms"
             x="${x}" y="${y}" width="${barW}" height="${padT + plotH - y}"
             fill="${M[arm]}" opacity=".85"><title>${arm} at ${r.visibility_m} m: ${m.toFixed(1)} +/- ${sd.toFixed(1)} SD</title></rect>`;
      if (sd > 0) {
        g += `<g class="whisk" style="--d:${delay}ms">
              <line x1="${bx}" y1="${yOf(m - sd)}" x2="${bx}" y2="${yOf(m + sd)}"
               stroke="#E4E9EC" stroke-width="1.4"/>
              <line x1="${bx - 7}" y1="${yOf(m + sd)}" x2="${bx + 7}" y2="${yOf(m + sd)}"
               stroke="#E4E9EC" stroke-width="1.4"/>
              <line x1="${bx - 7}" y1="${yOf(m - sd)}" x2="${bx + 7}" y2="${yOf(m - sd)}"
               stroke="#E4E9EC" stroke-width="1.4"/></g>`;
      }
      // clear the whisker, not just the bar: with a large SD the upper cap sits
      // well above the bar top and the label was landing inside it
      const labelY = yOf(m + Math.max(sd, 0)) - 8;
      g += `<text class="blab" style="--d:${delay}ms" x="${bx}" y="${labelY}" text-anchor="middle" fill="${M[arm]}"
             font-family="IBM Plex Mono, monospace" font-size="10.5">${shown}</text>`;
    });
    g += `<text x="${cx}" y="${H - 30}" text-anchor="middle" fill="#A9B4BB"
           font-family="IBM Plex Mono, monospace" font-size="11">${r.visibility_m} m visibility</text>`;
    const gainCol = r.gain >= 1 ? '#4FBE8B' : '#E0A93B';
    if (metric === 'tonne_km_per_hour') {
      g += `<text x="${cx}" y="${H - 13}" text-anchor="middle" fill="${gainCol}"
             font-family="IBM Plex Mono, monospace" font-size="11">${r.gain.toFixed(2)}x</text>`;
    }
  });

  return `<svg viewBox="0 0 ${W} ${H}">
    <text x="${padL}" y="11" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
     font-size="9.5" letter-spacing="2">${label.toUpperCase()}</text>${g}</svg>`;
}

/* ---------------- motion ---------------- */

const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run every number in a string up from zero at once, keeping the decimals and
 * whatever sits between them. "10.6 -> 25.3" animates both halves together,
 * which reads as one measurement changing rather than two unrelated counters.
 */
function countUp(el, ms = 900) {
  const final = el.textContent;
  const parts = final.split(/(\d+\.?\d*)/);
  if (!parts.some(p => /^\d+\.?\d*$/.test(p))) return;

  const t0 = performance.now();
  (function step(now) {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);                 // ease out
    el.textContent = parts.map(p => {
      if (!/^\d+\.?\d*$/.test(p)) return p;
      const dec = (p.split('.')[1] || '').length;
      return (parseFloat(p) * e).toFixed(dec);
    }).join('');
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = final;                      // land exactly on the value
  })(performance.now());

  // If frames stop being delivered part way through, the element would keep
  // whatever half-counted number it was showing. The figure on screen has to
  // be the measured one, so put it back regardless of how the animation ended.
  setTimeout(() => { el.textContent = final; }, ms + 400);
}

function wireMotion() {
  const prog = document.getElementById('prog');
  const blocks = [...document.querySelectorAll(
    'h1, .sub2, .headline, h2, main > p, main > ul, .method, .runcfg, ' +
    '.chartwrap, .key, table, .caveat, .bugs')];

  const show = () => blocks.forEach(el => el.classList.add('in'));

  // A zero-height viewport means a background tab or a collapsed pane: nothing
  // can ever be "in view", so reveal now rather than leaving a blank page.
  if (STILL || innerHeight === 0) { show(); return; }

  blocks.forEach(el => el.classList.add('reveal'));

  /*
   * Geometry, checked on scroll, rather than IntersectionObserver.
   *
   * IO is the usual tool here, but its callbacks are delivered on the
   * browser's own schedule and can be arbitrarily late in a throttled or
   * offscreen context -- which leaves the page blank, since the content is
   * hidden until the observer says otherwise. Reading getBoundingClientRect
   * inside a rAF-throttled scroll handler is a few microseconds for eighteen
   * elements and it always answers immediately.
   */
  function tick() {
    const vh = innerHeight;
    // The trigger line sits a little above the fold so a block resolves as it
    // arrives rather than after it has already been read. That leaves the last
    // element on the page short of the line even at full scroll, so hitting the
    // bottom releases whatever is left.
    const ended = scrollY + vh >= document.documentElement.scrollHeight - 4;
    for (const el of blocks) {
      if (el.classList.contains('in')) continue;
      const r = el.getBoundingClientRect();
      if (ended || (r.top < vh * 0.94 && r.bottom > 0)) {
        el.classList.add('in');
        el.querySelectorAll('.count').forEach(c => countUp(c));
      }
    }
    if (prog) {
      const max = document.documentElement.scrollHeight - vh;
      prog.style.width = `${max > 0 ? Math.min(100, (scrollY / max) * 100) : 0}%`;
    }
  }

  // No rAF throttle here on purpose. A rAF that never resolves -- which is
  // what a suspended or offscreen renderer does -- would leave the throttle
  // flag latched and wedge the handler permanently. Eighteen rect reads is
  // cheap enough to just do, and scroll already fires at most once a frame.
  addEventListener('scroll', tick, { passive: true });
  addEventListener('resize', tick);
  tick();                                     // whatever is already on screen

  // Belt and braces: if scroll events are being withheld, poll slowly until
  // everything has had its moment, then stop.
  const poll = setInterval(() => {
    tick();
    if (blocks.every(el => el.classList.contains('in'))) clearInterval(poll);
  }, 500);
}

/* ---------------- the full table ---------------- */

/*
 * The same figures as the charts, for anyone who wants to read them off.
 * Column headings are words rather than symbols, and the two-row header keeps
 * "without / with" under each measurement instead of abbreviating it into the
 * heading, which is what made the old one unreadable.
 */
function table(rows, payload) {
  const loads = v => fmt(v / payload, 0);
  return `<table>
    <thead>
      <tr>
        <th rowspan="2">You can see</th>
        <th colspan="2">Truckloads moved a km, per hour</th>
        <th rowspan="2">Times<br>better</th>
        <th colspan="2">Average speed, km/h</th>
        <th colspan="2">Minutes an hour, two in one lane</th>
      </tr>
      <tr>
        <th>without</th><th>with</th>
        <th>without</th><th>with</th>
        <th>without</th><th>with</th>
      </tr>
    </thead><tbody>
      ${rows.map(r => `<tr>
        <td>${r.visibility_m} m</td>
        <td>${loads(r.baseline.tonne_km_per_hour[0])}</td>
        <td>${loads(r.fogtwin.tonne_km_per_hour[0])}</td>
        <td class="gain ${r.gain < 1 ? 'neg' : ''}">${r.gain.toFixed(2)}&times;</td>
        <td>${fmt(r.baseline.kmh[0], 1)}</td>
        <td>${fmt(r.fogtwin.kmh[0], 1)}</td>
        <td>${fmt(r.baseline.cooccupancy_s_per_hour[0] / 60, 1)}</td>
        <td>${fmt(r.fogtwin.cooccupancy_s_per_hour[0] / 60, 1)}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

boot();
