use super::*;
use crate::providers::{catalog, MediaRef, TaskRequest};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

// ─── Planning ───────────────────────────────────────────────────────────────

fn request(capability: &str, model: &str, params: Value, provider_params: Value) -> TaskRequest {
    TaskRequest {
        capability: capability.into(),
        model: Some(model.into()),
        prompt: "a lighthouse at dusk".into(),
        inputs: BTreeMap::new(),
        slot_ports: BTreeMap::new(),
        params: params.as_object().cloned().unwrap(),
        provider_params: provider_params.as_object().cloned().unwrap(),
    }
}

fn image(path: &str) -> MediaRef {
    MediaRef {
        kind: "image".into(),
        path: path.into(),
        cloud_ids: BTreeMap::new(),
    }
}

#[test]
fn every_model_maps_every_param_it_accepts() {
    let manifest = catalog::manifest("fal").unwrap();
    for (capability, entry) in manifest["capabilities"].as_object().unwrap() {
        for model in entry["models"].as_array().unwrap() {
            let model = model.as_str().unwrap();
            let ep = &manifest["endpoints"][model];
            assert!(ep["text"].is_string(), "{model}: no text endpoint");
            for spec in catalog::param_specs("fal", capability, Some(model)).unwrap() {
                let key = spec["key"].as_str().unwrap();
                assert!(
                    ep["fields"].get(key).is_some(),
                    "{model}: `{key}` has no field mapping"
                );
            }
            // Initial values must be valid for the provider's default model.
            if entry["initial"]["model"] == model {
                let init = &entry["initial"];
                let req = request(
                    capability,
                    model,
                    init["params"].clone(),
                    init["provider_params"].clone(),
                );
                catalog::validate("fal", &req).unwrap_or_else(|e| panic!("{model}: {e}"));
                plan(&req).unwrap_or_else(|e| panic!("{model}: {e}"));
            }
        }
    }
}

#[test]
fn flux_dev_switches_endpoint_and_drops_text_only_fields_with_an_image() {
    let mut req = request(
        "image.generate",
        "flux-dev",
        json!({ "aspect_ratio": "9:16", "count": 2, "seed": 7 }),
        json!({ "strength": 0.6 }),
    );
    let text = plan(&req).unwrap();
    assert_eq!(text.endpoint, "fal-ai/flux/dev");
    assert_eq!(text.body["image_size"], "portrait_16_9");
    assert_eq!(text.body["num_images"], 2);
    assert!(
        text.body.get("strength").is_none(),
        "strength is image-to-image only"
    );

    req.inputs.insert(
        "images".into(),
        vec![image("/in/a.png"), image("/in/b.png")],
    );
    let with_image = plan(&req).unwrap();
    assert_eq!(with_image.endpoint, "fal-ai/flux/dev/image-to-image");
    assert!(with_image.body.get("image_size").is_none());
    assert_eq!(with_image.body["strength"], 0.6);
    let body = body_with_images(
        &with_image,
        &["https://cdn/a.png".into(), "https://cdn/b.png".into()],
    );
    assert_eq!(
        body["image_url"], "https://cdn/a.png",
        "single-image field takes the first"
    );
}

#[test]
fn nano_banana_edit_takes_every_reference_image() {
    let mut req = request(
        "image.generate",
        "nano-banana",
        json!({ "aspect_ratio": "21:9" }),
        json!({}),
    );
    req.inputs
        .insert("images".into(), vec![image("/a.png"), image("/b.png")]);
    let p = plan(&req).unwrap();
    assert_eq!(p.endpoint, "fal-ai/nano-banana/edit");
    let body = body_with_images(&p, &["u1".into(), "u2".into()]);
    assert_eq!(body["image_urls"], json!(["u1", "u2"]));
    assert_eq!(body["aspect_ratio"], "21:9");
}

#[test]
fn video_models_format_durations_their_own_way() {
    let kling = plan(&request(
        "video.generate",
        "kling-2.5-turbo-pro",
        json!({ "duration_s": 10, "aspect_ratio": "1:1" }),
        json!({}),
    ))
    .unwrap();
    assert_eq!(
        kling.endpoint,
        "fal-ai/kling-video/v2.5-turbo/pro/text-to-video"
    );
    assert_eq!(kling.body["duration"], "10");
    assert_eq!(kling.body["aspect_ratio"], "1:1");

    let veo = plan(&request(
        "video.generate",
        "veo-3.1-fast",
        json!({ "duration_s": 6, "audio": false }),
        json!({}),
    ))
    .unwrap();
    assert_eq!(veo.body["duration"], "6s");
    assert_eq!(veo.body["generate_audio"], false);

    let mut hailuo = request(
        "video.generate",
        "hailuo-02-standard",
        json!({ "duration_s": 6, "resolution": "512P" }),
        json!({}),
    );
    assert!(
        plan(&hailuo).unwrap().body.get("resolution").is_none(),
        "resolution is image-to-video only"
    );
    hailuo
        .inputs
        .insert("image".into(), vec![image("/still.png")]);
    let i2v = plan(&hailuo).unwrap();
    assert_eq!(
        i2v.endpoint,
        "fal-ai/minimax/hailuo-02/standard/image-to-video"
    );
    assert_eq!(i2v.body["resolution"], "512P");
}

#[test]
fn plan_rejects_what_the_model_cannot_do() {
    let mut schnell = request("image.generate", "flux-schnell", json!({}), json!({}));
    schnell
        .inputs
        .insert("images".into(), vec![image("/a.png")]);
    assert!(plan(&schnell)
        .unwrap_err()
        .to_string()
        .contains("reference image"));

    let mut no_prompt = request("image.generate", "flux-dev", json!({}), json!({}));
    no_prompt.prompt = "  ".into();
    assert!(plan(&no_prompt).unwrap_err().to_string().contains("prompt"));
}

#[test]
fn validation_applies_per_model_constraints() {
    let veo_bad = request(
        "video.generate",
        "veo-3.1-fast",
        json!({ "duration_s": 5 }),
        json!({}),
    );
    assert!(catalog::validate("fal", &veo_bad)
        .unwrap_err()
        .to_string()
        .contains("4, 6, 8"));
    let kling_seed = request(
        "video.generate",
        "kling-2.5-turbo-pro",
        json!({ "seed": 1 }),
        json!({}),
    );
    assert!(catalog::validate("fal", &kling_seed)
        .unwrap_err()
        .to_string()
        .contains("seed"));
    let too_many = request(
        "image.generate",
        "flux-dev",
        json!({ "count": 9 }),
        json!({}),
    );
    assert!(catalog::validate("fal", &too_many)
        .unwrap_err()
        .to_string()
        .contains("out of range"));
    let unknown_model = request("image.generate", "sdxl", json!({}), json!({}));
    assert!(catalog::validate("fal", &unknown_model).is_err());
    let ok = request(
        "video.generate",
        "veo-3.1-fast",
        json!({ "duration_s": "8", "resolution": "1080p" }),
        json!({}),
    );
    catalog::validate("fal", &ok).unwrap();
}

#[test]
fn api_errors_are_readable() {
    assert!(api_error(401, "{}").contains("API key"));
    let e = api_error(
        422,
        r#"{"detail":[{"loc":["body","duration"],"msg":"unexpected value","type":"literal_error"}]}"#,
    );
    assert_eq!(e, "fal.ai error (HTTP 422): duration: unexpected value");
    assert!(api_error(500, "boom").ends_with("boom"));
}

#[test]
fn output_media_reads_images_and_video() {
    let imgs = output_media(
        &json!({ "images": [{ "url": "https://x/1.png", "content_type": "image/png" }, { "url": "https://x/2.png" }] }),
        "images",
    );
    assert_eq!(imgs.len(), 2);
    assert_eq!(imgs[0].1.as_deref(), Some("image/png"));
    assert_eq!(
        output_media(&json!({ "video": { "url": "https://x/v.mp4" } }), "video")[0].0,
        "https://x/v.mp4"
    );
    assert!(output_media(&json!({}), "video").is_empty());
}

// ─── Full protocol against a mock fal server ────────────────────────────────

#[derive(Default)]
struct Seen {
    requests: Vec<(String, String, Option<String>, String)>, // method, url, auth, body
}

/// A tiny stand-in for queue.fal.run + rest.fal.ai. `result` (given the
/// server's base URL) is what the result endpoint answers once the request
/// completes; `never_completes` keeps the request IN_PROGRESS forever.
fn mock_fal(result: fn(&str) -> (u16, Value), never_completes: bool) -> (String, Arc<Mutex<Seen>>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (base2, seen2) = (base.clone(), seen.clone());
    std::thread::spawn(move || {
        let mut polls = 0;
        for mut req in server.incoming_requests() {
            let method = req.method().to_string();
            let url = req.url().to_string();
            let auth = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .map(|h| h.value.to_string());
            let mut body = String::new();
            let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
            seen2
                .lock()
                .unwrap()
                .requests
                .push((method.clone(), url.clone(), auth, body));
            let reply = |status: u16, v: Value| {
                tiny_http::Response::from_string(v.to_string())
                    .with_status_code(status)
                    .with_header(
                        "Content-Type: application/json"
                            .parse::<tiny_http::Header>()
                            .unwrap(),
                    )
            };
            let q = format!("{base2}/fal-ai/flux/requests/req-1");
            let response = match (method.as_str(), url.as_str()) {
                ("POST", u) if u.starts_with("/storage/upload/initiate") => reply(
                    200,
                    json!({ "upload_url": format!("{base2}/upload/abc"), "file_url": "https://cdn.test/abc.png" }),
                ),
                ("PUT", "/upload/abc") => reply(200, json!({})),
                ("POST", "/fal-ai/flux/dev/image-to-image") => reply(
                    200,
                    json!({ "request_id": "req-1", "status_url": format!("{q}/status"), "response_url": q, "cancel_url": format!("{q}/cancel") }),
                ),
                ("GET", "/fal-ai/flux/requests/req-1/status") => {
                    polls += 1;
                    let status = if never_completes || polls < 3 {
                        if polls == 1 {
                            "IN_QUEUE"
                        } else {
                            "IN_PROGRESS"
                        }
                    } else {
                        "COMPLETED"
                    };
                    reply(200, json!({ "status": status, "queue_position": 0 }))
                }
                ("GET", "/fal-ai/flux/requests/req-1") => {
                    let (status, body) = result(&base2);
                    reply(status, body)
                }
                ("PUT", "/fal-ai/flux/requests/req-1/cancel") => {
                    reply(202, json!({ "status": "CANCELLATION_REQUESTED" }))
                }
                ("GET", "/files/out.png") => {
                    tiny_http::Response::from_string("PNGDATA").with_status_code(200)
                }
                _ => reply(404, json!({ "detail": "not found" })),
            };
            let _ = req.respond(response);
        }
    });
    (base, seen)
}

fn test_client(base: &str) -> FalClient {
    let mut client = FalClient::with_bases("test-key".into(), base.into(), base.into());
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

fn flux_plan_with_local_image(dir: &Path) -> Plan {
    let src = dir.join("input.png");
    std::fs::write(&src, b"input-bytes").unwrap();
    let mut req = request(
        "image.generate",
        "flux-dev",
        json!({ "seed": 3 }),
        json!({}),
    );
    req.inputs
        .insert("images".into(), vec![image(src.to_str().unwrap())]);
    plan(&req).unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("beatboard-fal-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn uploads_submits_polls_and_downloads() {
    let (base, seen) = mock_fal(
        |base| {
            (
                200,
                json!({ "images": [{ "url": format!("{base}/files/out.png"), "content_type": "image/png" }], "seed": 3 }),
            )
        },
        false,
    );
    let dir = scratch("ok");
    let plan = flux_plan_with_local_image(&dir);
    let progress = Arc::new(Mutex::new(Vec::new()));
    let p2 = progress.clone();
    let (raw, thumbs) = block_on(test_client(&base).run(
        &plan,
        &dir.join("out"),
        move |p| p2.lock().unwrap().push(p),
        |_| {},
    ))
    .unwrap();

    // Output: one image, downloaded into the run dir under the request id.
    assert_eq!(raw["seed"], 3);
    assert_eq!(thumbs.len(), 1);
    let path = thumbs[0].path.clone().unwrap();
    assert!(path.ends_with("out/req-1-0.png"), "{path}");
    assert_eq!(std::fs::read(&path).unwrap(), b"PNGDATA");
    assert_eq!(thumbs[0].thumb_type, "image");
    assert!(
        thumbs[0].id.is_none(),
        "fal outputs must not look like PixVerse cloud ids"
    );

    // Protocol: upload, submit, poll until COMPLETED, fetch result, download.
    let log = seen.lock().unwrap();
    let steps: Vec<(&str, &str)> = log
        .requests
        .iter()
        .map(|(m, u, _, _)| (m.as_str(), u.as_str()))
        .collect();
    assert_eq!(
        steps[0],
        ("POST", "/storage/upload/initiate?storage_type=fal-cdn-v3")
    );
    assert_eq!(steps[1], ("PUT", "/upload/abc"));
    assert_eq!(steps[2], ("POST", "/fal-ai/flux/dev/image-to-image"));
    assert_eq!(steps.iter().filter(|s| s.1.ends_with("/status")).count(), 3);
    assert_eq!(
        steps[steps.len() - 2],
        ("GET", "/fal-ai/flux/requests/req-1")
    );
    assert_eq!(steps[steps.len() - 1], ("GET", "/files/out.png"));
    assert!(
        !steps.iter().any(|s| s.1.ends_with("/cancel")),
        "completed requests are not cancelled"
    );
    // Every fal API call is authenticated; the storage PUT uses its signed URL.
    for (m, u, auth, _) in &log.requests {
        let expect = if u == "/upload/abc" || u == "/files/out.png" {
            None
        } else {
            Some("Key test-key")
        };
        assert_eq!(auth.as_deref(), expect, "{m} {u}");
    }
    assert_eq!(log.requests[1].3, "input-bytes");
    let submitted: Value = serde_json::from_str(&log.requests[2].3).unwrap();
    assert_eq!(
        submitted,
        json!({ "prompt": "a lighthouse at dusk", "seed": 3, "image_url": "https://cdn.test/abc.png" })
    );

    // Progress only moves forward and ends at 1.
    let p = progress.lock().unwrap();
    assert!(p.windows(2).all(|w| w[1] >= w[0]), "{p:?}");
    assert_eq!(*p.last().unwrap(), 1.0);
}

#[test]
fn file_extensions_come_from_url_or_content_type() {
    assert_eq!(
        extension_for("https://x/files/out.png?sig=1", None, "image"),
        "png"
    );
    assert_eq!(
        extension_for("https://x/files/abc", Some("video/mp4"), "video"),
        "mp4"
    );
    assert_eq!(
        extension_for("https://x/files/abc", Some("image/jpeg"), "image"),
        "jpg"
    );
    assert_eq!(extension_for("https://x/files/abc", None, "video"), "mp4");
}

#[test]
fn failed_generation_surfaces_fal_error_and_does_not_cancel() {
    let (base, seen) = mock_fal(
        |_| {
            (
                422,
                json!({ "detail": [{ "loc": ["body", "prompt"], "msg": "flagged by safety checker" }] }),
            )
        },
        false,
    );
    let dir = scratch("err");
    let plan = flux_plan_with_local_image(&dir);
    let err = block_on(test_client(&base).run(&plan, &dir, |_| {}, |_| {})).unwrap_err();
    assert_eq!(
        err,
        "fal.ai error (HTTP 422): prompt: flagged by safety checker"
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(!seen
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|r| r.1.ends_with("/cancel")));
}

#[test]
fn dropping_a_running_request_cancels_it_on_fal() {
    let (base, seen) = mock_fal(|_| (200, json!({})), true);
    let dir = scratch("cancel");
    let plan = flux_plan_with_local_image(&dir);
    let client = test_client(&base);
    block_on(async {
        let run = client.run(&plan, &dir, |_| {}, |_| {});
        // Let it submit and poll a few times, then drop it (as Stop does).
        let _ = tokio::time::timeout(Duration::from_millis(300), run).await;
    });
    let mut cancelled = false;
    for _ in 0..50 {
        if seen.lock().unwrap().requests.iter().any(|(m, u, auth, _)| {
            m == "PUT" && u.ends_with("/req-1/cancel") && auth.as_deref() == Some("Key test-key")
        }) {
            cancelled = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(cancelled, "expected PUT …/cancel after the run was dropped");
}

// ─── Mixing providers in one graph ──────────────────────────────────────────

#[test]
fn fal_image_feeds_pixverse_video_and_pixverse_video_feeds_fal() {
    use crate::providers::{inputs, pixverse, Provider};

    // A fal image result, as FalClient::run stores it on the node.
    let fal_image = json!({
        "edge": { "to": { "port": 0 } }, "from": { "kind": "task", "provider": "fal" },
        "result": { "thumbs": [{ "type": "image", "path": "/runs/fal/req-1-0.png", "url": "https://v3.fal.media/files/x.png", "chosen": true }] }
    });
    let prompt = json!({ "edge": { "to": { "port": 1 } }, "from": { "kind": "prompt", "prompt": "slow push-in" } });
    let pv_video = json!({
        "kind": "task", "capability": "video.generate", "provider": "pixverse", "model": "v6",
        "params": { "duration_s": 5 }, "provider_params": { "timeout": 600 },
        "ports": [
            { "kind": "image", "side": "left", "slot": "image" },
            { "kind": "text", "side": "left", "slot": "prompt" },
            { "kind": "video", "side": "right" }
        ]
    });
    let req = pixverse::PixVerseProvider
        .build_request(&pv_video, &[fal_image, prompt.clone()])
        .unwrap();
    let argv = pixverse::args::build_args(&req).unwrap();
    let image_at = argv.iter().position(|a| a == "--image").unwrap();
    assert_eq!(
        argv[image_at + 1],
        "/runs/fal/req-1-0.png",
        "PixVerse gets fal's downloaded file"
    );

    // A PixVerse video (with its cloud id) into a fal image-to-video node:
    // fal takes the local file (to upload), never the PixVerse id.
    let pv_result = json!({
        "edge": { "to": { "port": 0 } }, "from": { "kind": "task", "provider": "pixverse" },
        "result": { "thumbs": [{ "type": "image", "path": "/runs/pixverse/still.png", "id": "pv-123" }] }
    });
    let fal_video = json!({
        "kind": "task", "capability": "video.generate", "provider": "fal", "model": "veo-3.1-fast",
        "params": { "duration_s": 8 }, "provider_params": {},
        "ports": pv_video["ports"].clone()
    });
    let req = inputs::task_request(&fal_video, &[pv_result, prompt]).unwrap();
    let p = plan(&req).unwrap();
    assert_eq!(p.endpoint, "fal-ai/veo3.1/fast/image-to-video");
    assert_eq!(p.images[0].path, "/runs/pixverse/still.png");
    assert!(!p.images[0].cloud_ids.contains_key("fal"));
}

#[test]
fn inspector_preview_shows_endpoint_and_body() {
    let node = json!({
        "kind": "task", "capability": "image.generate", "provider": "fal", "model": "nano-banana",
        "params": { "aspect_ratio": "1:1" }, "provider_params": {},
        "ports": [
            { "kind": "image", "side": "left", "slot": "images", "label": "img 1" },
            { "kind": "image", "side": "left", "slot": "images", "label": "img 2" },
            { "kind": "text", "side": "left", "slot": "prompt", "label": "prompt" },
            { "kind": "image", "side": "right" }
        ]
    });
    let lines = crate::providers::preview_task(&node).unwrap();
    assert_eq!(
        lines[0],
        "POST https://queue.fal.run/fal-ai/nano-banana/edit"
    );
    assert!(
        lines.contains(&r#"prompt: "<prompt>""#.to_string()),
        "{lines:?}"
    );
    assert!(
        lines.contains(&r#"image_urls: ["<img 1>","<img 2>"]"#.to_string()),
        "{lines:?}"
    );
    assert!(
        lines.contains(&r#"aspect_ratio: "1:1""#.to_string()),
        "{lines:?}"
    );
}

#[test]
fn submitted_job_is_reported_and_can_be_resumed_by_a_new_client() {
    let (base, seen) = mock_fal(
        |base| {
            (
                200,
                json!({ "images": [{ "url": format!("{base}/files/out.png") }] }),
            )
        },
        false,
    );
    let dir = scratch("resume");
    let plan = flux_plan_with_local_image(&dir);
    // First "session": submit, record the job, then quit before waiting.
    let job = block_on(test_client(&base).submit(&plan, |_| {})).unwrap();
    assert_eq!(job.request_id, "req-1");
    assert_eq!(job.output, "images");
    let stored = serde_json::to_value(&job).unwrap();
    // Second "session" (fresh client): resume from the stored job only.
    let restored: Job = serde_json::from_value(stored).unwrap();
    let (_, thumbs) =
        block_on(test_client(&base).wait(&restored, &dir.join("out"), |_| {})).unwrap();
    assert_eq!(
        std::fs::read(thumbs[0].path.as_ref().unwrap()).unwrap(),
        b"PNGDATA"
    );
    // Exactly one submission: resuming never re-submits (and never re-bills).
    let submits = seen
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|r| r.0 == "POST" && r.1.starts_with("/fal-ai/"))
        .count();
    assert_eq!(submits, 1);
}

#[test]
fn run_reports_the_job_before_waiting() {
    let (base, _seen) = mock_fal(
        |base| {
            (
                200,
                json!({ "images": [{ "url": format!("{base}/files/out.png") }] }),
            )
        },
        false,
    );
    let dir = scratch("report");
    let plan = flux_plan_with_local_image(&dir);
    let reported = Arc::new(Mutex::new(None));
    let r2 = reported.clone();
    block_on(test_client(&base).run(
        &plan,
        &dir.join("out"),
        |_| {},
        move |job| {
            *r2.lock().unwrap() = Some(job.clone());
        },
    ))
    .unwrap();
    assert_eq!(
        reported.lock().unwrap().as_ref().unwrap().request_id,
        "req-1"
    );
}
