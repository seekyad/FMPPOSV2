# FMP POS Design System

Extracted from the live codebase (Sept 2026). Source of truth:
- Tokens: `packages/ui/src/tokens.css` (CSS variables) and `apps/*/src/tailwind.css` (`@theme` block exposing them to Tailwind v4 as `text-ink`, `bg-navy`, `border-line`, …)
- Shared components: `packages/ui` (`@fmp/ui`) and `packages/pos-client` (`@fmp/pos-client`)

## Foundations

### Typography
- Font: **Inter** (Google Fonts, weights 400/500/600/700/800), fallback `system-ui, -apple-system, sans-serif`
- Body size 15px; table headers `600 11.5px` uppercase with `0.06em` letter-spacing; chips `600 13px`; buttons `600 15px` (md) / `600 17px` (lg); keypad keys `600 27px`
- Icons: **Bootstrap Icons** (`bootstrap-icons.css`, used as `<i className="bi bi-…">`)

### Colors (CSS variables on `:root`)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#17191c` | Primary text |
| `--ink-2` | `#40464d` | Secondary text |
| `--ink-3` | `#5b636c` | Tertiary text / footers |
| `--ink-4` | `#7d8590` | Muted text, placeholders, inactive headers |
| `--navy` | `#111827` | Dark buttons, active filter chips, sidebar accents |
| `--orange` | `#f97316` | Brand / primary action |
| `--orange-soft` | `#fdede1` | Selected row highlight, orange chip bg |
| `--page` | `#f0eee9` | App background (warm off-white) |
| `--card` | `#ffffff` | Surfaces (cards, tables, modals, inputs) |
| `--line` | `#e3e6ea` | Borders on inputs/buttons/keys |
| `--line-soft` | `#eef0f3` | Table row dividers, card borders, neutral chip bg |

Status pairs (bg + fg, plus `--green-line`/`--red-line` borders):

| Tone | bg | fg |
|---|---|---|
| green | `#e7f6ee` | `#15803d` |
| red | `#fdebe9` | `#b42318` |
| blue | `#e8effc` | `#1d4ed8` |
| purple | `#f0e9fc` | `#6d28d9` |
| amber | `#fdf3e1` | `#b45309` |

### Layout & shape
- `--sidebar-w: 92px` (icon rail)
- Radii: `--radius: 12px`, `--radius-lg: 16px`; in practice buttons 11px, inputs/search 12px, keypad keys/tables 14px, modals 20px, chips/filter pills `999px`
- Shadows: `--shadow: 0 12px 32px rgba(23,25,28,.18)` (modals), `--shadow-card: 0 1px 2px rgba(23,25,28,.06)`
- Modal overlay: `rgba(17,24,39,0.45)`, z-index 100
- App-like behavior: `overscroll-behavior: none`, `user-select: none` globally (re-enabled on inputs/textareas)
- Custom horizontal scrollbar utility: `.fmp-hscroll` (7px thin rounded thumb)

### Sizing conventions (touch-first, iPad)
- Buttons: min-height 44px (md) / 52px (lg); padding `12px 20px` / `16px 26px`
- Keypad keys: 78px tall (`size="md"`); the register ring-up pad uses `size="lg"` at 96px tall, 34px digits
- Table cells: `14px 16px` padding, sticky header and footer
- Search inputs: `12px 14px` padding with 40px left inset for the icon

## Components

### `@fmp/ui` — primitives (packages/ui)
| Component | Notes |
|---|---|
| `Button` | Variants `primary` (orange), `secondary` (white/line — default), `dark` (navy), `danger` (red-bg/red), `ghost`; sizes `md`/`lg` |
| `StatusChip` | Pill; tones `green` `red` `blue` `purple` `amber` `orange` `neutral` |
| `Modal` | Centered card, click-outside closes, 640px default width, radius 20, `--shadow` |
| `DataTable` | The standard FMP table: sortable columns, built-in search + filter chips, sticky header/footer, selected-row highlight (`--orange-soft`), `searchInputRef` for barcode scanners |
| `Keypad` | 4-col register keypad (7-8-9-⌫ / 4-5-6-⌫ / 1-2-3-00 / wide 0-C); ⌫ spans two rows |

### `@fmp/pos-client` — shared POS building blocks (packages/pos-client)
Screens: `PinScreen`, `CustomersScreen`, `InventoryScreen` (+ internal `AddItemModal`, `AdjustModal`)
Modals: `PaymentModal`, `CustomerModal`, `CustomItemModal`, `InventoryPickerModal`
Widgets: `RingUpPad`, `SidePanel`, `TicketLabelPreview`
Hooks/utilities: `useNarrow`, `api`/`session`, cart helpers, label printing (`printTicketLabel`, `printDeviceLabel`, `printInventoryLabel`, Code 128)

### App-level components
**repair-pos** (`apps/repair-pos`): `App`, `Sidebar`, `RegisterScreen` (+ `SearchBar`), `RepairsScreen`, `NewRepairWindow`, `DepositModal`, `PayoutModal`, `TradeInModal`, `PendingSalesScreen`, `ReportsScreen`, `CatalogPage` (+ `ImportModal`, `ServiceEditorModal`, `BulkPriceModal`), settings: `SettingsHub`, `StaffTab`, `TimeClockTab`, `PricebookTab`, `PrintCenterTab` (+ `BarcodePreview`, `FieldToggle`), `StoreSections` (`StoreProfileSection`, `TaxesSection`, `ReceiptsPrintingSection`, `PaymentsSection`, `SaveRow`)

**retail-pos** (`apps/retail-pos`): `App`, `Sidebar`, `SalesScreen`, `ActivationsScreen`, `BillPaymentsScreen`

## Usage snapshot
`Button` is imported in 24 files, `Modal` in 21, `DataTable` in 10, `StatusChip` in 9, `Keypad` in 3. Styling is inline-style-first using the CSS variables; Tailwind v4 is wired up (`@theme` maps every token) but most components use `style={}` directly.

---

# The code

Everything below is the literal code currently shipped, copy-paste ready.

## Global tokens & resets — `packages/ui/src/tokens.css`

```css
/* FMP POS design tokens — extracted from the iPad POS UI Kit */
:root {
  /* color */
  --ink: #17191c;
  --ink-2: #40464d;
  --ink-3: #5b636c;
  --ink-4: #7d8590;
  --navy: #111827;
  --orange: #f97316;
  --orange-soft: #fdede1;
  --page: #f0eee9;
  --card: #ffffff;
  --line: #e3e6ea;
  --line-soft: #eef0f3;

  /* status */
  --green-bg: #e7f6ee;
  --green-line: #bce5ce;
  --green: #15803d;
  --red-bg: #fdebe9;
  --red-line: #f7c7c1;
  --red: #b42318;
  --blue-bg: #e8effc;
  --blue: #1d4ed8;
  --purple-bg: #f0e9fc;
  --purple: #6d28d9;
  --amber-bg: #fdf3e1;
  --amber: #b45309;

  /* layout */
  --sidebar-w: 92px;
  --radius: 12px;
  --radius-lg: 16px;
  --shadow: 0 12px 32px rgba(23, 25, 28, 0.18);
  --shadow-card: 0 1px 2px rgba(23, 25, 28, 0.06);

  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  color: var(--ink);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--page);
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  /* POS screens are app-like: prevent overscroll bounce and accidental text selection */
  overscroll-behavior: none;
  user-select: none;
}

input,
textarea {
  user-select: text;
  font-family: inherit;
}

button {
  font-family: inherit;
  cursor: pointer;
}
```

## Tailwind theme mapping + scrollbar utility — `apps/repair-pos/src/tailwind.css`

```css
@import 'tailwindcss';
@source '../../../packages/pos-client/src';
@source '../../../packages/ui/src';

/* FMP design tokens exposed to Tailwind (text-ink, bg-navy, border-line, …) */
@theme {
  --font-sans: 'Inter', system-ui, sans-serif;

  --color-ink: #17191c;
  --color-ink-2: #40464d;
  --color-ink-3: #5b636c;
  --color-ink-4: #7d8590;
  --color-navy: #111827;
  --color-orange: #f97316;
  --color-orange-soft: #fdede1;
  --color-page: #f0eee9;
  --color-card: #ffffff;
  --color-line: #e3e6ea;
  --color-line-soft: #eef0f3;

  --color-green-bg: #e7f6ee;
  --color-green-line: #bce5ce;
  --color-green: #15803d;
  --color-red-bg: #fdebe9;
  --color-red-line: #f7c7c1;
  --color-red: #b42318;
  --color-blue-bg: #e8effc;
  --color-blue: #1d4ed8;
  --color-purple-bg: #f0e9fc;
  --color-purple: #6d28d9;
  --color-amber-bg: #fdf3e1;
  --color-amber: #b45309;
}

/* Slim rounded scrollbar for horizontal strips (recent transactions, etc.) */
.fmp-hscroll {
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.fmp-hscroll::-webkit-scrollbar {
  height: 7px;
}
.fmp-hscroll::-webkit-scrollbar-track {
  background: transparent;
}
.fmp-hscroll::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 999px;
}
.fmp-hscroll::-webkit-scrollbar-thumb:hover {
  background: var(--ink-4);
}
```

## Font & icon loading

`apps/repair-pos/index.html` (same in retail-pos):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
  rel="stylesheet"
/>
```

`apps/repair-pos/src/main.tsx` — import order matters (tokens → tailwind → icons):

```tsx
import '@fmp/ui/tokens.css';
import './tailwind.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
```

## Button — `packages/ui/src/Button.tsx`

```tsx
type Variant = 'primary' | 'secondary' | 'dark' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, CSSProperties> = {
  primary: { background: 'var(--orange)', color: '#fff', border: '1px solid var(--orange)' },
  secondary: { background: 'var(--card)', color: 'var(--ink)', border: '1px solid var(--line)' },
  dark: { background: 'var(--navy)', color: '#fff', border: '1px solid var(--navy)' },
  danger: { background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid var(--red-line)' },
  ghost: { background: 'transparent', color: 'var(--ink-2)', border: '1px solid transparent' },
};

// base style applied to every button:
{
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderRadius: 11,
  padding: size === 'lg' ? '16px 26px' : '12px 20px',
  minHeight: size === 'lg' ? 52 : 44,
  font: `600 ${size === 'lg' ? 17 : 15}px Inter, sans-serif`,
  transition: 'filter .1s',
  opacity: disabled ? 0.5 : 1,
}
```

## StatusChip — `packages/ui/src/StatusChip.tsx`

```tsx
export type ChipTone = 'green' | 'red' | 'blue' | 'purple' | 'amber' | 'orange' | 'neutral';

const TONES: Record<ChipTone, { bg: string; fg: string }> = {
  green: { bg: 'var(--green-bg)', fg: 'var(--green)' },
  red: { bg: 'var(--red-bg)', fg: 'var(--red)' },
  blue: { bg: 'var(--blue-bg)', fg: 'var(--blue)' },
  purple: { bg: 'var(--purple-bg)', fg: 'var(--purple)' },
  amber: { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  orange: { bg: 'var(--orange-soft)', fg: 'var(--orange)' },
  neutral: { bg: 'var(--line-soft)', fg: 'var(--ink-2)' },
};

// chip style:
{
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 12px',
  borderRadius: 999,
  background: t.bg,
  color: t.fg,
  font: '600 13px Inter, sans-serif',
  whiteSpace: 'nowrap',
}
```

## Modal — `packages/ui/src/Modal.tsx`

```tsx
// overlay (click closes):
{
  position: 'fixed',
  inset: 0,
  background: 'rgba(17, 24, 39, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
}

// card (default width 640):
{
  width,
  maxWidth: 'calc(100vw - 40px)',
  maxHeight: 'calc(100vh - 40px)',
  overflow: 'auto',
  background: 'var(--card)',
  borderRadius: 20,
  boxShadow: 'var(--shadow)',
  padding: 28,
}
```

## DataTable — `packages/ui/src/DataTable.tsx` (style specs)

```tsx
// search input:
{ padding: '12px 14px 12px 40px', borderRadius: 12, border: '1px solid var(--line)',
  background: 'var(--card)', fontSize: 15 }
// search icon: bi bi-search, absolute left 14, color var(--ink-4), 15px

// filter chip (pill):
{ padding: '10px 16px', borderRadius: 999, border: '1px solid var(--line)',
  background: active ? 'var(--navy)' : 'var(--card)',
  color: active ? '#fff' : 'var(--ink-2)',
  font: '600 13.5px Inter, sans-serif' }

// table container:
{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)',
  overflow: 'auto', flex: 1, minHeight: 0 }

// header cell (sticky, uppercase label):
{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)',
  position: 'sticky', top: 0, zIndex: 1, background: 'var(--card)',
  color: active ? 'var(--ink)' : 'var(--ink-4)',
  font: '600 11.5px Inter, sans-serif', letterSpacing: '0.06em' }
// sort icons: bi-caret-up-fill / bi-caret-down-fill / bi-chevron-expand

// body cell:
{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', verticalAlign: 'top' }
// selected row background: var(--orange-soft)

// sticky footer:
{ padding: '13px 16px', borderTop: '1px solid var(--line-soft)',
  color: 'var(--ink-3)', fontSize: 14, position: 'sticky', bottom: 0, background: 'var(--card)' }

// empty state: { padding: 28, color: 'var(--ink-4)', fontSize: 15, textAlign: 'center' }
```

## Keypad — `packages/ui/src/Keypad.tsx`

```tsx
// grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }

// key:
{ height: 78, borderRadius: 14, border: '1px solid var(--line)',
  background: 'var(--card)', font: '600 27px Inter, sans-serif', color: 'var(--ink)' }

// ⌫ and 00 keys: background var(--line-soft); ⌫ spans two rows
// C key: background var(--red-bg), color var(--red), bottom-right beside 0
// 0 key: gridColumn 'span 3'
```
