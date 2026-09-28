# Extractable components

## Layout components

No layout component is selected for standalone extraction for this target. `NavTabs` and `NavSidebar` are tightly coupled to React Aria tab ownership, Redux location state, dynamic unread badges, Electron drag regions, and resizable-pane behavior. They should be supplied as source context rather than converted into a simplified reusable canvas component.

## AxoButton

- Source: `ts/axo/AxoButton.dom.tsx`
- Category: basic
- Description: Axo button variants with icons, loading state, and accessibility behavior.
- Extractable props: variant, size, disabled, loading
- Hardcoded: Axo tokens, focus treatment, icon placement

## AxoSymbol

- Source: `ts/axo/AxoSymbol.dom.tsx`
- Category: basic
- Description: Shared icon/symbol renderer used by settings rows.
- Extractable props: symbol, size, label
- Hardcoded: symbol sprite mapping and Axo token styling

Basic components are intentionally not extracted for the shell draft; the design workflow can render them inline from source context.



