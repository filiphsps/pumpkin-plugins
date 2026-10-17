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
pub fn host_failure(operation: &Operation) -> Value {
    match operation {
        Operation::Poll { operation_id } | Operation::Cancel { operation_id } => {
            json!({"v":1,"ok":false,"operationId":operation_id,"code":"host_failure"})
        }
        _ => error("host_failure"),
    }
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

#[cfg(test)]
mod tests {
    use super::{Operation, host_failure};
    use serde_json::json;

    #[test]
    fn worker_failure_keeps_poll_and_cancel_operation_ids() {
        assert_eq!(
            host_failure(&Operation::Poll {
                operation_id: "job-1".into(),
            }),
            json!({"v":1,"ok":false,"code":"host_failure","operationId":"job-1"})
        );
        assert_eq!(
            host_failure(&Operation::Cancel {
                operation_id: "job-2".into(),
            }),
            json!({"v":1,"ok":false,"code":"host_failure","operationId":"job-2"})
        );
    }

    #[test]
    fn worker_failure_does_not_add_operation_ids_to_other_requests() {
        assert_eq!(
            host_failure(&Operation::Probe),
            json!({"v":1,"ok":false,"code":"host_failure"})
        );
        assert_eq!(
            host_failure(&Operation::Submit {
                world: "world".into(),
                x: 0,
                z: 0,
            }),
            json!({"v":1,"ok":false,"code":"host_failure"})
        );
        assert_eq!(
            host_failure(&Operation::Release {
                lease_id: "lease-1".into(),
            }),
            json!({"v":1,"ok":false,"code":"host_failure"})
        );
    }
}
