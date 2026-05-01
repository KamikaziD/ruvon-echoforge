import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sovereign: "#10b981",   // emerald-500
        sentinel:  "#f59e0b",   // amber-500
        danger:    "#ef4444",   // red-500
        muted:     "#6b7280",   // gray-500
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
