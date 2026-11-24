import { PanelLeftOpen } from 'lucide-react';

interface Props {
  native: boolean;
  sidebarCollapsed: boolean;
  onOpenSidebar: () => void;
  onSearch: () => void;
}

export function TitleBar({ native, sidebarCollapsed, onOpenSidebar, onSearch }: Props) {
  return (
    <header className={`title-bar${native ? ' native-title-bar' : ''}`} data-tauri-drag-region>
      <div className="title-leading" data-tauri-drag-region>
        {!native && (
          <div className="browser-traffic-lights" aria-hidden="true">
            <span /><span /><span />
          </div>
        )}
        {sidebarCollapsed && (
          <button className="icon-button" aria-label="Expand sidebar" title="Expand sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen size={15} />
          </button>
        )}
      </div>
      <span className="window-title" data-tauri-drag-region>GitDesk</span>
      <button className="title-shortcut" aria-label="Find repository (⌘K)" title="Find repository (⌘K)" onClick={onSearch}>
        ⌘ K
      </button>
    </header>
  );
}
