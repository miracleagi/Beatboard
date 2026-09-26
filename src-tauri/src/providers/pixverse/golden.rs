// Golden test: legacy PixVerse nodes and their migrated task nodes must resolve
// to the same CLI argv, and neither may pass on a candidate a Pick rejected.
// Fixtures come from scripts/gen-pixverse-fixtures.mjs, which runs the
// frontend migration (src/task-model.jsx) over every PixVerse node Beatboard
// can create.

use super::{args, legacy, PixVerseProvider, RESOLVED_ARGS};
use crate::providers::{catalog, Provider};
use serde_json::Value;

const FIXTURES: &str = include_str!("../../../tests/fixtures/pixverse_task_migration.json");

/// Order-insensitive view of an argv: the subcommand, then each flag with its
/// values, sorted. The PixVerse CLI does not care about flag order.
fn normalized(argv: &[String]) -> (Vec<String>, Vec<Vec<String>>) {
    let head = argv.iter().take(2).cloned().collect();
    let mut groups: Vec<Vec<String>> = Vec::new();
    for arg in argv.iter().skip(2) {
        if arg.starts_with("--") || groups.is_empty() {
            groups.push(vec![arg.clone()]);
        } else {
            groups.last_mut().unwrap().push(arg.clone());
        }
    }
    groups.sort();
    (head, groups)
}

fn task_argv(task: &Value, deps: &[Value]) -> Result<Vec<String>, String> {
    let req = PixVerseProvider
        .build_request(task, deps)
        .map_err(|e| e.to_string())?;
    // Every migrated or spawned node must also pass manifest validation.
    catalog::validate("pixverse", &req).map_err(|e| e.to_string())?;
    match req.provider_params.get(RESOLVED_ARGS) {
        Some(resolved) => Ok(serde_json::from_value(resolved.clone()).unwrap()),
        None => args::build_args(&req).map_err(|e| e.to_string()),
    }
}

#[test]
fn migrated_task_nodes_reproduce_legacy_argv() {
    let fixtures: Value = serde_json::from_str(FIXTURES).expect("fixture JSON");
    let cases = fixtures["cases"].as_array().expect("cases");
    assert!(cases.len() > 100, "fixture looks truncated");

    let mut failures = Vec::new();
    let mut compared = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let deps = case["deps"].as_array().cloned().unwrap_or_default();
        let legacy_argv = match legacy::resolve_pixverse_args(&case["legacy"], &deps) {
            Ok(argv) => argv,
            // Legacy gen/motion nodes rejected a missing prompt up front;
            // task nodes leave that to the CLI. Nothing to compare.
            Err(_) if case["legacy_may_fail"] == true => continue,
            Err(e) => {
                failures.push(format!("{name}: legacy resolver failed: {e}"));
                continue;
            }
        };
        let task_argv = match task_argv(&case["task"], &deps) {
            Ok(argv) => argv,
            Err(e) => {
                failures.push(format!("{name}: task resolver failed: {e}"));
                continue;
            }
        };
        compared += 1;
        for forbidden in case["forbidden"].as_array().into_iter().flatten() {
            let forbidden = forbidden.as_str().unwrap_or_default();
            for (which, argv) in [("legacy", &legacy_argv), ("task", &task_argv)] {
                if argv.iter().any(|a| a == forbidden) {
                    failures.push(format!(
                        "{name}: {which} argv passes on rejected Pick candidate {forbidden}"
                    ));
                }
            }
        }
        let same = if case["exact"] == true {
            legacy_argv == task_argv
        } else {
            normalized(&legacy_argv) == normalized(&task_argv)
        };
        if !same {
            failures.push(format!(
                "{name}:\n  legacy: {legacy_argv:?}\n  task:   {task_argv:?}"
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    assert!(compared > 100, "too few cases compared: {compared}");
}
