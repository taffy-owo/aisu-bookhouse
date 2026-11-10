/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      screens: {
        xs: '380px',
      },
      boxShadow: {
        glass: '0 22px 90px rgba(74, 56, 42, 0.09)',
        soft: '0 16px 55px rgba(74, 56, 42, 0.08)',
        dusk: '0 30px 60px -28px rgba(120, 72, 82, 0.5)',
        'dusk-sm': '0 20px 40px -26px rgba(120, 72, 82, 0.45)',
      },
      colors: {
        // Tailwind 3 cannot apply slash opacity to the literal currentColor.
        // Keep reader tools tied to their active reading palette while making
        // translucent borders, text and selection backgrounds compile.
        current: ({ opacityValue }) => opacityValue === undefined
          ? 'currentColor'
          : `color-mix(in srgb, currentColor calc(${opacityValue} * 100%), transparent)`,
        // Single accessible brand accent family (coral, matches the favicon).
        accent: {
          DEFAULT: '#C94441', // links and filled controls; readable on light backgrounds and behind white text
          strong: '#B83A38', // primary controls / compact badge text
          deep: '#982E2C', // hover / pressed step
          soft: '#F1B09E', // accent-tinted text & fills on dark surfaces
        },
        cream: '#EBE2DC',
        hairline: '#CFBBB4',
        ink: '#2C2430',
        // Dark-mode surface tokens — single source of truth so canvas, panels,
        // bars and dialogs share the exact same near-blacks instead of drifting hexes.
        night: {
          DEFAULT: '#1A1320', // dark app canvas / page background
          surface: '#241B29', // elevated surfaces (cards, panels, bars)
          ink: 'rgb(var(--night-ink) / <alpha-value>)',
          copy: 'rgb(var(--night-copy) / <alpha-value>)',
          soft: 'rgb(var(--night-soft) / <alpha-value>)',
        },
        // A muted warm rose canvas and paper surfaces keep light mode soft.
        paper: '#E6DCD7',
        sakura: '#EEDDE0',
        shell: '#F0E7E2',
        plum: '#4C3A42', // muted accent fill on dark (active nav, chips)
        peach: '#FFD4B0', // warm accent text used on dark surfaces
      },
      fontFamily: {
        display: ['"Noto Serif SC"', 'Songti SC', 'serif'],
        brand: ['"LXGW WenKai"', 'Kaiti SC', 'STKaiti', 'ui-serif', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(2px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
      },
    },
  },
  plugins: [],
};
