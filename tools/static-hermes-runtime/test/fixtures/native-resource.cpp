#include <cassert>
#include <memory>
#include <string>

#include "runtime-contract-support.hpp"

/* GENERATED_NATIVE_RESOURCE */

class ProbeResource : public HostObject {};

int main() {
    Runtime runtime;

    bool plainObjectRejected = false;
    try {
        nativeResource(runtime, Value(Object(runtime)));
    } catch (const JSError &) {
        plainObjectRejected = true;
    }
    assert(plainObjectRejected);

    const auto resource = std::make_shared<ProbeResource>();
    Object wrapper(runtime);
    wrapper.setProperty(runtime, "__staticHermesResource",
                        Value(Object::createFromHostObject(runtime, resource)));
    assert(nativeResource(runtime, Value(wrapper)) == resource);
}
