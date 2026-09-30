use super::*;
use crate::providers::{catalog, preview_task, provider, MediaRef, TaskRequest};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

// ─── A text-to-image workflow with one image input, as ComfyUI exports it ───

fn graph() -> Value {
    json!({
        "3": { "class_type": "KSampler", "inputs": {
            "seed": 42, "steps": 20, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["12", 0] } },
        "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
        "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "a castle", "clip": ["4", 1] } },
        "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry", "clip": ["4", 1] } },
        "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
        "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] } },
        "10": { "class_type": "LoadImage", "inputs": { "image": "example.png" } },
        "12": { "class_type": "VAEEncode", "inputs": { "pixels": ["10", 0], "vae": ["4", 2] } }
    })
}

fn workflow() -> Value {
    json!({
        "name": "sdxl img2img",
        "graph": graph(),
        "bindings": {
            "prompt": { "node": "6", "input": "text" },
            "negative": { "node": "7", "input": "text" },
            "seed": [{ "node": "3", "input": "seed" }],
            "inputs": [{ "node": "10", "input": "image", "kind": "image" }],
            "output": "9"
        }
    })
}

fn request(workflow: Value, params: Value, provider_params: Value) -> TaskRequest {
    let mut pp = provider_params.as_object().cloned().unwrap();
    pp.insert("_workflow".into(), workflow);
    TaskRequest {
        capability: "comfyui.workflow".into(),
        model: None,
        prompt: "a lighthouse at dusk".into(),
        inputs: BTreeMap::new(),
        slot_ports: BTreeMap::new(),
        params: params.as_object().cloned().unwrap(),
        provider_params: pp,
    }
}

fn image(path: &str) -> MediaRef {
    MediaRef {
        kind: "image".into(),
        path: path.into(),
        cloud_ids: BTreeMap::new(),
    }
}

fn err(r: Result<Plan, ProviderError>) -> String {
    r.map(|_| ()).unwrap_err().to_string()
}

// ─── Planning ───────────────────────────────────────────────────────────────

#[test]
fn plan_fills_prompt_negative_media_and_seeds() {
    let mut req = request(
        workflow(),
        json!({ "seed": 10, "count": 3 }),
        json!({ "negative_prompt": "text, watermark" }),
    );
    req.inputs
        .insert(input_slot("10"), vec![image("/in/photo.jpg")]);
    let p = plan(&req, || unreachable!("seed is fixed")).unwrap();
    assert_eq!(p.graph["6"]["inputs"]["text"], "a lighthouse at dusk");
    assert_eq!(p.graph["7"]["inputs"]["text"], "text, watermark");
    assert_eq!(p.seeds, vec![Some(10), Some(11), Some(12)]);
    assert_eq!(p.uploads.len(), 1);
    assert_eq!(p.uploads[0].1.path, "/in/photo.jpg");

    let g = prompt_graph(&p, &["beatboard-ab.jpg".into()], Some(11));
    assert_eq!(g["10"]["inputs"]["image"], "beatboard-ab.jpg");
    assert_eq!(g["3"]["inputs"]["seed"], 11);
    // Links and untouched values survive.
    assert_eq!(g["3"]["inputs"]["model"], json!(["4", 0]));
    assert_eq!(g["4"]["inputs"]["ckpt_name"], "sd_xl_base_1.0.safetensors");
}

#[test]
fn unconnected_inputs_keep_the_workflows_own_values() {
    let mut req = request(workflow(), json!({}), json!({}));
    req.prompt = String::new();
    let mut n = 100;
    let p = plan(&req, || {
        n += 1;
        n
    })
    .unwrap();
    assert_eq!(p.graph["6"]["inputs"]["text"], "a castle");
    assert_eq!(p.graph["7"]["inputs"]["text"], "blurry");
    assert!(p.uploads.is_empty());
    assert_eq!(p.seeds, vec![Some(101)], "no seed set → a fresh random one");
    let g = prompt_graph(&p, &[], p.seeds[0]);
    assert_eq!(g["10"]["inputs"]["image"], "example.png");
}

#[test]
fn plan_explains_what_is_wrong() {
    let none = TaskRequest {
        provider_params: Map::new(),
        ..request(json!(null), json!({}), json!({}))
    };
    assert!(err(plan(&none, || 0)).contains("import a ComfyUI workflow"));

    // The editor format (nodes + links) instead of Export (API).
    let ui = json!({ "graph": { "nodes": [], "links": [] } });
    assert!(err(plan(&request(ui, json!({}), json!({})), || 0)).contains("Export (API)"));

    let mut wired = workflow();
    wired["bindings"]["prompt"] = json!({ "node": "3", "input": "positive" });
    assert!(
        err(plan(&request(wired, json!({}), json!({})), || 0)).contains("wired to another node")
    );

    let mut missing = workflow();
    missing["bindings"]["output"] = json!("99");
    assert!(err(plan(&request(missing, json!({}), json!({})), || 0)).contains("#99"));

    let mut no_prompt = workflow();
    no_prompt["bindings"]["prompt"] = Value::Null;
    assert!(err(plan(&request(no_prompt, json!({}), json!({})), || 0)).contains("no prompt input"));

    let mut no_seed = workflow();
    no_seed["bindings"]["seed"] = json!([]);
    let req = request(no_seed.clone(), json!({ "count": 2 }), json!({}));
    assert!(err(plan(&req, || 0)).contains("no seed input"));
    // …but a single run without a seed binding keeps the workflow's seed.
    let p = plan(&request(no_seed, json!({}), json!({})), || 0).unwrap();
    assert_eq!(p.seeds, vec![None]);

    let mut cloud_only = request(workflow(), json!({}), json!({}));
    let mut media = image("");
    media.cloud_ids.insert("pixverse".into(), "123".into());
    cloud_only.inputs.insert(input_slot("10"), vec![media]);
    assert!(err(plan(&cloud_only, || 0)).contains("needs a file"));
}

#[test]
fn catalog_accepts_comfyui_params_and_rejects_others() {
    let ok = request(
        workflow(),
        json!({ "seed": 5, "count": 2 }),
        json!({ "negative_prompt": "x" }),
    );
    catalog::validate("comfyui", &ok).unwrap();
    let bad = request(workflow(), json!({ "aspect_ratio": "16:9" }), json!({}));
    assert!(catalog::validate("comfyui", &bad).is_err());
    let range = request(workflow(), json!({ "count": 50 }), json!({}));
    assert!(catalog::validate("comfyui", &range).is_err());
}

// ─── Reading results ────────────────────────────────────────────────────────

#[test]
fn outcome_reads_files_and_errors() {
    let done = json!({
        "status": { "status_str": "success", "completed": true, "messages": [] },
        "outputs": {
            "9": { "images": [{ "filename": "ComfyUI_00001_.png", "subfolder": "", "type": "output" }] },
            "20": { "images": [{ "filename": "preview.png", "subfolder": "", "type": "temp" }] }
        }
    });
    let files = outcome(&done, Some("9")).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].filename, "ComfyUI_00001_.png");
    // Without an output node, saved files win over temporary previews.
    let any = outcome(&done, None).unwrap();
    assert_eq!(any, files);
    assert!(outcome(&done, Some("5")).unwrap_err().contains("cache"));

    let video = json!({ "status": { "status_str": "success" }, "outputs": {
        "30": { "gifs": [{ "filename": "clip_00001.mp4", "subfolder": "vid", "type": "output", "format": "video/h264-mp4" }] } } });
    let f = &outcome(&video, Some("30")).unwrap()[0];
    assert_eq!(media_kind(&f.filename), "video");
    assert_eq!(
        view_url("http://h:8188", f),
        "http://h:8188/view?filename=clip_00001.mp4&subfolder=vid&type=output"
    );

    let failed = json!({ "status": { "status_str": "error", "messages": [
        ["execution_start", {}],
        ["execution_error", { "node_id": "4", "node_type": "CheckpointLoaderSimple",
            "exception_message": "Value not in list: ckpt_name: 'x.safetensors'\n" }]
    ] }, "outputs": {} });
    assert_eq!(
        outcome(&failed, Some("9")).unwrap_err(),
        "ComfyUI failed in #4 CheckpointLoaderSimple: Value not in list: ckpt_name: 'x.safetensors'"
    );
}

#[test]
fn rejected_prompts_list_node_errors() {
    let body = json!({
        "error": { "type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", "details": "" },
        "node_errors": { "4": { "class_type": "CheckpointLoaderSimple", "errors": [
            { "message": "Value not in list", "details": "ckpt_name: 'missing.safetensors' not in []" } ] } }
    });
    let msg = prompt_error(400, &body.to_string());
    assert!(msg.contains("HTTP 400"), "{msg}");
    assert!(msg.contains("Prompt outputs failed validation"), "{msg}");
    assert!(
        msg.contains("#4 CheckpointLoaderSimple: Value not in list (ckpt_name: 'missing.safetensors' not in [])"),
        "{msg}"
    );
}

#[test]
fn server_address_comes_from_config() {
    assert_eq!(server_url(&json!({})).unwrap(), DEFAULT_SERVER);
    assert_eq!(
        server_url(&json!({ "comfyuiUrl": " http://10.0.0.5:8188/ " })).unwrap(),
        "http://10.0.0.5:8188"
    );
    assert!(server_url(&json!({ "comfyuiUrl": "10.0.0.5:8188" })).is_err());
}

// ─── Against a mock ComfyUI server ──────────────────────────────────────────

#[derive(Default)]
struct Seen {
    /// (method, url, body)
    requests: Vec<(String, String, Vec<u8>)>,
    prompts: Vec<Value>,
}

impl Seen {
    fn count(&self, method: &str, prefix: &str) -> usize {
        self.requests
            .iter()
            .filter(|(m, u, _)| m == method && u.starts_with(prefix))
            .count()
    }
}

/// A stand-in for ComfyUI's server. Each prompt shows up in /queue as
/// pending, then running, then lands in /history (unless `never_finishes`).
/// `history` builds the finished entry for a prompt id.
fn mock_comfy(history: fn(&str) -> Value, never_finishes: bool) -> (String, Arc<Mutex<Seen>>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let seen2 = seen.clone();
    std::thread::spawn(move || {
        let mut polls: BTreeMap<String, u32> = BTreeMap::new();
        let mut next = 0;
        for mut req in server.incoming_requests() {
            let method = req.method().to_string();
            let url = req.url().to_string();
            let mut body = Vec::new();
            let _ = std::io::Read::read_to_end(req.as_reader(), &mut body);
            seen2
                .lock()
                .unwrap()
                .requests
                .push((method.clone(), url.clone(), body.clone()));
            let reply = |status: u16, v: Value| {
                tiny_http::Response::from_string(v.to_string())
                    .with_status_code(status)
                    .with_header(
                        "Content-Type: application/json"
                            .parse::<tiny_http::Header>()
                            .unwrap(),
                    )
            };
            let response = match (method.as_str(), url.as_str()) {
                ("POST", "/upload/image") => {
                    let text = String::from_utf8_lossy(&body);
                    let name = text
                        .split("filename=\"")
                        .nth(1)
                        .and_then(|s| s.split('"').next())
                        .unwrap_or("?")
                        .to_string();
                    reply(
                        200,
                        json!({ "name": name, "subfolder": "", "type": "input" }),
                    )
                }
                ("POST", "/prompt") => {
                    let v: Value = serde_json::from_slice(&body).unwrap();
                    seen2.lock().unwrap().prompts.push(v["prompt"].clone());
                    next += 1;
                    let id = format!("p{next}");
                    polls.insert(id.clone(), 0);
                    reply(
                        200,
                        json!({ "prompt_id": id, "number": next, "node_errors": {} }),
                    )
                }
                ("GET", u) if u.starts_with("/history/") => {
                    let id = u.trim_start_matches("/history/").to_string();
                    // Unknown ids (e.g. after a server restart) have no history.
                    let Some(n) = polls.get_mut(&id) else {
                        let _ = req.respond(reply(200, json!({})));
                        continue;
                    };
                    *n += 1;
                    if never_finishes || *n < 3 {
                        reply(200, json!({}))
                    } else {
                        reply(200, json!({ id.clone(): history(&id) }))
                    }
                }
                ("GET", "/queue") => {
                    let mut running = Vec::new();
                    let mut pending = Vec::new();
                    for (id, n) in &polls {
                        if never_finishes || *n < 3 {
                            if *n <= 1 {
                                pending.push(json!([0, id, {}, {}, []]));
                            } else {
                                running.push(json!([0, id, {}, {}, []]));
                            }
                        }
                    }
                    // Someone else's prompt, running on the same server.
                    if never_finishes {
                        running.push(json!([0, "not-ours", {}, {}, []]));
                    }
                    reply(
                        200,
                        json!({ "queue_running": running, "queue_pending": pending }),
                    )
                }
                ("POST", "/queue") | ("POST", "/interrupt") => reply(200, json!({})),
                ("GET", u) if u.starts_with("/view?") => {
                    tiny_http::Response::from_string(format!("BYTES:{u}")).with_status_code(200)
                }
                _ => reply(404, json!({ "error": "not found" })),
            };
            let _ = req.respond(response);
        }
    });
    (base, seen)
}

fn saved_image(id: &str) -> Value {
    json!({
        "status": { "status_str": "success", "completed": true, "messages": [] },
        "outputs": { "9": { "images": [{ "filename": format!("{id}_00001_.png"), "subfolder": "", "type": "output" }] } }
    })
}

fn test_client(base: &str) -> ComfyClient {
    let mut client = ComfyClient::new(base.into());
    client.http = reqwest::Client::builder().no_proxy().build().unwrap();
    client.poll_interval = Duration::from_millis(10);
    client
}

fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(fut)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("beatboard-comfy-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn plan_with_local_image(dir: &Path, params: Value) -> Plan {
    let src = dir.join("input.png");
    std::fs::write(&src, b"input-bytes").unwrap();
    let mut req = request(workflow(), params, json!({}));
    req.inputs
        .insert(input_slot("10"), vec![image(src.to_str().unwrap())]);
    plan(&req, || 7).unwrap()
}

#[test]
fn uploads_queues_one_prompt_per_seed_waits_and_downloads() {
    let (base, seen) = mock_comfy(saved_image, false);
    let dir = scratch("run");
    let plan = plan_with_local_image(&dir, json!({ "seed": 100, "count": 2 }));
    let client = test_client(&base);
    let reported = Mutex::new(None);
    let progress = Mutex::new(Vec::new());
    let (raw, thumbs) = block_on(client.run(
        &plan,
        &dir.join("out"),
        |p| progress.lock().unwrap().push(p),
        |job| *reported.lock().unwrap() = Some(job.clone()),
    ))
    .unwrap();

    let seen = seen.lock().unwrap();
    // The same file is uploaded once, named by its content hash.
    assert_eq!(seen.count("POST", "/upload/image"), 1);
    let upload = &seen
        .requests
        .iter()
        .find(|(m, u, _)| m == "POST" && u == "/upload/image")
        .unwrap()
        .2;
    let upload = String::from_utf8_lossy(upload);
    assert!(upload.contains("input-bytes"));
    assert!(upload.contains("name=\"overwrite\"\r\n\r\ntrue"));
    let uploaded = upload
        .split("filename=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    assert!(uploaded.starts_with("beatboard-") && uploaded.ends_with(".png"));

    assert_eq!(seen.prompts.len(), 2);
    for (prompt, seed) in seen.prompts.iter().zip([100, 101]) {
        assert_eq!(prompt["6"]["inputs"]["text"], "a lighthouse at dusk");
        assert_eq!(prompt["10"]["inputs"]["image"], uploaded);
        assert_eq!(prompt["3"]["inputs"]["seed"], seed);
    }

    let job = reported.lock().unwrap().clone().expect("job reported");
    assert_eq!(job.prompt_ids, vec!["p1", "p2"]);
    assert_eq!(job.seeds, vec![Some(100), Some(101)]);
    assert_eq!(job.server, base);

    assert_eq!(thumbs.len(), 2);
    assert_eq!(thumbs[0].label, "sdxl img2img · seed 100");
    assert_eq!(thumbs[1].label, "sdxl img2img · seed 101");
    assert!(thumbs[0].chosen && !thumbs[1].chosen);
    assert_eq!(thumbs[0].thumb_type, "image");
    let saved = std::fs::read_to_string(thumbs[0].path.as_ref().unwrap()).unwrap();
    assert_eq!(
        saved,
        "BYTES:/view?filename=p1_00001_.png&subfolder=&type=output"
    );
    assert_eq!(raw["seeds"], json!([100, 101]));
    let p = progress.lock().unwrap();
    assert_eq!(p.last(), Some(&1.0));
    assert!(
        p.windows(2).all(|w| w[0] <= w[1]),
        "progress must not go backwards: {p:?}"
    );
    // Nothing to cancel after a clean finish.
    assert_eq!(seen.count("POST", "/interrupt"), 0);
}

#[test]
fn failed_workflow_reports_the_node_that_failed() {
    fn failed(_: &str) -> Value {
        json!({ "status": { "status_str": "error", "messages": [["execution_error", {
            "node_id": "3", "node_type": "KSampler", "exception_message": "CUDA out of memory" }]] },
            "outputs": {} })
    }
    let (base, _) = mock_comfy(failed, false);
    let dir = scratch("failed");
    let plan = plan_with_local_image(&dir, json!({}));
    let e = block_on(test_client(&base).run(&plan, &dir, |_| {}, |_| {})).unwrap_err();
    assert_eq!(e, "ComfyUI failed in #3 KSampler: CUDA out of memory");
}

#[test]
fn stopping_removes_queued_prompts_and_interrupts_only_ours() {
    let (base, seen) = mock_comfy(saved_image, true);
    let dir = scratch("cancel");
    let plan = plan_with_local_image(&dir, json!({ "count": 2 }));
    let client = test_client(&base);
    block_on(async {
        let run = client.run(&plan, &dir, |_| {}, |_| {});
        let _ = tokio::time::timeout(Duration::from_millis(300), run).await;
    });
    let mut done = false;
    for _ in 0..50 {
        let seen = seen.lock().unwrap();
        let delete = seen.requests.iter().any(|(m, u, b)| {
            m == "POST"
                && u == "/queue"
                && serde_json::from_slice::<Value>(b).ok()
                    == Some(json!({ "delete": ["p1", "p2"] }))
        });
        let interrupts: Vec<Value> = seen
            .requests
            .iter()
            .filter(|(m, u, _)| m == "POST" && u == "/interrupt")
            .map(|(_, _, b)| serde_json::from_slice(b).unwrap())
            .collect();
        if delete && !interrupts.is_empty() {
            assert_eq!(
                interrupts,
                vec![json!({ "prompt_id": "p1" })],
                "only our running prompt"
            );
            done = true;
            break;
        }
        drop(seen);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        done,
        "expected the queued prompts removed and ours interrupted"
    );
}

#[test]
fn a_reported_job_can_be_collected_by_a_new_client() {
    let (base, seen) = mock_comfy(saved_image, false);
    let dir = scratch("resume");
    let plan = plan_with_local_image(&dir, json!({ "seed": 1 }));
    let job = block_on(test_client(&base).submit(&plan, |_| {})).unwrap();
    let stored = serde_json::to_value(&job).unwrap();
    let job: Job = serde_json::from_value(stored).unwrap();
    let (_, thumbs) = block_on(test_client(&job.server).wait(&job, &dir, |_| {})).unwrap();
    assert_eq!(thumbs.len(), 1);
    assert_eq!(
        seen.lock().unwrap().count("POST", "/prompt"),
        1,
        "resume must not resubmit"
    );
}

#[test]
fn lost_prompts_fail_instead_of_waiting_forever() {
    fn never(_: &str) -> Value {
        Value::Null
    }
    let (base, _) = mock_comfy(never, false);
    let job = Job {
        server: base.clone(),
        prompt_ids: vec!["gone".into()],
        seeds: vec![None],
        output: None,
        name: "x".into(),
    };
    // The mock has never seen "gone": it is neither queued nor in history.
    let e = block_on(test_client(&base).wait(&job, &scratch("lost"), |_| {})).unwrap_err();
    assert!(e.contains("no longer has this run"), "{e}");
}

#[test]
fn unreachable_server_says_how_to_fix_it() {
    let dir = scratch("down");
    let plan = plan_with_local_image(&dir, json!({}));
    // Nothing listens on port 9 (discard) locally.
    let e =
        block_on(test_client("http://127.0.0.1:9").run(&plan, &dir, |_| {}, |_| {})).unwrap_err();
    assert!(
        e.contains("can't reach ComfyUI at http://127.0.0.1:9"),
        "{e}"
    );
}

// ─── Through the provider, from a task node ─────────────────────────────────

fn node() -> Value {
    json!({
        "id": "c1", "kind": "task", "capability": "comfyui.workflow", "provider": "comfyui",
        "params": { "seed": 5 }, "provider_params": {},
        "workflow": workflow(),
        "ports": [
            { "kind": "text", "side": "left", "top": 44, "label": "prompt", "slot": "prompt" },
            { "kind": "image", "side": "left", "top": 68, "label": "#10 LoadImage", "slot": "in@10" },
            { "kind": "image", "side": "right", "top": 56 }
        ]
    })
}

#[test]
fn task_node_workflow_reaches_the_plan_with_upstream_media() {
    let p = provider("comfyui").unwrap();
    // A fal image feeding the LoadImage input.
    let deps = vec![
        json!({ "from": { "kind": "prompt", "prompt": "neon city" }, "edge": { "to": { "port": 0 } } }),
        json!({ "from": { "kind": "task", "thumbs": [] }, "edge": { "to": { "port": 1 } },
                "result": { "thumbs": [{ "type": "image", "path": "/runs/fal/r-0.png" }] } }),
    ];
    let req = p.build_request(&node(), &deps).unwrap();
    catalog::validate("comfyui", &req).unwrap();
    let plan = plan(&req, || 0).unwrap();
    assert_eq!(plan.graph["6"]["inputs"]["text"], "neon city");
    assert_eq!(plan.uploads[0].1.path, "/runs/fal/r-0.png");
    assert_eq!(plan.seeds, vec![Some(5)]);
}

#[test]
fn inspector_preview_shows_bindings() {
    let lines = preview_task(&node()).unwrap();
    assert_eq!(lines[0], "POST /prompt · sdxl img2img (8 nodes)");
    assert!(
        lines.contains(&"#6 CLIPTextEncode.text = <prompt>  (prompt)".to_string()),
        "{lines:?}"
    );
    assert!(
        lines.contains(&"#10 LoadImage.image = upload <#10 LoadImage>".to_string()),
        "{lines:?}"
    );
    assert!(
        lines.contains(&"#3 KSampler.seed = 5".to_string()),
        "{lines:?}"
    );
    assert_eq!(lines.last().unwrap(), "output: #9 SaveImage");

    let mut random = node();
    random["params"] = json!({});
    let lines = preview_task(&random).unwrap();
    assert!(
        lines.contains(&"#3 KSampler.seed = random each run".to_string()),
        "{lines:?}"
    );

    let mut empty = node();
    empty["workflow"] = Value::Null;
    assert!(preview_task(&empty)
        .unwrap_err()
        .contains("import a ComfyUI workflow"));
}
