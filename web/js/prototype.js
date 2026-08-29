/* FogTwin — the ESP32 prototype node.

   A build page, not a brochure. Wiring, bill of materials, flashing steps, the
   exact message the node puts on the wire, and a live indicator showing whether
   one is talking to this twin right now.

   The claim it supports is narrow and true: the twin cannot tell a 900-rupee
   ESP32 apart from a simulated 100 tonne dumper, because both publish the same
   VehicleState and both obey the advisory that comes back. */

const BOM = [
  ['ESP32 DevKit V1', 'the node', 350],
  ['MPU-6050 IMU', 'heading rate, over I2C', 130],
  ['Breadboard + jumpers', 'no soldering needed', 150],
  ['USB power bank', 'reuse any phone bank', 250],
  ['HB100 Doppler module', 'optional: stands in for the 77 GHz radar', 300],
];

const PINS = [
  ['MPU-6050 VCC', 'ESP32 3V3', '#E4574F'],
  ['MPU-6050 GND', 'ESP32 GND', '#6E7A82'],
  ['MPU-6050 SDA', 'ESP32 GPIO21', '#4FBE8B'],
  ['MPU-6050 SCL', 'ESP32 GPIO22', '#6FA8C8'],
  ['HB100 IF out', 'ESP32 GPIO34', '#E0A93B'],
];

function boot() {
  const required = BOM.filter(b => !b[1].startsWith('optional'));
  const minTotal = required.reduce((a, b) => a + b[2], 0);
  const maxTotal = BOM.reduce((a, b) => a + b[2], 0);

  document.getElementById('main').innerHTML = `
    <h1>The prototype we can actually build</h1>
    <div class="sub2">ESP32 node &middot; &#8377;${minTotal} required, &#8377;${maxTotal} with the Doppler module</div>

    <p>We do not have a 100 tonne dumper, and a page that pretended otherwise
      would fall apart the moment a judge asked to see one. What we have instead
      is a node that speaks the production protocol. It publishes the same
      <code>VehicleState</code> message a real machine publishes, at the same
      5&nbsp;Hz, and it obeys the advisory that comes back: it slows to the
      segment speed limit and it stops dead when its conflict-zone token is
      refused.</p>
    <p><b>The twin cannot tell it apart from the simulated fleet.</b> It appears
      in the control room list, it has its own entry in the cab picker, and it
      gets tokens arbitrated against six virtual dumpers. That is the whole
      claim, and it is the one thing on this project that costs under a thousand
      rupees to verify.</p>

    <h2><span class="n">01</span>Is a node online right now?</h2>
    <div class="live" id="live"></div>
    <p style="margin-top:10px;font-size:12.5px;color:var(--ink-3)">
      Polls <code>/api/snapshot</code> every two seconds and looks for a vehicle
      id starting <code>RV-</code>. No hardware to hand? Run
      <code>python firmware/rover_desktop.py</code> &mdash; identical protocol,
      so the same indicator lights up.</p>

    <h2><span class="n">02</span>Bill of materials</h2>
    <table>
      <thead><tr><th>Part</th><th>What it does</th><th class="r">&#8377;</th></tr></thead>
      <tbody>
        ${BOM.map(([p, w, c]) => `<tr><td>${p}</td><td>${w}</td><td class="r">${c}</td></tr>`).join('')}
        <tr class="total"><td>Required only</td><td></td><td class="r">${minTotal}</td></tr>
      </tbody>
    </table>
    <div class="note">
      <h4>Why an IMU and not a GPS</h4>
      <p style="margin-bottom:0">GNSS does not work inside a hall, so the node
      cannot borrow the production localisation story. It integrates heading from
      the gyro instead and reports a <b>growing</b> <code>pos_conf</code> as it
      drifts. That is deliberate: the control room then draws a widening
      staleness ring around it and eventually drops it into Mode&nbsp;D, which is
      exactly the uncertainty behaviour a real dumper gets under the highwall.
      The prototype demonstrates the degraded path for free.</p>
    </div>

    <h2><span class="n">03</span>Wiring</h2>
    <div class="wirewrap">${wiring()}</div>
    <table>
      <thead><tr><th>From</th><th>To</th></tr></thead>
      <tbody>${PINS.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody>
    </table>
    <p style="font-size:12.5px;color:var(--ink-3)">The HB100 is optional. Its IF
      output needs a 100&nbsp;nF series capacitor and a 10k/10k divider to bias
      around 1.65&nbsp;V before it reaches GPIO34, or the ADC sees nothing useful.</p>

    <h2><span class="n">04</span>Flashing it</h2>
    <ol>
      <li>Arduino IDE &rarr; <b>Preferences</b> &rarr; Additional Board Manager URLs:
        <code>https://espressif.github.io/arduino-esp32/package_esp32_index.json</code></li>
      <li><b>Boards Manager</b> &rarr; install <code>esp32 by Espressif Systems</code>.
        Select board <b>ESP32 Dev Module</b>.</li>
      <li>Open <code>firmware/rover_esp32/rover_esp32.ino</code> and edit the four
        constants at the top: <code>WIFI_SSID</code>, <code>WIFI_PASS</code>,
        <code>TWIN_HOST</code> and <code>VEHICLE_ID</code>.</li>
      <li><code>TWIN_HOST</code> is the laptop running the twin, on the same
        network &mdash; something like <code>http://192.168.1.20:8000</code>.
        <b>Not</b> <code>localhost</code>: that would be the ESP32 itself.</li>
      <li>Start the twin with <code>python run_demo.py</code>, then upload. Watch
        the serial monitor at 115200 baud, and watch this page.</li>
    </ol>
    <div class="note warnnote">
      <h4>Two things that will catch you out</h4>
      <p>The twin binds <code>0.0.0.0</code> so it is reachable from the network,
      but <b>Windows Firewall will block port 8000 on first run</b>. Allow it, or
      the ESP32 gets connection refused and the serial log fills with
      <code>uplink -1</code>.</p>
      <p style="margin-bottom:0">Most ESP32 boards are <b>2.4&nbsp;GHz only</b>.
      A 5&nbsp;GHz phone hotspot will look like a wrong password. Force the
      hotspot to 2.4&nbsp;GHz.</p>
    </div>

    <h2><span class="n">05</span>What it puts on the wire</h2>
    <p>Six fields carry it. Everything else in the schema has a default, which
      was a deliberate decision when the contract was frozen: hardware should be
      able to join the twin without implementing the whole message.</p>
    <pre>POST /ingest/state
{
  "<b>vehicle_id</b>": "RV-201",
  "<b>x</b>": 260.0, "<b>y</b>": -40.0, "z": 1173.0,   <span style="color:#6E7A82">ENU metres from the Bailadila crest</span>
  "<b>heading</b>": 2.6,                    <span style="color:#6E7A82">radians, 0 = east</span>
  "<b>speed</b>": 3.0,                      <span style="color:#6E7A82">m/s</span>
  "<b>pos_conf</b>": 0.05                   <span style="color:#6E7A82">1-sigma position error, metres</span>
}</pre>
    <p>And what comes back, which the node then obeys:</p>
    <pre>GET /advisory/RV-201
{
  "speed_advisory_ms": 5.6,             <span style="color:#6E7A82">slow to this</span>
  "token": { "state": "held", "zone_id": "RAMP-E" },   <span style="color:#6E7A82">stop</span>
  "alert": "caution", "visibility_m": 8.0
}</pre>
    <div class="note">
      <h4>Report the honest uncertainty</h4>
      <p style="margin-bottom:0"><code>pos_conf</code> is the field to resist
      fudging. Report the real number and the twin will draw it, cap your speed,
      and past one metre refuse you a token entirely. Lying there to make the
      demo look tidy would defeat the point of having the field at all &mdash;
      and the degraded behaviour is more interesting to a judge than a node that
      pretends to be perfect.</p>
    </div>

    <h2><span class="n">06</span>Scale</h2>
    <p>A demo table is a couple of metres across; the mine is kilometres. The
      firmware maps one metre of table to <code>ROVER_SCALE</code> metres of
      mine, currently 400. <b>Say that number out loud in the pitch.</b> It is a
      completely reasonable thing to do and a slightly awkward thing to be caught
      doing.</p>`;

  poll();
}

/* ---------------- wiring diagram ---------------- */

function wiring() {
  const W = 880, H = 300;
  const esp = { x: 90, y: 60, w: 150, h: 190 };
  const mpu = { x: 480, y: 62, w: 140, h: 96 };
  const hb = { x: 480, y: 190, w: 140, h: 62 };

  const box = (b, title, sub, colour) => `
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3"
      fill="#171B1F" stroke="${colour}" stroke-width="1.5"/>
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="4" fill="${colour}"/>
    <text x="${b.x + b.w / 2}" y="${b.y + 24}" text-anchor="middle" fill="#E4E9EC"
      font-family="IBM Plex Mono, monospace" font-size="12">${title}</text>
    <text x="${b.x + b.w / 2}" y="${b.y + 40}" text-anchor="middle" fill="#6E7A82"
      font-family="IBM Plex Mono, monospace" font-size="9.5">${sub}</text>`;

  let wires = '', labels = '';
  PINS.forEach(([from, to, colour], i) => {
    const isHb = from.startsWith('HB100');
    const y = isHb ? hb.y + 42 : mpu.y + 56 + i * 14;
    const ey = esp.y + 62 + i * 26;
    const midX = 360 + i * 12;
    const src = isHb ? hb.x : mpu.x;
    wires += `
      <path d="M ${esp.x + esp.w} ${ey} H ${midX} V ${y} H ${src}"
        fill="none" stroke="${colour}" stroke-width="2" opacity=".85"/>
      <circle cx="${esp.x + esp.w}" cy="${ey}" r="3" fill="${colour}"/>
      <circle cx="${src}" cy="${y}" r="3" fill="${colour}"/>`;
    // label the pin ON the wire, just clear of the board. Drawing it inside the
    // box put it underneath the box fill and it vanished.
    labels += `<text x="${esp.x + esp.w + 9}" y="${ey - 5}" fill="${colour}"
        font-family="IBM Plex Mono, monospace" font-size="9.5">${to.replace('ESP32 ', '')}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}">
    <text x="20" y="24" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
      font-size="9.5" letter-spacing="2.2">BREADBOARD WIRING &mdash; NO SOLDERING</text>
    ${box(esp, 'ESP32', 'DevKit V1', '#E4652F')}
    ${box(mpu, 'MPU-6050', 'IMU, I2C', '#4FBE8B')}
    ${box(hb, 'HB100', 'Doppler, optional', '#E0A93B')}
    ${wires}${labels}
    <text x="${esp.x + esp.w / 2}" y="${esp.y + esp.h - 14}" text-anchor="middle"
      fill="#6E7A82" font-family="IBM Plex Mono, monospace" font-size="9.5">USB &rarr; power bank</text>
    <text x="700" y="${mpu.y + 60}" fill="#6E7A82"
      font-family="IBM Plex Mono, monospace" font-size="10">heading rate</text>
    <text x="700" y="${hb.y + 40}" fill="#6E7A82"
      font-family="IBM Plex Mono, monospace" font-size="10">closing speed</text>
  </svg>`;
}

/* ---------------- live node indicator ---------------- */

async function poll() {
  const el = document.getElementById('live');
  try {
    const snap = await (await fetch('/api/snapshot')).json();
    const rovers = snap.vehicles.filter(v => v.vehicle_id.startsWith('RV-'));
    const fleet = snap.vehicles.length;

    if (!rovers.length) {
      el.innerHTML = `
        <div><div class="v off"><span class="pulse"></span>offline</div>
          <div class="k">no RV- node publishing</div></div>
        <div><div class="v">${fleet}</div><div class="k">vehicles in the twin</div></div>
        <div><div class="v off">&mdash;</div><div class="k">position confidence</div></div>
        <div><div class="v off">&mdash;</div><div class="k">twin advisory</div></div>`;
    } else {
      const r = rovers[0];
      const alert = snap.alerts[r.vehicle_id] || 'info';
      const mode = snap.modes[r.vehicle_id] || 'A';
      const age = snap.ages[r.vehicle_id] ?? 0;
      el.innerHTML = `
        <div><div class="v on"><span class="pulse on"></span>${r.vehicle_id}</div>
          <div class="k">publishing &middot; last heard ${age.toFixed(1)} s ago</div></div>
        <div><div class="v">${(r.speed * 3.6).toFixed(0)}<span style="font-size:13px;color:var(--ink-3)"> km/h</span></div>
          <div class="k">obeying the twin advisory</div></div>
        <div><div class="v ${r.pos_conf > 1 ? 'off' : 'on'}">${r.pos_conf.toFixed(2)}<span style="font-size:13px;color:var(--ink-3)"> m</span></div>
          <div class="k">reported position confidence &middot; mode ${mode}</div></div>
        <div><div class="v">${alert}</div>
          <div class="k">alert level from the twin</div></div>`;
    }
  } catch (e) {
    el.innerHTML = `<div><div class="v off">twin unreachable</div>
      <div class="k">is the server running?</div></div>`;
  }
  setTimeout(poll, 2000);
}

boot();
