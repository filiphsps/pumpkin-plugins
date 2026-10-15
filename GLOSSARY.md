# Pumpkin Plugin API

Terms for the host contract that Pumpkin plugins compile against.

## Language

**WIT package version**:
The version string declared by a WIT package, such as `0.1.0`. It does not uniquely identify an API target when release and nightly contracts share that string.

**API target**:
A distinct Pumpkin host API contract that a plugin is built against. Multiple API targets may share the same WIT package version.

**API package version**:
The release version of the TypeScript facade package. It identifies the API library release, not the host ABI or API target.
_Avoid_: WIT package version

**Plugin registration**:
The association between a plugin and the host that identifies which plugin supplies metadata and receives lifecycle and inter-plugin message callbacks. It persists across the plugin's load and unload cycles.
_Avoid_: Callback registration

**Callback registration**:
The association between a plugin callback and a host operation, such as an event, command, or scheduled task. It belongs to one plugin load and must be recreated after a later load.
_Avoid_: Plugin registration

**WASI capability**:
A plugin's declared need for one or more WASI-provided services, such as HTTP or filesystem access. It describes the plugin's host-service requirements; a Pumpkin permission is a separate authorization.
_Avoid_: WASI permission, Pumpkin permission

**Pumpkin permission**:
A host authorization that controls whether a plugin may perform a protected operation or access a protected resource through Pumpkin. The server operator grants it to the plugin.
_Avoid_: WASI capability
