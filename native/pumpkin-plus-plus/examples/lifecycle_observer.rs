//! Real-host evidence fixture. Never install this diagnostic plugin on a production server.
use pumpkin::plugin::{Context, Plugin, PluginFuture, PluginMetadata};
use pumpkin_util::math::vector2::Vector2;
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock, Mutex};

#[unsafe(no_mangle)]
pub static PUMPKIN_API_VERSION: u32 = pumpkin::plugin::PLUGIN_API_VERSION;
#[unsafe(no_mangle)]
pub static METADATA: LazyLock<PluginMetadata> = LazyLock::new(|| PluginMetadata {
    name: "BridgeInspector".into(),
    version: "0.0.0".into(),
    authors: vec![],
    description: "Test-only host ticket evidence".into(),
    dependencies: vec![],
    permissions: vec![],
});
#[unsafe(no_mangle)]
pub fn plugin() -> Box<dyn Plugin> {
    Box::new(Inspector(Mutex::new(None)))
}
struct Inspector(Mutex<Option<Arc<Context>>>);
impl Plugin for Inspector {
    fn on_load(&self, context: Arc<Context>) -> PluginFuture<'_, Result<(), String>> {
        *self.0.lock().unwrap() = Some(context);
        Box::pin(async { Ok(()) })
    }
    fn on_unload(&self, _: Arc<Context>) -> PluginFuture<'_, Result<(), String>> {
        self.0.lock().unwrap().take();
        Box::pin(async { Ok(()) })
    }
    fn on_ipc_message(&self, _: &str, message: &[u8]) -> PluginFuture<'_, Result<Vec<u8>, String>> {
        let reply = (|| {
            let request: Value = serde_json::from_slice(message).map_err(|e| e.to_string())?;
            let guard = self.0.lock().unwrap();
            let context = guard.as_ref().ok_or("not loaded")?;
            let worlds = context.server.worlds.load();
            let world = worlds
                .iter()
                .find(|w| Some(w.get_world_name()) == request["world"].as_str())
                .ok_or("unknown world")?;
            let x = request["x"].as_i64().ok_or("x missing")? as i32;
            let z = request["z"].as_i64().ok_or("z missing")? as i32;
            let pos = Vector2::new(x, z);
            let loading = world.level.chunk_loading.lock().unwrap();
            let levels = loading.ticket.get(&pos).cloned().unwrap_or_default();
            let loaded = world.level.loaded_chunks.contains_key(&pos);
            Ok(serde_json::to_vec(&json!({"levels":levels,"loaded":loaded})).unwrap())
        })();
        Box::pin(async move { reply })
    }
}
