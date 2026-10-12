#include "plugin.h"
#include "api-enums.generated.h"

#include "hermes/VM/static_h.h"
#include "hermes/hermes.h"
#include "jsi/jsi.h"

#include <cstdint>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using facebook::hermes::HermesRuntime;
using namespace facebook::jsi;

extern "C" SHUnit *sh_export_plugin_bundle(void);

namespace {

SHRuntime *staticRuntime = nullptr;
HermesRuntime *jsRuntime = nullptr;

enum class ResourceKind { Context, Server, Player, World, JavaPlayer };

struct ResourceState {
  ResourceKind kind;
  int32_t handle;
  bool owned;

  void drop() {
    if (!owned)
      return;
    owned = false;
    switch (kind) {
      case ResourceKind::Context:
        pumpkin_plugin_context_context_drop_own(
            pumpkin_plugin_context_own_context_t{handle});
        break;
      case ResourceKind::Server:
        pumpkin_plugin_server_server_drop_own(
            pumpkin_plugin_server_own_server_t{handle});
        break;
      case ResourceKind::Player:
        pumpkin_plugin_player_player_drop_own(
            pumpkin_plugin_player_own_player_t{handle});
        break;
      case ResourceKind::World:
        pumpkin_plugin_world_world_drop_own(
            pumpkin_plugin_world_own_world_t{handle});
        break;
      case ResourceKind::JavaPlayer:
        pumpkin_plugin_player_java_player_drop_own(
            pumpkin_plugin_player_own_java_player_t{handle});
        break;
    }
  }

  void transfer() { owned = false; }
};

String jsString(Runtime &runtime, const std::string &value) {
  return String::createFromUtf8(runtime, value);
}

std::string utf8(Runtime &runtime, const Value &value) {
  return value.asString(runtime).utf8(runtime);
}

Function hostFunction(Runtime &runtime, const char *name, unsigned int arity, HostFunctionType fn) {
  return Function::createFromHostFunction(
      runtime, PropNameID::forAscii(runtime, name), arity, std::move(fn));
}

std::string propertyName(Runtime &runtime, const PropNameID &name) {
  return name.utf8(runtime);
}

pumpkin_plugin_context_event_type_t eventType(const std::string &name) {
  for (const auto &entry : pumpkin_static_api::eventTypes)
    if (name == entry.name) return static_cast<pumpkin_plugin_context_event_type_t>(entry.value);
  throw std::runtime_error("Static Hermes runtime does not recognize event type: " + name);
}

pumpkin_plugin_context_event_priority_t eventPriority(const std::string &name) {
  for (const auto &entry : pumpkin_static_api::eventPriorities)
    if (name == entry.name) return static_cast<pumpkin_plugin_context_event_priority_t>(entry.value);
  throw std::runtime_error("Static Hermes runtime does not recognize event priority: " + name);
}

class ContextObject final : public HostObject {
 public:
  explicit ContextObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}

  Value get(Runtime &runtime, const PropNameID &name) override {
    const auto key = propertyName(runtime, name);
    if (key == "registerEvent") {
      auto state = state_;
      return hostFunction(runtime, "registerEvent", 4, [state](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
        if (count < 4) throw JSError(rt, "Context.registerEvent expects four arguments");
        pumpkin_plugin_context_method_context_register_event(
            pumpkin_plugin_context_borrow_context_t{state->handle},
            static_cast<uint32_t>(args[0].asNumber()),
            eventType(utf8(rt, args[1])),
            eventPriority(utf8(rt, args[2])),
            args[3].getBool());
        return Value::undefined();
      });
    }
    if (key == "drop") {
      auto state = state_;
      return hostFunction(runtime, "drop", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
        state->drop();
        return Value::undefined();
      });
    }
    return Value::undefined();
  }

 private:
  std::shared_ptr<ResourceState> state_;
};

class ServerObject final : public HostObject {
 public:
  explicit ServerObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}
  Value get(Runtime &runtime, const PropNameID &name) override;

 private:
  std::shared_ptr<ResourceState> state_;
};

class WorldObject final : public HostObject {
 public:
  explicit WorldObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}

  Value get(Runtime &runtime, const PropNameID &name) override {
    const auto key = propertyName(runtime, name);
    if (key == "getName") {
      auto state = state_;
      return hostFunction(runtime, "getName", 0, [state](Runtime &rt, const Value &, const Value *, std::size_t) -> Value {
        plugin_string_t name{};
        pumpkin_plugin_world_method_world_get_name(
            pumpkin_plugin_world_borrow_world_t{state->handle}, &name);
        std::string result(reinterpret_cast<const char *>(name.ptr), name.len);
        plugin_string_free(&name);
        return jsString(rt, result);
      });
    }
    if (key == "getGameRule") {
      auto state = state_;
      return hostFunction(runtime, "getGameRule", 1, [state](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
        if (count < 1) throw JSError(rt, "World.getGameRule expects one argument");
        const auto name = utf8(rt, args[0]);
        std::optional<pumpkin_plugin_world_game_rule_t> gameRuleValue;
        for (const auto &entry : pumpkin_static_api::gameRules)
          if (name == entry.name) {
            gameRuleValue = static_cast<pumpkin_plugin_world_game_rule_t>(entry.value);
            break;
          }
        if (!gameRuleValue)
          throw JSError(rt, "Static Hermes runtime does not recognize game rule: " + name);
        pumpkin_plugin_world_game_rule_value_t value{};
        pumpkin_plugin_world_method_world_get_game_rule(
            pumpkin_plugin_world_borrow_world_t{state->handle},
            *gameRuleValue,
            &value);
        Object result(rt);
        if (value.tag == PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_VALUE_BOOL) {
          result.setProperty(rt, "tag", "bool");
          result.setProperty(rt, "val", value.val.bool_);
        } else {
          result.setProperty(rt, "tag", "int");
          result.setProperty(rt, "val", value.val.int_);
        }
        return result;
      });
    }
    if (key == "drop") {
      auto state = state_;
      return hostFunction(runtime, "drop", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
        state->drop();
        return Value::undefined();
      });
    }
    return Value::undefined();
  }

 private:
  std::shared_ptr<ResourceState> state_;
};

class JavaPlayerObject final : public HostObject {
 public:
  explicit JavaPlayerObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}

  Value get(Runtime &runtime, const PropNameID &name) override {
    const auto key = propertyName(runtime, name);
    if (key == "sendCustomPayload") {
      auto state = state_;
      return hostFunction(runtime, "sendCustomPayload", 2, [state](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
        if (count < 2) throw JSError(rt, "JavaPlayer.sendCustomPayload expects two arguments");
        const auto channelValue = utf8(rt, args[0]);
        auto bytes = args[1].asObject(rt).asTypedArray(rt);
        auto buffer = bytes.buffer(rt);
        const auto offset = bytes.byteOffset(rt);
        const auto length = bytes.byteLength(rt);
        plugin_string_t channel{};
        plugin_string_dup_n(&channel, channelValue.data(), channelValue.size());
        plugin_list_u8_t payload{buffer.data(rt) + offset, length};
        pumpkin_plugin_player_method_java_player_send_custom_payload(
            pumpkin_plugin_player_borrow_java_player_t{state->handle}, &channel, &payload);
        plugin_string_free(&channel);
        return Value::undefined();
      });
    }
    if (key == "drop") {
      auto state = state_;
      return hostFunction(runtime, "drop", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
        state->drop();
        return Value::undefined();
      });
    }
    return Value::undefined();
  }

 private:
  std::shared_ptr<ResourceState> state_;
};

class PlayerObject final : public HostObject {
 public:
  explicit PlayerObject(std::shared_ptr<ResourceState> state) : state_(std::move(state)) {}

  Value get(Runtime &runtime, const PropNameID &name) override {
    const auto key = propertyName(runtime, name);
    if (key == "getId") {
      auto state = state_;
      return hostFunction(runtime, "getId", 0, [state](Runtime &rt, const Value &, const Value *, std::size_t) -> Value {
        pumpkin_plugin_player_uuid_t uuid{};
        pumpkin_plugin_player_method_player_get_id(
            pumpkin_plugin_player_borrow_player_t{state->handle}, &uuid);
        Object result(rt);
        result.setProperty(rt, "high", BigInt::fromUint64(rt, uuid.high));
        result.setProperty(rt, "low", BigInt::fromUint64(rt, uuid.low));
        return result;
      });
    }
    if (key == "getName") {
      auto state = state_;
      return hostFunction(runtime, "getName", 0, [state](Runtime &rt, const Value &, const Value *, std::size_t) -> Value {
        plugin_string_t name{};
        pumpkin_plugin_player_method_player_get_name(
            pumpkin_plugin_player_borrow_player_t{state->handle}, &name);
        std::string result(reinterpret_cast<const char *>(name.ptr), name.len);
        plugin_string_free(&name);
        return jsString(rt, result);
      });
    }
    if (key == "getSaturation") {
      auto state = state_;
      return hostFunction(runtime, "getSaturation", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
        return Value(pumpkin_plugin_player_method_player_get_saturation(
            pumpkin_plugin_player_borrow_player_t{state->handle}));
      });
    }
    if (key == "getExhaustion") {
      auto state = state_;
      return hostFunction(runtime, "getExhaustion", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
        return Value(pumpkin_plugin_player_method_player_get_exhaustion(
            pumpkin_plugin_player_borrow_player_t{state->handle}));
      });
    }
    if (key == "getWorld") {
      auto state = state_;
      return hostFunction(runtime, "getWorld", 0, [state](Runtime &rt, const Value &, const Value *, std::size_t) -> Value {
        auto world = pumpkin_plugin_player_method_player_get_world(
            pumpkin_plugin_player_borrow_player_t{state->handle});
        auto resource = std::make_shared<ResourceState>(ResourceState{ResourceKind::World, world.__handle, true});
        return Object::createFromHostObject(rt, std::make_shared<WorldObject>(resource));
      });
    }
    if (key == "asJava") {
      auto state = state_;
      return hostFunction(runtime, "asJava", 0, [state](Runtime &rt, const Value &, const Value *, std::size_t) -> Value {
        pumpkin_plugin_player_own_java_player_t java{};
        if (!pumpkin_plugin_player_method_player_as_java(
                pumpkin_plugin_player_borrow_player_t{state->handle}, &java))
          return Value::null();
        auto resource = std::make_shared<ResourceState>(ResourceState{ResourceKind::JavaPlayer, java.__handle, true});
        return Object::createFromHostObject(rt, std::make_shared<JavaPlayerObject>(resource));
      });
    }
    if (key == "drop") {
      auto state = state_;
      return hostFunction(runtime, "drop", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
        state->drop();
        return Value::undefined();
      });
    }
    return Value::undefined();
  }

 private:
  std::shared_ptr<ResourceState> state_;
};

Value ServerObject::get(Runtime &runtime, const PropNameID &name) {
  const auto key = propertyName(runtime, name);
  if (key == "getAllPlayers") {
    auto state = state_;
    return hostFunction(runtime, "getAllPlayers", 0, [state](Runtime &rt, const Value &, const Value *, std::size_t) -> Value {
      pumpkin_plugin_server_list_own_player_t players{};
      pumpkin_plugin_server_method_server_get_all_players(
          pumpkin_plugin_server_borrow_server_t{state->handle}, &players);
      Array result(rt, players.len);
      for (std::size_t index = 0; index < players.len; ++index) {
        auto player = std::make_shared<ResourceState>(ResourceState{
            ResourceKind::Player, players.ptr[index].__handle, true});
        result.setValueAtIndex(rt, index, Object::createFromHostObject(rt, std::make_shared<PlayerObject>(player)));
      }
      pumpkin_plugin_server_list_own_player_free(&players);
      return result;
    });
  }
  if (key == "drop") {
    auto state = state_;
    return hostFunction(runtime, "drop", 0, [state](Runtime &, const Value &, const Value *, std::size_t) -> Value {
      state->drop();
      return Value::undefined();
    });
  }
  return Value::undefined();
}

Value makeServer(Runtime &runtime, int32_t handle) {
  auto state = std::make_shared<ResourceState>(ResourceState{ResourceKind::Server, handle, true});
  return Object::createFromHostObject(runtime, std::make_shared<ServerObject>(state));
}

Object exportsObject(Runtime &runtime) {
  return runtime.global().getPropertyAsObject(runtime, "__pumpkinPlugin");
}

Value callExport(const char *name, const Value *args, std::size_t count) {
  if (!jsRuntime) throw std::runtime_error("Static Hermes runtime is not initialized");
  auto exports = exportsObject(*jsRuntime);
  return exports.getPropertyAsFunction(*jsRuntime, name).call(*jsRuntime, args, count);
}

void initializeRuntime() {
  if (jsRuntime) return;
  staticRuntime = _sh_init(hermes::vm::RuntimeConfig{});
  SHLegacyValue result{};
  if (!_sh_unit_init_guarded(staticRuntime, sh_export_plugin_bundle, &result)) {
    _sh_done(staticRuntime);
    staticRuntime = nullptr;
    throw std::runtime_error("Static Hermes failed while evaluating the plugin bundle");
  }
  jsRuntime = _sh_get_hermes_runtime(staticRuntime);

  Object host(*jsRuntime);
  host.setProperty(*jsRuntime, "log", hostFunction(*jsRuntime, "log", 2, [](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
    if (count < 2) return Value::undefined();
    const auto levelName = utf8(rt, args[0]);
    const auto messageText = utf8(rt, args[1]);
    pumpkin_plugin_logging_level_t level = PUMPKIN_PLUGIN_LOGGING_LEVEL_INFO;
    if (levelName == "trace") level = PUMPKIN_PLUGIN_LOGGING_LEVEL_TRACE;
    else if (levelName == "debug") level = PUMPKIN_PLUGIN_LOGGING_LEVEL_DEBUG;
    else if (levelName == "warn") level = PUMPKIN_PLUGIN_LOGGING_LEVEL_WARN;
    else if (levelName == "error") level = PUMPKIN_PLUGIN_LOGGING_LEVEL_ERROR;
    plugin_string_t message{};
    plugin_string_dup_n(&message, messageText.data(), messageText.size());
    pumpkin_plugin_logging_log(level, &message);
    plugin_string_free(&message);
    return Value::undefined();
  }));
  host.setProperty(*jsRuntime, "scheduleDelayedTask", hostFunction(*jsRuntime, "scheduleDelayedTask", 2, [](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
    if (count < 2) throw JSError(rt, "scheduleDelayedTask expects two arguments");
    const auto handler = static_cast<uint32_t>(args[0].asNumber());
    const auto delay = args[1].asBigInt(rt).asUint64(rt);
    return Value(static_cast<double>(pumpkin_plugin_scheduler_schedule_delayed_task(handler, delay)));
  }));
  host.setProperty(*jsRuntime, "scheduleRepeatingTask", hostFunction(*jsRuntime, "scheduleRepeatingTask", 3, [](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
    if (count < 3) throw JSError(rt, "scheduleRepeatingTask expects three arguments");
    const auto handler = static_cast<uint32_t>(args[0].asNumber());
    const auto delay = args[1].asBigInt(rt).asUint64(rt);
    const auto period = args[2].asBigInt(rt).asUint64(rt);
    return Value(static_cast<double>(pumpkin_plugin_scheduler_schedule_repeating_task(handler, delay, period)));
  }));
  host.setProperty(*jsRuntime, "cancelTask", hostFunction(*jsRuntime, "cancelTask", 1, [](Runtime &, const Value &, const Value *args, std::size_t) -> Value {
    pumpkin_plugin_scheduler_cancel_task(static_cast<uint32_t>(args[0].asNumber()));
    return Value::undefined();
  }));
  jsRuntime->global().setProperty(*jsRuntime, "__pumpkinHost", std::move(host));
}

void resetRuntime() {
  jsRuntime = nullptr;
  if (staticRuntime) {
    _sh_done(staticRuntime);
    staticRuntime = nullptr;
  }
}

void setError(plugin_string_t *error, const std::string &message) {
  plugin_string_dup_n(error, message.data(), message.size());
}

void copyString(plugin_string_t *target, Runtime &runtime, const Value &value) {
  const auto text = utf8(runtime, value);
  plugin_string_dup_n(target, text.data(), text.size());
}

void copyStringList(plugin_list_string_t *target, Runtime &runtime, const Value &value) {
  if (value.isUndefined() || value.isNull()) return;
  auto list = value.asObject(runtime).asArray(runtime);
  target->len = list.size(runtime);
  if (!target->len) return;
  target->ptr = static_cast<plugin_string_t *>(std::calloc(target->len, sizeof(plugin_string_t)));
  if (!target->ptr) throw std::bad_alloc();
  for (std::size_t i = 0; i < target->len; ++i)
    copyString(&target->ptr[i], runtime, list.getValueAtIndex(runtime, i));
}

std::string eventName(pumpkin_plugin_event_event_type_t tag) {
  for (const auto &entry : pumpkin_static_api::eventTypes)
    if (tag == entry.value) return std::string(entry.name);
  return "unknown-event";
}

Object makeEvent(Runtime &runtime, plugin_event_t *event, std::shared_ptr<ResourceState> *playerState) {
  Object result(runtime);
  const auto name = eventName(event->tag);
  result.setProperty(runtime, "tag", jsString(runtime, name));
  Object data(runtime);
  if (event->tag == PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_PLAYER_JOIN_EVENT) {
    const auto handle = event->val.player_join_event.player.__handle;
    *playerState = std::make_shared<ResourceState>(ResourceState{ResourceKind::Player, handle, true});
    data.setProperty(runtime, "player", Object::createFromHostObject(runtime, std::make_shared<PlayerObject>(*playerState)));
  } else if (event->tag == PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_PLAYER_LEAVE_EVENT) {
    const auto handle = event->val.player_leave_event.player.__handle;
    *playerState = std::make_shared<ResourceState>(ResourceState{ResourceKind::Player, handle, true});
    data.setProperty(runtime, "player", Object::createFromHostObject(runtime, std::make_shared<PlayerObject>(*playerState)));
  }
  result.setProperty(runtime, "val", std::move(data));
  return result;
}

} // namespace

extern "C" {

void exports_plugin_init_plugin(void) {
  try {
    initializeRuntime();
    callExport("initPlugin", nullptr, 0);
  } catch (const std::exception &error) {
    const std::string message = error.what();
    plugin_string_t text{};
    plugin_string_dup_n(&text, message.data(), message.size());
    pumpkin_plugin_logging_log(PUMPKIN_PLUGIN_LOGGING_LEVEL_ERROR, &text);
    plugin_string_free(&text);
  }
}

bool exports_plugin_on_load(plugin_own_context_t context, plugin_string_t *error) {
  initializeRuntime();
  auto state = std::make_shared<ResourceState>(ResourceState{ResourceKind::Context, context.__handle, true});
  auto contextObject = Object::createFromHostObject(*jsRuntime, std::make_shared<ContextObject>(state));
  try {
    Value contextValue(std::move(contextObject));
    callExport("onLoad", &contextValue, 1);
    state->drop();
    return true;
  } catch (const std::exception &exception) {
    state->drop();
    setError(error, exception.what());
    return false;
  }
}

bool exports_plugin_on_unload(plugin_own_context_t context, plugin_string_t *error) {
  auto state = std::make_shared<ResourceState>(ResourceState{ResourceKind::Context, context.__handle, true});
  auto contextObject = Object::createFromHostObject(*jsRuntime, std::make_shared<ContextObject>(state));
  try {
    Value contextValue(std::move(contextObject));
    callExport("onUnload", &contextValue, 1);
    state->drop();
    resetRuntime();
    return true;
  } catch (const std::exception &exception) {
    state->drop();
    setError(error, exception.what());
    resetRuntime();
    return false;
  }
}

void exports_plugin_handle_event(uint32_t event_id, plugin_own_server_instance_t server, plugin_event_t *event, plugin_event_t *ret) {
  *ret = *event;
  auto playerState = std::shared_ptr<ResourceState>{};
  auto serverObject = makeServer(*jsRuntime, server.__handle);
  auto eventObject = makeEvent(*jsRuntime, event, &playerState);
  Value args[] = {Value(static_cast<double>(event_id)), std::move(serverObject), std::move(eventObject)};
  try {
    callExport("handleEvent", args, 3);
    if (playerState && event->tag == PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_PLAYER_JOIN_EVENT)
      playerState->transfer();
  } catch (const std::exception &exception) {
    const std::string message = exception.what();
    plugin_string_t text{};
    plugin_string_dup_n(&text, message.data(), message.size());
    pumpkin_plugin_logging_log(PUMPKIN_PLUGIN_LOGGING_LEVEL_ERROR, &text);
    plugin_string_free(&text);
  }
  pumpkin_plugin_server_server_drop_own(pumpkin_plugin_server_own_server_t{server.__handle});
}

bool exports_plugin_handle_command(uint32_t, plugin_own_command_sender_t, plugin_own_server_instance_t, plugin_own_consumed_args_t, int32_t *ret, plugin_command_error_t *error) {
  *ret = 0;
  std::memset(error, 0, sizeof(*error));
  return false;
}

void exports_plugin_handle_command_suggestion(uint32_t, plugin_own_command_sender_t, plugin_own_server_instance_t, plugin_suggestion_request_t *, plugin_command_suggestions_t *ret) {
  std::memset(ret, 0, sizeof(*ret));
}

void exports_plugin_handle_task(uint32_t handler_id, plugin_own_server_instance_t server) {
  auto serverObject = makeServer(*jsRuntime, server.__handle);
  Value args[] = {Value(static_cast<double>(handler_id)), std::move(serverObject)};
  try {
    callExport("handleTask", args, 2);
  } catch (const std::exception &exception) {
    const std::string message = exception.what();
    plugin_string_t text{};
    plugin_string_dup_n(&text, message.data(), message.size());
    pumpkin_plugin_logging_log(PUMPKIN_PLUGIN_LOGGING_LEVEL_ERROR, &text);
    plugin_string_free(&text);
  }
  pumpkin_plugin_server_server_drop_own(pumpkin_plugin_server_own_server_t{server.__handle});
}

bool exports_plugin_handle_ipc_message(plugin_plugin_id_t *, plugin_ipc_message_t *, plugin_ipc_message_t *ret, plugin_string_t *error) {
  std::memset(ret, 0, sizeof(*ret));
  setError(error, "Static Hermes runtime does not implement IPC callbacks");
  return false;
}

bool exports_plugin_handle_ai_goal_can_start(uint32_t, plugin_own_server_instance_t, plugin_own_entity_t) { return false; }
bool exports_plugin_handle_ai_goal_should_continue(uint32_t, plugin_own_server_instance_t, plugin_own_entity_t) { return false; }
void exports_plugin_handle_ai_goal_start(uint32_t, plugin_own_server_instance_t, plugin_own_entity_t) {}
void exports_plugin_handle_ai_goal_tick(uint32_t, plugin_own_server_instance_t, plugin_own_entity_t) {}
void exports_plugin_handle_ai_goal_stop(uint32_t, plugin_own_server_instance_t, plugin_own_entity_t) {}
void exports_plugin_handle_generate_phase(uint32_t, plugin_generation_phase_t, plugin_own_chunk_buffer_t) {}

void exports_pumpkin_plugin_metadata_get_metadata(exports_pumpkin_plugin_metadata_plugin_metadata_t *ret) {
  std::memset(ret, 0, sizeof(*ret));
  try {
    initializeRuntime();
    auto exports = exportsObject(*jsRuntime);
    auto metadata = exports.getPropertyAsObject(*jsRuntime, "metadata");
    auto value = metadata.getPropertyAsFunction(*jsRuntime, "getMetadata").call(*jsRuntime);
    auto object = value.asObject(*jsRuntime);
    copyString(&ret->name, *jsRuntime, object.getProperty(*jsRuntime, "name"));
    copyString(&ret->version, *jsRuntime, object.getProperty(*jsRuntime, "version"));
    copyString(&ret->description, *jsRuntime, object.getProperty(*jsRuntime, "description"));
    copyStringList(&ret->authors, *jsRuntime, object.getProperty(*jsRuntime, "authors"));
    copyStringList(&ret->dependencies, *jsRuntime, object.getProperty(*jsRuntime, "dependencies"));
    copyStringList(&ret->permissions, *jsRuntime, object.getProperty(*jsRuntime, "permissions"));
  } catch (...) {
    plugin_string_dup(&ret->name, "unknown");
    plugin_string_dup(&ret->version, "0.0.0");
    plugin_string_dup(&ret->description, "Static Hermes plugin");
  }
}

} // extern "C"
