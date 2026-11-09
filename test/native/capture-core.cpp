#define CU_CAPTURE_TEST
#include "../../src/helper/native/capture.cpp"
#include <iostream>
using cu::Json;
void check(bool value) {
  if (!value)
    throw std::runtime_error("native core check failed");
}
template <class F> void rejects(F operation) {
  bool failed = false;
  try {
    operation();
  } catch (...) {
    failed = true;
  }
  check(failed);
}
int main() {
  try {
    const Json topology{
        {"virtualScreen", {{"x", -100}, {"y", -50}, {"width", 400}, {"height", 200}}},
        {"monitors",
         Json::array(
             {Json{{"x", -100}, {"y", -50}, {"width", 200}, {"height", 200}, {"primary", false}},
              Json{{"x", 100}, {"y", -50}, {"width", 200}, {"height", 200}, {"primary", true}}})}};
    cu::validateTopology(topology, true);
    check(cu::hashJson(Json::object()) ==
          "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    check(
        cu::rectJson(cu::resolveSelector(
            Json{{"kind", "normalized"}, {"left", 0}, {"top", 0}, {"right", 499}, {"bottom", 499}},
            topology)) == Json({{"x", -100}, {"y", -50}, {"width", 201}, {"height", 101}}));
    check(cu::rectJson(cu::resolveSelector(Json{{"kind", "normalized"},
                                                {"left", 999},
                                                {"top", 999},
                                                {"right", 999},
                                                {"bottom", 999}},
                                           topology)) ==
          Json({{"x", 299}, {"y", 149}, {"width", 1}, {"height", 1}}));
    rejects([&] {
      cu::resolveSelector(
          Json{{"kind", "normalized"}, {"left", 0}, {"top", 0}, {"right", 999}, {"bottom", 999}},
          topology);
    });
    const Json region{
        {"kind", "pixel"}, {"left", 120}, {"top", -20}, {"width", 50}, {"height", 40}};
    const auto rightId = cu::displayId(topology, 1), leftId = cu::displayId(topology, 0);
    check(cu::rectJson(cu::resolveSelector(
              Json{{"kind", "display_region"}, {"displayId", rightId}, {"region", region}},
              topology)) == Json({{"x", 120}, {"y", -20}, {"width", 50}, {"height", 40}}));
    rejects([&] {
      cu::resolveSelector(
          Json{{"kind", "display_region"}, {"displayId", leftId}, {"region", region}}, topology);
    });
    check(cu::rectJson(cu::resolveSelector(
              Json{{"kind", "full_screen"}, {"displayIds", Json::array({rightId, leftId})}},
              topology)) == topology["virtualScreen"]);
    auto stale = topology;
    stale["monitors"][0]["width"] = 199;
    rejects([&] {
      cu::resolveSelector(Json{{"kind", "full_screen"}, {"displayIds", Json::array({leftId})}},
                          stale);
    });
    auto duplicate = topology;
    duplicate["monitors"][0] = duplicate["monitors"][1];
    duplicate["monitors"][0]["primary"] = false;
    cu::validateTopology(duplicate, false);
    rejects([&] { cu::validateTopology(duplicate, true); });
    auto invalid = topology;
    invalid["monitors"][0]["primary"] = true;
    rejects([&] { cu::validateTopology(invalid, false); });
    invalid = topology;
    invalid["monitors"][0]["x"] = -101;
    rejects([&] { cu::validateTopology(invalid, false); });
    invalid = topology;
    invalid["monitors"][0]["width"] = 0;
    rejects([&] { cu::validateTopology(invalid, false); });
    invalid = topology;
    invalid["virtualScreen"]["x"] = 2147483647;
    rejects([&] { cu::validateTopology(invalid, false); });
    auto before = topology;
    before["desktop"] = {{"sessionId", 1}, {"desktopName", "Default"}};
    before["foreground"] = {{"windowHandle", "0x0000000000000001"}, {"processId", 1}};
    auto after = before;
    after["foreground"]["processId"] = 2;
    check(!cu::sameEnvironment(before, after, false));
    check(cu::sameEnvironment(before, after, true));
    after = before;
    after["desktop"]["sessionId"] = 2;
    check(!cu::sameEnvironment(before, after, false));
    check(!cu::sameEnvironment(before, after, true));
    after = before;
    after["monitors"][0]["x"] = -99;
    check(!cu::sameEnvironment(before, after, true));
    const std::string display = "{\"kind\":\"cu.windows-display.request/"
                                "v1\",\"requestId\":\"req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n";
    check(cu::parseRequest(display)["kind"] == "cu.windows-display.request/v1");
    rejects([&] { cu::parseRequest(display + "\n"); });
    rejects([&] {
      cu::parseRequest("{\"kind\":\"x\",\"kind\":\"cu.windows-display.request/"
                       "v1\",\"requestId\":\"req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n");
    });
    rejects([&] { cu::wide(std::string("x\0y", 3)); });
    // A failure after a write must delete only the file owned by this open handle.
    wchar_t temp[MAX_PATH + 1]{}, path[MAX_PATH + 1]{};
    check(GetTempPathW(MAX_PATH, temp) > 0);
    check(GetTempFileNameW(temp, L"cun", 0, path) != 0);
    check(DeleteFileW(path) != 0);
    const unsigned char bytes[] = {1, 2, 3, 4};
    {
      cu::OwnedFile file(path);
      file.write(bytes, sizeof(bytes));
      check(file.read() == std::vector<unsigned char>({1, 2, 3, 4}));
    }
    check(GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES);
    {
      cu::OwnedFile file(path);
      file.write(bytes, sizeof(bytes));
      file.publish();
    }
    rejects([&] { cu::OwnedFile conflict(path); });
    check(GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES);
    check(DeleteFileW(path) != 0);
    std::cout << "native core: topology, mapping, binding, protocol, environment and owned cleanup "
                 "passed\n";
    return 0;
  } catch (...) {
    std::cerr << "native core failed\n";
    return 1;
  }
}
