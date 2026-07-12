// MCP server — exposes the Atlas canvas to AI agents (Claude Code, Cursor, …)
// over the Model Context Protocol (streamable-HTTP transport, JSON-RPC 2.0).
//
// The server owns no graph state: every tool call is forwarded to the React
// frontend as an `mcp:op` event, applied there by src/mcp-bridge.jsx against
// the live canvas, and answered back through the `mcp_response` command.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 4923;
const OP_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: &str = "2025-06-18";

const TOOL_NAMES: [&str; 6] = [
    "get_graph",
    "add_node",
    "connect_nodes",
    "set_params",
    "run_node",
    "get_node_result",
];

const SERVER_INSTRUCTIONS: &str = "Atlas is a node-graph canvas for AI media \
generation, open on the user's desktop — every change you make is visible to \
them live. Typical flow: get_graph to orient → add_node for inputs (prompt, \
asset) and generators (image, video, transition, …) → connect_nodes to wire \
inputs into generator ports → run_node → poll get_node_result until 'done', \
then use the returned local file paths. Generation runs on the PixVerse cloud \
and takes 1–5 minutes per node; ffmpeg_compose concatenates videos locally. \
The user can also edit and run the canvas themselves at any time.";

// ─── Pending-op registry (HTTP thread ⇄ frontend round trip) ─────────────────

static PENDING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<Value>>>> = OnceLock::new();
static NEXT_OP_ID: AtomicU64 = AtomicU64::new(1);

fn pending_map() -> &'static Mutex<HashMap<u64, mpsc::Sender<Value>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Frontend reply to an `mcp:op` event (invoked from src/mcp-bridge.jsx).
#[tauri::command]
pub fn mcp_response(id: u64, result: Value) {
    if let Some(tx) = pending_map().lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

/// Forward one tool call to the frontend bridge and block until it replies.
fn call_frontend(app: &AppHandle, tool: &str, args: &Value) -> Value {
    let id = NEXT_OP_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    pending_map().lock().unwrap().insert(id, tx);
    if let Err(e) = app.emit_all("mcp:op", json!({ "id": id, "tool": tool, "args": args })) {
        pending_map().lock().unwrap().remove(&id);
        return json!({ "error": format!("failed to reach the Atlas window: {e}") });
    }
    match rx.recv_timeout(OP_TIMEOUT) {
        Ok(v) => v,
        Err(_) => {
            pending_map().lock().unwrap().remove(&id);
            json!({ "error": "timed out waiting for the Atlas window — is the app open and a project loaded?" })
        }
    }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

fn tool_definitions() -> Value {
    let params_schema = json!({
        "type": "object",
        "description": "Node parameters. Accepted keys depend on the node type: \
            `title` (any node); `prompt` (prompt + generator nodes); \
            `path` (asset nodes — absolute local file path of an image/video); \
            `model`, `quality`, `aspect_ratio`, `duration`, `count`, `timeout` \
            (PixVerse generator nodes; e.g. model 'qwen-image' for image, 'v6' for video, \
            quality '720p'/'1080p', aspect_ratio '16:9', duration seconds, count = variants); \
            `selected_index` (pick nodes)."
    });
    json!([
        {
            "name": "get_graph",
            "description": "Return the current canvas: all nodes (id, type, title, params, input ports, result state) and edges. Call this first to orient yourself.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "add_node",
            "description": "Add a node to the canvas. Types — inputs: `prompt` (text prompt), `asset` (local image/video file, set params.path); \
                generators (PixVerse cloud): `image` (text/image-to-image), `video` (text/image-to-video), `transition` (video between two images, ports 'from'/'to'), \
                `reference` (generate from multiple reference images/videos), `motion_control` (drive a character image with a motion video), \
                `extend` / `upscale` / `speech` (operate on an upstream video); \
                other: `pick` (human selects among upstream candidates — pauses the run until the user clicks), \
                `ffmpeg_compose` (concatenate connected video clips locally), `output` (final sink). \
                Returns the new node_id and its input port labels.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["prompt", "asset", "image", "video", "transition", "reference", "motion_control", "extend", "upscale", "speech", "pick", "ffmpeg_compose", "output"] },
                    "params": params_schema,
                    "x": { "type": "number", "description": "Canvas position (optional, auto-laid-out if omitted)" },
                    "y": { "type": "number" }
                },
                "required": ["type"]
            }
        },
        {
            "name": "connect_nodes",
            "description": "Connect the output of one node to an input port of another. If to_port is omitted, the first compatible free input port is used. Fails with a reason on type mismatch, duplicate, or cycle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from_node": { "type": "string" },
                    "to_node": { "type": "string" },
                    "to_port": { "type": "string", "description": "Target input port label as shown by get_graph (e.g. 'prompt', 'src', 'from', 'to', 'clips')" }
                },
                "required": ["from_node", "to_node"]
            }
        },
        {
            "name": "set_params",
            "description": "Update a node's parameters (same keys as add_node's params).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "node_id": { "type": "string" },
                    "params": params_schema
                },
                "required": ["node_id", "params"]
            }
        },
        {
            "name": "run_node",
            "description": "Execute the graph. With node_id: runs that node and everything downstream of it. Without: runs the whole graph from its roots. Returns immediately with the list of node ids that will run — poll get_node_result to await completion. Generator nodes take 1–5 minutes. Only one run can be active at a time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "node_id": { "type": "string", "description": "Optional start node" }
                }
            }
        },
        {
            "name": "get_node_result",
            "description": "Get a node's execution state: idle | running (with progress) | waiting_for_pick (human must click a choice in the Atlas window) | done (with local file paths of the generated media) | error.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "node_id": { "type": "string" }
                },
                "required": ["node_id"]
            }
        }
    ])
}

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────────

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Handle one JSON-RPC message. Returns None for notifications (no reply).
fn handle_message(app: &AppHandle, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = match msg.get("id") {
        Some(v) if !v.is_null() => v.clone(),
        _ => return None, // notification
    };
    let result = match method {
        "initialize" => {
            let requested = msg
                .pointer("/params/protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_VERSION);
            json!({
                "protocolVersion": requested,
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "atlas",
                    "title": "Atlas — AI media canvas",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": SERVER_INSTRUCTIONS
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_definitions() }),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
            if !TOOL_NAMES.contains(&name) {
                return Some(rpc_error(id, -32602, &format!("unknown tool: {name}")));
            }
            let args = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let reply = call_frontend(app, name, &args);
            let is_error = reply.get("error").is_some();
            let text = serde_json::to_string_pretty(&reply).unwrap_or_else(|_| reply.to_string());
            json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
        }
        _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(rpc_result(id, result))
}

// ─── HTTP server (streamable-HTTP transport, stateless) ──────────────────────

fn json_response(status: u16, body: &Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(body.to_string().into_bytes())
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        )
}

fn empty_response(status: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(Vec::new()).with_status_code(status)
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let port = std::env::var("ATLAS_MCP_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[mcp] could not bind 127.0.0.1:{port}: {e}");
                return;
            }
        };
        println!("[mcp] listening on http://127.0.0.1:{port}/mcp");

        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);

            let response = match method {
                tiny_http::Method::Post => match serde_json::from_str::<Value>(&body) {
                    Ok(msg) => match handle_message(&app, &msg) {
                        Some(reply) => json_response(200, &reply),
                        None => empty_response(202), // notification accepted
                    },
                    Err(_) => json_response(
                        400,
                        &rpc_error(Value::Null, -32700, "parse error: body must be a JSON-RPC message"),
                    ),
                },
                // Session teardown — stateless server, nothing to do.
                tiny_http::Method::Delete => empty_response(200),
                // No server-initiated stream support.
                _ => empty_response(405),
            };
            let _ = request.respond(response);
        }
    });
}
