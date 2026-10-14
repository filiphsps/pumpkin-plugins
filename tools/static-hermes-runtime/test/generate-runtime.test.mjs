import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const generator = path.join(packageRoot, 'test/oracles/generate-runtime.mjs');
const directories = [];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-runtime-generator-'));
    directories.push(root);
    const wit = path.join(root, 'wit');
    fs.mkdirSync(wit);
    fs.writeFileSync(
        path.join(wit, 'plugin.wit'),
        'package pumpkin:plugin@0.1.0;\nworld plugin {\n  import %world;\n  import context;\n  import server;\n  import player;\n  import command;\n  import text;\n  import common;\n  import event;\n  import wasi:filesystem/preopens@0.2.3;\n  import wasi:http/types@0.2.3;\n  import wasi:http/outgoing-handler@0.2.3;\n  import wasi:io/streams@0.2.3;\n  import wasi:clocks/monotonic-clock@0.2.3;\n  export init: func();\n}\n',
    );
    fs.writeFileSync(
        path.join(wit, 'world.wit'),
        'interface %world { resource world { get-min-y: func() -> s32; } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'context.wit'),
        'interface context { resource context { get-server: func() -> server; } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'server.wit'),
        'interface server { use world.{world}; resource server { get-mspt: func() -> f64; get-all-worlds: func() -> list<world>; } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'player.wit'),
        'interface player { resource player { get-saturation: func() -> f32; } }\n',
    );
    fs.writeFileSync(path.join(wit, 'command.wit'), 'interface command { resource command { then: func(); } }\n');
    fs.writeFileSync(
        path.join(wit, 'text.wit'),
        'interface text { resource text-component { color-named: func(); } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'common.wit'),
        'interface common { record block-pos { x: s32, y: s32, z: s32 } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'event.wit'),
        'interface event { use common.{block-pos}; use player.{player}; record player-custom-payload-event-data { player: player, channel: string, data: list<u8>, unused: string } record server-tick-end-event-data { tick: s32, duration-nanos: s64 } variant event { player-custom-payload-event(player-custom-payload-event-data), server-tick-end-event(server-tick-end-event-data), unused-event(string) } }\n',
    );
    const wasiDefinitions = {
        'filesystem/preopens.wit':
            'package wasi:filesystem@0.2.3; interface preopens { use types.{descriptor}; get-directories: func() -> list<tuple<descriptor, string>>; }\n',
        'filesystem/types.wit':
            'package wasi:filesystem@0.2.3; interface types { resource descriptor { stat: func() -> u32; } }\n',
        'http/types.wit':
            'package wasi:http@0.2.3; interface types { enum error-code { protocol-error } resource fields { constructor(); set: func(); } resource outgoing-request { constructor(headers: fields); } resource request-options { constructor(); } resource incoming-body; resource incoming-response { consume: func() -> result<incoming-body, error-code>; } resource future-incoming-response { get: func() -> result<option<incoming-response>, error-code>; } }\n',
        'http/outgoing-handler.wit':
            'package wasi:http@0.2.3; interface outgoing-handler { use types.{outgoing-request, request-options}; handle: func(request: outgoing-request, options: option<request-options>); }\n',
        'io/streams.wit':
            'package wasi:io@0.2.3; interface streams { variant stream-error { closed } resource input-stream { read: func(len: u64) -> result<list<u8>, stream-error>; } }\n',
        'clocks/monotonic-clock.wit': 'package wasi:clocks@0.2.3; interface monotonic-clock { now: func() -> u64; }\n',
    };
    for (const [relativePath, source] of Object.entries(wasiDefinitions)) {
        const file = path.join(wit, 'deps', relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
    }
    const template = path.join(packageRoot, 'src/component/templates/runtime-shim.template');
    return { root, wit, template, output: path.join(root, 'runtime.cpp'), bundle: path.join(root, 'bundle.js') };
}

function addUnsupportedWasiRuntime(witDir) {
    const pluginPath = path.join(witDir, 'plugin.wit');
    const pluginSource = fs.readFileSync(pluginPath, 'utf8');
    fs.writeFileSync(
        pluginPath,
        pluginSource.replace('  export init: func();', '  import wasi:test/runtime@0.2.3;\n  export init: func();'),
    );
    const dependencyDir = path.join(witDir, 'deps/test');
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(
        path.join(dependencyDir, 'world.wit'),
        'package wasi:test@0.2.3; world imports { import runtime; }\n',
    );
    fs.writeFileSync(
        path.join(dependencyDir, 'runtime.wit'),
        'package wasi:test@0.2.3; interface runtime { unsupported: func(value: future-value); }\n',
    );
}

function generate({ wit, template, output, wasiImports, wasiMethods, bundle, bundleSource = 'server.getMspt();' }) {
    fs.writeFileSync(bundle, bundleSource);
    childProcess.execFileSync(
        process.execPath,
        [
            generator,
            '--wit',
            wit,
            '--bundle',
            bundle,
            '--template',
            template,
            '--wasi-imports',
            JSON.stringify(wasiImports),
            ...(wasiMethods === undefined ? [] : ['--wasi-methods', JSON.stringify(wasiMethods)]),
            '--output',
            output,
        ],
        { stdio: 'pipe' },
    );
}

function compileAndRunCpp(root, source) {
    const input = path.join(root, 'runtime-contract.cpp');
    const executable = path.join(root, 'runtime-contract');
    fs.writeFileSync(input, source);
    childProcess.execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', input, '-o', executable], { stdio: 'pipe' });
    childProcess.execFileSync(executable, [], { stdio: 'pipe' });
}

function generatedBlock(source, marker) {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`generated source is missing ${marker}`);
    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`generated source has no body for ${marker}`);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`generated source has an unclosed body for ${marker}`);
}

const WASI_RESOURCE_RESULT_HARNESS = /* cpp */ `
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

class Runtime {};
class HostObject {
  public:
    virtual ~HostObject() = default;
};

class Value {
  public:
    enum class Kind { Undefined, Object };
    Kind kind = Kind::Undefined;
    std::shared_ptr<HostObject> hostObject;
    static Value undefined() { return {}; }
};

class Object : public Value {
  public:
    explicit Object(Runtime &) { kind = Kind::Object; }
    void setProperty(Runtime &, const char *, Value) {}
    static Value createFromHostObject(Runtime &, std::shared_ptr<HostObject> object) {
        Value value;
        value.kind = Kind::Object;
        value.hostObject = std::move(object);
        return value;
    }
};

class JSError : public std::runtime_error {
  public:
    JSError(Runtime &, const char *message) : std::runtime_error(message) {}
};

Value jsString(Runtime &, const char *) { return {}; }

template <typename Callback>
Value hostFunction(Runtime &runtime, const char *, unsigned int, Callback callback) {
    return callback(runtime, Value{}, nullptr, 0);
}

enum class ResourceKind { Wit };
struct ResourceState {
    ResourceKind kind;
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
        ResourceKind::Wit, 41, false, "types", "incoming-response", "wasi:http"});
    const Value result = generatedWasiResourceMethod(
        runtime, "wasi:http", "types", "incoming-response", "consume", response);
    assert(consumedResponseHandle == 41);
    assert(result.kind == Value::Kind::Object);
    const auto body = std::dynamic_pointer_cast<WitResourceHostObject>(result.hostObject);
    assert(body);
    assert(body->state->kind == ResourceKind::Wit);
    assert(body->state->handle == 73);
    assert(body->state->owned);
    assert(body->state->interfaceName == "types");
    assert(body->state->resourceName == "incoming-body");
    assert(body->state->packageName == "wasi:http");
}
`;

const WIT_EVENT_HARNESS = /* cpp */ `
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

class Runtime {};

struct Value {
    enum class Kind { Undefined, String, Bytes };
    Kind kind = Kind::Undefined;
    std::string string;
    std::vector<std::uint8_t> bytes;
};

class ArrayBuffer {
  public:
    explicit ArrayBuffer(std::vector<std::uint8_t> *bytes) : bytes(bytes) {}
    void *data(Runtime &) { return bytes->data(); }
  private:
    std::vector<std::uint8_t> *bytes;
};

class Uint8Array {
  public:
    Uint8Array(Runtime &, std::size_t size) : bytes(size) {}
    ArrayBuffer buffer(Runtime &) { return ArrayBuffer(&bytes); }
    std::vector<std::uint8_t> bytes;
};

class Object {
  public:
    explicit Object(Runtime &) {}
    void setProperty(Runtime &, const char *name, Value value) { properties[name] = std::move(value); }
    void setProperty(Runtime &, const char *name, Uint8Array value) {
        Value bytes;
        bytes.kind = Value::Kind::Bytes;
        bytes.bytes = std::move(value.bytes);
        properties[name] = std::move(bytes);
    }
    const Value &getProperty(const char *name) const { return properties.at(name); }
    bool hasProperty(const char *name) const { return properties.count(name) != 0; }
  private:
    std::unordered_map<std::string, Value> properties;
};

Value jsString(Runtime &, const std::string &value) {
    Value result;
    result.kind = Value::Kind::String;
    result.string = value;
    return result;
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
`;

const COMMAND_HANDLER_HARNESS = /* cpp */ `
#include <cassert>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

class Runtime {};
Runtime *jsRuntime = nullptr;

enum class ResourceKind { CommandSender, Server, ConsumedArgs };
int senderDrops = 0;
int serverDrops = 0;
int argsDrops = 0;

struct ResourceState {
    ResourceKind kind;
    std::int32_t handle;
    bool owned;
    void drop() {
        if (!owned) return;
        owned = false;
        if (kind == ResourceKind::CommandSender) senderDrops++;
        if (kind == ResourceKind::Server) serverDrops++;
        if (kind == ResourceKind::ConsumedArgs) argsDrops++;
    }
};

class HostObject {
  public:
    virtual ~HostObject() = default;
};

struct Value {
    enum class Kind { Undefined, Number, Object };
    Kind kind = Kind::Undefined;
    double number = 0;
    std::shared_ptr<HostObject> hostObject;
    Value() = default;
    explicit Value(double number) : kind(Kind::Number), number(number) {}
    static Value object(std::shared_ptr<HostObject> hostObject) {
        Value value;
        value.kind = Kind::Object;
        value.hostObject = std::move(hostObject);
        return value;
    }
    bool isNumber() const { return kind == Kind::Number; }
    double asNumber() const { return number; }
};

class Object {
  public:
    static Value createFromHostObject(Runtime &, std::shared_ptr<HostObject> hostObject) {
        return Value::object(std::move(hostObject));
    }
};

Value wrapResourceObject(Runtime &runtime, std::shared_ptr<HostObject> resource) {
    return Object::createFromHostObject(runtime, std::move(resource));
}

template <typename State>
class ResourceObject : public HostObject {
  public:
    explicit ResourceObject(std::shared_ptr<State> state) : state(std::move(state)) {}
    std::shared_ptr<State> state;
};
class CommandSenderObject : public ResourceObject<ResourceState> { using ResourceObject::ResourceObject; };
class ServerObject : public ResourceObject<ResourceState> { using ResourceObject::ResourceObject; };
class ConsumedArgsObject : public ResourceObject<ResourceState> { using ResourceObject::ResourceObject; };

struct plugin_own_command_sender_t { std::int32_t __handle; };
struct plugin_own_server_instance_t { std::int32_t __handle; };
struct plugin_own_consumed_args_t { std::int32_t __handle; };
struct plugin_command_error_t { char message[128]; };

void pumpkin_plugin_command_command_sender_drop_own(plugin_own_command_sender_t) {}
void pumpkin_plugin_server_server_drop_own(plugin_own_server_instance_t) {}
void pumpkin_plugin_command_consumed_args_drop_own(plugin_own_consumed_args_t) {}
void initializeRuntime() {}

class JSError : public std::runtime_error {
  public:
    explicit JSError(const std::string &message) : std::runtime_error(message) {}
    std::string getMessage() const { return what(); }
    std::string getStack() const { return what(); }
};

std::string invokedExport;
std::vector<Value> receivedArgs;
Value callExport(const char *name, Value *args, std::size_t count) {
    invokedExport = name;
    receivedArgs.assign(args, args + count);
    return Value(19);
}
bool setCommandFailure(plugin_command_error_t *, const JSError &) { return false; }
void setCommandError(plugin_command_error_t *error, const std::string &message) {
    std::strncpy(error->message, message.c_str(), sizeof(error->message) - 1);
}

/* GENERATED_COMMAND_HANDLER */

int main() {
    Runtime runtime;
    jsRuntime = &runtime;
    int result = -1;
    plugin_command_error_t error{};
    const bool handled = exports_plugin_handle_command(
        23, {41}, {42}, {43}, &result, &error);
    assert(handled);
    assert(result == 19);
    assert(std::string(error.message).empty());
    assert(invokedExport == "handleCommand");
    assert(receivedArgs.size() == 4);
    assert(receivedArgs[0].isNumber() && receivedArgs[0].asNumber() == 23);
    const auto sender = std::dynamic_pointer_cast<CommandSenderObject>(receivedArgs[1].hostObject);
    const auto server = std::dynamic_pointer_cast<ServerObject>(receivedArgs[2].hostObject);
    const auto args = std::dynamic_pointer_cast<ConsumedArgsObject>(receivedArgs[3].hostObject);
    assert(sender && sender->state->handle == 41);
    assert(server && server->state->handle == 42);
    assert(args && args->state->handle == 43);
    assert(senderDrops == 1 && serverDrops == 1 && argsDrops == 1);
}
`;

const SERVER_CALLBACK_LIFETIME_HARNESS = fs.readFileSync(
    path.join(packageRoot, 'test/fixtures/server-callback-lifetime.cpp'),
    'utf8',
);

const COMMAND_SUGGESTION_HANDLER_HARNESS = /* cpp */ `
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

class Runtime {};
Runtime *jsRuntime = nullptr;

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

class HostObject {
  public:
    virtual ~HostObject() = default;
};
struct ObjectData;
class Object;
class Array;
struct Value {
    enum class Kind { Undefined, Null, Number, String, Object };
    Kind kind = Kind::Undefined;
    double number = 0;
    std::string string;
    std::shared_ptr<ObjectData> object;
    Value() = default;
    explicit Value(double number) : kind(Kind::Number), number(number) {}
    explicit Value(std::string string) : kind(Kind::String), string(std::move(string)) {}
    explicit Value(const char *string) : Value(std::string(string)) {}
    Value(Object object);
    bool isNumber() const { return kind == Kind::Number; }
    bool isString() const { return kind == Kind::String; }
    bool isObject() const { return kind == Kind::Object; }
    bool isUndefined() const { return kind == Kind::Undefined; }
    bool isNull() const { return kind == Kind::Null; }
    double asNumber() const {
        if (!isNumber()) throw std::runtime_error("Expected a number");
        return number;
    }
    const std::string &asString() const {
        if (!isString()) throw std::runtime_error("Expected a string");
        return string;
    }
    Object asObject(Runtime &) const;
    static Value null() { Value value; value.kind = Kind::Null; return value; }
};
struct ObjectData {
    std::unordered_map<std::string, Value> properties;
    std::vector<Value> values;
    std::shared_ptr<HostObject> hostObject;
    bool isArray = false;
};
class Object {
  public:
    explicit Object(Runtime &) : data_(std::make_shared<ObjectData>()) {}
    explicit Object(std::shared_ptr<ObjectData> data) : data_(std::move(data)) {}
    void setProperty(Runtime &, const char *name, Value value) {
        data_->properties[name] = std::move(value);
    }
    Value getProperty(Runtime &, const char *name) const {
        const auto found = data_->properties.find(name);
        return found == data_->properties.end() ? Value{} : found->second;
    }
    std::shared_ptr<HostObject> getHostObject(Runtime &) const { return data_->hostObject; }
    Array asArray(Runtime &) const;
    static Object createFromHostObject(Runtime &, std::shared_ptr<HostObject> hostObject) {
        auto data = std::make_shared<ObjectData>();
        data->hostObject = std::move(hostObject);
        return Object(std::move(data));
    }
    const std::shared_ptr<ObjectData> &data() const { return data_; }
  private:
    std::shared_ptr<ObjectData> data_;
};
class Array {
  public:
    Array(Runtime &, std::size_t size) : data_(std::make_shared<ObjectData>()) {
        data_->isArray = true;
        data_->values.resize(size);
    }
    explicit Array(std::shared_ptr<ObjectData> data) : data_(std::move(data)) {}
    std::size_t size(Runtime &) const { return data_->values.size(); }
    Value getValueAtIndex(Runtime &, std::size_t index) const { return data_->values.at(index); }
    void setValueAtIndex(Runtime &, std::size_t index, Value value) {
        data_->values.at(index) = std::move(value);
    }
  private:
    std::shared_ptr<ObjectData> data_;
};
Value::Value(Object value) : kind(Kind::Object), object(value.data()) {}
Object Value::asObject(Runtime &) const {
    if (!isObject()) throw std::runtime_error("Expected an object");
    return Object(object);
}
Array Object::asArray(Runtime &) const {
    if (!data_->isArray) throw std::runtime_error("Expected an array");
    return Array(data_);
}

enum class ResourceKind { CommandSender, Server, Text };
struct ResourceState {
    ResourceKind kind;
    std::int32_t handle;
    bool owned;
    bool valid = true;
    void drop() {
        if (!owned) return;
        owned = false;
        valid = false;
        if (kind == ResourceKind::CommandSender) senderDrops++;
        if (kind == ResourceKind::Server) serverDrops++;
        if (kind == ResourceKind::Text) textDrops++;
    }
    void transfer() { owned = false; valid = false; }
};
void pumpkin_plugin_command_command_sender_drop_own(plugin_own_command_sender_t) {}
void pumpkin_plugin_server_server_drop_own(plugin_own_server_instance_t) {}
class ResourceObject : public HostObject {
  public:
    explicit ResourceObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}
    const std::shared_ptr<ResourceState> &state() const { return state_; }
  private:
    std::shared_ptr<ResourceState> state_;
};
class CommandSenderObject : public ResourceObject { using ResourceObject::ResourceObject; };
class ServerObject : public ResourceObject { using ResourceObject::ResourceObject; };
class TextObject : public ResourceObject { using ResourceObject::ResourceObject; };

Object wrapResourceObject(Runtime &, std::shared_ptr<ResourceObject> resource) {
    return Object::createFromHostObject(*jsRuntime, std::move(resource));
}
std::shared_ptr<ResourceState> getWitResourceState(
    Runtime &, const Value &value, const std::string &interfaceName,
    const std::string &resourceName, const std::string & = "") {
    const auto object = value.asObject(*jsRuntime);
    const auto resource = std::dynamic_pointer_cast<ResourceObject>(object.getHostObject(*jsRuntime));
    if (!resource || interfaceName != "text" || resourceName != "text-component")
        throw std::runtime_error("Expected text.text-component resource");
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
template <typename Callback>
class WitScopeGuard {
  public:
    explicit WitScopeGuard(Callback callback) : callback_(std::move(callback)) {}
    ~WitScopeGuard() { if (active_) callback_(); }
    void release() { active_ = false; }
  private:
    Callback callback_;
    bool active_ = true;
};
class JSError : public std::runtime_error {
  public:
    JSError(Runtime &, const std::string &message) : std::runtime_error(message) {}
    explicit JSError(const std::string &message) : std::runtime_error(message) {}
    std::string getMessage() const { return what(); }
    std::string getStack() const { return what(); }
};
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
    *state = ResourceState{ResourceKind::Text, handle, true};
    return Object::createFromHostObject(runtime, std::make_shared<TextObject>(state));
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
    auto tooltipState = std::make_shared<ResourceState>(ResourceState{ResourceKind::Text, 0, false});
    callbackResult = Value(makeResult(runtime, tooltipState));
    auto request = makeRequest();
    plugin_command_suggestions_t result{};
    exports_plugin_handle_command_suggestion(23, {41}, {42}, &request, &result);
    assert(invokedExport == "handleCommandSuggestion");
    assert(receivedArgs.size() == 4);
    assert(receivedArgs[0].asNumber() == 23);
    const auto sender = std::dynamic_pointer_cast<CommandSenderObject>(
        receivedArgs[1].asObject(runtime).getHostObject(runtime));
    const auto server = std::dynamic_pointer_cast<ServerObject>(
        receivedArgs[2].asObject(runtime).getHostObject(runtime));
    assert(sender && sender->state()->handle == 41);
    assert(server && server->state()->handle == 42);
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

    auto failedTooltipState = std::make_shared<ResourceState>(ResourceState{ResourceKind::Text, 0, false});
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
`;

const PLUGIN_ON_LOAD_HARNESS = /* cpp */ `
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

struct plugin_string_t { std::uint8_t *ptr; std::size_t len; };
struct plugin_own_context_t { std::int32_t __handle; };
struct pumpkin_plugin_context_own_context_t { std::int32_t __handle; };
int contextDrops = 0;
void pumpkin_plugin_context_context_drop_own(pumpkin_plugin_context_own_context_t context) {
    assert(context.__handle == 9);
    contextDrops++;
}

class Runtime {};
Runtime *jsRuntime = nullptr;
enum class ResourceKind { Context };
struct ResourceState {
    ResourceKind kind;
    std::int32_t handle;
    bool owned;
    void drop() {
        if (!owned) return;
        owned = false;
        pumpkin_plugin_context_context_drop_own({handle});
    }
};
class Object {};
class Value {
  public:
    explicit Value(Object &&) {}
};
class ContextObject {
  public:
    explicit ContextObject(std::shared_ptr<ResourceState>) {}
};
Object wrapResourceObject(Runtime &, std::shared_ptr<ContextObject>) { return {}; }
void initializeRuntime() { throw std::runtime_error("bundle evaluation failed"); }
void callExport(const char *, const Value *, std::size_t) {}
void setError(plugin_string_t *error, const std::string &message) {
    error->ptr = static_cast<std::uint8_t *>(std::malloc(message.size()));
    assert(error->ptr);
    std::memcpy(error->ptr, message.data(), message.size());
    error->len = message.size();
}
template <typename Callback>
class WitScopeGuard {
  public:
    explicit WitScopeGuard(Callback callback) : callback_(std::move(callback)) {}
    ~WitScopeGuard() { if (active_) callback_(); }
    void release() { active_ = false; }
  private:
    Callback callback_;
    bool active_ = true;
};

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
`;

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('generate-runtime', () => {
    it('does not generate unsupported WASI operations when the bundle does not use them', () => {
        const f = fixture();
        addUnsupportedWasiRuntime(f.wit);
        f.wasiImports = [];
        f.wasiMethods = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).not.toContain('wasi_test_runtime_unsupported');
    });

    it('rejects selected WASI operations that have no type adapter', () => {
        const f = fixture();
        addUnsupportedWasiRuntime(f.wit);
        f.wasiImports = ['wasi:test/runtime@0.2.3'];
        f.wasiMethods = ['wasi:test/runtime@0.2.3#unsupported'];

        let failure;
        try {
            generate(f);
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeDefined();
        expect(failure.stderr?.toString()).toContain(
            'No Static Hermes JSI adapter is generated for wasi:test/runtime@0.2.3#unsupported',
        );
    });

    it('passes command IDs and owned resources to the plugin command callback', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const handler = generatedBlock(output, 'bool exports_plugin_handle_command(');
        compileAndRunCpp(f.root, COMMAND_HANDLER_HARNESS.replace('/* GENERATED_COMMAND_HANDLER */', handler));
    }, 15_000);

    it('invalidates server wrappers after event and task callbacks', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const resourceState = generatedBlock(output, 'std::shared_ptr<ResourceState>\ngetWitResourceState(');
        const eventHandler = generatedBlock(output, 'void exports_plugin_handle_event(');
        const taskHandler = generatedBlock(output, 'void exports_plugin_handle_task(');
        const source = SERVER_CALLBACK_LIFETIME_HARNESS.replace('/* GENERATED_GET_WIT_RESOURCE_STATE */', resourceState)
            .replace('/* GENERATED_EVENT_CALLBACK */', eventHandler)
            .replace('/* GENERATED_TASK_CALLBACK */', taskHandler);
        compileAndRunCpp(f.root, source);
    }, 15_000);

    it('dispatches command suggestions and marshals values, tooltips, and owned inputs', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const handler = generatedBlock(output, 'void exports_plugin_handle_command_suggestion(');
        compileAndRunCpp(
            f.root,
            COMMAND_SUGGESTION_HANDLER_HARNESS.replace('/* GENERATED_COMMAND_SUGGESTION_HANDLER */', handler),
        );
    }, 15_000);

    it('returns runtime initialization errors and releases the owned plugin context', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const onLoad = generatedBlock(output, 'bool exports_plugin_on_load(');
        compileAndRunCpp(f.root, PLUGIN_ON_LOAD_HARNESS.replace('/* GENERATED_PLUGIN_ON_LOAD */', onLoad));
    }, 15_000);

    it('generates event payloads from imported WIT and plugin event usage', () => {
        const f = fixture();
        f.wasiImports = [];
        f.bundleSource = ['registerEvent("player-custom-payload-event");', 'event.channel;', 'event.data;'].join('\n');

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const eventDispatch = generatedBlock(output, 'switch (event->tag)');
        compileAndRunCpp(f.root, WIT_EVENT_HARNESS.replace('/* GENERATED_WIT_EVENT_DISPATCH */', eventDispatch));
    }, 15_000);

    it('generates only selected WASI adapters from their WIT declarations', () => {
        const f = fixture();
        f.wasiImports = ['wasi:clocks/monotonic-clock@0.2.3'];
        f.wasiMethods = ['wasi:clocks/monotonic-clock@0.2.3#now'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('generatedMonotonicClockApi.setProperty');
        expect(output).toContain('wasi_clocks_monotonic_clock_now()');
        expect(output).toContain('__pumpkinWasiClocksMonotonicClock');
        expect(output).not.toContain('installWasiClocksMonotonicClock');
        expect(output).not.toContain('__pumpkinWasiHttpTypes');
        expect(output).not.toContain('installWasiHttpTypes');
    });

    it('generates an adapter for a used WIT method missing from resolved bundle imports', () => {
        const f = fixture();
        f.wasiImports = ['wasi:http/types@0.2.3', 'wasi:http/outgoing-handler@0.2.3'];
        f.wasiMethods = ['wasi:clocks/monotonic-clock@0.2.3#now'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('wasi_clocks_monotonic_clock_now');
    });

    it('generates HTTP constructors and future methods from the imported WIT', () => {
        const f = fixture();
        f.wasiImports = ['wasi:http/types@0.2.3'];
        f.wasiMethods = [
            'wasi:http/types@0.2.3#fields.constructor',
            'wasi:http/types@0.2.3#outgoing-request.constructor',
            'wasi:http/types@0.2.3#future-incoming-response.get',
        ];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('wasi_http_types_constructor_fields()');
        expect(output).toContain('wasi_http_types_constructor_outgoing_request');
        expect(output).toContain('wasi_http_types_method_future_incoming_response_get');
        expect(output).toContain('__pumpkinWasiHttpTypes');
        expect(output).not.toContain('WasiHttpFutureObject');
        expect(output).not.toContain('installWasiHttpTypes');
    });

    it('wraps a returned WASI resource handle as an owned host resource', () => {
        const f = fixture();
        f.wasiImports = ['wasi:http/outgoing-handler@0.2.3'];
        f.wasiMethods = ['wasi:http/types@0.2.3#incoming-response.consume'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const resourceMethod = generatedBlock(output, 'Value generatedWasiResourceMethod(Runtime &runtime');
        compileAndRunCpp(
            f.root,
            WASI_RESOURCE_RESULT_HARNESS.replace('/* GENERATED_WASI_RESOURCE_METHOD */', resourceMethod),
        );
    }, 15_000);

    it('generates input-stream reads as WIT byte-list results', () => {
        const f = fixture();
        f.wasiImports = ['wasi:io/streams@0.2.3'];
        f.wasiMethods = ['wasi:io/streams@0.2.3#input-stream.read'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const readAdapter = output.slice(output.indexOf('"input-stream" && methodName == "read"'));
        expect(readAdapter).toContain('wasi_io_streams_method_input_stream_read');
        expect(readAdapter).toContain('Uint8Array resultValue');
        expect(readAdapter).not.toContain('Value::null()');
    });

    it('fails when an imported interface is not present in plugin WIT', () => {
        const f = fixture();
        f.wasiImports = ['wasi:sockets/tcp@0.2.3'];

        expect(() => generate(f)).toThrow(/WASI interface wasi:sockets\/tcp@0\.2\.3 is not imported by plugin WIT/);
    });
});
