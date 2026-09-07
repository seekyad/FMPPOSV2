import { useEffect, useState } from 'react';

/**
 * True when the viewport is too narrow for side-by-side panels —
 * tablet portrait and below. Screens switch detail panels to overlay
 * drawers and stack columns when this is on.
 */
export function useNarrow(maxWidth = 1080): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}
