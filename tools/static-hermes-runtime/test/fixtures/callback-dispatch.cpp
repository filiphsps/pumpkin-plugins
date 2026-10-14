#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

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

enum class ResourceKind { Server, Entity, ChunkBuffer, Wit };
struct ResourceState {
    ResourceKind kind;
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

class ResourceObject {
  public:
    explicit ResourceObject(std::shared_ptr<ResourceState> state) : state(std::move(state)) {}
    std::shared_ptr<ResourceState> state;
};
class ServerObject : public ResourceObject { using ResourceObject::ResourceObject; };

class Runtime {};
Runtime *jsRuntime = nullptr;
template <typename Callback>
class WitScopeGuard {
  public:
    explicit WitScopeGuard(Callback callback) : callback(std::move(callback)) {}
    ~WitScopeGuard() { if (active) callback(); }
    void release() { active = false; }
  private:
    Callback callback;
    bool active = true;
};
class Object {
  public:
    explicit Object(std::shared_ptr<ResourceObject> resource) : resource(std::move(resource)) {}
    std::shared_ptr<ResourceObject> resource;
};
struct Value {
    enum class Kind { Boolean, Number, String, Object };
    Kind kind;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::shared_ptr<ResourceObject> resource;

    explicit Value(bool value) : kind(Kind::Boolean), boolean(value) {}
    explicit Value(double value) : kind(Kind::Number), number(value) {}
    explicit Value(std::string value) : kind(Kind::String), string(std::move(value)) {}
    explicit Value(Object object) : kind(Kind::Object), resource(std::move(object.resource)) {}
    bool getBool() const {
        if (kind != Kind::Boolean) throw std::runtime_error("Expected callback boolean");
        return boolean;
    }
    bool asBool() const {
        if (kind != Kind::Boolean) throw std::runtime_error("Expected callback boolean");
        return boolean;
    }
};

std::shared_ptr<ResourceObject> makeWitResourceObject(std::shared_ptr<ResourceState> state) {
    return std::make_shared<ResourceObject>(std::move(state));
}
Object wrapResourceObject(Runtime &, std::shared_ptr<ResourceObject> resource) {
    return Object(std::move(resource));
}
Value jsString(Runtime &, const char *value) { return Value(std::string(value)); }
void initializeRuntime() {}

std::string invokedExport;
std::vector<Value> receivedArguments;
Value callbackResult(false);
int loggedErrors = 0;
Value callExport(const char *name, Value *arguments, std::size_t count) {
    invokedExport = name;
    receivedArguments.assign(arguments, arguments + count);
    return callbackResult;
}
void logPluginError(const std::string &message) {
    if (!message.empty()) loggedErrors++;
}

/* GENERATED_CALLBACKS */

void assertGoalCall(const char *name, std::uint32_t goalId, std::int32_t serverHandle,
                    std::int32_t entityHandle) {
    assert(invokedExport == name);
    assert(receivedArguments.size() == 3);
    assert(receivedArguments[0].kind == Value::Kind::Number);
    assert(receivedArguments[0].number == goalId);
    assert(receivedArguments[1].resource->state->handle == serverHandle);
    assert(receivedArguments[1].resource->state->interfaceName == "server");
    assert(receivedArguments[2].resource->state->handle == entityHandle);
    assert(receivedArguments[2].resource->state->interfaceName == "world");
}

int main() {
    callbackResult = Value(true);
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
    assert(receivedArguments[0].number == 6);
    assert(receivedArguments[1].kind == Value::Kind::String);
    assert(receivedArguments[1].string == "surface");
    assert(receivedArguments[2].resource->state->handle == 306);
    assert(receivedArguments[2].resource->state->resourceName == "chunk-buffer");

    assert((droppedServerHandles == std::vector<std::int32_t>{101, 102, 103, 104, 105}));
    assert((droppedEntityHandles == std::vector<std::int32_t>{201, 202, 203, 204, 205}));
    assert((droppedChunkHandles == std::vector<std::int32_t>{306}));
    assert(loggedErrors == 0);
}
