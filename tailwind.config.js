/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Noto Sans SC", "Inter", "system-ui", "sans-serif"]
      },
      colors: {
        oat: "#F7F0E4",
        matcha: "#8FAE5A",
        leaf: "#446B43",
        citrus: "#F4B95B",
        tomato: "#D8705F",
        ink: "#243027",
        cream: "#FFF9EF"
      },
      boxShadow: {
        soft: "0 20px 60px rgba(68, 107, 67, 0.14)"
      }
    }
  },
  plugins: []
};
