#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "runtime-contract-support.hpp"

Value jsString(Runtime &, const std::string &value) {
    return Value(value);
}

struct plugin_string_t { const char *ptr; std::size_t len; };
std::string wasiStringValue(const plugin_string_t &value) { return {value.ptr, value.len}; }
struct plugin_list_u8_t { const std::uint8_t *ptr; std::size_t len; };

enum pumpkin_plugin_event_type_t {
    PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_PLAYER_CUSTOM_PAYLOAD_EVENT
};
struct plugin_event_t {
    pumpkin_plugin_event_type_t tag;
    struct {
        struct {
            plugin_string_t channel;
            plugin_list_u8_t data;
        } player_custom_payload_event;
    } val;
};

Object convertEvent(Runtime &runtime, const plugin_event_t *event) {
    Object data(runtime);
    /* GENERATED_WIT_EVENT_DISPATCH */
    return data;
}

int main() {
    Runtime runtime;
    const std::uint8_t bytes[] = {0x41, 0x00, 0xff};
    const plugin_event_t event{
        PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_PLAYER_CUSTOM_PAYLOAD_EVENT,
        {{ {"chat", 4}, {bytes, sizeof(bytes)} }}
    };
    const Object data = convertEvent(runtime, &event);
    const auto &channel = data.getProperty("channel");
    assert(channel.kind == Value::Kind::String);
    assert(channel.string == "chat");
    const auto &payload = data.getProperty("data");
    assert(payload.kind == Value::Kind::Bytes);
    assert((payload.bytes == std::vector<std::uint8_t>{0x41, 0x00, 0xff}));
    assert(!data.hasProperty("unused"));
}
