// Copy this to secrets.h and fill in your own values.
//
// secrets.h is git-ignored. Keeping the real SSID and password out of the
// repository matters: this sketch is public, and a Wi-Fi password committed
// once stays in the history even after it is deleted.

const char *WIFI_SSID = "your-hotspot";        // 2.4 GHz — an ESP32 cannot see 5 GHz
const char *WIFI_PASS = "your-password";
const char *TWIN_HOST = "http://192.168.1.20:8000";   // the laptop running the twin
