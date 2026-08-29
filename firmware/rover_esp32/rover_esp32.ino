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
 *   MPU-6050 IMU (I2C)           ~Rs 130
 *   Jumper wires + breadboard    ~Rs 150
 *   Any USB power bank           ~Rs 250 (or reuse one)
 *   optional HB100 Doppler       ~Rs 300   stands in for the 77 GHz radar
 *
 * Wiring
 *   MPU-6050 VCC -> 3V3 | GND -> GND | SDA -> GPIO21 | SCL -> GPIO22
 *   HB100 (optional) IF output -> GPIO34 through a 100 nF cap and a
 *   10k/10k divider to bias at ~1.65 V
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
const char *WIFI_SSID = "your-hotspot";
const char *WIFI_PASS = "your-password";
const char *TWIN_HOST = "http://192.168.1.20:8000";   // laptop running the twin
const char *VEHICLE_ID = "RV-201";                    // shows up in the cab list

#define MODE_DEAD_RECKON 0
#define MODE_REPLAY      1
#define POSITION_MODE    MODE_REPLAY

const float ROVER_SCALE = 400.0;   // 1 m of table = 400 m of mine
const float PUBLISH_HZ = 5.0;      // the twin ticks at 5 Hz; match it

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
float gyro_z_bias = 0.0;

void imuBegin() {
  Wire.begin(21, 22);
  Wire.beginTransmission(MPU);
  Wire.write(0x6B); Wire.write(0);            // wake it up
  Wire.endTransmission(true);

  // sit still for a moment and learn the gyro bias, or the heading walks away
  long sum = 0;
  for (int i = 0; i < 200; i++) { sum += readGyroZRaw(); delay(5); }
  gyro_z_bias = sum / 200.0;
}

int16_t readGyroZRaw() {
  Wire.beginTransmission(MPU);
  Wire.write(0x47);                            // GYRO_ZOUT_H
  Wire.endTransmission(false);
  Wire.requestFrom(MPU, 2, true);
  if (Wire.available() < 2) return 0;
  return (Wire.read() << 8) | Wire.read();
}

float readYawRate() {                          // rad/s
  float raw = readGyroZRaw() - gyro_z_bias;
  return (raw / 131.0) * PI / 180.0;           // 131 LSB per deg/s at +/-250
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

  HTTPClient http;
  http.begin(String(TWIN_HOST) + "/ingest/state");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(600);
  int code = http.POST((uint8_t *)body, strlen(body));
  http.end();
  if (code != 200) Serial.printf("uplink %d\n", code);
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
  http.setTimeout(600);
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
  wifiBegin();
  lastTick = millis();
}

void loop() {
  const unsigned long periodMs = (unsigned long)(1000.0 / PUBLISH_HZ);
  unsigned long now = millis();
  if (now - lastTick < periodMs) return;
  float dt = (now - lastTick) / 1000.0;
  lastTick = now;

#if POSITION_MODE == MODE_DEAD_RECKON
  heading += readYawRate() * dt;
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

  publishState(driftConf);
  fetchAdvisory();

  Serial.printf("x %.0f y %.0f hdg %.2f v %.1f conf %.2f\n",
                ex, ey, heading, speed_ms, driftConf);
}
