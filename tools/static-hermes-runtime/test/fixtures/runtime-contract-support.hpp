#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

class Runtime {};

inline Runtime *jsRuntime = nullptr;

class HostObject {
  public:
    virtual ~HostObject() = default;
};

struct ObjectData;
class Object;
class Array;
class ArrayBuffer;
class Uint8Array;

struct Value {
    enum class Kind { Undefined, Null, Number, String, Bytes, Object };
    Kind kind = Kind::Undefined;
    double number = 0;
    std::string string;
    std::vector<std::uint8_t> bytes;
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
    static Value undefined() { return {}; }
    static Value null() {
        Value value;
        value.kind = Kind::Null;
        return value;
    }
};

struct ObjectData {
    std::unordered_map<std::string, Value> properties;
    std::vector<Value> values;
    std::shared_ptr<HostObject> hostObject;
    bool isArray = false;
};

class ArrayBuffer {
  public:
    explicit ArrayBuffer(std::vector<std::uint8_t> *bytes) : bytes_(bytes) {}
    void *data(Runtime &) { return bytes_->data(); }

  private:
    std::vector<std::uint8_t> *bytes_;
};

class Uint8Array {
  public:
    Uint8Array(Runtime &, std::size_t size) : bytes(size) {}
    ArrayBuffer buffer(Runtime &) { return ArrayBuffer(&bytes); }

    std::vector<std::uint8_t> bytes;
};

class Object {
  public:
    Object() : data_(std::make_shared<ObjectData>()) {}
    explicit Object(Runtime &) : Object() {}
    explicit Object(std::shared_ptr<ObjectData> data) : data_(std::move(data)) {}

    void setProperty(Runtime &, const char *name, Value value) {
        data_->properties[name] = std::move(value);
    }

    void setProperty(Runtime &, const char *name, Uint8Array value) {
        Value bytes;
        bytes.kind = Value::Kind::Bytes;
        bytes.bytes = std::move(value.bytes);
        data_->properties[name] = std::move(bytes);
    }

    Value getProperty(Runtime &, const char *name) const { return getProperty(name); }
    Value getProperty(const char *name) const {
        const auto found = data_->properties.find(name);
        return found == data_->properties.end() ? Value{} : found->second;
    }

    bool hasProperty(const char *name) const { return data_->properties.count(name) != 0; }
    std::shared_ptr<HostObject> getHostObject(Runtime &) const { return data_->hostObject; }
    Array asArray(Runtime &) const;
    const std::shared_ptr<ObjectData> &data() const { return data_; }

    static Object createFromHostObject(Runtime &, std::shared_ptr<HostObject> hostObject) {
        auto data = std::make_shared<ObjectData>();
        data->hostObject = std::move(hostObject);
        return Object(std::move(data));
    }

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

inline Value::Value(Object value) : kind(Kind::Object), object(value.data()) {}

inline Object Value::asObject(Runtime &) const {
    if (!isObject()) throw std::runtime_error("Expected an object");
    return Object(object);
}

inline Array Object::asArray(Runtime &) const {
    if (!data_->isArray) throw std::runtime_error("Expected an array");
    return Array(data_);
}

class JSError : public std::runtime_error {
  public:
    explicit JSError(const std::string &message) : std::runtime_error(message) {}
    JSError(Runtime &, const std::string &message) : std::runtime_error(message) {}
    JSError(Runtime &, const char *message) : std::runtime_error(message) {}

    std::string getMessage() const { return what(); }
    std::string getStack() const { return what(); }
};

template <typename Callback>
class WitScopeGuard {
  public:
    explicit WitScopeGuard(Callback callback) : callback_(std::move(callback)) {}
    ~WitScopeGuard() {
        if (active_) callback_();
    }

    void release() { active_ = false; }

  private:
    Callback callback_;
    bool active_ = true;
};
