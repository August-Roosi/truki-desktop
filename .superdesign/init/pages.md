# Key page dependency trees

## Inbox shell

Entry: `ts/components/App.dom.tsx`

Dependencies:
- `ts/state/smart/App.preload.tsx`
  - `ts/state/smart/Inbox.preload.tsx`
    - `ts/components/Inbox.dom.tsx`
    - `ts/state/smart/NavTabs.preload.tsx`
      - `ts/components/NavTabs.dom.tsx`
        - `ts/components/Tooltip.dom.tsx`
        - `ts/types/Nav.std.ts`
    - `ts/state/smart/ChatsTab.preload.tsx`
      - `ts/state/smart/LeftPane.preload.tsx`
        - `ts/components/LeftPane.dom.tsx`
          - `ts/components/NavSidebar.dom.tsx`
      - `ts/state/smart/ConversationView.preload.tsx`
    - `ts/state/smart/CallsTab.preload.tsx`
      - `ts/components/NavSidebar.dom.tsx`
    - `ts/state/smart/StoriesTab.preload.tsx`
      - `ts/components/NavSidebar.dom.tsx`
- `stylesheets/components/Inbox.scss`
- `stylesheets/components/NavTabs.scss`
- `stylesheets/components/NavSidebar.scss`

## Settings

Entry: `ts/state/smart/Preferences.preload.tsx`

Dependencies:
- `ts/components/Preferences.dom.tsx`
  - `ts/components/NavSidebar.dom.tsx`
  - `ts/axo/AxoButton.dom.tsx`
  - `ts/axo/AxoSymbol.dom.tsx`
  - `ts/axo/items/AxoItem.dom.tsx`
  - `ts/axo/items/AxoList.dom.tsx`
  - `ts/components/PreferencesUtil.dom.tsx`
  - settings page components selected by `SettingsPage`
- `ts/types/Nav.std.ts`
- `ts/state/ducks/nav.std.ts`
- `stylesheets/components/Preferences.scss`
- `stylesheets/components/NavSidebar.scss`

The target redesign affects the shell relationship between `NavTabs`, `NavSidebar`, and `Preferences`; detailed chat and settings forms should retain their current visual structure.



