#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "runtime-contract-support.hpp"

struct plugin_own_server_instance_t { std::int32_t __handle; };
struct plugin_own_entity_t { std::int32_t __handle; };
struct plugin_own_chunk_buffer_t { std::int32_t __handle; };
struct pumpkin_plugin_server_own_server_t { std::int32_t __handle; };
struct pumpkin_plugin_world_own_entity_t { std::int32_t __handle; };
struct pumpkin_plugin_world_own_chunk_buffer_t { std::int32_t __handle; };
using plugin_generation_phase_t = std::uint8_t;

#define PUMPKIN_PLUGIN_WORLD_GENERATION_PHASE_BIOMES 0
#define PUMPKIN_PLUGIN_WORLD_GENERATION_PHASE_NOISE 1
#define PUMPKIN_PLUGIN_WORLD_GENERATION_PHASE_SURFACE 2
#define PUMPKIN_PLUGIN_WORLD_GENERATION_PHASE_FEATURES 3

std::vector<std::int32_t> droppedServerHandles;
std::vector<std::int32_t> droppedEntityHandles;
std::vector<std::int32_t> droppedChunkHandles;

void pumpkin_plugin_server_server_drop_own(pumpkin_plugin_server_own_server_t resource) {
    droppedServerHandles.push_back(resource.__handle);
}
void pumpkin_plugin_world_entity_drop_own(pumpkin_plugin_world_own_entity_t resource) {
    droppedEntityHandles.push_back(resource.__handle);
}
void pumpkin_plugin_world_chunk_buffer_drop_own(pumpkin_plugin_world_own_chunk_buffer_t resource) {
    droppedChunkHandles.push_back(resource.__handle);
}

struct ResourceState {
    std::int32_t handle;
    bool owned;
    std::string interfaceName;
    std::string resourceName;
    std::string packageName;
    bool valid = true;

    void drop() {
        if (!owned) return;
        owned = false;
        valid = false;
        if (interfaceName == "server" && resourceName == "server")
            pumpkin_plugin_server_server_drop_own({handle});
        else if (interfaceName == "world" && resourceName == "entity")
            pumpkin_plugin_world_entity_drop_own({handle});
        else if (interfaceName == "world" && resourceName == "chunk-buffer")
            pumpkin_plugin_world_chunk_buffer_drop_own({handle});
        else
            throw std::runtime_error("Unexpected Pumpkin resource");
    }
};

class WitResourceObject : public HostObject {
  public:
    explicit WitResourceObject(std::shared_ptr<ResourceState> state) : state(std::move(state)) {}
    std::shared_ptr<ResourceState> state;
};

std::shared_ptr<WitResourceObject> makeWitResourceObject(std::shared_ptr<ResourceState> state) {
    return std::make_shared<WitResourceObject>(std::move(state));
}
Object wrapResourceObject(Runtime &runtime, std::shared_ptr<WitResourceObject> resource) {
    return Object::createFromHostObject(runtime, std::move(resource));
}
Value jsString(Runtime &, const char *value) { return Value(value); }
void initializeRuntime() {}

std::string invokedExport;
std::vector<Value> receivedArguments;
Value callbackResult = Value::fromBool(false);
bool callbackThrows = false;
int loggedErrors = 0;
Value callExport(const char *name, Value *arguments, std::size_t count) {
    invokedExport = name;
    receivedArguments.assign(arguments, arguments + count);
    if (callbackThrows) throw JSError("callback failed");
    return callbackResult;
}
void logPluginError(const std::string &message) {
    if (!message.empty()) loggedErrors++;
}

/* GENERATED_CALLBACKS */

std::shared_ptr<ResourceState> receivedResource(std::size_t index) {
    auto &runtime = *jsRuntime;
    const auto resource = std::dynamic_pointer_cast<WitResourceObject>(
        receivedArguments.at(index).asObject(runtime).getHostObject(runtime));
    assert(resource);
    return resource->state;
}

void assertGoalCall(const char *name, std::uint32_t goalId, std::int32_t serverHandle,
                    std::int32_t entityHandle) {
    assert(invokedExport == name);
    assert(receivedArguments.size() == 3);
    assert(receivedArguments[0].asNumber() == goalId);
    assert(receivedResource(1)->handle == serverHandle);
    assert(receivedResource(1)->interfaceName == "server");
    assert(receivedResource(2)->handle == entityHandle);
    assert(receivedResource(2)->interfaceName == "world");
}

int main() {
    Runtime runtime;
    jsRuntime = &runtime;

    callbackResult = Value::fromBool(true);
    assert(exports_plugin_handle_ai_goal_can_start(1, {101}, {201}));
    assertGoalCall("handleAiGoalCanStart", 1, 101, 201);
    assert(exports_plugin_handle_ai_goal_should_continue(2, {102}, {202}));
    assertGoalCall("handleAiGoalShouldContinue", 2, 102, 202);
    exports_plugin_handle_ai_goal_start(3, {103}, {203});
    assertGoalCall("handleAiGoalStart", 3, 103, 203);
    exports_plugin_handle_ai_goal_tick(4, {104}, {204});
    assertGoalCall("handleAiGoalTick", 4, 104, 204);
    exports_plugin_handle_ai_goal_stop(5, {105}, {205});
    assertGoalCall("handleAiGoalStop", 5, 105, 205);

    exports_plugin_handle_generate_phase(6, PUMPKIN_PLUGIN_WORLD_GENERATION_PHASE_SURFACE, {306});
    assert(invokedExport == "handleGeneratePhase");
    assert(receivedArguments.size() == 3);
    assert(receivedArguments[0].asNumber() == 6);
    assert(receivedArguments[1].asString() == "surface");
    assert(receivedResource(2)->handle == 306);
    assert(receivedResource(2)->resourceName == "chunk-buffer");

    assert((droppedServerHandles == std::vector<std::int32_t>{101, 102, 103, 104, 105}));
    assert((droppedEntityHandles == std::vector<std::int32_t>{201, 202, 203, 204, 205}));
    assert((droppedChunkHandles == std::vector<std::int32_t>{306}));
    assert(loggedErrors == 0);

    // A throwing handler fails boolean goal callbacks, logs every error and still drops every resource.
    callbackThrows = true;
    assert(!exports_plugin_handle_ai_goal_can_start(11, {111}, {211}));
    assert(!exports_plugin_handle_ai_goal_should_continue(12, {112}, {212}));
    exports_plugin_handle_ai_goal_start(13, {113}, {213});
    exports_plugin_handle_ai_goal_tick(14, {114}, {214});
    exports_plugin_handle_ai_goal_stop(15, {115}, {215});
    exports_plugin_handle_generate_phase(16, PUMPKIN_PLUGIN_WORLD_GENERATION_PHASE_NOISE, {316});
    assert(loggedErrors == 6);
    assert((droppedServerHandles ==
            std::vector<std::int32_t>{101, 102, 103, 104, 105, 111, 112, 113, 114, 115}));
    assert((droppedEntityHandles ==
            std::vector<std::int32_t>{201, 202, 203, 204, 205, 211, 212, 213, 214, 215}));
    assert((droppedChunkHandles == std::vector<std::int32_t>{306, 316}));
}
