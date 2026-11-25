use crate::model::{Failure, Result};

#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<()> {
    if text.len() > 4 * 1024 * 1024 {
        return Err(Failure::invalid("The text is too large to copy."));
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;

        let board = NSPasteboard::generalPasteboard();
        let text = NSString::from_str(&text);
        // AppKit defines this pasteboard type as an immutable NSString constant.
        let string_type = unsafe { NSPasteboardTypeString };
        board.clearContents();
        if board.setString_forType(&text, string_type) {
            return Ok(());
        }
    }
    Err(Failure::new(
        "CLIPBOARD_UNAVAILABLE",
        "The system clipboard is unavailable.",
    ))
}
