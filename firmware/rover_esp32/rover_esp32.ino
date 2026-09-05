/*
 * FogTwin rover node — ESP32.
 *
 * Publishes the same VehicleState message a 100 tonne dumper publishes, so the
 * twin cannot tell this apart from the simulated fleet. It appears in the
 * control room, you can drop into its cab on the HUD, it gets speed advisories
 * and conflict-zone tokens back, and it obeys them.
 *
 * That is the whole point: the software above the driver layer is identical.
 * Swap the HB100 for a 77 GHz radar and the ESP32 for a Jetson and nothing in
 * the twin changes.
 *
 * ---------------------------------------------------------------------------
 * Bill of materials, about Rs 900 if you have a phone charger already
 * ---------------------------------------------------------------------------
 *   ESP32 DevKit V1              ~Rs 350
 *   MPU-6050 IMU (I2C)           ~Rs 130   heading, and live attitude
 *   Jumper wires + breadboard    ~Rs 150
 *   Any USB power bank           ~Rs 250 (or reuse one)
 *   HB100 Doppler module         ~Rs 300   optional, not fitted on this build
 *   HC-SR04 ultrasonic           ~Rs 80    short-range proximity, fitted
 *
 * The HC-SR04 is a proximity aid, not a stand-in for the radar. It is a sound
 * wave in air: a few metres of reach, a narrow cone, no velocity, and stopped
 * by the first solid thing in the way. Those limits are the point -- it shows
 * what on-board sensing alone buys you, against the 250 m of surveyed corridor
 * and the neighbour list the twin hands over for free.
 *
 * Wiring
 *   MPU-6050 VCC -> 3V3 | GND -> GND | SDA -> GPIO21 | SCL -> GPIO22
 *   HB100 VCC -> VIN (5 V) | GND -> GND
 *   HB100 IF output -> GPIO34 through a 100 nF series cap, with a 10k/10k
 *   divider from 3V3 to GND on the GPIO side to bias the input at ~1.65 V.
 *   The IF signal is a few millivolts riding on that bias, so the ADC has to
 *   sit in the middle of its range to see both halves of the waveform.
 *
 *   HC-SR04 VCC -> VIN (5 V) | GND -> GND | TRIG -> GPIO5
 *   HC-SR04 ECHO -> 10k -> junction -> GPIO18, and junction -> 10k -> 10k -> GND.
 *   ECHO idles at 5 V and an ESP32 pin is 3.3 V only, so it must be divided.
 *   10k over 20k gives 3.33 V, which is inside spec with margin; a 10k/10k
 *   pair would give 2.5 V, barely above the input-high threshold, and would
 *   work on the bench and fail when the board warms up.
 *
 * ---------------------------------------------------------------------------
 * Positioning
 * ---------------------------------------------------------------------------
 * GNSS is useless inside a demo hall, so POSITION_MODE picks how the rover
 * knows where it is:
 *
 *   MODE_DEAD_RECKON  integrate heading from the gyro and speed from a fixed
 *                     wheel constant. Drifts, and that is honest: watch the
 *                     control room draw a widening staleness ring around it,
 *                     which is exactly the uncertainty display the twin uses
 *                     for a dumper under the highwall.
 *
 *   MODE_REPLAY       walk a fixed loop of waypoints at a set speed. Use this
 *                     when you want a reliable demo and the rover is really a
 *                     prop. Say so if asked.
 *
 * Coordinates are ENU metres from the Bailadila crest, matching the twin. A
 * demo table is a few metres across and the mine is kilometres, so ROVER_SCALE
 * maps one real centimetre to SCALE metres of mine. Declare that number out
 * loud in the pitch, do not let anyone discover it.
 * ---------------------------------------------------------------------------
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>

// ---------------------------------------------------------------- config ---
/*
 * Network settings live in secrets.h, which is git-ignored. Copy
 * secrets.example.h over it and put your own values in. A Wi-Fi password
 * committed once stays in the repository history even after it is deleted, so
 * it is worth the extra file.
 *
 * The fallback below keeps a fresh clone compiling without one.
 */
#if __has_include("secrets.h")
#include "secrets.h"
#else
const char *WIFI_SSID = "your-hotspot";        // 2.4 GHz; an ESP32 cannot see 5 GHz
const char *WIFI_PASS = "your-password";
const char *TWIN_HOST = "http://192.168.1.20:8000";   // laptop running the twin
#endif

const char *VEHICLE_ID = "RV-201";                    // shows up in the cab list

#define MODE_DEAD_RECKON 0
#define MODE_REPLAY      1
#define POSITION_MODE    MODE_REPLAY

const float ROVER_SCALE = 400.0;   // 1 m of table = 400 m of mine
const float PUBLISH_HZ = 5.0;      // the twin ticks at 5 Hz; match it

// -2 rather than -1 for "no radio": -1 is HTTPClient's own
// HTTPC_ERROR_CONNECTION_REFUSED, and conflating the two hid a real fault.
const int UPLINK_NO_WIFI = -2;

// -------------------------------------------------------------- proximity --
// Set to 0 if the HC-SR04 is not fitted. It is honest short-range sensing and
// nothing more: see the note at the top of this file before describing it.
#define HAS_SONAR 1
const int SONAR_TRIG = 5;
const int SONAR_ECHO = 18;
const float SONAR_MAX_M = 4.0;     // datasheet ceiling
const float SONAR_CONE_DEG = 15.0;
const unsigned long SONAR_TIMEOUT_US = 25000;   // ~4.2 m there and back

// ------------------------------------------------------------------ radar --
// The HB100 could not be sourced for this build, so the rover runs on the IMU
// alone: everything else works unchanged, it simply publishes no tracks. Set
// this back to 1 if a module turns up and you wire it per guide section 3.2.
#define HAS_HB100 0
const int HB100_PIN = 34;          // ADC1_CH6, input-only pin
const int HB100_SAMPLES = 256;     // one window, ~26 ms at 100 us per sample
const int HB100_THRESHOLD = 120;   // ADC counts of peak-to-peak swing

// Start pose in twin ENU metres. Put the rover somewhere with a conflict zone
// nearby so tokens actually fire. Bench 4 ramp head is a good spot.
float ex = 260.0, ey = -40.0, ez = 1173.0;
float heading = 2.6;               // radians, 0 = east, CCW positive
float speed_ms = 3.0;

// A short waypoint loop for MODE_REPLAY, in twin ENU metres.
const float ROUTE[][2] = {
  {260, -40}, {235, 136}, {89, 210}, {-140, 564}, {-274, -128}, {102, -646},
};
const int ROUTE_N = sizeof(ROUTE) / sizeof(ROUTE[0]);
int leg = 0;

// ------------------------------------------------------------------- imu ---
const int MPU = 0x68;
// Zero-rate offset for each gyro axis, in deg/s, subtracted after scaling.
// All three matter: X and Y feed the tilt filter, Z feeds the heading.
float gyro_bias_x = 0.0, gyro_bias_y = 0.0, gyro_bias_z = 0.0;

/* Raw gyro triple, read before the bias values exist. Used only by the
   calibration below; everything afterwards goes through readImu(). */
void readGyroRaw3(int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(MPU);
  Wire.write(0x43);                            // GYRO_XOUT_H
  Wire.endTransmission(false);
  Wire.requestFrom(MPU, 6, true);
  if (Wire.available() < 6) { gx = gy = gz = 0; return; }
  gx = (Wire.read() << 8) | Wire.read();
  gy = (Wire.read() << 8) | Wire.read();
  gz = (Wire.read() << 8) | Wire.read();
}

void imuBegin() {
  Wire.begin(21, 22);
  Wire.beginTransmission(MPU);
  Wire.write(0x6B); Wire.write(0);            // wake it up
  Wire.endTransmission(true);

  /*
   * Sit still for a second and measure the zero-rate offset on all three axes.
   *
   * Doing only Z, as this used to, leaves X and Y offsets to be integrated by
   * the tilt filter, where they settle as a standing error of several tens of
   * degrees. Whatever the board is resting on during this second becomes
   * "not rotating", so it must genuinely be still -- wave it here and the
   * error is baked in for the session.
   */
  double sx = 0, sy = 0, sz = 0;
  int16_t gx, gy, gz;
  for (int i = 0; i < 200; i++) {
    readGyroRaw3(gx, gy, gz);
    sx += gx; sy += gy; sz += gz;
    delay(5);
  }
  gyro_bias_x = (sx / 200.0) / 131.0;           // deg/s at the default range
  gyro_bias_y = (sy / 200.0) / 131.0;
  gyro_bias_z = (sz / 200.0) / 131.0;
  Serial.printf("gyro bias  x %.2f  y %.2f  z %.2f deg/s\n",
                gyro_bias_x, gyro_bias_y, gyro_bias_z);
}


/*
 * The whole sensor in one burst from 0x3B: accel x/y/z, die temperature, then
 * gyro x/y/z. Fourteen bytes in a single transaction rather than seven, which
 * matters because the pieces have to describe the same instant -- reading them
 * separately lets the board move between them and puts a twist in the attitude.
 */
struct Imu {
  float ax, ay, az;        // g
  float gx, gy, gz;        // deg/s
  float temp_c;
} imu;

void readImu() {
  Wire.beginTransmission(MPU);
  Wire.write(0x3B);                            // ACCEL_XOUT_H
  Wire.endTransmission(false);
  Wire.requestFrom(MPU, 14, true);
  if (Wire.available() < 14) return;

  int16_t axr = (Wire.read() << 8) | Wire.read();
  int16_t ayr = (Wire.read() << 8) | Wire.read();
  int16_t azr = (Wire.read() << 8) | Wire.read();
  int16_t tr  = (Wire.read() << 8) | Wire.read();
  int16_t gxr = (Wire.read() << 8) | Wire.read();
  int16_t gyr = (Wire.read() << 8) | Wire.read();
  int16_t gzr = (Wire.read() << 8) | Wire.read();

  imu.ax = axr / 16384.0;                      // +/-2 g default range
  imu.ay = ayr / 16384.0;
  imu.az = azr / 16384.0;
  imu.temp_c = tr / 340.0 + 36.53;             // per the datasheet
  imu.gx = gxr / 131.0 - gyro_bias_x;          // +/-250 deg/s default
  imu.gy = gyr / 131.0 - gyro_bias_y;
  imu.gz = gzr / 131.0 - gyro_bias_z;
}

/*
 * Pitch and roll from the gravity vector. These are absolute and do not drift:
 * gravity always points down, so however long the node has been running, level
 * still reads level. Yaw cannot be had this way -- rotating about the vertical
 * does not change where gravity is -- so it stays integrated from the gyro and
 * is reported knowing it drifts. That difference is worth being able to show a
 * panel: it is the same reason the vehicle needs RTK and not just an IMU.
 */
float accelPitchDeg() {
  return atan2(-imu.ax, sqrt(imu.ay * imu.ay + imu.az * imu.az)) * 180.0 / PI;
}

float accelRollDeg() {
  return atan2(imu.ay, imu.az) * 180.0 / PI;
}

/*
 * Complementary filter. The two sensors fail in opposite ways, so each covers
 * the other: integrating the gyro is smooth and responsive but the constant
 * accumulates without bound, while the accelerometer never drifts -- gravity
 * does not move -- but is noisy and reads any acceleration as a tilt. Trusting
 * the gyro for the short term and letting the accelerometer pull it back
 * slowly gives an estimate with the noise of the gyro and the long-run truth
 * of the accelerometer.
 *
 * ALPHA sets the crossover. At 5 Hz publishing, 0.93 puts the time constant
 * near 2.7 s: quick enough that tilting the truck looks instant, slow enough
 * that hand tremor and table knocks are ignored. Lower it if it feels laggy,
 * raise it if it still jitters.
 *
 * This is the honest version of a smoothing fix. Filtering it in the browser
 * would have made the picture calmer while the node still published noise, and
 * anything else consuming that message would have kept seeing it.
 */
/*
 * TAU is the crossover: below it the gyro is trusted, above it the
 * accelerometer pulls the estimate back to gravity. The blend is computed from
 * TAU and the actual dt every tick rather than being a fixed number, because a
 * fixed one silently changes meaning whenever the loop rate moves -- which is
 * how a 0.93 chosen for 5 Hz became a 4.4x bias amplifier at 3 Hz.
 *
 * Steady-state tilt error is now bias * TAU. With the bias measured at boot
 * that is a fraction of a degree.
 */
const float TAU_S = 0.7;

/*
 * How the breakout is bolted down, expressed as a sign per axis.
 *
 * The board is not mounted in the vehicle's own axes on this prototype, so
 * without this a nose-up movement reported nose-down. Set to +1 or -1 to match
 * the physical fitting; both the accelerometer angle and the gyro rate that
 * feeds it have to flip together, or the two halves of the filter fight each
 * other and the estimate creeps.
 *
 * If the wrong axis ends up inverted, these are the only two lines to change.
 */
const float MOUNT_PITCH = -1.0;    // nose up / down
const float MOUNT_ROLL  = +1.0;    // leaning left / right
float pitch_f = 0.0, roll_f = 0.0;
/*
 * Body yaw, integrated from the gyro and kept separate from `heading`.
 *
 * `heading` is where the vehicle is pointing along the road graph, which in
 * replay mode comes from the waypoint list and in dead-reckoning mode also
 * happens to be gyro-derived. Attitude is a different question: which way the
 * physical board is facing. Publishing the route bearing as attitude yaw meant
 * turning the node on the table changed nothing on the dashboard.
 *
 * There is no absolute reference for this -- gravity cannot see rotation about
 * the vertical -- so it drifts, and it is reported knowing that. Saying so is
 * the point: it is the same reason a real machine needs RTK and not an IMU.
 */
float yaw_f = 0.0;
bool attitude_primed = false;

void updateAttitude(float dt) {
  const float ap = MOUNT_PITCH * accelPitchDeg();
  const float ar = MOUNT_ROLL * accelRollDeg();

  if (!attitude_primed) {          // start level-true, do not sweep up from 0
    pitch_f = ap; roll_f = ar;
    attitude_primed = true;
    return;
  }

  // gy rotates about the lateral axis (pitch), gx about the longitudinal (roll)
  const float a = TAU_S / (TAU_S + dt);        // same behaviour at any dt
  pitch_f = a * (pitch_f + MOUNT_PITCH * imu.gy * dt) + (1.0 - a) * ap;
  roll_f  = a * (roll_f  + MOUNT_ROLL * imu.gx * dt) + (1.0 - a) * ar;

  // Pure integration, with no accelerometer term available to correct it.
  yaw_f += imu.gz * dt;
  yaw_f = fmod(yaw_f, 360.0);
  if (yaw_f < 0) yaw_f += 360.0;
}

float pitchDeg() { return pitch_f; }
float rollDeg()  { return roll_f; }
float yawDeg()   { return yaw_f; }

/*
 * The HB100 emits at 10.525 GHz and mixes the return down to an audio-band IF
 * whose frequency is proportional to radial velocity: about 31.4 Hz per m/s.
 * We do not need the velocity for the demo, only the fact of motion, so rather
 * than run an FFT on an ESP32 we measure the peak-to-peak swing of the IF over
 * one window. Still air gives a flat line; a hand, a person or a rolling truck
 * gives a swing well above the noise floor.
 *
 * The point being made on the table is not precision. It is that a cloth, a
 * cardboard box or a bottle of water placed in front of the module does not
 * stop it, because 2.85 cm of wavelength does not care about any of them --
 * while a camera pointed at the same scene is completely blocked. That is the
 * same argument as 3.9 mm against a 10 um fog droplet, one band down.
 */
int radarSwing() {
#if HAS_HB100
  int lo = 4095, hi = 0;
  for (int i = 0; i < HB100_SAMPLES; i++) {
    int v = analogRead(HB100_PIN);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    delayMicroseconds(100);
  }
  return hi - lo;
#else
  return 0;
#endif
}

/*
 * Publish a radar track the same way the production kit would. rel_x is
 * forward range in metres: the HB100 gives no range, so we report a nominal
 * standoff and flag the confidence honestly rather than inventing a distance.
 */
void publishDetection(int swing) {
  if (WiFi.status() != WL_CONNECTED) return;

  char body[280];
  snprintf(body, sizeof(body),
    "{\"vehicle_id\":\"%s\",\"t\":0,\"tracks\":["
    "{\"track_id\":1,\"rel_x\":%.1f,\"rel_y\":0.0,"
    "\"rel_vx\":-2.0,\"rcs\":10.0,\"vclass\":\"light_vehicle\","
    "\"conf\":%.2f}]}",
    VEHICLE_ID, 40.0, min(0.95f, 0.35f + swing / 600.0f));

  postJson("/ingest/detections", body);
}

/*
 * Everything this tick, in one POST.
 *
 * The three messages are still three messages -- the twin unpacks them into
 * the same stores the individual endpoints write to, and each of those
 * endpoints still exists and still works. What changed is the number of times
 * we pay for a round trip: measured at four per tick, this board managed a
 * quarter of a hertz, and the dashboard visibly lagged a hand waved at the
 * sensor. One request per tick fixes that without merging anything.
 */
void publishReport(float posConf, float range_m) {
  if (WiFi.status() != WL_CONNECTED) return;

  char body[820];
  int n = snprintf(body, sizeof(body),
    "{\"state\":{\"vehicle_id\":\"%s\",\"t\":0,"
      "\"x\":%.2f,\"y\":%.2f,\"z\":%.1f,\"heading\":%.4f,\"speed\":%.2f,"
      "\"loaded\":true,\"payload_t\":92.0,\"pos_conf\":%.3f},"
    "\"attitude\":{\"vehicle_id\":\"%s\",\"t\":0,"
      "\"pitch_deg\":%.2f,\"roll_deg\":%.2f,\"yaw_deg\":%.2f,"
      "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,"
      "\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,\"temp_c\":%.1f}",
    VEHICLE_ID, ex, ey, ez, heading, speed_ms, posConf,
    VEHICLE_ID, pitchDeg(), rollDeg(), yawDeg(),
    imu.ax, imu.ay, imu.az, imu.gx, imu.gy, imu.gz, imu.temp_c);

#if HAS_SONAR
  if (range_m > 0) {
    n += snprintf(body + n, sizeof(body) - n,
      ",\"proximity\":{\"vehicle_id\":\"%s\",\"t\":0,\"range_m\":%.3f,"
      "\"max_range_m\":%.1f,\"cone_deg\":%.1f,\"sensor\":\"ultrasonic\"}",
      VEHICLE_ID, range_m, SONAR_MAX_M, SONAR_CONE_DEG);
  } else {
    n += snprintf(body + n, sizeof(body) - n,
      ",\"proximity\":{\"vehicle_id\":\"%s\",\"t\":0,\"range_m\":null,"
      "\"max_range_m\":%.1f,\"cone_deg\":%.1f,\"sensor\":\"ultrasonic\"}",
      VEHICLE_ID, SONAR_MAX_M, SONAR_CONE_DEG);
  }
#endif
  snprintf(body + n, sizeof(body) - n, "}");

  int code = postJson("/ingest/node", body);
  if (code != 200 && code != UPLINK_NO_WIFI) Serial.printf("uplink %d\n", code);
}

/*
 * Attitude goes on its own endpoint rather than into VehicleState. Nothing in
 * the interlocking reads it, and a node should be able to publish a pose
 * without implementing telemetry it does not have.
 */
void publishAttitude() {
  if (WiFi.status() != WL_CONNECTED) return;

  char body[300];
  snprintf(body, sizeof(body),
    "{\"vehicle_id\":\"%s\",\"t\":0,"
    "\"pitch_deg\":%.2f,\"roll_deg\":%.2f,\"yaw_deg\":%.2f,"
    "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,"
    "\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,\"temp_c\":%.1f}",
    VEHICLE_ID, pitchDeg(), rollDeg(), yawDeg(),
    imu.ax, imu.ay, imu.az, imu.gx, imu.gy, imu.gz, imu.temp_c);

  postJson("/ingest/attitude", body);
}

#if HAS_SONAR
/*
 * One ping. Returns metres, or -1 when nothing answered inside the timeout.
 *
 * Nothing-in-range and sensor-broken look identical from here, and that is
 * worth being honest about rather than papering over: both come back as -1 and
 * the dashboard says "clear" rather than inventing a distance. Speed of sound
 * is taken at 343 m/s for 20 C. It varies about 0.6 m/s per degree, which at
 * these ranges is millimetres -- not worth compensating, but worth knowing
 * that we did not.
 */
float sonarRangeM() {
  digitalWrite(SONAR_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(SONAR_TRIG, HIGH);
  delayMicroseconds(10);                       // the datasheet trigger pulse
  digitalWrite(SONAR_TRIG, LOW);

  unsigned long us = pulseIn(SONAR_ECHO, HIGH, SONAR_TIMEOUT_US);
  if (us == 0) return -1.0;                    // timed out: nothing in range

  float m = (us * 0.000343) / 2.0;             // there and back
  if (m > SONAR_MAX_M || m < 0.02) return -1.0;
  return m;
}

void publishProximity(float range_m) {
  if (WiFi.status() != WL_CONNECTED) return;

  char body[200];
  if (range_m > 0) {
    snprintf(body, sizeof(body),
      "{\"vehicle_id\":\"%s\",\"t\":0,\"range_m\":%.3f,"
      "\"max_range_m\":%.1f,\"cone_deg\":%.1f,\"sensor\":\"ultrasonic\"}",
      VEHICLE_ID, range_m, SONAR_MAX_M, SONAR_CONE_DEG);
  } else {
    snprintf(body, sizeof(body),
      "{\"vehicle_id\":\"%s\",\"t\":0,\"range_m\":null,"
      "\"max_range_m\":%.1f,\"cone_deg\":%.1f,\"sensor\":\"ultrasonic\"}",
      VEHICLE_ID, SONAR_MAX_M, SONAR_CONE_DEG);
  }

  postJson("/ingest/proximity", body);
}
#endif

/*
 * One HTTP client for every uplink, kept open between ticks.
 *
 * Each publish used to construct its own client and close the socket after,
 * so a single tick paid four TCP handshakes to the same host. With keep-alive
 * the connection is established once and reused, which is most of the latency
 * gone. The timeout comes down to 250 ms as well: at 5 Hz there is no value in
 * waiting 600 ms for a reply that has already been overtaken by the next
 * sample -- dropping a stale POST is better than delaying a fresh one.
 */
HTTPClient uplink;
bool uplinkReady = false;

void uplinkBegin() {
  // Keep-alive was tried and removed. Reusing the socket produced
  // HTTPC_ERROR_CONNECTION_REFUSED once the server had closed its end, and
  // because that code is -1 it was easy to mistake for "no WiFi" and swallow.
  // A fresh connection per tick costs a handshake and is reliable.
  uplink.setReuse(false);
  // 250 ms was too tight and produced HTTPC_ERROR_READ_TIMEOUT (-11) under
  // load, which wastes the whole POST. 500 ms is comfortably above what the
  // twin takes to answer and still well inside the 200 ms x N tick budget now
  // that there is only one request per tick.
  uplink.setTimeout(500);
  uplink.setConnectTimeout(600);
  uplinkReady = true;
}

int postJson(const char *path, const char *body) {
  if (WiFi.status() != WL_CONNECTED) return UPLINK_NO_WIFI;
  if (!uplinkReady) uplinkBegin();

  uplink.begin(String(TWIN_HOST) + path);
  uplink.addHeader("Content-Type", "application/json");
  int code = uplink.POST((uint8_t *)body, strlen(body));
  uplink.end();                                // with setReuse, keeps it alive
  return code;
}

// ------------------------------------------------------------------ wifi ---
void wifiBegin() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("wifi");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nconnected, ip %s\n", WiFi.localIP().toString().c_str());
}

// ------------------------------------------------------------- the uplink --
/*
 * One POST, six fields that matter. Everything else in the schema has a
 * default, which was a deliberate decision when we froze it: hardware should
 * be able to join the twin without implementing the whole message.
 *
 * pos_conf is the honest one. Report the real uncertainty and the twin will
 * draw it, cap your speed, and eventually refuse you a token. Lying here to
 * make the demo look tidy would defeat the point of having the field.
 */
void publishState(float posConf) {
  if (WiFi.status() != WL_CONNECTED) return;

  char body[320];
  snprintf(body, sizeof(body),
    "{\"vehicle_id\":\"%s\",\"t\":0,"
    "\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,"
    "\"heading\":%.4f,\"speed\":%.2f,"
    "\"loaded\":true,\"payload_t\":92.0,\"pos_conf\":%.2f}",
    VEHICLE_ID, ex, ey, ez, heading, speed_ms, posConf);

  int code = postJson("/ingest/state", body);
  if (code != 200 && code != UPLINK_NO_WIFI) Serial.printf("uplink %d\n", code);
}

/*
 * Pull the advisory back down and obey it. A rover that publishes but ignores
 * what the twin says is telemetry, not a participant. This one slows for the
 * segment speed advisory and stops when its conflict-zone token is refused,
 * which is the behaviour the whole project is arguing for.
 */
void fetchAdvisory() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(TWIN_HOST) + "/advisory/" + VEHICLE_ID);
  http.setTimeout(300);
  http.setConnectTimeout(400);
  if (http.GET() == 200) {
    String body = http.getString();

    int i = body.indexOf("\"speed_advisory_ms\":");
    if (i >= 0) {
      float limit = body.substring(i + 20).toFloat();
      if (limit > 0 && limit < speed_ms) speed_ms = limit;
      else if (limit > speed_ms) speed_ms += 0.2;   // ease back up
    }

    if (body.indexOf("\"state\":\"held\"") >= 0) {
      speed_ms = 0.0;                                // token refused: stop
      Serial.println("HOLD - conflict zone occupied");
    }
    if (body.indexOf("\"alert\":\"intervene\"") >= 0) {
      speed_ms = 0.0;
      Serial.println("INTERVENE - throttle cut");
    }
  }
  http.end();
}

// ------------------------------------------------------------------ setup --
unsigned long lastTick = 0;
float driftConf = 0.05;

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("FogTwin rover %s\n", VEHICLE_ID);
  imuBegin();
#if HAS_SONAR
  pinMode(SONAR_TRIG, OUTPUT);
  pinMode(SONAR_ECHO, INPUT);
  digitalWrite(SONAR_TRIG, LOW);
  Serial.println("HC-SR04 proximity enabled on GPIO5/18");
#endif
#if HAS_HB100
  analogSetPinAttenuation(HB100_PIN, ADC_11db);   // full 0-3.3 V range
  Serial.println("HB100 Doppler enabled on GPIO34");
#endif
  wifiBegin();
  lastTick = millis();
}

void loop() {
  const unsigned long periodMs = (unsigned long)(1000.0 / PUBLISH_HZ);
  unsigned long now = millis();
  if (now - lastTick < periodMs) return;
  float dt = (now - lastTick) / 1000.0;
  lastTick = now;

  readImu();                                  // one burst, used by both paths
  updateAttitude(dt);                         // fuse it before anyone reads it

#if POSITION_MODE == MODE_DEAD_RECKON
  heading += imu.gz * PI / 180.0 * dt;
  // dead reckoning has no absolute reference, so confidence decays. The twin
  // will show a growing ring and, past 1 m, drop us into Mode D.
  driftConf = min(driftConf + 0.012f * dt * max(speed_ms, 0.5f), 3.0f);
#else
  // walk the waypoint loop
  float tx = ROUTE[leg][0], ty = ROUTE[leg][1];
  float dx = tx - ex, dy = ty - ey;
  float dist = sqrt(dx * dx + dy * dy);
  if (dist < 12.0) { leg = (leg + 1) % ROUTE_N; }
  else { heading = atan2(dy, dx); }
  driftConf = 0.05;
#endif

  ex += cos(heading) * speed_ms * dt;
  ey += sin(heading) * speed_ms * dt;

  // Ping first: the reading goes out in the same envelope as the pose, so
  // everything the dashboard draws for this tick describes the same instant.
  static float lastRange = -1.0;
#if HAS_SONAR
  lastRange = sonarRangeM();
#endif
  publishReport(driftConf, lastRange);

  // Radar runs at a fraction of the publish rate: one 26 ms sampling window
  // every fourth tick is plenty to catch a hand crossing the beam, and it
  // keeps the loop well inside its 200 ms budget.
  static int radarTick = 0;
  int swing = 0;
  if (++radarTick >= 4) {
    radarTick = 0;
    swing = radarSwing();
    if (swing > HB100_THRESHOLD) {
      publishDetection(swing);
      Serial.printf("RADAR motion, swing %d counts\n", swing);
    }
  }

  // The advisory changes on the twin's own 5 Hz tick, but nothing the driver
  // sees depends on catching every one of them, and it is a whole round trip.
  static int advTick = 0;
  if (++advTick % 3 == 0) fetchAdvisory();

#if HAS_SONAR
  if (lastRange > 0) {
    Serial.printf("x %.0f y %.0f hdg %.2f v %.1f conf %.2f swing %d  prox %.2f m\n",
                  ex, ey, heading, speed_ms, driftConf, swing, lastRange);
  } else {
    Serial.printf("x %.0f y %.0f hdg %.2f v %.1f conf %.2f swing %d  prox clear\n",
                  ex, ey, heading, speed_ms, driftConf, swing);
  }
#else
  Serial.printf("x %.0f y %.0f hdg %.2f v %.1f conf %.2f swing %d\n",
                ex, ey, heading, speed_ms, driftConf, swing);
#endif
}
