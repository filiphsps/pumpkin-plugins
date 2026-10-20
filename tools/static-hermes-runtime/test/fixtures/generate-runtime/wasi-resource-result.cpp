#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include "runtime-contract-support.hpp"

Value jsString(Runtime &, const char *) { return {}; }

template <typename Callback>
Value hostFunction(Runtime &runtime, const char *, unsigned int, Callback callback) {
    return callback(runtime, Value{}, nullptr, 0);
}

struct ResourceState {
    int32_t handle;
    bool owned;
    std::string interfaceName;
    std::string resourceName;
    std::string packageName;
};

class WitResourceHostObject : public HostObject {
  public:
    explicit WitResourceHostObject(std::shared_ptr<ResourceState> state) : state(std::move(state)) {}
    std::shared_ptr<ResourceState> state;
};

std::shared_ptr<HostObject> makeWitResourceObject(std::shared_ptr<ResourceState> state) {
    return std::make_shared<WitResourceHostObject>(std::move(state));
}

Value wrapResourceObject(Runtime &runtime, std::shared_ptr<HostObject> resource) {
    return Object::createFromHostObject(runtime, std::move(resource));
}

struct wasi_http_types_borrow_incoming_response_t { int32_t __handle; };
struct wasi_http_types_own_incoming_body_t { int32_t __handle; };
enum wasi_http_types_error_code_t { WASI_HTTP_TYPES_ERROR_CODE_PROTOCOL_ERROR };

int32_t consumedResponseHandle = -1;
bool wasi_http_types_method_incoming_response_consume(
    wasi_http_types_borrow_incoming_response_t response,
    wasi_http_types_own_incoming_body_t *body,
    wasi_http_types_error_code_t *) {
    consumedResponseHandle = response.__handle;
    body->__handle = 73;
    return true;
}

/* GENERATED_WASI_RESOURCE_METHOD */

int main() {
    Runtime runtime;
    auto response = std::make_shared<ResourceState>(ResourceState{
        41, false, "types", "incoming-response", "wasi:http"});
    const Value result = generatedWasiResourceMethod(
        runtime, "wasi:http", "types", "incoming-response", "consume", response);
    assert(consumedResponseHandle == 41);
    assert(result.kind == Value::Kind::Object);
    const auto body = std::dynamic_pointer_cast<WitResourceHostObject>(
        result.asObject(runtime).getHostObject(runtime));
    assert(body);
    assert(body->state->handle == 73);
    assert(body->state->owned);
    assert(body->state->interfaceName == "types");
    assert(body->state->resourceName == "incoming-body");
    assert(body->state->packageName == "wasi:http");
}
