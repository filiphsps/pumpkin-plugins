//! One bounded state machine; host work is triggered by owned tickets, never an awaited fetch.
use crate::protocol::{Operation, error};
use crossbeam::channel::{Receiver, TryRecvError};
use pumpkin::{plugin::Context, world::World};
use pumpkin_util::math::vector2::Vector2;
use pumpkin_world::{chunk::ChunkData, chunk_system::ChunkLoading};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::{Arc, Weak, atomic::Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_WORLDS: usize = 8;
const MAX_LIVE: usize = 64;
const MAX_CALLER_LIVE: usize = 16;
const MAX_QUEUED: usize = 32;
const MAX_CALLER_QUEUED: usize = 8;
const MAX_ACTIVE: usize = 32;
const MAX_CALLER_ACTIVE: usize = 16;
const MAX_PHYSICAL: usize = 16;
const MAX_TERMINAL: usize = 64;
const MAX_CALLER_TERMINAL: usize = 16;
const OBSERVER_BACKLOG: usize = 4096;
const DEADLINE: Duration = Duration::from_secs(30);
const LEASE: Duration = Duration::from_secs(30);
const RETENTION: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct ChunkKey {
    world_instance: usize,
    x: i32,
    z: i32,
}

type Publications = Receiver<(Vector2<i32>, Weak<ChunkData>)>;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(rename = "deadlineMs", default = "default_deadline")]
    deadline_ms: u64,
    #[serde(rename = "leaseMs", default = "default_lease")]
    lease_ms: u64,
    #[serde(rename = "terminalRetentionMs", default = "default_retention")]
    retention_ms: u64,
}
fn default_deadline() -> u64 {
    DEADLINE.as_millis() as u64
}
fn default_lease() -> u64 {
    LEASE.as_millis() as u64
}
fn default_retention() -> u64 {
    RETENTION.as_millis() as u64
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Queued,
    Running,
    Ready,
    Failed,
    Cancelled,
    Expired,
    Released,
    Timeout,
}
impl State {
    fn live(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Ready)
    }
}

struct Job {
    caller: String,
    key: ChunkKey,
    world: Option<Arc<World>>,
    state: State,
    created: Instant,
    changed: Instant,
    lease: Option<(String, Instant)>,
}
impl Job {
    fn world(&self) -> &Arc<World> {
        self.world.as_ref().expect("live jobs retain their world")
    }

    fn make_terminal(&mut self, state: State, now: Instant) {
        debug_assert!(!state.live());
        self.state = state;
        self.changed = now;
        self.world = None;
    }
}

struct Observer {
    world: Arc<World>,
    receiver: Option<Publications>,
}

// Removal from this map is the sole ticket release path. No task can abandon a hidden host ticket.
struct Ticket {
    world: Arc<World>,
    pos: Vector2<i32>,
    publication: Option<Weak<ChunkData>>,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        let mut loading = self
            .world
            .level
            .chunk_loading
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loading.remove_ticket(self.pos, ChunkLoading::FULL_CHUNK_LEVEL);
        loading.send_change();
    }
}

pub struct Jobs {
    context: Arc<Context>,
    observers: HashMap<usize, Observer>,
    tickets: HashMap<ChunkKey, Ticket>,
    jobs: HashMap<String, Job>,
    nonce: u128,
    sequence: u64,
    deadline: Duration,
    lease_duration: Duration,
    retention: Duration,
}
impl Jobs {
    pub fn new(context: Arc<Context>) -> Result<Self, String> {
        let path = context.get_data_folder().join("config.json");
        let bytes = match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(8193)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                bytes
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::write(&path, b"{}\n").map_err(|e| e.to_string())?;
                b"{}".to_vec()
            }
            Err(e) => return Err(e.to_string()),
        };
        if bytes.len() > 8192 {
            return Err("Pumpkin++ config exceeds 8192 bytes".into());
        }
        let config: Config = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if !(1..=DEADLINE.as_millis() as u64).contains(&config.deadline_ms)
            || !(1..=60000).contains(&config.lease_ms)
            || !(1..=30000).contains(&config.retention_ms)
        {
            return Err("Pumpkin++ durations exceed finite protocol bounds".into());
        }
        Ok(Self {
            deadline: Duration::from_millis(config.deadline_ms),
            lease_duration: Duration::from_millis(config.lease_ms),
            retention: Duration::from_millis(config.retention_ms),
            context,
            observers: HashMap::new(),
            tickets: HashMap::new(),
            jobs: HashMap::new(),
            sequence: 0,
            nonce: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos(),
        })
    }

    fn world_live(&self, world: &Arc<World>) -> bool {
        !world.level.cancel_token.is_cancelled()
            && !world.level.shut_down_chunk_system.load(Ordering::Acquire)
            && self
                .context
                .server
                .worlds
                .load()
                .iter()
                .any(|w| Arc::ptr_eq(w, world))
    }

    pub fn request(&mut self, caller: &str, operation: Operation) -> Value {
        self.expire(Instant::now());
        // IPC only performs bounded admission/lookup. Host ticket transitions and generation occur
        // on the scheduled task after this callback returns, avoiding guest-generator re-entry
        // deadlock.
        match operation {
            Operation::Submit { world, x, z } => self.submit(caller, &world, x, z),
            Operation::Poll { operation_id } => {
                match self.jobs.get(&operation_id).filter(|j| j.caller == caller) {
                    Some(job) => self.response(&operation_id, job),
                    None => error("not_found"),
                }
            }
            Operation::Cancel { operation_id } => {
                let Some(job) = self.jobs.get(&operation_id).filter(|j| j.caller == caller) else {
                    return error("not_found");
                };
                if job.state == State::Ready || (!job.state.live() && job.state != State::Cancelled)
                {
                    return self.response(&operation_id, &self.jobs[&operation_id]);
                }
                let job = self.jobs.get_mut(&operation_id).unwrap();
                if job.state.live() {
                    job.make_terminal(State::Cancelled, Instant::now());
                }
                self.release_unused();
                self.trim_terminal();
                json!({"v":1,"ok":true,"operationId":operation_id,"state":"cancelled"})
            }
            Operation::Release { lease_id } => {
                let id = self
                    .jobs
                    .iter()
                    .find(|(_, j)| {
                        j.caller == caller
                            && matches!(j.state, State::Ready | State::Released)
                            && j.lease.as_ref().is_some_and(|(id, _)| id == &lease_id)
                    })
                    .map(|(id, _)| id.clone());
                let Some(id) = id else {
                    return error("not_found");
                };
                if self.jobs[&id].state == State::Ready {
                    let job = self.jobs.get_mut(&id).unwrap();
                    job.make_terminal(State::Released, Instant::now());
                    self.release_unused();
                    self.trim_terminal();
                }
                json!({"v":1,"ok":true,"leaseId":lease_id,"released":true})
            }
            Operation::Probe => unreachable!("probe is handled at the IPC boundary"),
        }
    }

    fn submit(&mut self, caller: &str, name: &str, x: i32, z: i32) -> Value {
        let Some(world) = self
            .context
            .server
            .worlds
            .load()
            .iter()
            .find(|w| w.get_world_name() == name || w.dimension.minecraft_name == name)
            .cloned()
        else {
            return error("unknown_world");
        };
        if !self.world_live(&world) {
            return error("host_failure");
        }
        let counts = |owner: Option<&str>, state: Option<State>| {
            self.jobs
                .values()
                .filter(|j| {
                    owner.is_none_or(|o| j.caller == o)
                        && state.map_or(j.state.live(), |s| j.state == s)
                })
                .count()
        };
        if counts(None, None) >= MAX_LIVE
            || counts(Some(caller), None) >= MAX_CALLER_LIVE
            || counts(None, Some(State::Queued)) >= MAX_QUEUED
            || counts(Some(caller), Some(State::Queued)) >= MAX_CALLER_QUEUED
        {
            return error("busy");
        }
        let instance = Arc::as_ptr(&world) as usize;
        if !self.observers.contains_key(&instance) {
            if self.observers.len() >= MAX_WORLDS {
                return error("busy");
            }
            let receiver = world.level.chunk_listener.add_global_chunk_listener();
            self.observers.insert(
                instance,
                Observer {
                    world: world.clone(),
                    receiver: Some(receiver),
                },
            );
        }
        if self.observers[&instance].receiver.is_none() {
            return error("host_failure");
        }
        self.sequence = match self.sequence.checked_add(1) {
            Some(n) => n,
            None => return error("busy"),
        };
        let id = format!("o{:x}-{:x}", self.nonce, self.sequence);
        let now = Instant::now();
        self.jobs.insert(
            id.clone(),
            Job {
                caller: caller.into(),
                key: ChunkKey {
                    world_instance: instance,
                    x,
                    z,
                },
                world: Some(world),
                state: State::Queued,
                created: now,
                changed: now,
                lease: None,
            },
        );
        self.response(&id, &self.jobs[&id])
    }

    fn response(&self, id: &str, job: &Job) -> Value {
        match job.state {
            State::Queued => json!({"v":1,"ok":true,"operationId":id,"state":"queued"}),
            State::Running => json!({"v":1,"ok":true,"operationId":id,"state":"running"}),
            State::Ready => {
                let (lease, until) = job.lease.as_ref().unwrap();
                let remaining = until.saturating_duration_since(Instant::now()).as_millis();
                // expire() checks before every poll; do not promise a lease that elapsed meanwhile.
                if remaining == 0 {
                    return json!({"v":1,"ok":false,"operationId":id,"code":"expired"});
                }
                json!({"v":1,"ok":true,"operationId":id,"state":"ready","leaseId":lease,"remainingLeaseMs":remaining.min(60000)})
            }
            state => json!({"v":1,"ok":false,"operationId":id,"code":match state {
                State::Cancelled => "cancelled", State::Expired | State::Released => "expired", State::Timeout => "timeout", _ => "host_failure",
            }}),
        }
    }

    fn expire(&mut self, now: Instant) {
        let changes: Vec<_> =
            self.jobs
                .iter()
                .filter_map(|(id, job)| {
                    if !job.state.live() {
                        return None;
                    }
                    let world = job.world();
                    let next = if !self.world_live(world) {
                        Some(State::Failed)
                    } else if !self.context.plugin_manager.is_plugin_active(&job.caller) {
                        Some(State::Cancelled)
                    } else if job.lease.as_ref().is_some_and(|(_, until)| now >= *until) {
                        Some(State::Expired)
                    } else if job.state != State::Ready
                        && now.duration_since(job.created) >= self.deadline
                    {
                        Some(State::Timeout)
                    } else if job.state == State::Ready
                        && !self.tickets.get(&job.key).is_some_and(|t| {
                            t.publication.as_ref().and_then(Weak::upgrade).is_some_and(
                                |published| {
                                    world.level.loaded_chunks.get(&t.pos).is_some_and(
                                        |loaded| Arc::ptr_eq(loaded.value(), &published),
                                    )
                                },
                            )
                        })
                    {
                        Some(State::Failed)
                    } else {
                        None
                    };
                    next.map(|state| (id.clone(), state))
                })
                .collect();
        for (id, state) in changes {
            let job = self.jobs.get_mut(&id).unwrap();
            job.make_terminal(state, now);
        }
        self.jobs
            .retain(|_, j| j.state.live() || now.duration_since(j.changed) < self.retention);
        self.release_unused();
        self.trim_terminal();
    }

    fn trim_terminal(&mut self) {
        let mut terminal: Vec<_> = self
            .jobs
            .iter()
            .filter(|(_, j)| !j.state.live())
            .map(|(id, j)| (id.clone(), j.caller.clone(), j.changed))
            .collect();
        terminal.sort_by_key(|(_, _, changed)| *changed);
        let mut per_caller = HashMap::<String, usize>::new();
        let mut keep = HashSet::new();
        for (id, caller, _) in terminal.into_iter().rev() {
            let count = per_caller.entry(caller).or_default();
            if keep.len() < MAX_TERMINAL && *count < MAX_CALLER_TERMINAL {
                keep.insert(id);
                *count += 1;
            }
        }
        self.jobs
            .retain(|id, j| j.state.live() || keep.contains(id));
    }

    fn release_unused(&mut self) {
        self.tickets.retain(|key, _| {
            self.jobs
                .values()
                .any(|j| j.key == *key && matches!(j.state, State::Running | State::Ready))
        });
    }

    pub fn tick(&mut self) {
        let now = Instant::now();
        self.expire(now);
        // A persistent observer is registered only once per live world. Drain unrelated publications
        // too; never grow a bridge-side history. A poisoned observer is not reattached to that world.
        let mut failed = HashSet::new();
        for (instance, observer) in &mut self.observers {
            if let Some(receiver) = &observer.receiver {
                if receiver.len() > OBSERVER_BACKLOG {
                    failed.insert(*instance);
                    continue;
                }
                for _ in 0..OBSERVER_BACKLOG {
                    match receiver.try_recv() {
                        Ok((pos, chunk)) => {
                            if let Some(ticket) = self.tickets.get_mut(&ChunkKey {
                                world_instance: *instance,
                                x: pos.x,
                                z: pos.y,
                            }) {
                                ticket.publication = Some(chunk);
                            }
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            failed.insert(*instance);
                            break;
                        }
                    }
                }
            }
        }
        for instance in &failed {
            self.observers.get_mut(instance).unwrap().receiver.take();
        }
        for job in self
            .jobs
            .values_mut()
            .filter(|j| j.state.live() && failed.contains(&j.key.world_instance))
        {
            job.make_terminal(State::Failed, now);
        }
        self.release_unused();
        let queued: Vec<_> = self
            .jobs
            .iter()
            .filter(|(_, j)| j.state == State::Queued)
            .map(|(id, j)| (id.clone(), j.created))
            .collect();
        let mut queued = queued;
        queued.sort_by_key(|(_, created)| *created);
        for (id, _) in queued {
            let job = &self.jobs[&id];
            let active = |caller: Option<&str>| {
                self.jobs
                    .values()
                    .filter(|j| {
                        matches!(j.state, State::Running | State::Ready)
                            && caller.is_none_or(|c| j.caller == c)
                    })
                    .count()
            };
            if active(None) >= MAX_ACTIVE || active(Some(&job.caller)) >= MAX_CALLER_ACTIVE {
                continue;
            }
            if !self.tickets.contains_key(&job.key) {
                if self.tickets.len() >= MAX_PHYSICAL {
                    continue;
                }
                let world = job.world().clone();
                let pos = Vector2::new(job.key.x, job.key.z);
                // The observer already exists. Taking the ticket before lookup closes the eviction
                // race. A ready response additionally checks the exact published Arc on every poll.
                let mut loading = world
                    .level
                    .chunk_loading
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                loading.add_ticket(pos, ChunkLoading::FULL_CHUNK_LEVEL);
                loading.send_change();
                drop(loading);
                let publication = world
                    .level
                    .loaded_chunks
                    .get(&pos)
                    .map(|c| Arc::downgrade(c.value()));
                self.tickets.insert(
                    job.key,
                    Ticket {
                        world,
                        pos,
                        publication,
                    },
                );
            }
            self.jobs.get_mut(&id).unwrap().state = State::Running;
        }
        for (id, job) in &mut self.jobs {
            if job.state != State::Running {
                continue;
            }
            let ticket = &self.tickets[&job.key];
            let valid = ticket
                .publication
                .as_ref()
                .and_then(Weak::upgrade)
                .is_some_and(|published| {
                    job.world()
                        .level
                        .loaded_chunks
                        .get(&ticket.pos)
                        .is_some_and(|loaded| Arc::ptr_eq(loaded.value(), &published))
                });
            if valid {
                job.state = State::Ready;
                job.changed = now;
                job.lease = Some((id.replacen('o', "l", 1), now + self.lease_duration));
            }
        }
        let worlds = self.context.server.worlds.load();
        self.observers.retain(|_, observer| {
            !observer.world.level.cancel_token.is_cancelled()
                && !observer
                    .world
                    .level
                    .shut_down_chunk_system
                    .load(Ordering::Acquire)
                && worlds
                    .iter()
                    .any(|world| Arc::ptr_eq(world, &observer.world))
        });
        self.trim_terminal();
    }

    pub fn shutdown(&mut self) {
        self.jobs.clear();
        self.tickets.clear();
        self.observers.clear();
        self.context
            .log("bridge drained: jobs=0 tickets=0 observers=0");
    }
}
