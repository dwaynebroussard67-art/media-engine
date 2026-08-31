// PostCSS config — Tailwind v4 via the official Next.js plugin.
// The UI components (gallery page, ReviewCard, home dashboard) were written
// against Tailwind utility classes, but Tailwind was never installed — the
// classes resolved to nothing. This wires them up for real.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
