#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod model;
mod workspace;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("workspaces.json");
            app.manage(workspace::WorkspaceState::new(path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::add_workspace,
            workspace::rescan_workspace,
            workspace::cancel_scan,
            workspace::add_repository,
            workspace::remove_workspace,
            workspace::remove_repository,
            workspace::get_repository_snapshot,
            workspace::open_history,
            workspace::list_commit_authors,
            workspace::load_history_page,
            workspace::close_history,
            workspace::save_workspace_selection,
            workspace::watch_workspace_worktree,
            workspace::review::get_commit_detail,
            workspace::review::list_worktree_changes,
            workspace::review::get_file_preview,
            workspace::review::cancel_review,
            workspace::review::open_worktree_location,
            workspace::operations::list_operation_remotes,
            workspace::operations::prepare_git_operation,
            workspace::operations::execute_git_operation,
            workspace::operations::cancel_git_operation,
            workspace::operations::get_fetch_activity,
            workspace::releases::get_release_overview,
            workspace::releases::save_release_targets,
            workspace::releases::save_release_task,
            workspace::releases::delete_release_task,
            workspace::releases::list_release_observations,
            workspace::releases::release_candidates,
            workspace::releases::evaluate_release,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run GitDesk");
}
