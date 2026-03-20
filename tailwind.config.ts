import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        arbiter: {
          bg: '#0a0a0f',
          surface: '#111118',
          card: '#16161f',
          elevated: '#1e1e2a',
          border: '#2a2a38',
          'border-hi': '#3d3d55',
          text: '#e8e8f0',
          'text-2': '#8888a8',
          'text-3': '#555570',
          amber: '#f5a623',
          green: '#00d4a0',
          red: '#ff4d6d',
          blue: '#4d9eff',
          purple: '#a78bfa',
        },
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
      },
    },
  },
  plugins: [],
};

export default config;
