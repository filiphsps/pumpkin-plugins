//! Bounded v1 JSON bytes. Sender identity is deliberately absent from these types.
use serde::Deserialize;
use serde_json::{Value, json};

pub const MAX_BYTES: usize = 8192;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum Operation {
    Probe,
    Submit {
        world: String,
        x: i32,
        z: i32,
    },
    Poll {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Cancel {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Release {
        #[serde(rename = "leaseId")]
        lease_id: String,
    },
}

pub fn decode(bytes: &[u8]) -> Result<Operation, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("invalid_request");
    }
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| "invalid_request")?;
    let object = value.as_object_mut().ok_or("invalid_request")?;
    match object.remove("v") {
        Some(v) if v.as_u64() == Some(1) => {}
        Some(v) if v.is_u64() => return Err("incompatible"),
        _ => return Err("invalid_request"),
    }
    let operation: Operation = serde_json::from_value(value).map_err(|_| "invalid_request")?;
    let valid = match &operation {
        Operation::Submit { world, x, z } => {
            !world.is_empty()
                && world.len() <= 128
                && (-1_000_000..=1_000_000).contains(x)
                && (-1_000_000..=1_000_000).contains(z)
        }
        Operation::Poll { operation_id: id }
        | Operation::Cancel { operation_id: id }
        | Operation::Release { lease_id: id } => !id.is_empty() && id.len() <= 64,
        Operation::Probe => true,
    };
    if valid {
        Ok(operation)
    } else {
        Err("invalid_request")
    }
}

pub fn error(code: &str) -> Value {
    json!({"v":1,"ok":false,"code":code})
}
pub fn probe() -> Value {
    json!({"v":1,"ok":true,"provider":"Pumpkin++","protocol":1,
        "hostRelease":env!("PUMPKIN_HOST_RELEASE"),
        "hostSourceCommit":env!("PUMPKIN_HOST_SOURCE_COMMIT")})
}
pub fn encode(value: Value) -> Vec<u8> {
    match serde_json::to_vec(&value) {
        Ok(bytes) if bytes.len() <= MAX_BYTES => bytes,
        _ => br#"{"v":1,"ok":false,"code":"host_failure"}"#.to_vec(),
    }
}
