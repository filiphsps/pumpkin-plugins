#include <cassert>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "runtime-contract-support.hpp"

struct plugin_own_server_instance_t { std::int32_t __handle; };
struct pumpkin_plugin_server_own_server_t { std::int32_t __handle; };
int serverDrops = 0;
void pumpkin_plugin_server_server_drop_own(pumpkin_plugin_server_own_server_t) { serverDrops++; }
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
    }
    void transfer() { owned = false; valid = false; }
};
class WitResourceObject final : public HostObject {
  public:
    explicit WitResourceObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}
    const std::shared_ptr<ResourceState> &state() const { return state_; }
  private:
    std::shared_ptr<ResourceState> state_;
};
std::shared_ptr<WitResourceObject> makeWitResourceObject(std::shared_ptr<ResourceState> state) {
    return std::make_shared<WitResourceObject>(std::move(state));
}
Object wrapResourceObject(Runtime &runtime, std::shared_ptr<WitResourceObject> resource) {
    return Object::createFromHostObject(runtime, std::move(resource));
}
std::shared_ptr<HostObject> nativeResource(Runtime &runtime, const Value &value) {
    return value.asObject(runtime).getHostObject(runtime);
}
std::shared_ptr<ResourceState> getWitResourceState(Runtime &runtime, const Value &value,
                                                   const std::string &interfaceName,
                                                   const std::string &resourceName,
                                                   const std::string &packageName);
/* GENERATED_GET_WIT_RESOURCE_STATE */

struct plugin_event_t { std::int32_t value; };
Object makeEvent(Runtime &runtime, plugin_event_t *, std::vector<std::shared_ptr<ResourceState>> *) {
    return Object(runtime);
}
void returnEvent(Runtime &, const Value &, plugin_event_t *, plugin_event_t *,
                 std::vector<std::shared_ptr<ResourceState>> *) {}
void logPluginError(const char *) {}
void initializeRuntime() {}

Value retainedServer;
bool dropDuringCallback = false;
Value callExport(const char *, const Value *args, std::size_t count) {
    assert(count >= 2);
    retainedServer = args[1];
    if (dropDuringCallback) {
        const auto server = std::dynamic_pointer_cast<WitResourceObject>(
            retainedServer.asObject(*jsRuntime).getHostObject(*jsRuntime));
        assert(server);
        server->state()->drop();
    }
    return {};
}

/* GENERATED_EVENT_CALLBACK */

/* GENERATED_TASK_CALLBACK */

int main() {
    Runtime runtime;
    jsRuntime = &runtime;
    plugin_event_t event{7};
    plugin_event_t ret{};
    exports_plugin_handle_event(5, {41}, &event, &ret);
    assert(serverDrops == 1);
    bool eventWrapperRejected = false;
    try {
        getWitResourceState(runtime, retainedServer, "server", "server", "");
    } catch (const JSError &) {
        eventWrapperRejected = true;
    }
    assert(eventWrapperRejected);

    serverDrops = 0;
    dropDuringCallback = true;
    exports_plugin_handle_task(9, {42});
    assert(serverDrops == 1);
    bool taskWrapperRejected = false;
    try {
        getWitResourceState(runtime, retainedServer, "server", "server", "");
    } catch (const JSError &) {
        taskWrapperRejected = true;
    }
    assert(taskWrapperRejected);
}
