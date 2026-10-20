#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "runtime-contract-support.hpp"

struct plugin_string_t { std::uint8_t *ptr; std::size_t len; };
struct plugin_own_command_sender_t { std::int32_t __handle; };
struct plugin_own_server_instance_t { std::int32_t __handle; };
struct plugin_own_text_component_t { std::int32_t __handle; };
struct plugin_suggestion_request_t {
    plugin_string_t input;
    std::uint32_t cursor;
    std::uint32_t start;
    plugin_string_t remaining;
};
struct plugin_command_suggestion_t {
    plugin_string_t value;
    struct { bool is_some; plugin_own_text_component_t val; } tooltip;
};
struct plugin_command_suggestions_t {
    std::uint32_t start;
    std::uint32_t length;
    struct { plugin_command_suggestion_t *ptr; std::size_t len; } values;
};

int requestFrees = 0;
int senderDrops = 0;
int serverDrops = 0;
int textDrops = 0;
int stringAllocations = 0;
int stringFrees = 0;
int loggedErrors = 0;

void plugin_string_dup_n(plugin_string_t *value, const char *text, std::size_t size) {
    value->ptr = static_cast<std::uint8_t *>(size ? std::malloc(size) : nullptr);
    if (size && !value->ptr) throw std::bad_alloc();
    if (size) std::memcpy(value->ptr, text, size);
    value->len = size;
    if (size) stringAllocations++;
}
void plugin_string_free(plugin_string_t *value) {
    if (value->ptr) stringFrees++;
    std::free(value->ptr);
    value->ptr = nullptr;
    value->len = 0;
}
void plugin_suggestion_request_free(plugin_suggestion_request_t *request) {
    plugin_string_free(&request->input);
    plugin_string_free(&request->remaining);
    requestFrees++;
}
void plugin_command_suggestions_free(plugin_command_suggestions_t *suggestions) {
    for (std::size_t index = 0; index < suggestions->values.len; index++)
        plugin_string_free(&suggestions->values.ptr[index].value);
    std::free(suggestions->values.ptr);
}

struct ResourceState {
    std::int32_t handle;
    bool owned;
    std::string interfaceName;
    std::string resourceName;
    bool valid = true;
    void drop() {
        if (!owned) return;
        owned = false;
        valid = false;
        if (interfaceName == "command" && resourceName == "command-sender") senderDrops++;
        if (interfaceName == "server" && resourceName == "server") serverDrops++;
        if (interfaceName == "text" && resourceName == "text-component") textDrops++;
    }
    void transfer() { owned = false; valid = false; }
};
void pumpkin_plugin_command_command_sender_drop_own(plugin_own_command_sender_t) {}
void pumpkin_plugin_server_server_drop_own(plugin_own_server_instance_t) {}
class WitResourceObject : public HostObject {
  public:
    explicit WitResourceObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}
    const std::shared_ptr<ResourceState> &state() const { return state_; }
  private:
    std::shared_ptr<ResourceState> state_;
};
std::shared_ptr<WitResourceObject> makeWitResourceObject(std::shared_ptr<ResourceState> state) {
    return std::make_shared<WitResourceObject>(std::move(state));
}

Object wrapResourceObject(Runtime &, std::shared_ptr<WitResourceObject> resource) {
    return Object::createFromHostObject(*jsRuntime, std::move(resource));
}
std::shared_ptr<ResourceState> getWitResourceState(
    Runtime &, const Value &value, const std::string &interfaceName,
    const std::string &resourceName, const std::string & = "") {
    const auto object = value.asObject(*jsRuntime);
    const auto resource = std::dynamic_pointer_cast<WitResourceObject>(object.getHostObject(*jsRuntime));
    if (!resource || resource->state()->interfaceName != interfaceName ||
        resource->state()->resourceName != resourceName)
        throw std::runtime_error("Expected " + interfaceName + "." + resourceName + " resource");
    if (!resource->state()->valid) throw std::runtime_error("Resource is not valid");
    return resource->state();
}
Value jsString(Runtime &, const std::string &value) { return Value(value); }
std::string utf8(Runtime &, const Value &value) { return value.asString(); }
std::string wasiStringValue(const plugin_string_t &value) {
    return value.len ? std::string(reinterpret_cast<const char *>(value.ptr), value.len) : std::string{};
}
template <typename Integer>
Integer wasiInputInteger(Runtime &, const Value &value, const char *) {
    const double number = value.asNumber();
    if (!std::isfinite(number) || std::trunc(number) != number ||
        number < static_cast<double>(std::numeric_limits<Integer>::lowest()) ||
        number > static_cast<double>(std::numeric_limits<Integer>::max()))
        throw std::runtime_error("Expected an integral WIT value");
    return static_cast<Integer>(number);
}
void copyString(plugin_string_t *target, Runtime &runtime, const Value &value) {
    const auto text = utf8(runtime, value);
    plugin_string_dup_n(target, text.data(), text.size());
}
void initializeRuntime() {}
std::string invokedExport;
std::vector<Value> receivedArgs;
Value callbackResult;
Value callExport(const char *name, Value *args, std::size_t count) {
    invokedExport = name;
    receivedArgs.assign(args, args + count);
    return callbackResult;
}
void logPluginError(const std::string &message) { if (!message.empty()) loggedErrors++; }

/* GENERATED_COMMAND_SUGGESTION_HANDLER */

plugin_suggestion_request_t makeRequest() {
    plugin_suggestion_request_t request{};
    plugin_string_dup_n(&request.input, "/wp g", 5);
    request.cursor = 5;
    request.start = 4;
    plugin_string_dup_n(&request.remaining, "g", 1);
    return request;
}
Object makeTooltip(Runtime &runtime, std::int32_t handle,
                   const std::shared_ptr<ResourceState> &state) {
    *state = ResourceState{handle, true, "text", "text-component"};
    return Object::createFromHostObject(runtime, std::make_shared<WitResourceObject>(state));
}
Object makeResult(Runtime &runtime, const std::shared_ptr<ResourceState> &tooltipState,
                  bool malformedSecondValue = false) {
    Object result(runtime);
    result.setProperty(runtime, "start", Value(4));
    result.setProperty(runtime, "length", Value(1));
    Object first(runtime);
    first.setProperty(runtime, "value", Value("grass"));
    first.setProperty(runtime, "tooltip", Value(makeTooltip(runtime, 77, tooltipState)));
    Object second(runtime);
    second.setProperty(runtime, "value", malformedSecondValue ? Value(2) : Value("gravel"));
    second.setProperty(runtime, "tooltip", Value::null());
    Object valuesObject(runtime);
    // Store the array as an object value so the result matches the pinned WIT list shape.
    valuesObject = Object(std::make_shared<ObjectData>());
    valuesObject.data()->isArray = true;
    valuesObject.data()->values = {Value(first), Value(second)};
    result.setProperty(runtime, "values", Value(valuesObject));
    return result;
}

int main() {
    Runtime runtime;
    jsRuntime = &runtime;
    auto tooltipState = std::make_shared<ResourceState>(ResourceState{0, false, "text", "text-component"});
    callbackResult = Value(makeResult(runtime, tooltipState));
    auto request = makeRequest();
    plugin_command_suggestions_t result{};
    exports_plugin_handle_command_suggestion(23, {41}, {42}, &request, &result);
    assert(invokedExport == "handleCommandSuggestion");
    assert(receivedArgs.size() == 4);
    assert(receivedArgs[0].asNumber() == 23);
    const auto sender = std::dynamic_pointer_cast<WitResourceObject>(
        receivedArgs[1].asObject(runtime).getHostObject(runtime));
    const auto server = std::dynamic_pointer_cast<WitResourceObject>(
        receivedArgs[2].asObject(runtime).getHostObject(runtime));
    assert(sender && sender->state()->handle == 41 && sender->state()->resourceName == "command-sender");
    assert(server && server->state()->handle == 42 && server->state()->resourceName == "server");
    const auto requestObject = receivedArgs[3].asObject(runtime);
    assert(requestObject.getProperty(runtime, "input").asString() == "/wp g");
    assert(requestObject.getProperty(runtime, "cursor").asNumber() == 5);
    assert(requestObject.getProperty(runtime, "start").asNumber() == 4);
    assert(requestObject.getProperty(runtime, "remaining").asString() == "g");
    assert(result.start == 4 && result.length == 1 && result.values.len == 2);
    assert(std::string(reinterpret_cast<char *>(result.values.ptr[0].value.ptr),
                       result.values.ptr[0].value.len) == "grass");
    assert(result.values.ptr[0].tooltip.is_some && result.values.ptr[0].tooltip.val.__handle == 77);
    assert(std::string(reinterpret_cast<char *>(result.values.ptr[1].value.ptr),
                       result.values.ptr[1].value.len) == "gravel");
    assert(!result.values.ptr[1].tooltip.is_some);
    assert(!tooltipState->owned && textDrops == 0);
    assert(senderDrops == 1 && serverDrops == 1 && requestFrees == 1);
    plugin_command_suggestions_free(&result);

    auto failedTooltipState = std::make_shared<ResourceState>(ResourceState{0, false, "text", "text-component"});
    callbackResult = Value(makeResult(runtime, failedTooltipState, true));
    request = makeRequest();
    result = {};
    exports_plugin_handle_command_suggestion(24, {43}, {44}, &request, &result);
    assert(loggedErrors == 1);
    assert(result.start == 0 && result.length == 0 && result.values.ptr == nullptr && result.values.len == 0);
    assert(failedTooltipState->owned == false && textDrops == 1);
    assert(senderDrops == 2 && serverDrops == 2 && requestFrees == 2);
    assert(stringAllocations == stringFrees);
}
