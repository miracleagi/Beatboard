// Step-by-step progress from ComfyUI's websocket (`/ws?clientId=…`).
//
// ComfyUI sends execution events only to the client id that submitted the
// prompt, so every run uses its own id (see `new_client_id`). The events used:
//
//   execution_start    { prompt_id }
//   execution_cached   { prompt_id, nodes: [id, …] }         nodes reused from cache
//   executing          { prompt_id, node: id | null }       null = prompt finished
//   progress           { prompt_id?, node?, value, max }     sampler steps etc.
//   executed           { prompt_id, node, output }
//   execution_success | execution_error | execution_interrupted { prompt_id }
//   progress_state     { prompt_id, nodes: { id: { state, value, max } } }  (newer servers)
//
// This file is pure: `Tracker` turns messages into a fraction per run and a
// status line. `/history` stays the authority on whether a prompt finished.

use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

/// What to show after a message.
#[derive(Debug, Clone, PartialEq)]
pub struct Update {
    /// 0–1 across all of the job's prompts.
    pub fraction: f64,
    pub status: String,
    /// The prompt at this index finished executing (successfully or not).
    pub finished: Option<usize>,
}

pub struct Tracker {
    prompts: Vec<String>,
    /// Node id → title, for the status line.
    titles: BTreeMap<String, String>,
    /// Nodes each prompt executes (the workflow's node count).
    size: usize,
    done: Vec<HashSet<String>>,
    /// Prompt index and node currently executing, with its step progress.
    current: Option<(usize, String, Option<(u64, u64)>)>,
    finished: Vec<bool>,
    last_fraction: f64,
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

impl Tracker {
    pub fn new(prompts: Vec<String>, titles: BTreeMap<String, String>) -> Self {
        let n = prompts.len();
        Self {
            size: titles.len().max(1),
            prompts,
            titles,
            done: vec![HashSet::new(); n],
            current: None,
            finished: vec![false; n],
            last_fraction: 0.0,
        }
    }

    fn index(&self, data: &Value) -> Option<usize> {
        match data.get("prompt_id").and_then(text) {
            Some(id) => self.prompts.iter().position(|p| *p == id),
            // Older servers send `progress` without a prompt id: it belongs
            // to whatever is executing.
            None => self.current.as_ref().map(|(i, _, _)| *i),
        }
    }

    fn title(&self, node: &str) -> String {
        match self.titles.get(node) {
            Some(t) => format!("#{node} {t}"),
            None => format!("#{node}"),
        }
    }

    fn finish_current(&mut self) {
        if let Some((i, node, _)) = self.current.take() {
            self.done[i].insert(node);
        }
    }

    /// Fraction of one prompt: finished nodes plus the running node's steps.
    fn prompt_fraction(&self, i: usize) -> f64 {
        if self.finished[i] {
            return 1.0;
        }
        let running = match &self.current {
            Some((ci, node, steps)) if *ci == i && !self.done[i].contains(node) => match steps {
                Some((v, m)) if *m > 0 => (*v as f64 / *m as f64).min(1.0),
                _ => 0.0,
            },
            _ => 0.0,
        };
        ((self.done[i].len() as f64 + running) / self.size as f64).min(0.99)
    }

    fn status(&self) -> String {
        let prefix = |i: usize| {
            if self.prompts.len() > 1 {
                format!("{}/{} · ", i + 1, self.prompts.len())
            } else {
                String::new()
            }
        };
        match &self.current {
            Some((i, node, Some((v, m)))) => format!("{}{} {v}/{m}", prefix(*i), self.title(node)),
            Some((i, node, None)) => format!("{}{}", prefix(*i), self.title(node)),
            None => match self.finished.iter().position(|f| !f) {
                Some(i) if self.done[i].is_empty() => {
                    format!("{}waiting in ComfyUI's queue", prefix(i))
                }
                Some(i) => format!("{}running", prefix(i)),
                None => "saving results".into(),
            },
        }
    }

    /// Feed one websocket text message. Returns what to show, if it changed
    /// anything for our prompts.
    pub fn on_message(&mut self, message: &str) -> Option<Update> {
        let msg: Value = serde_json::from_str(message).ok()?;
        let data = &msg["data"];
        let mut finished = None;
        match msg["type"].as_str()? {
            "execution_start" => {
                self.index(data)?;
            }
            "execution_cached" => {
                let i = self.index(data)?;
                for node in data["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(text)
                {
                    self.done[i].insert(node);
                }
            }
            "executing" => {
                let i = self.index(data)?;
                self.finish_current();
                match data.get("node").and_then(text) {
                    Some(node) => self.current = Some((i, node, None)),
                    None => {
                        self.finished[i] = true;
                        finished = Some(i);
                    }
                }
            }
            "progress" => {
                let i = self.index(data)?;
                let node = data
                    .get("node")
                    .and_then(text)
                    .or_else(|| self.current.as_ref().map(|(_, n, _)| n.clone()))?;
                let steps = Some((data["value"].as_u64()?, data["max"].as_u64()?));
                self.current = Some((i, node, steps));
            }
            "progress_state" => {
                let i = self.index(data)?;
                for (node, state) in data["nodes"].as_object()? {
                    match state["state"].as_str() {
                        Some("finished") => {
                            self.done[i].insert(node.clone());
                        }
                        Some("running") => {
                            let steps = state["value"]
                                .as_u64()
                                .zip(state["max"].as_u64())
                                .filter(|(_, m)| *m > 1);
                            self.current = Some((i, node.clone(), steps));
                        }
                        _ => {}
                    }
                }
            }
            "executed" => {
                let i = self.index(data)?;
                if let Some(node) = data.get("node").and_then(text) {
                    self.done[i].insert(node);
                }
            }
            "execution_success" | "execution_error" | "execution_interrupted" => {
                let i = self.index(data)?;
                self.current = None;
                self.finished[i] = true;
                finished = Some(i);
            }
            _ => return None,
        }
        let n = self.prompts.len().max(1) as f64;
        let total: f64 = (0..self.prompts.len())
            .map(|i| self.prompt_fraction(i))
            .sum();
        // Never move backwards (e.g. a node re-reporting from 0).
        self.last_fraction = self.last_fraction.max(total / n);
        Some(Update {
            fraction: self.last_fraction,
            status: self.status(),
            finished,
        })
    }
}

/// A client id of our own for one run, so ComfyUI routes its events to us.
pub fn new_client_id() -> String {
    format!("beatboard-{:013x}", super::random_seed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn titles() -> BTreeMap<String, String> {
        [
            ("3", "KSampler"),
            ("4", "Load Checkpoint"),
            ("6", "Positive"),
            ("8", "VAEDecode"),
            ("9", "SaveImage"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
    }

    fn msg(kind: &str, data: Value) -> String {
        json!({ "type": kind, "data": data }).to_string()
    }

    #[test]
    fn sampler_steps_move_the_fraction_and_status() {
        let mut t = Tracker::new(vec!["p1".into()], titles());
        let u = t
            .on_message(&msg("execution_start", json!({ "prompt_id": "p1" })))
            .unwrap();
        assert_eq!(u.fraction, 0.0);
        assert_eq!(u.status, "waiting in ComfyUI's queue");
        // Loader and text encoder reused from the cache: 2 of 5 nodes done.
        let u = t
            .on_message(&msg(
                "execution_cached",
                json!({ "prompt_id": "p1", "nodes": ["4", "6"] }),
            ))
            .unwrap();
        assert!((u.fraction - 0.4).abs() < 1e-9, "{u:?}");
        let u = t
            .on_message(&msg("executing", json!({ "prompt_id": "p1", "node": "3" })))
            .unwrap();
        assert_eq!(u.status, "#3 KSampler");
        let u = t
            .on_message(&msg(
                "progress",
                json!({ "prompt_id": "p1", "node": "3", "value": 10, "max": 20 }),
            ))
            .unwrap();
        assert_eq!(u.status, "#3 KSampler 10/20");
        assert!((u.fraction - 0.5).abs() < 1e-9, "(2 + 0.5) / 5: {u:?}");
        // Older servers: no prompt id or node on progress.
        let u = t
            .on_message(&msg("progress", json!({ "value": 20, "max": 20 })))
            .unwrap();
        assert_eq!(u.status, "#3 KSampler 20/20");
        let u = t
            .on_message(&msg("executing", json!({ "prompt_id": "p1", "node": "8" })))
            .unwrap();
        assert!((u.fraction - 0.6).abs() < 1e-9, "{u:?}");
        assert_eq!(u.status, "#8 VAEDecode");
        let u = t
            .on_message(&msg(
                "executing",
                json!({ "prompt_id": "p1", "node": null }),
            ))
            .unwrap();
        assert_eq!(u.finished, Some(0));
        assert_eq!(u.fraction, 1.0);
    }

    #[test]
    fn several_prompts_share_the_bar_and_others_are_ignored() {
        let mut t = Tracker::new(vec!["a".into(), "b".into()], titles());
        assert!(t
            .on_message(&msg(
                "executing",
                json!({ "prompt_id": "someone-else", "node": "3" })
            ))
            .is_none());
        assert!(t.on_message("not json").is_none());
        assert!(t
            .on_message(&msg("status", json!({ "status": {} })))
            .is_none());
        t.on_message(&msg("execution_success", json!({ "prompt_id": "a" })));
        let u = t
            .on_message(&msg(
                "progress",
                json!({ "prompt_id": "b", "node": "3", "value": 5, "max": 10 }),
            ))
            .unwrap();
        assert_eq!(u.status, "2/2 · #3 KSampler 5/10");
        assert!((u.fraction - (1.0 + 0.1) / 2.0).abs() < 1e-9, "{u:?}");
        // A node restarting from 0 does not move the bar back.
        let back = t
            .on_message(&msg(
                "progress",
                json!({ "prompt_id": "b", "node": "3", "value": 0, "max": 10 }),
            ))
            .unwrap();
        assert_eq!(back.fraction, u.fraction);
    }

    #[test]
    fn newer_progress_state_messages_are_understood() {
        let mut t = Tracker::new(vec!["p".into()], titles());
        let u = t
            .on_message(&msg(
                "progress_state",
                json!({ "prompt_id": "p", "nodes": {
                    "4": { "state": "finished", "value": 1, "max": 1 },
                    "3": { "state": "running", "value": 3, "max": 4 } } }),
            ))
            .unwrap();
        assert_eq!(u.status, "#3 KSampler 3/4");
        assert!((u.fraction - (1.0 + 0.75) / 5.0).abs() < 1e-9, "{u:?}");
    }

    #[test]
    fn client_ids_are_unique() {
        assert_ne!(new_client_id(), new_client_id());
        assert!(new_client_id().starts_with("beatboard-"));
    }
}
