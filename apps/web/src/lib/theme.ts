export type Theme = 'system' | 'light' | 'dark';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');
let current: Theme = (localStorage.getItem('theme') as Theme | null) ?? 'system';

function apply() {
  const dark = current === 'dark' || (current === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(t: Theme) {
  current = t;
  try {
    localStorage.setItem('theme', t);
  } catch {
    /* private mode */
  }
  apply();
}

media().addEventListener('change', apply);
apply();
