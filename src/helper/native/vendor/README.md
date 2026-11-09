# Native capture dependency

`json.hpp` is the unmodified single-header distribution of **nlohmann/json v3.12.0**:

- Source: https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp
- SHA-256: `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`
- License: [MIT](LICENSE.nlohmann-json), copied into the packaged runtime.

The helper uses ordered JSON for protocol serialization and hashing, rejects duplicate
keys in a parse callback, bounds request bytes/depth, admits exact request shapes and
integer ranges, then requires byte-for-byte canonical serialization plus one LF.
The header is compiled into the executable; it is not a runtime DLL or network dependency.
