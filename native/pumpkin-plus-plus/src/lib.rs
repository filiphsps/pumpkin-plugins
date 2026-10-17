//! PumpkinMC native extension with chunk preparation as its first capability for one exact host
//! build.

mod jobs;
mod protocol;

use pumpkin::plugin::{Context, Plugin, PluginFuture, PluginMetadata};
use std::{
    sync::{
        Arc, LazyLock, Mutex, Once,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

// The upstream macro derives the metadata name from the crate name. Explicit exports preserve
// the loader's exact Rust ABI while allowing the required, non-Cargo name Pumpkin++.
#[unsafe(no_mangle)]
pub static PUMPKIN_API_VERSION: u32 = pumpkin::plugin::PLUGIN_API_VERSION;
#[unsafe(no_mangle)]
pub static METADATA: LazyLock<PluginMetadata> = LazyLock::new(|| PluginMetadata {
    name: "Pumpkin++".into(),
    version: env!("CARGO_PKG_VERSION").into(),
    authors: vec!["Filiph Sandström".into()],
    description: env!("CARGO_PKG_DESCRIPTION").into(),
    dependencies: vec![],
    permissions: vec![],
});

#[unsafe(no_mangle)]
pub fn plugin() -> Box<dyn Plugin> {
    Box::new(Bridge::default())
}

static LOGGING: Once = Once::new();

#[derive(Default)]
struct Bridge {
    jobs: Arc<Mutex<Option<jobs::Jobs>>>,
    worker_stop: Mutex<Option<Arc<AtomicBool>>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

// A worker panic also drops all owned jobs/tickets. The bridge then answers host_failure until
// reloaded, instead of silently leaving leases resident after its expiry worker stopped.
struct WorkerCleanup(Arc<Mutex<Option<jobs::Jobs>>>);
impl Drop for WorkerCleanup {
    fn drop(&mut self) {
        if let Some(mut jobs) = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            jobs.shutdown();
        }
    }
}

impl Plugin for Bridge {
    fn on_load(&self, context: Arc<Context>) -> PluginFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let jobs = jobs::Jobs::new(context.clone())?;
            let mut state = self
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.is_some() {
                return Err("Pumpkin++ is already loaded".into());
            }
            *state = Some(jobs);
            drop(state);
            let shared = self.jobs.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = stop.clone();
            let worker = match thread::Builder::new()
                .name("pumpkin-plus-plus-worker".into())
                .spawn(move || {
                    let _cleanup = WorkerCleanup(shared.clone());
                    while !worker_stop.load(Ordering::Acquire) {
                        let mut state = shared
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let Some(jobs) = state.as_mut() else {
                            break;
                        };
                        jobs.tick();
                        drop(state);
                        thread::sleep(Duration::from_millis(10));
                    }
                }) {
                Ok(worker) => worker,
                Err(error) => {
                    if let Some(mut jobs) = self
                        .jobs
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .take()
                    {
                        jobs.shutdown();
                    }
                    return Err(error.to_string());
                }
            };
            *self
                .worker_stop
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stop);
            *self
                .worker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(worker);
            LOGGING.call_once(|| context.init_log());
            context.log("bridge loaded");
            Ok(())
        })
    }

    fn on_unload(&self, context: Arc<Context>) -> PluginFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if let Some(stop) = self
                .worker_stop
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                stop.store(true, Ordering::Release);
            }
            let worker = self
                .worker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            // Join the bridge thread before the native loader closes this library.
            let worker_result = if let Some(worker) = worker {
                worker
                    .join()
                    .map_err(|_| "Pumpkin++ bridge worker panicked".to_owned())
            } else {
                Ok(())
            };
            // Keep the fallback if the thread exited before its cleanup guard ran.
            if let Some(mut jobs) = self
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                jobs.shutdown();
            }
            worker_result?;
            context.log("bridge worker joined");
            Ok(())
        })
    }

    fn on_ipc_message(
        &self,
        sender: &str,
        message: &[u8],
    ) -> PluginFuture<'_, Result<Vec<u8>, String>> {
        let response = match protocol::decode(message) {
            Ok(protocol::Operation::Probe) => protocol::probe(),
            Ok(operation) => {
                let mut state = self
                    .jobs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.as_mut().map_or_else(
                    || protocol::error("host_failure"),
                    |jobs| jobs.request(sender, operation),
                )
            }
            Err(code) => protocol::error(code),
        };
        Box::pin(async move { Ok(protocol::encode(response)) })
    }
}
