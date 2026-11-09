// Command-scoped capture endpoint. No workspace writes and no input emission.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
// Windows SDK headers below require windows.h to be included first.
#include <windows.h>
#include <wtsapi32.h>
#include <bcrypt.h>
#include <objidl.h>
#include <gdiplus.h>
#include "vendor/json.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace cu {
using Json = nlohmann::ordered_json;
struct Failure {};
void require(bool valid) {
  if (!valid)
    throw Failure{};
}
constexpr std::size_t maxRequest = 65536;
constexpr std::size_t maxImage = 67108864;
constexpr int64_t intMin = -2147483648LL, intMax = 2147483647LL;

bool keys(const Json &value, std::initializer_list<const char *> names) {
  if (!value.is_object() || value.size() != names.size())
    return false;
  return std::all_of(names.begin(), names.end(),
                     [&](const char *name) { return value.contains(name); });
}
bool integer(const Json &value, int64_t low, int64_t high) {
  if (!value.is_number_integer())
    return false;
  if (value.is_number_unsigned())
    return value.get<uint64_t>() <= static_cast<uint64_t>(high) &&
           (low <= 0 || value.get<uint64_t>() >= static_cast<uint64_t>(low));
  const auto n = value.get<int64_t>();
  return n >= low && n <= high;
}
bool identifier(const Json &value, const std::string &prefix) {
  if (!value.is_string())
    return false;
  const auto &s = value.get_ref<const std::string &>();
  return s.size() == prefix.size() + 32 && s.compare(0, prefix.size(), prefix) == 0 &&
         std::all_of(s.begin() + prefix.size(), s.end(),
                     [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
bool regionShape(const Json &s) {
  if (keys(s, {"kind", "left", "top", "right", "bottom"}) && s["kind"] == "normalized") {
    for (auto key : {"left", "top", "right", "bottom"})
      if (!integer(s[key], 0, 999))
        return false;
    return s["left"].get<int>() <= s["right"].get<int>() &&
           s["top"].get<int>() <= s["bottom"].get<int>();
  }
  return keys(s, {"kind", "left", "top", "width", "height"}) && s["kind"] == "pixel" &&
         integer(s["left"], intMin, intMax) && integer(s["top"], intMin, intMax) &&
         integer(s["width"], 1, 4096) && integer(s["height"], 1, 4096);
}
bool selectorShape(const Json &s) {
  if (regionShape(s))
    return true;
  if (keys(s, {"kind", "displayId", "region"}) && s["kind"] == "display_region")
    return identifier(s["displayId"], "dsp_") && regionShape(s["region"]);
  if (!keys(s, {"kind", "displayIds"}) || s["kind"] != "full_screen" ||
      !s["displayIds"].is_array() || s["displayIds"].empty() || s["displayIds"].size() > 32)
    return false;
  std::set<std::string> seen;
  for (const auto &id : s["displayIds"])
    if (!identifier(id, "dsp_") || !seen.insert(id.get<std::string>()).second)
      return false;
  return true;
}
Json parseRequest(const std::string &bytes) {
  require(!bytes.empty() && bytes.size() <= maxRequest && bytes.back() == '\n');
  // Reject duplicates before ordered_json can collapse them. All numbers are admitted below.
  std::vector<std::set<std::string>> objectKeys;
  auto callback = [&](int depth, Json::parse_event_t event, Json &value) {
    require(depth <= 16);
    if (event == Json::parse_event_t::object_start)
      objectKeys.emplace_back();
    if (event == Json::parse_event_t::key)
      require(!objectKeys.empty() && objectKeys.back().insert(value.get<std::string>()).second);
    if (event == Json::parse_event_t::object_end)
      objectKeys.pop_back();
    return true;
  };
  auto request = Json::parse(bytes, callback);
  require(request.is_object() && request.contains("requestId") &&
          identifier(request["requestId"], "req_"));
  const bool display =
      keys(request, {"kind", "requestId"}) && request["kind"] == "cu.windows-display.request/v1";
  const bool capture = keys(request, {"kind", "requestId", "destinationPath", "selector"}) &&
                       request["kind"] == "cu.windows-capture.request/v1" &&
                       request["destinationPath"].is_string() && selectorShape(request["selector"]);
  require(display || capture);
  require(request.dump() + "\n" == bytes);
  return request;
}
std::wstring wide(const std::string &s) {
  require(!s.empty() && s.find('\0') == std::string::npos && s.size() <= 65536);
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(),
                                        static_cast<int>(s.size()), nullptr, 0);
  require(count > 0);
  std::wstring result(count, L'\0');
  require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()),
                              result.data(), count) == count);
  return result;
}
std::string utf8(const std::wstring &s) {
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(),
                                        static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
  require(count > 0);
  std::string result(count, '\0');
  require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()),
                              result.data(), count, nullptr, nullptr) == count);
  return result;
}
std::string sha256(const unsigned char *bytes, std::size_t size) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  require(size <= maxImage);
  try {
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0);
    require(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0);
    require(BCryptHashData(hash, const_cast<PUCHAR>(bytes), static_cast<ULONG>(size), 0) == 0);
    std::array<unsigned char, 32> digest{};
    require(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0);
    BCryptDestroyHash(hash);
    hash = nullptr;
    BCryptCloseAlgorithmProvider(algorithm, 0);
    algorithm = nullptr;
    const char *hex = "0123456789abcdef";
    std::string result;
    for (auto b : digest) {
      result += hex[b >> 4];
      result += hex[b & 15];
    }
    return result;
  } catch (...) {
    if (hash)
      BCryptDestroyHash(hash);
    if (algorithm)
      BCryptCloseAlgorithmProvider(algorithm, 0);
    throw;
  }
}
std::string hashJson(const Json &value) {
  const auto s = value.dump();
  return sha256(reinterpret_cast<const unsigned char *>(s.data()), s.size());
}
struct Rect {
  int64_t x, y, width, height;
};
Json rectJson(const Rect &r) {
  return {{"x", r.x}, {"y", r.y}, {"width", r.width}, {"height", r.height}};
}
Rect rect(const Json &r) {
  require(r.is_object() && r.contains("x") && r.contains("y") && r.contains("width") &&
          r.contains("height"));
  require(integer(r["x"], intMin, intMax) && integer(r["y"], intMin, intMax) &&
          integer(r["width"], 1, intMax) && integer(r["height"], 1, intMax));
  Rect result{r["x"].get<int64_t>(), r["y"].get<int64_t>(), r["width"].get<int64_t>(),
              r["height"].get<int64_t>()};
  require(result.x + result.width <= intMax && result.y + result.height <= intMax);
  return result;
}
bool contains(const Rect &a, const Rect &b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width &&
         b.y + b.height <= a.y + a.height;
}
void validateTopology(const Json &snapshot, bool distinct) {
  const auto virtualRect = rect(snapshot.at("virtualScreen"));
  const auto &monitors = snapshot.at("monitors");
  require(monitors.is_array() && !monitors.empty() && monitors.size() <= 32);
  std::set<std::string> placements;
  int primaries = 0;
  for (const auto &m : monitors) {
    require(keys(m, {"x", "y", "width", "height", "primary"}) && m["primary"].is_boolean());
    const auto r = rect(m);
    require(contains(virtualRect, r));
    const bool inserted = placements.insert(rectJson(r).dump()).second;
    require(!distinct || inserted);
    if (m["primary"].get<bool>())
      ++primaries;
  }
  require(primaries == 1);
}
std::string displayId(const Json &snapshot, std::size_t index) {
  const auto fingerprint = hashJson(
      Json{{"virtualScreen", snapshot["virtualScreen"]}, {"monitors", snapshot["monitors"]}});
  return "dsp_" + hashJson(Json{{"kind", "cu.display-id/v1"},
                                {"topologyFingerprint", fingerprint},
                                {"index", index}})
                      .substr(0, 32);
}
Rect resolveSelector(const Json &selector, const Json &snapshot) {
  require(selectorShape(selector));
  const auto v = rect(snapshot.at("virtualScreen"));
  const std::string kind = selector["kind"].get<std::string>();
  if (kind == "display_region" || kind == "full_screen") {
    validateTopology(snapshot, true);
    const auto &monitors = snapshot["monitors"];
    auto find = [&](const Json &id) {
      for (std::size_t i = 0; i < monitors.size(); ++i)
        if (displayId(snapshot, i) == id)
          return rect(monitors[i]);
      throw Failure{};
    };
    if (kind == "display_region") {
      const auto r = resolveSelector(selector["region"], snapshot);
      require(contains(find(selector["displayId"]), r));
      return r;
    }
    Rect r = find(selector["displayIds"][0]);
    int64_t right = r.x + r.width, bottom = r.y + r.height;
    for (const auto &id : selector["displayIds"]) {
      const auto m = find(id);
      r.x = std::min(r.x, m.x);
      r.y = std::min(r.y, m.y);
      right = std::max(right, m.x + m.width);
      bottom = std::max(bottom, m.y + m.height);
    }
    r.width = right - r.x;
    r.height = bottom - r.y;
    require(r.width <= 32768 && r.height <= 32768);
    return r;
  }
  Rect r{};
  if (kind == "pixel")
    r = {selector["left"].get<int64_t>(), selector["top"].get<int64_t>(),
         selector["width"].get<int64_t>(), selector["height"].get<int64_t>()};
  else {
    const int64_t left = selector["left"].get<int64_t>() * (v.width - 1) / 999,
                  top = selector["top"].get<int64_t>() * (v.height - 1) / 999;
    const int64_t right = std::min(
                      v.width, (selector["right"].get<int64_t>() * (v.width - 1) + 998) / 999 + 1),
                  bottom = std::min(
                      v.height,
                      (selector["bottom"].get<int64_t>() * (v.height - 1) + 998) / 999 + 1);
    r = {v.x + left, v.y + top, right - left, bottom - top};
  }
  require(r.width <= 4096 && r.height <= 4096 && contains(v, r) && !contains(r, v));
  return r;
}
struct Monitor {
  Rect bounds;
  bool primary;
  std::wstring name;
};
struct MonitorEnumeration {
  std::vector<Monitor> monitors;
  bool failed = false;
};
BOOL CALLBACK enumerateMonitor(HMONITOR monitor, HDC, LPRECT, LPARAM context) noexcept {
  auto &state = *reinterpret_cast<MonitorEnumeration *>(context);
  try {
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    require(GetMonitorInfoW(monitor, &info) != 0 && state.monitors.size() < 32);
    state.monitors.push_back({{info.rcMonitor.left, info.rcMonitor.top,
                               int64_t(info.rcMonitor.right) - info.rcMonitor.left,
                               int64_t(info.rcMonitor.bottom) - info.rcMonitor.top},
                              (info.dwFlags & MONITORINFOF_PRIMARY) != 0,
                              info.szDevice});
    return TRUE;
  } catch (...) {
    state.failed = true;
    return FALSE;
  }
}
Json snapshot(bool distinct) {
  DWORD session = 0;
  require(ProcessIdToSessionId(GetCurrentProcessId(), &session) != 0 && session <= intMax);
  LPWSTR buffer = nullptr;
  DWORD count = 0;
  const bool queried = WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session,
                                                   WTSConnectState, &buffer, &count) != 0;
  bool connected = false;
  if (queried && buffer && count >= sizeof(WTS_CONNECTSTATE_CLASS))
    connected = *reinterpret_cast<WTS_CONNECTSTATE_CLASS *>(buffer) == WTSActive;
  if (buffer)
    WTSFreeMemory(buffer);
  require(connected);
  USEROBJECTFLAGS flags{};
  DWORD needed = 0;
  require(GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS, &flags, sizeof(flags),
                                    &needed) != 0 &&
          (flags.dwFlags & WSF_VISIBLE));
  HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  require(desktop != nullptr);
  std::wstring desktopName;
  try {
    GetUserObjectInformationW(desktop, UOI_NAME, nullptr, 0, &needed);
    require(needed > 2 && needed <= 1024 && needed % sizeof(wchar_t) == 0);
    std::vector<wchar_t> name(needed / sizeof(wchar_t), L'\0');
    require(GetUserObjectInformationW(desktop, UOI_NAME, name.data(), needed, &needed) != 0 &&
            name.back() == L'\0');
    desktopName = name.data();
  } catch (...) {
    CloseDesktop(desktop);
    throw;
  }
  require(CloseDesktop(desktop) != 0 && desktopName == L"Default");
  Rect virtualRect{GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
                   GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)};
  MonitorEnumeration enumeration;
  require(EnumDisplayMonitors(nullptr, nullptr, enumerateMonitor,
                              reinterpret_cast<LPARAM>(&enumeration)) != 0 &&
          !enumeration.failed);
  auto &monitors = enumeration.monitors;
  std::sort(monitors.begin(), monitors.end(), [](const Monitor &a, const Monitor &b) {
    if (a.bounds.x != b.bounds.x)
      return a.bounds.x < b.bounds.x;
    if (a.bounds.y != b.bounds.y)
      return a.bounds.y < b.bounds.y;
    return a.name < b.name;
  });
  Json list = Json::array();
  for (const auto &monitor : monitors) {
    auto m = rectJson(monitor.bounds);
    m["primary"] = monitor.primary;
    list.push_back(m);
  }
  const HWND window = GetForegroundWindow();
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  require(pid <= intMax);
  char handle[19]{};
  std::snprintf(handle, sizeof(handle), "0x%016llx",
                static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(window)));
  Json value{{"virtualScreen", rectJson(virtualRect)},
             {"monitors", list},
             {"desktop",
              {{"interactive", true},
               {"connected", true},
               {"kind", "default"},
               {"sessionId", session},
               {"desktopName", "Default"}}},
             {"foreground", {{"windowHandle", handle}, {"processId", pid}}}};
  validateTopology(value, distinct);
  return value;
}
bool sameEnvironment(Json before, Json after, bool displayOnly) {
  if (displayOnly) {
    before.erase("foreground");
    after.erase("foreground");
  }
  return before == after;
}
std::wstring fullPath(const std::wstring &raw) {
  require(!raw.empty() && raw.find(L'\0') == std::wstring::npos && raw.size() < 32768);
  DWORD count = GetFullPathNameW(raw.c_str(), 0, nullptr, nullptr);
  require(count > 0 && count <= 32768);
  std::vector<wchar_t> out(count);
  DWORD written = GetFullPathNameW(raw.c_str(), count, out.data(), nullptr);
  require(written > 0 && written < count);
  return std::wstring(out.data(), written);
}
std::wstring destinationPath(const std::string &destination) {
  DWORD count = GetEnvironmentVariableW(L"TEMP", nullptr, 0);
  require(count > 1 && count <= 32768);
  std::vector<wchar_t> temp(count);
  require(GetEnvironmentVariableW(L"TEMP", temp.data(), count) == count - 1);
  auto root = fullPath(temp.data());
  while (root.size() > 3 && root.back() == L'\\')
    root.pop_back();
  const auto path = fullPath(wide(destination));
  const auto separator = path.find_last_of(L"\\/");
  require(separator != std::wstring::npos);
  const auto parent = path.substr(0, separator), leaf = path.substr(separator + 1);
  require(CompareStringOrdinal(parent.data(), static_cast<int>(parent.size()), root.data(),
                               static_cast<int>(root.size()), TRUE) == CSTR_EQUAL);
  require(leaf.size() > 4 && leaf.substr(leaf.size() - 4) == L".png" &&
          leaf.find_first_of(L":*?<>|\"") == std::wstring::npos);
  require(GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES &&
          GetLastError() == ERROR_FILE_NOT_FOUND);
  return path;
}
class OwnedFile {
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  bool published_ = false;

public:
  explicit OwnedFile(const std::wstring &path) {
    handle_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, 0, nullptr,
                          CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(handle_ != INVALID_HANDLE_VALUE);
  }
  OwnedFile(const OwnedFile &) = delete;
  OwnedFile &operator=(const OwnedFile &) = delete;
  ~OwnedFile() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      if (!published_) {
        FILE_DISPOSITION_INFO deletion{TRUE};
        SetFileInformationByHandle(handle_, FileDispositionInfo, &deletion, sizeof(deletion));
      }
      CloseHandle(handle_);
    }
  }
  void write(const unsigned char *data, std::size_t size) {
    require(size > 0 && size <= maxImage);
    DWORD written = 0;
    require(WriteFile(handle_, data, static_cast<DWORD>(size), &written, nullptr) != 0 &&
            written == size);
    require(FlushFileBuffers(handle_) != 0);
  }
  std::vector<unsigned char> read() {
    LARGE_INTEGER size{}, zero{};
    require(GetFileSizeEx(handle_, &size) != 0 && size.QuadPart > 0 &&
            size.QuadPart <= int64_t(maxImage));
    require(SetFilePointerEx(handle_, zero, nullptr, FILE_BEGIN) != 0);
    std::vector<unsigned char> result(static_cast<std::size_t>(size.QuadPart));
    DWORD count = 0;
    require(ReadFile(handle_, result.data(), static_cast<DWORD>(result.size()), &count, nullptr) !=
                0 &&
            count == result.size());
    return result;
  }
  void publish() { published_ = true; }
};
class GdiSession {
  ULONG_PTR token_ = 0;

public:
  GdiSession() {
    Gdiplus::GdiplusStartupInput input;
    require(Gdiplus::GdiplusStartup(&token_, &input, nullptr) == Gdiplus::Ok);
  }
  ~GdiSession() {
    if (token_)
      Gdiplus::GdiplusShutdown(token_);
  }
};
struct StreamRelease {
  void operator()(IStream *value) const {
    if (value)
      value->Release();
  }
};
std::vector<unsigned char> capturePng(const Rect &rect) {
  GdiSession session;
  Gdiplus::Bitmap bitmap(static_cast<INT>(rect.width), static_cast<INT>(rect.height),
                         PixelFormat24bppRGB);
  require(bitmap.GetLastStatus() == Gdiplus::Ok);
  {
    Gdiplus::Graphics graphics(&bitmap);
    require(graphics.GetLastStatus() == Gdiplus::Ok);
    HDC target = graphics.GetHDC();
    require(target != nullptr);
    HDC source = GetDC(nullptr);
    const bool copied =
        source && BitBlt(target, 0, 0, static_cast<int>(rect.width), static_cast<int>(rect.height),
                         source, static_cast<int>(rect.x), static_cast<int>(rect.y), SRCCOPY) != 0;
    const bool released = !source || ReleaseDC(nullptr, source) != 0;
    graphics.ReleaseHDC(target);
    require(copied && released && graphics.GetLastStatus() == Gdiplus::Ok);
  }
  IStream *raw = nullptr;
  require(CreateStreamOnHGlobal(nullptr, TRUE, &raw) == S_OK);
  std::unique_ptr<IStream, StreamRelease> stream(raw);
  const CLSID pngEncoder{
      0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e}};
  require(bitmap.Save(stream.get(), &pngEncoder, nullptr) == Gdiplus::Ok);
  STATSTG stat{};
  require(stream->Stat(&stat, STATFLAG_NONAME) == S_OK && stat.cbSize.QuadPart > 0 &&
          stat.cbSize.QuadPart <= maxImage);
  LARGE_INTEGER zero{};
  require(stream->Seek(zero, STREAM_SEEK_SET, nullptr) == S_OK);
  std::vector<unsigned char> bytes(static_cast<std::size_t>(stat.cbSize.QuadPart));
  ULONG read = 0;
  require(stream->Read(bytes.data(), static_cast<ULONG>(bytes.size()), &read) == S_OK &&
          read == bytes.size());
  return bytes;
}
std::string readRequest() {
  std::string value;
  std::array<char, 4096> chunk{};
  DWORD count = 0;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  for (;;) {
    const BOOL ok =
        ReadFile(input, chunk.data(), static_cast<DWORD>(chunk.size()), &count, nullptr);
    if (!ok) {
      require(GetLastError() == ERROR_BROKEN_PIPE);
      break;
    }
    if (count == 0)
      break;
    require(value.size() + count <= maxRequest);
    value.append(chunk.data(), count);
  }
  return value;
}
void output(const Json &result) {
  const auto bytes = result.dump() + "\n";
  require(bytes.size() <= 65536);
  DWORD written = 0;
  require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()),
                    &written, nullptr) != 0 &&
          written == bytes.size());
}
int execute() {
  require(SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != 0);
  const auto request = parseRequest(readRequest());
  if (request["kind"] == "cu.windows-display.request/v1") {
    const auto before = snapshot(true), after = snapshot(true);
    require(sameEnvironment(before, after, true));
    output(Json{{"kind", "cu.windows-display.result/v1"},
                {"requestId", request["requestId"]},
                {"virtualScreen", before["virtualScreen"]},
                {"monitors", before["monitors"]}});
    return 0;
  }
  const auto destination = destinationPath(request["destinationPath"].get<std::string>());
  const auto &selector = request["selector"];
  const bool distinct = selector["kind"] == "display_region" || selector["kind"] == "full_screen";
  const auto before = snapshot(distinct);
  const auto region = resolveSelector(selector, before);
  const auto image = capturePng(region);
  OwnedFile file(destination);
  file.write(image.data(), image.size());
  const auto after = snapshot(distinct);
  require(sameEnvironment(before, after, false));
  const auto persisted = file.read();
  output(Json{{"kind", "cu.windows-capture.result/v1"},
              {"requestId", request["requestId"]},
              {"destinationPath", utf8(destination)},
              {"sourceRectPx", rectJson(region)},
              {"virtualScreen", before["virtualScreen"]},
              {"monitors", before["monitors"]},
              {"desktop", before["desktop"]},
              {"foreground", before["foreground"]},
              {"image",
               {{"sha256", sha256(persisted.data(), persisted.size())},
                {"byteLength", persisted.size()},
                {"width", region.width},
                {"height", region.height}}}});
  file.publish();
  return 0;
}
} // namespace cu
#ifndef CU_CAPTURE_TEST
int main() {
  try {
    return cu::execute();
  } catch (...) {
    const char error[] = "capture_failed\n";
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), error, sizeof(error) - 1, &written, nullptr);
    return 3;
  }
}
#endif
