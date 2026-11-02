import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

type Theme = 'light' | 'dark'
const THEME_KEY = 'ynote.theme.v1'

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  }
}

/** A local display preference only; it never changes provider settings. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch { /* The toggle still works when browser storage is unavailable. */ }
  }, [theme])

  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) setTheme(readTheme())
    }
    window.addEventListener('storage', syncTheme)
    return () => window.removeEventListener('storage', syncTheme)
  }, [])

  const isDark = theme === 'dark'
  const label = isDark ? '切换到亮色模式' : '切换到暗色模式'
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      aria-pressed={isDark}
      title={label}
      onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}
    >
      {isDark ? <Sun size={17} strokeWidth={1.7} aria-hidden="true" /> : <Moon size={17} strokeWidth={1.7} aria-hidden="true" />}
    </button>
  )
}
