#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "runtime-contract-support.hpp"

struct plugin_string_t { std::uint8_t *ptr; std::size_t len; };
using plugin_plugin_id_t = plugin_string_t;
struct plugin_ipc_message_t { std::uint8_t *ptr; std::size_t len; };

int senderFrees = 0;
int messageFrees = 0;
void plugin_plugin_id_free(plugin_plugin_id_t *sender) {
    std::free(sender->ptr);
    sender->ptr = nullptr;
    senderFrees++;
}
void plugin_ipc_message_free(plugin_ipc_message_t *message) {
    std::free(message->ptr);
    message->ptr = nullptr;
    messageFrees++;
}
void plugin_string_free(plugin_string_t *text) {
    std::free(text->ptr);
    text->ptr = nullptr;
}

void initializeRuntime() {}
Value jsString(Runtime &, const std::string &value) { return Value(value); }
std::string wasiStringValue(const plugin_string_t &value) {
    return value.len ? std::string(reinterpret_cast<const char *>(value.ptr), value.len) : std::string{};
}
void setError(plugin_string_t *error, const std::string &message) {
    error->ptr = static_cast<std::uint8_t *>(std::malloc(message.size()));
    std::memcpy(error->ptr, message.data(), message.size());
    error->len = message.size();
}

bool handlerFails = false;
std::string receivedSender;
std::vector<std::uint8_t> receivedMessage;
Value callExport(const char *name, Value *args, std::size_t count) {
    assert(std::string(name) == "handleIpcMessage");
    assert(count == 2);
    receivedSender = args[0].asString();
    receivedMessage = args[1].asObject(*jsRuntime).asUint8Array(*jsRuntime).bytes;
    if (handlerFails) throw std::runtime_error("handler failed");
    Uint8Array response(*jsRuntime, 2);
    response.bytes = {0x6f, 0x6b};
    return Value(std::move(response));
}

/* GENERATED_HANDLE_IPC_MESSAGE */

// Guest-owned arguments, allocated the way the canonical ABI hands them to an export.
std::uint8_t *owned(const std::string &text) {
    auto *bytes = static_cast<std::uint8_t *>(std::malloc(text.size()));
    std::memcpy(bytes, text.data(), text.size());
    return bytes;
}

int main() {
    Runtime runtime;
    jsRuntime = &runtime;

    plugin_plugin_id_t sender{owned("Sender"), 6};
    plugin_ipc_message_t message{owned("ping"), 4};
    plugin_ipc_message_t response{};
    plugin_string_t error{};
    assert(exports_plugin_handle_ipc_message(&sender, &message, &response, &error));
    assert(receivedSender == "Sender");
    assert((receivedMessage == std::vector<std::uint8_t>{'p', 'i', 'n', 'g'}));
    assert(response.len == 2 && response.ptr[0] == 0x6f && response.ptr[1] == 0x6b);
    std::free(response.ptr);
    assert(senderFrees == 1 && messageFrees == 1);

    handlerFails = true;
    sender = {owned("Sender"), 6};
    message = {owned("ping"), 4};
    assert(!exports_plugin_handle_ipc_message(&sender, &message, &response, &error));
    assert(error.len > 0);
    plugin_string_free(&error);
    assert(senderFrees == 2 && messageFrees == 2);
}
