#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include "runtime-contract-support.hpp"

struct plugin_string_t { std::uint8_t *ptr; std::size_t len; };
struct plugin_own_context_t { std::int32_t __handle; };
struct pumpkin_plugin_context_own_context_t { std::int32_t __handle; };
int contextDrops = 0;
void pumpkin_plugin_context_context_drop_own(pumpkin_plugin_context_own_context_t context) {
    assert(context.__handle == 9);
    contextDrops++;
}

struct ResourceState {
    std::int32_t handle;
    bool owned;
    std::string interfaceName;
    std::string resourceName;
    void drop() {
        if (!owned) return;
        owned = false;
        assert(interfaceName == "context" && resourceName == "context");
        pumpkin_plugin_context_context_drop_own({handle});
    }
};
class WitResourceObject : public HostObject {
  public:
    explicit WitResourceObject(std::shared_ptr<ResourceState>) {}
};
std::shared_ptr<WitResourceObject> makeWitResourceObject(std::shared_ptr<ResourceState> state) {
    return std::make_shared<WitResourceObject>(std::move(state));
}
Object wrapResourceObject(Runtime &runtime, std::shared_ptr<WitResourceObject> context) {
    return Object::createFromHostObject(runtime, std::move(context));
}

int unloadCalls = 0;
void callExport(const char *name, const Value *, std::size_t) {
    assert(std::string(name) == "onUnload");
    unloadCalls++;
    throw 42;
}
int runtimeResets = 0;
void resetRuntime() {
    jsRuntime = nullptr;
    runtimeResets++;
}
void setError(plugin_string_t *error, const std::string &message) {
    error->ptr = static_cast<std::uint8_t *>(std::malloc(message.size()));
    assert(error->ptr);
    std::memcpy(error->ptr, message.data(), message.size());
    error->len = message.size();
}
/* GENERATED_PLUGIN_ON_UNLOAD */

int main() {
    // Pumpkin unloads a plugin whose load failed, after the runtime was torn down.
    plugin_string_t error{reinterpret_cast<std::uint8_t *>(1), 1};
    assert(exports_plugin_on_unload({9}, &error));
    assert(error.ptr == nullptr && error.len == 0);
    assert(contextDrops == 1);
    assert(unloadCalls == 0);

    // A handler that throws something other than a std::exception still fails the unload cleanly.
    Runtime runtime;
    jsRuntime = &runtime;
    contextDrops = 0;
    assert(!exports_plugin_on_unload({9}, &error));
    assert(unloadCalls == 1);
    assert(error.len > 0);
    std::free(error.ptr);
    assert(contextDrops == 1);
    assert(runtimeResets == 1 && jsRuntime == nullptr);
}
