import { useMemo, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** value used for sorting; omit to make the column unsortable */
  sortValue?: (row: T) => string | number | null;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;
  /** enables the built-in client-side search box over this text */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  /** filter chips shown next to the search box */
  filters?: Array<{ id: string; label: string; count?: number }>;
  activeFilter?: string;
  onFilterChange?: (id: string) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  emptyText?: string;
  /** rendered on the toolbar's right side (e.g. an Add button) */
  toolbar?: ReactNode;
  /** footer bar under the table (e.g. "Showing 14 of 86 · retail value …") */
  footer?: ReactNode;
  /** lets the page focus the search input (barcode scanners type into it) */
  searchInputRef?: RefObject<HTMLInputElement>;
  style?: CSSProperties;
}

/**
 * The standard FMP table: every column sortable (click the header),
 * optional built-in search and filter chips, sticky header, roomy rows,
 * no truncated text.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  searchText,
  searchPlaceholder = 'Search…',
  filters,
  activeFilter,
  onFilterChange,
  initialSort,
  emptyText = 'Nothing here yet.',
  toolbar,
  footer,
  searchInputRef,
  style,
}: DataTableProps<T>) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);

  const visible = useMemo(() => {
    let out = rows;
    if (searchText && query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((r) => searchText(r).toLowerCase().includes(q));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        out = [...out].sort((a, b) => {
          const va = col.sortValue!(a);
          const vb = col.sortValue!(b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp =
            typeof va === 'number' && typeof vb === 'number'
              ? va - vb
              : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
  }, [rows, query, sort, columns, searchText]);

  function toggleSort(col: Column<T>) {
    if (!col.sortValue) return;
    setSort((prev) =>
      prev?.key === col.key ? { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'asc' },
    );
  }

  const hasToolbar = Boolean(searchText || filters || toolbar);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, ...style }}>
      {hasToolbar && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          {searchText && (
            <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 420 }}>
              <i
                className="bi bi-search"
                style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-4)', fontSize: 15 }}
              />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                style={{
                  width: '100%',
                  padding: '12px 14px 12px 40px',
                  borderRadius: 12,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  fontSize: 15,
                }}
              />
            </div>
          )}
          {filters?.map((f) => (
            <button
              key={f.id}
              onClick={() => onFilterChange?.(f.id)}
              style={{
                padding: '10px 16px',
                borderRadius: 999,
                border: '1px solid var(--line)',
                background: activeFilter === f.id ? 'var(--navy)' : 'var(--card)',
                color: activeFilter === f.id ? '#fff' : 'var(--ink-2)',
                font: '600 13.5px Inter, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              {f.label}
              {f.count != null && <span style={{ opacity: 0.65, marginLeft: 6 }}>{f.count}</span>}
            </button>
          ))}
          {toolbar && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{toolbar}</div>}
        </div>
      )}

      <div style={{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1, minHeight: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
          <thead>
            <tr>
              {columns.map((col) => {
                const active = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col)}
                    style={{
                      padding: '14px 16px',
                      borderBottom: '1px solid var(--line-soft)',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      background: 'var(--card)',
                      textAlign: col.align ?? 'left',
                      color: active ? 'var(--ink)' : 'var(--ink-4)',
                      font: '600 11.5px Inter, sans-serif',
                      letterSpacing: '0.06em',
                      cursor: col.sortValue ? 'pointer' : 'default',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                      width: col.width,
                    }}
                  >
                    {col.label.toUpperCase()}
                    {col.sortValue && (
                      <i
                        className={`bi ${active ? (sort!.dir === 'asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill') : 'bi-chevron-expand'}`}
                        style={{ marginLeft: 5, fontSize: 10, opacity: active ? 1 : 0.45 }}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{
                    cursor: onRowClick ? 'pointer' : 'default',
                    background: selectedKey != null && selectedKey === key ? 'var(--orange-soft)' : 'transparent',
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '14px 16px',
                        borderBottom: '1px solid var(--line-soft)',
                        textAlign: col.align ?? 'left',
                        verticalAlign: 'top',
                      }}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div style={{ padding: 28, color: 'var(--ink-4)', fontSize: 15, textAlign: 'center' }}>{emptyText}</div>
        )}
        {footer && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '13px 16px',
              borderTop: '1px solid var(--line-soft)',
              color: 'var(--ink-3)',
              fontSize: 14,
              position: 'sticky',
              bottom: 0,
              background: 'var(--card)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
