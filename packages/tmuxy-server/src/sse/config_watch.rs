use std::sync::Arc;
use tmuxy_core::host;

use crate::state::AppState;

pub async fn watch_config_dir(state: Arc<AppState>) {
    let shutdown = state.shutdown.clone();
    let watcher = state.clone();
    state
        .spawn(async move {
            tokio::select! {
                _ = host::watch_config(|change| {
                    let state = watcher.clone();
                    tokio::spawn(async move {
                        let runtimes: Vec<_> = state
                            .sessions
                            .read()
                            .await
                            .values()
                            .map(|conns| Arc::clone(&conns.runtime))
                            .collect();
                        for runtime in runtimes {
                            runtime.config_changed(change).await;
                        }
                    });
                }) => {}
                _ = shutdown.cancelled() => {}
            }
        })
        .await;
}
