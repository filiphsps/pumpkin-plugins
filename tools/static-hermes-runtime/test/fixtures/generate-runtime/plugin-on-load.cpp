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
void initializeRuntime() { throw std::runtime_error("bundle evaluation failed"); }
void callExport(const char *, const Value *, std::size_t) {}
void setError(plugin_string_t *error, const std::string &message) {
    error->ptr = static_cast<std::uint8_t *>(std::malloc(message.size()));
    assert(error->ptr);
    std::memcpy(error->ptr, message.data(), message.size());
    error->len = message.size();
}
/* GENERATED_PLUGIN_ON_LOAD */

int main() {
    plugin_string_t error{};
    assert(!exports_plugin_on_load({9}, &error));
    assert(contextDrops == 1);
    assert(error.len == std::strlen("bundle evaluation failed"));
    assert(std::string(reinterpret_cast<char *>(error.ptr), error.len) ==
           "bundle evaluation failed");
    std::free(error.ptr);
}
