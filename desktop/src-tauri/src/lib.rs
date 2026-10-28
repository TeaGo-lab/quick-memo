use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryConfig {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub desc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub enabled: bool,
    pub provider_preset: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub custom_system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub vault_path: String,
    pub shortcut: String,
    pub llm: LlmConfig,
    pub categories: Vec<CategoryConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAttachmentInput {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    pub name: String,
    pub rel_path: String,
    pub abs_path: String,
    pub mime_type: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoRecord {
    pub id: String,
    pub title: String,
    pub category: String,
    #[serde(rename = "type")]
    pub memo_type: String,
    pub content: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub ai_classified: bool,
    pub attachments: Vec<SavedAttachment>,
    pub md_rel_path: String,
    pub md_abs_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMemoPayload {
    pub content: String,
    #[serde(default)]
    pub raw_attachments: Vec<RawAttachmentInput>,
    pub category: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub ai_classified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoPatch {
    pub title: Option<String>,
    pub category: Option<String>,
    pub content: Option<String>,
    pub summary: Option<String>,
    pub tags: Option<Vec<String>>,
    pub ai_classified: Option<bool>,
}

fn default_categories() -> Vec<CategoryConfig> {
    vec![
        CategoryConfig {
            id: "01-灵感与备忘".into(),
            name: "灵感与备忘".into(),
            icon: Some("💡".into()),
            desc: Some("随手记下的想法、灵感、日常备忘、语录摘抄".into()),
        },
        CategoryConfig {
            id: "02-技术与代码".into(),
            name: "技术与代码".into(),
            icon: Some("💻".into()),
            desc: Some("代码片段、命令行、报错信息、架构方案、AI Prompt".into()),
        },
        CategoryConfig {
            id: "03-精读与链接".into(),
            name: "精读与链接".into(),
            icon: Some("🔗".into()),
            desc: Some("网址链接、GitHub 仓库、文章收藏、工具网站".into()),
        },
        CategoryConfig {
            id: "04-工作与待办".into(),
            name: "工作与待办".into(),
            icon: Some("📌".into()),
            desc: Some("待办事项、项目推进、会议纪要、重要通知或参数".into()),
        },
        CategoryConfig {
            id: "05-截图与视觉".into(),
            name: "截图与视觉".into(),
            icon: Some("🖼️".into()),
            desc: Some("屏幕截图、参考图、海报、图表、照片".into()),
        },
        CategoryConfig {
            id: "06-资料与文档".into(),
            name: "资料与文档".into(),
            icon: Some("📂".into()),
            desc: Some("PDF、Word、Excel、压缩包等本地文件归档".into()),
        },
        CategoryConfig {
            id: "99-收件箱".into(),
            name: "收件箱".into(),
            icon: Some("📥".into()),
            desc: Some("暂未分类或其它杂项内容".into()),
        },
    ]
}

fn config_file_path() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    cwd.join(".quick-memo-config.json")
}

fn default_config() -> AppConfig {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    AppConfig {
        vault_path: cwd.join("vault").to_string_lossy().to_string(),
        shortcut: "Alt+Space".into(),
        llm: LlmConfig {
            enabled: true,
            provider_preset: "deepseek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: "".into(),
            model: "deepseek-chat".into(),
            custom_system_prompt: "".into(),
        },
        categories: default_categories(),
    }
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn build_markdown_content(memo: &MemoRecord) -> String {
    let tags_yaml = if memo.tags.is_empty() {
        "tags: []".to_string()
    } else {
        let items: Vec<String> = memo
            .tags
            .iter()
            .map(|t| format!("  - \"{}\"", t.replace('"', "\\\"")))
            .collect();
        format!("tags:\n{}", items.join("\n"))
    };

    format!(
        "---\nid: \"{}\"\ntitle: \"{}\"\ncategory: \"{}\"\ntype: \"{}\"\ncreated_at: \"{}\"\nai_classified: {}\nsummary: \"{}\"\n{}\n---\n\n# {}\n\n> **分类**：`{}` · **时间**：{}\n> **摘要**：{}\n\n---\n\n{}\n",
        memo.id,
        memo.title.replace('"', "\\\""),
        memo.category.replace('"', "\\\""),
        memo.memo_type,
        memo.created_at,
        memo.ai_classified,
        memo.summary.replace('"', "\\\"").replace('\n', " "),
        tags_yaml,
        memo.title,
        memo.category,
        memo.created_at,
        memo.summary,
        memo.content
    )
}

fn read_index(vault_path: &Path) -> Vec<MemoRecord> {
    let idx_path = vault_path.join(".quick-memo-index.json");
    if let Ok(raw) = fs::read_to_string(idx_path) {
        if let Ok(items) = serde_json::from_str::<Vec<MemoRecord>>(&raw) {
            return items;
        }
    }
    vec![]
}

fn write_index(vault_path: &Path, items: &[MemoRecord]) {
    let idx_path = vault_path.join(".quick-memo-index.json");
    if let Ok(json) = serde_json::to_string_pretty(items) {
        let _ = fs::write(idx_path, json);
    }
}

#[tauri::command]
fn get_config() -> AppConfig {
    let path = config_file_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
            return cfg;
        }
    }
    let cfg = default_config();
    let _ = save_config(cfg.clone());
    cfg
}

#[tauri::command]
fn save_config(new_config: AppConfig) -> AppConfig {
    let path = config_file_path();
    if let Ok(raw) = serde_json::to_string_pretty(&new_config) {
        let _ = fs::write(path, raw);
    }
    let vault = PathBuf::from(&new_config.vault_path);
    let _ = fs::create_dir_all(&vault);
    for cat in &new_config.categories {
        let _ = fs::create_dir_all(vault.join(sanitize_filename(&cat.id)));
    }
    new_config
}

#[tauri::command]
fn list_memos() -> Vec<MemoRecord> {
    let cfg = get_config();
    let vault = PathBuf::from(&cfg.vault_path);
    read_index(&vault)
}

#[tauri::command]
fn save_memo(payload: SaveMemoPayload) -> Result<MemoRecord, String> {
    let cfg = get_config();
    let vault = PathBuf::from(&cfg.vault_path);
    let now = Local::now();
    let date_str = now.format("%Y-%m-%d").to_string();
    let compact_time = now.format("%H%M%S").to_string();
    let compact_full = now.format("%Y%m%d_%H%M%S").to_string();
    let full_str = now.format("%Y-%m-%d %H:%M:%S").to_string();

    let id = format!("memo_{}", now.timestamp_millis());
    let category = sanitize_filename(&payload.category);
    let safe_title = sanitize_filename(&payload.title);
    let cat_dir = vault.join(&category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let mut saved_attachments = vec![];
    if !payload.raw_attachments.is_empty() {
        let assets_dir = cat_dir.join("assets");
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
        for att in payload.raw_attachments {
            let clean_b64 = att
                .data_base64
                .split(',')
                .next_back()
                .unwrap_or(&att.data_base64);
            let bytes = BASE64.decode(clean_b64).map_err(|e| e.to_string())?;
            let file_name = format!("{}_{}", compact_full, sanitize_filename(&att.name));
            let abs_path = assets_dir.join(&file_name);
            fs::write(&abs_path, &bytes).map_err(|e| e.to_string())?;
            saved_attachments.push(SavedAttachment {
                name: att.name,
                rel_path: format!("./assets/{}", file_name),
                abs_path: abs_path.to_string_lossy().to_string(),
                mime_type: att.mime_type,
                size: bytes.len(),
            });
        }
    }

    let md_file_name = format!("{}_{}_{}.md", date_str, compact_time, safe_title);
    let md_abs_path = cat_dir.join(&md_file_name);

    let memo = MemoRecord {
        id: id.clone(),
        title: payload.title,
        category: category.clone(),
        memo_type: "text".into(),
        content: payload.content,
        summary: payload.summary,
        tags: payload.tags,
        created_at: full_str,
        ai_classified: payload.ai_classified,
        attachments: saved_attachments,
        md_rel_path: format!("{}/{}", category, md_file_name),
        md_abs_path: md_abs_path.to_string_lossy().to_string(),
    };

    let md_text = build_markdown_content(&memo);
    fs::write(&md_abs_path, md_text).map_err(|e| e.to_string())?;

    let mut index = read_index(&vault);
    index.insert(0, memo.clone());
    write_index(&vault, &index);

    Ok(memo)
}

#[tauri::command]
fn update_memo(id: String, patch: UpdateMemoPatch) -> Result<MemoRecord, String> {
    let cfg = get_config();
    let vault = PathBuf::from(&cfg.vault_path);
    let mut index = read_index(&vault);
    let pos = index
        .iter()
        .position(|x| x.id == id)
        .ok_or_else(|| "找不到该记录".to_string())?;

    let mut item = index[pos].clone();
    let _ = fs::remove_file(&item.md_abs_path);

    if let Some(t) = patch.title {
        item.title = t;
    }
    if let Some(c) = patch.category {
        item.category = sanitize_filename(&c);
    }
    if let Some(cnt) = patch.content {
        item.content = cnt;
    }
    if let Some(s) = patch.summary {
        item.summary = s;
    }
    if let Some(tags) = patch.tags {
        item.tags = tags;
    }
    if let Some(ai) = patch.ai_classified {
        item.ai_classified = ai;
    }

    let cat_dir = vault.join(&item.category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;
    let safe_title = sanitize_filename(&item.title);
    let md_file_name = format!("{}.md", safe_title);
    let md_abs_path = cat_dir.join(&md_file_name);
    item.md_rel_path = format!("{}/{}", item.category, md_file_name);
    item.md_abs_path = md_abs_path.to_string_lossy().to_string();

    let md_text = build_markdown_content(&item);
    fs::write(&md_abs_path, md_text).map_err(|e| e.to_string())?;

    index[pos] = item.clone();
    write_index(&vault, &index);
    Ok(item)
}

#[tauri::command]
fn delete_memo(id: String) -> serde_json::Value {
    let cfg = get_config();
    let vault = PathBuf::from(&cfg.vault_path);
    let mut index = read_index(&vault);
    if let Some(pos) = index.iter().position(|x| x.id == id) {
        let removed = index.remove(pos);
        let _ = fs::remove_file(&removed.md_abs_path);
        write_index(&vault, &index);
    }
    serde_json::json!({ "deleted": true, "id": id })
}

#[tauri::command]
fn open_in_explorer(target_path: String) {
    let cfg = get_config();
    let target = if target_path.trim().is_empty() {
        cfg.vault_path
    } else {
        target_path
    };
    let p = PathBuf::from(&target);
    if p.is_file() {
        let _ = Command::new("explorer.exe")
            .arg(format!("/select,{}", target))
            .spawn();
    } else {
        let _ = Command::new("explorer.exe").arg(target).spawn();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(true);
                            if is_visible && window.is_focused().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app.global_shortcut().register("Alt+Space");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_memos,
            save_memo,
            update_memo,
            delete_memo,
            open_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
