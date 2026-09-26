// Per-run cancellation.
//
// `run_node` registers every run under its run id; `cancel_run` flips the
// run's flag. The router races the node future against the flag and drops it
// on cancel — child processes are spawned with `kill_on_drop`, so dropping the
// future kills the PixVerse CLI / ffmpeg subprocess and aborts downloads.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::task::Poll;
use tokio::sync::watch;

#[derive(Default)]
struct Registry {
    live: HashMap<String, watch::Sender<bool>>,
    // Cancels that arrived before their run registered (the invoke for the
    // run and the cancel can race over IPC). Bounded so late cancels for
    // already-finished runs cannot grow it without limit.
    early: HashSet<String>,
}

const MAX_EARLY_CANCELS: usize = 256;

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

#[derive(Clone)]
pub struct CancelToken(watch::Receiver<bool>);

impl CancelToken {
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    /// Resolves once the run is cancelled. Never resolves otherwise.
    pub async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        while self.0.changed().await.is_ok() {
            if self.is_cancelled() {
                return;
            }
        }
        // Sender dropped without cancelling: the run finished normally.
        std::future::pending::<()>().await
    }
}

/// Drive `fut` to completion unless the run is cancelled first, in which case
/// `fut` is dropped and `None` is returned.
pub async fn until_cancelled<F: Future>(fut: F, mut token: CancelToken) -> Option<F::Output> {
    let mut fut = std::pin::pin!(fut);
    let mut cancelled = std::pin::pin!(token.cancelled());
    std::future::poll_fn(|cx| {
        if let Poll::Ready(out) = fut.as_mut().poll(cx) {
            return Poll::Ready(Some(out));
        }
        if cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

/// Unregisters the run when dropped.
pub struct RunGuard {
    run_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut reg) = registry().lock() {
            reg.live.remove(&self.run_id);
        }
    }
}

pub fn register(run_id: &str) -> (CancelToken, RunGuard) {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let already_cancelled = reg.early.remove(run_id);
    let (tx, rx) = watch::channel(already_cancelled);
    reg.live.insert(run_id.to_string(), tx);
    (
        CancelToken(rx),
        RunGuard {
            run_id: run_id.to_string(),
        },
    )
}

/// Returns true when a live run was signalled.
pub fn cancel(run_id: &str) -> bool {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = reg.live.get(run_id) {
        let _ = tx.send(true);
        return true;
    }
    if reg.early.len() >= MAX_EARLY_CANCELS {
        reg.early.clear();
    }
    reg.early.insert(run_id.to_string());
    false
}

#[cfg(test)]
mod tests {
    use super::{cancel, register, until_cancelled};

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }

    #[test]
    fn cancel_drops_the_running_future() {
        let (token, _guard) = register("t-live");
        assert!(!token.is_cancelled());
        let canceller = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            assert!(cancel("t-live"));
        });
        let out = block_on(until_cancelled(std::future::pending::<()>(), token.clone()));
        canceller.join().unwrap();
        assert!(out.is_none());
        assert!(token.is_cancelled());
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_the_child_process() {
        use crate::runtime::RuntimeCommand;

        let (token, _guard) = register("t-kill");
        let (pid_tx, pid_rx) = std::sync::mpsc::channel();
        let canceller = std::thread::spawn(move || {
            let pid: u32 = pid_rx.recv().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(50));
            assert!(cancel("t-kill"));
            pid
        });
        let out = block_on(until_cancelled(
            async move {
                let child = RuntimeCommand::new("sleep", "test")
                    .command(["30"])
                    .spawn()
                    .unwrap();
                pid_tx.send(child.id().unwrap()).unwrap();
                child.wait_with_output().await
            },
            token,
        ));
        assert!(out.is_none());
        let pid = canceller.join().unwrap();
        // Gone, or a zombie awaiting reaping — either way no longer running.
        std::thread::sleep(std::time::Duration::from_millis(100));
        let ps = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&ps.stdout);
        assert!(
            stat.trim().is_empty() || stat.starts_with('Z'),
            "sleep still running: {stat}"
        );
    }

    #[test]
    fn completed_future_wins_when_not_cancelled() {
        let (token, _guard) = register("t-done");
        assert_eq!(block_on(until_cancelled(async { 7 }, token)), Some(7));
    }

    #[test]
    fn cancel_before_register_is_honoured() {
        assert!(!cancel("t-early"));
        let (token, _guard) = register("t-early");
        assert!(token.is_cancelled());
    }

    #[test]
    fn guard_unregisters_run() {
        {
            let (_token, _guard) = register("t-drop");
        }
        // No live run any more: recorded as an early cancel instead.
        assert!(!cancel("t-drop"));
        let (token, _guard) = register("t-drop");
        assert!(token.is_cancelled());
    }
}
