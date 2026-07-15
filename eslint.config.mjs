export default [
  {
    files: ["main.js", "preload.js", "api.js", "ui.js", "db.js", "qobuz_scraper.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        localStorage: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        window: "readonly"
      }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn"
    }
  },
  {
    files: ["api.js", "ui.js"],
    languageOptions: {
      sourceType: "module"
    }
  }
];
